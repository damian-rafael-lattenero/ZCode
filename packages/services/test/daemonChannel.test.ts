/* [fork] B3a — tests herméticos del canal «daemon local» (ADR-022).
 * Socket unix REAL en un tmpdir (dataRootDir inyectado): nada de ~/.zcode,
 * nada de red, nada del env del fork. El cliente de prueba es node:net.
 * La spec del protocolo: docs/fork/DAEMON-CHANNEL.md; shapes: @zcode/shared
 * (daemon-channel.ts).
 */
import { connect } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotInboundMessage, ZCodeStreamEvent } from "@zcode/shared";
import {
  DAEMON_CHANNEL_FILE_MODE,
  DAEMON_CHANNEL_PROVIDER,
  type DaemonChannelClientMessage,
  type DaemonChannelServerMessage,
} from "@zcode/shared";
import type { IZCodeTaskService } from "../src/session/zcodeTaskService.js";
import { createDaemonLocalChannel } from "../src/bots/daemonChannel.js";
import * as f from "./botsService.fixtures.js";

interface StreamHandle {
  listeners: Set<(event: ZCodeStreamEvent) => void>;
  fire(event: ZCodeStreamEvent): void;
  dispose(): void;
}

function createTaskServiceWithStream(): IZCodeTaskService & {
  onDynamicTaskEvent: (
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
      taskId: string;
      deliveryKind?: string;
    },
  ) => (listener: (event: ZCodeStreamEvent) => void) => { dispose(): void };
  streamFor(taskId: string): StreamHandle | undefined;
} {
  const streams = new Map<
    string,
    { params: unknown; handle: StreamHandle }
  >();
  const base = f.createLegacyTaskService();
  const onDynamicTaskEvent = vi.fn((params: { taskId: string }) => {
    const existing = streams.get(params.taskId);
    if (existing) return (listener: (event: ZCodeStreamEvent) => void) => {
      existing.handle.listeners.add(listener);
      return {
        dispose() {
          existing.handle.listeners.delete(listener);
        },
      };
    };
    const listeners = new Set<(event: ZCodeStreamEvent) => void>();
    const handle: StreamHandle = {
      listeners,
      fire(event) {
        for (const listener of Array.from(listeners)) listener(event);
      },
      dispose() {
        listeners.clear();
      },
    };
    streams.set(params.taskId, { params, handle });
    return (listener: (event: ZCodeStreamEvent) => void) => {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    };
  });
  return {
    ...base,
    listActiveTaskIds: vi.fn(async () => ["task-1", "task-2"]),
    onDynamicTaskEvent,
    streamFor: (taskId: string) => streams.get(taskId)?.handle,
  } as unknown as ReturnType<typeof createTaskServiceWithStream>;
}

class TestClient {
  readonly socket: ReturnType<typeof connect>;
  private buffer = "";
  private waiters: Array<{
    predicate: (message: DaemonChannelServerMessage) => boolean;
    resolve: (message: DaemonChannelServerMessage) => void;
  }> = [];
  private closed: (() => void)[] = [];
  readonly opened: Promise<void>;

  constructor(
    socketPath: string,
    onUnsolicited?: (message: DaemonChannelServerMessage) => void,
  ) {
    this.socket = connect(socketPath);
    this.opened = new Promise((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("error", (error) => reject(error));
    });
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf("\n");
        if (!line) continue;
        const message = JSON.parse(line) as DaemonChannelServerMessage;
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
        if (waiterIndex >= 0) {
          const [waiter] = this.waiters.splice(waiterIndex, 1);
          waiter.resolve(message);
        } else {
          onUnsolicited?.(message);
        }
      }
    });
    this.socket.on("close", () => {
      for (const onClose of this.closed) onClose();
    });
  }

  send(message: DaemonChannelClientMessage): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(predicate: (message: DaemonChannelServerMessage) => boolean): Promise<DaemonChannelServerMessage> {
    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }

  waitClose(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.closed.push(resolve);
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

describe("daemon local channel (B3a)", () => {
  let dataDir: string;
  let taskService: ReturnType<typeof createTaskServiceWithStream>;
  let botsService: ReturnType<typeof f.createBotsService>;
  const usageService = {
    getEntitlementSnapshot: vi.fn(async () => ({
      generatedAt: 1,
      authenticated: true,
      provider: { id: "glm", name: "GLM" },
      remaining: { count: 42, isShow: true },
      subscription: null,
      quota: null,
    })),
  };

  async function startChannel(overrides?: {
    env?: Record<string, string | undefined>;
    config?: unknown;
    modelSelectionService?: unknown;
    modelSelectionDefault?: unknown;
    streamKeepaliveIntervalMs?: number;
  }) {
    const repo = overrides?.config ?? f.createMemoryRepo(f.baseConfig);
    botsService = f.createBotsService({
      repo: repo as never,
      legacyTaskService: taskService as never,
    });
    const channel = createDaemonLocalChannel({
      botsService,
      zcodeTaskService: taskService,
      usageStatsService: usageService,
      modelSelectionService: overrides?.modelSelectionService as never,
      modelSelectionDefault: overrides?.modelSelectionDefault as never,
      dataRootDir: () => dataDir,
      env: overrides?.env ?? {},
      handshakeTimeoutMs: 250,
      ...(overrides?.streamKeepaliveIntervalMs !== undefined
        ? { streamKeepaliveIntervalMs: overrides.streamKeepaliveIntervalMs }
        : {}),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    await channel.start();
    return { channel, repo };
  }

  async function readToken(): Promise<string> {
    return (await readFile(join(dataDir, "daemon-local.token"), "utf8")).trim();
  }

  async function connectAndHandshake(clientId = "test-daemon"): Promise<TestClient> {
    const client = new TestClient(join(dataDir, "daemon-local.sock"));
    await client.opened;
    client.send({
      type: "hello",
      protocolVersion: 1,
      token: await readToken(),
      clientId,
    });
    const helloOk = await client.waitFor((message) => message.type === "hello_ok");
    expect(helloOk).toMatchObject({ type: "hello_ok", protocolVersion: 1 });
    // Capacidades nuevas del /plan y del /context_window (aditivas, protocolo v1).
    expect((helloOk as { capabilities: string[] }).capabilities).toEqual(
      expect.arrayContaining([
        "queries:modelSelection",
        "control:setModelSelection",
        "queries:contextWindow",
      ]),
    );
    return client;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "daemon-channel-test-"));
    taskService = createTaskServiceWithStream();
    usageService.getEntitlementSnapshot.mockClear();
  });

  afterEach(async () => {
    botsService?.disposeAll();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("listens on a 0600 socket, provisions the daemon bot, and rotates the token per start", async () => {
    const { channel } = await startChannel();
    expect(channel.getState()).toBe("listening");
    const socketStat = await stat(join(dataDir, "daemon-local.sock"));
    expect(socketStat.mode & 0o777).toBe(DAEMON_CHANNEL_FILE_MODE);
    const tokenStat = await stat(join(dataDir, "daemon-local.token"));
    expect(tokenStat.mode & 0o777).toBe(DAEMON_CHANNEL_FILE_MODE);
    const firstToken = await readToken();
    expect(firstToken).toMatch(/^[0-9a-f]{64}$/);
    const config = await botsService.getConfig();
    expect(config.bots.some((bot) => bot.provider === DAEMON_CHANNEL_PROVIDER)).toBe(true);
    await channel.dispose();
    // Segundo arranque: token NUEVO (rota) y el socket reaparece.
    const second = createDaemonLocalChannel({
      botsService,
      zcodeTaskService: taskService,
      dataRootDir: () => dataDir,
      env: {},
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await second.start();
    expect(await readToken()).not.toBe(firstToken);
    await second.dispose();
  });

  it("rejects a wrong token and an unsupported protocol version, then closes", async () => {
    await startChannel();
    const badToken = new TestClient(join(dataDir, "daemon-local.sock"));
    await badToken.opened;
    badToken.send({ type: "hello", protocolVersion: 1, token: "nope" });
    const authError = await badToken.waitFor((message) => message.type === "error");
    expect(authError).toMatchObject({ type: "error", code: "auth_failed", fatal: true });
    await badToken.waitClose();

    const badVersion = new TestClient(join(dataDir, "daemon-local.sock"));
    await badVersion.opened;
    badVersion.send({ type: "hello", protocolVersion: 99, token: await readToken() });
    const versionError = await badVersion.waitFor((message) => message.type === "error");
    expect(versionError).toMatchObject({
      type: "error",
      code: "unsupported_version",
      supported: [1],
      fatal: true,
    });
    await badVersion.waitClose();
  });

  it("times out a connection that never says hello", async () => {
    await startChannel();
    const silent = new TestClient(join(dataDir, "daemon-local.sock"));
    await silent.opened;
    const timeoutError = await silent.waitFor((message) => message.type === "error");
    expect(timeoutError).toMatchObject({ type: "error", code: "auth_timeout", fatal: true });
    await silent.waitClose();
  });

  it("forwards inbound free text through handleInboundMessage and dedupes by messageId", async () => {
    const { repo } = await startChannel();
    const client = await connectAndHandshake();
    const inboundSpy = vi.spyOn(botsService, "handleInboundMessage");
    client.send({ type: "inbound", id: "r1", text: "build the thing", messageId: "tg-100" });
    const result = await client.waitFor(
      (message) => message.type === "inbound_result" && message.id === "r1",
    );
    expect(result.type).toBe("inbound_result");
    if (result.type !== "inbound_result") return;
    // La bot daemon queda pre-bound (providerUserId fijo): el mensaje entra al
    // MISMO camino que el composer — draft → createTask → sendPrompt.
    expect(inboundSpy).toHaveBeenCalledTimes(1);
    const forwarded = inboundSpy.mock.calls[0]![0] as BotInboundMessage;
    expect(forwarded.text).toBe("build the thing");
    expect(forwarded.actor).toMatchObject({
      provider: "daemon",
      chatType: "private",
      providerUserId: "daemon",
    });
    expect(forwarded.actor.providerMessageId).toBe("tg-100");
    await vi.waitFor(() =>
      expect(taskService.sendPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ content: "build the thing" }),
      ),
    );
    // El retry tras perder la respuesta NO reenvía el prompt (at-least-once con
    // dedupe del lado costoso).
    inboundSpy.mockClear();
    (taskService.sendPrompt as ReturnType<typeof vi.fn>).mockClear();
    client.send({ type: "inbound", id: "r2", text: "build the thing", messageId: "tg-100" });
    const duplicate = await client.waitFor(
      (message) => message.type === "inbound_result" && message.id === "r2",
    );
    expect(duplicate).toMatchObject({ type: "inbound_result", duplicate: true, replies: [] });
    expect(inboundSpy).not.toHaveBeenCalled();
    // La bot quedó en el config (provisionada) y el estado avanzó a task mode.
    const config = await botsService.getConfig();
    expect(config.bots.some((bot) => bot.provider === "daemon")).toBe(true);
    expect(repo).toBeDefined();
    client.destroy();
  });

  it("streams bot-channel-continuous events with seq and server timestamp", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({
      type: "subscribe",
      id: "s1",
      taskId: "task-9",
      workspacePath: "/tmp/workspace",
    });
    await client.waitFor((message) => message.type === "subscribed" && message.id === "s1");
    expect(taskService.onDynamicTaskEvent.mock.calls.at(-1)![0]).toMatchObject({
      taskId: "task-9",
      workspacePath: "/tmp/workspace",
      deliveryKind: "bot-channel-continuous",
    });
    const stream = taskService.streamFor("task-9");
    expect(stream).toBeDefined();
    const events: DaemonChannelServerMessage[] = [];
    stream!.fire({ type: "agent_thought_chunk", taskId: "task-9", traceId: "t", content: "hola" });
    const first = await client.waitFor((message) => message.type === "stream_event");
    events.push(first);
    stream!.fire({ type: "task_complete", taskId: "task-9", traceId: "t" } as ZCodeStreamEvent);
    const second = await client.waitFor(
      (message) => message.type === "stream_event" && message.seq === 2,
    );
    events.push(second);
    expect(events[0]).toMatchObject({
      type: "stream_event",
      taskId: "task-9",
      seq: 1,
      event: { type: "agent_thought_chunk", content: "hola" },
    });
    expect(events[0]).toHaveProperty("at");
    expect(events[1]).toMatchObject({ seq: 2, event: { type: "task_complete" } });
    // Unsubscribe corta la entrega.
    client.send({ type: "unsubscribe", id: "u1", taskId: "task-9" });
    await client.waitFor((message) => message.type === "unsubscribed" && message.id === "u1");
    stream!.fire({ type: "task_complete", taskId: "task-9", traceId: "t" } as ZCodeStreamEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.destroy();
  });

  it("heartbeats stream_keepalive per live subscription, sharing the connection seq counter", async () => {
    await startChannel({ streamKeepaliveIntervalMs: 20 });
    const client = await connectAndHandshake();
    client.send({
      type: "subscribe",
      id: "s1",
      taskId: "task-9",
      workspacePath: "/tmp/workspace",
    });
    await client.waitFor((message) => message.type === "subscribed" && message.id === "s1");
    // El latido llega sin eventos: un modelo callado NO rompe el canal.
    const firstBeat = await client.waitFor((message) => message.type === "stream_keepalive");
    expect(firstBeat).toMatchObject({ type: "stream_keepalive", taskId: "task-9" });
    expect(firstBeat).toHaveProperty("at");
    expect((firstBeat as { seq: number }).seq).toBeGreaterThanOrEqual(1);
    // El seq del latido comparte el MISMO contador monótono de stream_event.
    const stream = taskService.streamFor("task-9");
    expect(stream).toBeDefined();
    stream!.fire({ type: "task_complete", taskId: "task-9", traceId: "t" } as ZCodeStreamEvent);
    const event = (await client.waitFor((message) => message.type === "stream_event")) as {
      seq: number;
    };
    const nextBeat = (await client.waitFor(
      (message) => message.type === "stream_keepalive" && message.seq > event.seq,
    )) as { seq: number };
    expect(nextBeat.seq).toBeGreaterThan(event.seq);
    client.destroy();
  });

  it("unsubscribe stops the heartbeat; a resubscribe replaces the timer instead of stacking", async () => {
    await startChannel({ streamKeepaliveIntervalMs: 15 });
    const client = await connectAndHandshake();
    client.send({
      type: "subscribe",
      id: "s1",
      taskId: "task-9",
      workspacePath: "/tmp/workspace",
    });
    await client.waitFor((message) => message.type === "subscribed" && message.id === "s1");
    await client.waitFor((message) => message.type === "stream_keepalive");
    const stream = taskService.streamFor("task-9");
    expect(stream).toBeDefined();
    // Re-subscribir la misma task reemplaza la suscripción: un solo listener vivo
    // (el dispose del reemplazo limpió el timer viejo — cero latidos dobles).
    client.send({
      type: "subscribe",
      id: "s2",
      taskId: "task-9",
      workspacePath: "/tmp/workspace",
    });
    await client.waitFor((message) => message.type === "subscribed" && message.id === "s2");
    expect(stream!.listeners.size).toBe(1);
    // Unsubscribe mata la suscripción Y su latido: nada de frames en 5 intervalos.
    client.send({ type: "unsubscribe", id: "u1", taskId: "task-9" });
    await client.waitFor((message) => message.type === "unsubscribed" && message.id === "u1");
    expect(stream!.listeners.size).toBe(0);
    const beatAfterUnsubscribe = await Promise.race([
      client.waitFor((message) => message.type === "stream_keepalive"),
      new Promise<"none">((resolve) => setTimeout(() => resolve("none"), 75)),
    ]);
    expect(beatAfterUnsubscribe).toBe("none");
    client.destroy();
  });

  it("answers service queries and control ops (quota, listTasks, stopAll)", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    const sendQuery = (id: string, query: unknown) =>
      client.send({ type: "query", id, query } as never);
    const queryResult = (id: string) =>
      client.waitFor((message) => message.type === "query_result" && message.id === id);

    sendQuery("q1", { kind: "quota" });
    const quota = await queryResult("q1");
    expect(quota).toMatchObject({
      type: "query_result",
      result: { authenticated: true, remaining: { count: 42 } },
    });

    sendQuery("q2", { kind: "listTasks", workspacePath: "/tmp/workspace" });
    await queryResult("q2");
    expect(taskService.listTasks).toHaveBeenCalledWith({ workspacePath: "/tmp/workspace" });

    sendQuery("q3", { kind: "stopAll", workspacePath: "/tmp/workspace" });
    const stopAll = await queryResult("q3");
    expect(stopAll).toMatchObject({ type: "query_result", result: { stopped: ["task-1", "task-2"] } });
    expect(taskService.stopGeneration).toHaveBeenCalledTimes(2);

    sendQuery("q4", { kind: "doesNotExist" });
    const unknown = await client.waitFor(
      (message) => message.type === "error" && message.id === "q4",
    );
    expect(unknown).toMatchObject({ type: "error", code: "unknown_query" });
    client.destroy();
  });

  it("answers modelSelection/setModelSelection: conversation scope + default scope", async () => {
    // Registry fake: un plan Z.ai con un modelo y dos effort (low < high).
    const modelSelectionView = {
      providers: [
        {
          providerId: "account:zai-individual-coding-plan",
          providerName: "Z.ai Coding Plan",
          models: [
            {
              modelId: "GLM-5.3",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
            },
          ],
        },
      ],
    } as never;
    const modelSelectionService = { getView: vi.fn(async () => modelSelectionView) };
    let storedDefault: unknown;
    const modelSelectionDefault = {
      read: vi.fn(async () => storedDefault as never),
      saveConfiguredDefault: vi.fn(async (selection: unknown) => {
        storedDefault = selection;
        return selection as never;
      }),
    };
    await startChannel({ modelSelectionService, modelSelectionDefault });
    const client = await connectAndHandshake();
    const sendQuery = (id: string, query: unknown) =>
      client.send({ type: "query", id, query } as never);
    const queryResult = (id: string) =>
      client.waitFor((message) => message.type === "query_result" && message.id === id);

    // El hello anuncia las capacidades nuevas (verificado en connectAndHandshake).

    // QUERY modelSelection: delega en botsService.getBotModelSelection y agrega
    // default global + planes. Los dos spies quedan activos: el CONTROL
    // conversation vuelve a leer el snapshot tras escribir.
    const getSpy = vi
      .spyOn(botsService, "getBotModelSelection")
      .mockResolvedValue({
        scope: "draft",
        selection: {
          providerId: "account:zai-start-plan",
          modelId: "GLM-5.3",
          reasoningLevel: "high",
        },
      });
    sendQuery("m1", { kind: "modelSelection" });
    const readResult = await client.waitFor(
      (message) =>
        (message.type === "query_result" || message.type === "error") && message.id === "m1",
    );
    expect(readResult.type).toBe("query_result");
    expect(readResult).toMatchObject({
      type: "query_result",
      result: {
        scope: "conversation",
        selection: { providerId: "account:zai-start-plan", modelId: "GLM-5.3" },
        plans: [
          {
            providerId: "account:zai-individual-coding-plan",
            label: "Z.ai Coding Plan",
            // El vocabulary de effort del catálogo viaja con cada modelo (aditivo).
            models: [{ id: "GLM-5.3", label: "GLM-5.3", reasoningLevels: ["low", "high"] }],
          },
        ],
      },
    });

    // CONTROL conversation: setea plan/modelo y devuelve el snapshot nuevo.
    // (el read-back post-escritura devuelve la selección YA cambiada)
    getSpy.mockResolvedValue({
      scope: "draft",
      selection: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-5.3",
        reasoningLevel: "high",
      },
    });
    const setSpy = vi
      .spyOn(botsService, "setBotModelSelection")
      .mockResolvedValue({
        scope: "draft",
        selection: {
          providerId: "account:zai-individual-coding-plan",
          modelId: "GLM-5.3",
          reasoningLevel: "high",
        },
      });
    sendQuery("m2", {
      kind: "setModelSelection",
      scope: "conversation",
      plan: "account:zai-individual-coding-plan",
      model: "GLM-5.3",
    });
    const setResult = await queryResult("m2");
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "daemon-local",
        plan: "account:zai-individual-coding-plan",
        model: "GLM-5.3",
      }),
    );
    expect(setResult).toMatchObject({
      type: "query_result",
      result: {
        scope: "conversation",
        selection: { providerId: "account:zai-individual-coding-plan" },
      },
    });
    getSpy.mockRestore();
    setSpy.mockRestore();

    // CONTROL default: completa el effort con la tier máxima del modelo.
    sendQuery("m3", {
      kind: "setModelSelection",
      scope: "default",
      plan: "account:zai-individual-coding-plan",
      model: "GLM-5.3",
    });
    const defaultResult = await queryResult("m3");
    expect(modelSelectionDefault.saveConfiguredDefault).toHaveBeenCalledWith({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "high" },
    });
    expect(defaultResult).toMatchObject({
      type: "query_result",
      result: {
        scope: "default",
        default: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
      },
    });

    // Effort inválido → error honesto con los valores válidos.
    sendQuery("m4", {
      kind: "setModelSelection",
      scope: "default",
      plan: "account:zai-individual-coding-plan",
      model: "GLM-5.3",
      effort: "turbo",
    });
    const effortError = await client.waitFor(
      (message) => message.type === "error" && message.id === "m4",
    );
    expect(effortError).toMatchObject({ type: "error", code: "internal" });
    expect((effortError as { message?: string }).message).toContain("valid values: low, high");
    client.destroy();
  });

  it("answers contextWindow with the REAL context meter (used, window, model)", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    const sendQuery = (id: string, query: unknown) =>
      client.send({ type: "query", id, query } as never);
    const queryResult = (id: string) =>
      client.waitFor((message) => message.type === "query_result" && message.id === id);

    // runtime.contextUsage = la MISMA fuente que restaura el meter del desktop
    // (contextUsageFromRuntime ?? contextUsageFromProjection del adapter).
    (taskService.getTaskSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      meta: { taskId: "task-7", title: "T", workspacePath: "/tmp/workspace", model: "meta-model" },
      messages: [],
      runtime: { contextUsage: { used: 45300, size: 200000 } },
    });
    (taskService.getTaskModelSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      providerId: "account:zai-start-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "max" },
    });

    sendQuery("cw1", { kind: "contextWindow", taskId: "task-7", workspacePath: "/tmp/workspace" });
    const result = await queryResult("cw1");
    // El model de la sesión activa gana sobre meta.model; el meter viaja crudo
    // (sin registry, el size del runtime es el respaldo — y viaja su fuente).
    expect(result).toMatchObject({
      type: "query_result",
      result: { model: "GLM-5.3-Flash", usedTokens: 45300, windowTokens: 200000, windowSource: "runtime" },
    });
    // El medidor se lee liviano: 1 mensaje basta (no es el /last del snapshot).
    expect(taskService.getTaskSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-7", workspacePath: "/tmp/workspace", messageLimit: 1 }),
    );
    client.destroy();
  });

  it("contextWindow stays honest without a meter: nulls, and model falls back to meta", async () => {
    await startChannel(); // sin modelSelectionService: no hay registry de donde caer
    const client = await connectAndHandshake();
    const sendQuery = (id: string, query: unknown) =>
      client.send({ type: "query", id, query } as never);
    const queryResult = (id: string) =>
      client.waitFor((message) => message.type === "query_result" && message.id === id);
    (taskService.getTaskSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      meta: { taskId: "task-7", title: "T", workspacePath: "/tmp/workspace", model: "meta-model" },
      messages: [],
    });
    (taskService.getTaskModelSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      providerId: "account:zai-start-plan",
      modelId: "session-model",
      options: { reasoningLevel: "max" },
    });

    // Sin runtime.contextUsage NO se inventa nada: ambos null.
    sendQuery("cw2", { kind: "contextWindow", taskId: "task-7", workspacePath: "/tmp/workspace" });
    const result = await queryResult("cw2");
    expect(result).toMatchObject({
      type: "query_result",
      result: { model: "session-model", usedTokens: null, windowTokens: null },
    });

    // Sin selección de sesión viva → el model cae a meta.model.
    (taskService.getTaskModelSelection as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("task target is not live"),
    );
    sendQuery("cw3", { kind: "contextWindow", taskId: "task-7", workspacePath: "/tmp/workspace" });
    const fallback = await queryResult("cw3");
    expect(fallback).toMatchObject({
      type: "query_result",
      result: { model: "meta-model", usedTokens: null, windowTokens: null },
    });
    client.destroy();
  });

  it("the registry's contextWindow WINS over the runtime's segment cap (the owner's 200K/200K bug)", async () => {
    const modelSelectionView = {
      providers: [
        {
          providerId: "account:zai-start-plan",
          providerName: "Start Plan",
          models: [
            {
              modelId: "GLM-5.3-Flash",
              config: { properties: { contextWindow: 1_000_000 } },
            },
          ],
        },
      ],
    };
    const modelSelectionService = { getView: vi.fn(async () => modelSelectionView) };
    await startChannel({ modelSelectionService, modelSelectionDefault: null });
    const client = await connectAndHandshake();
    const sendQuery = (id: string, query: unknown) =>
      client.send({ type: "query", id, query } as never);
    const queryResult = (id: string) =>
      client.waitFor((message) => message.type === "query_result" && message.id === id);
    // the runtime's 200K is a segment cap, NOT the model's window — the
    // registry's 1M is the truth (the owner saw 200K/200K = 100%)
    (taskService.getTaskSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      meta: { taskId: "task-7", title: "T", workspacePath: "/tmp/workspace", model: "meta-model" },
      messages: [],
      runtime: { contextUsage: { used: 200000, size: 200000 } },
    });
    (taskService.getTaskModelSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      providerId: "account:zai-start-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "max" },
    });
    sendQuery("cw4", { kind: "contextWindow", taskId: "task-7", workspacePath: "/tmp/workspace" });
    const result = await queryResult("cw4");
    expect(result).toMatchObject({
      type: "query_result",
      result: { usedTokens: 200000, windowTokens: 1_000_000, windowSource: "model" },
    });
    client.destroy();
  });

  it("an inbound WITH taskId is an ORDER: sendPrompt straight into that session", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({
      type: "inbound",
      id: "ord1",
      text: "cambiale el título a la carta",
      messageId: "tg-900",
      taskId: "sess_subagent_agent_419b5d75",
    } as never);
    const result = await client.waitFor(
      (message) => message.type === "inbound_result" && message.id === "ord1",
    );
    // the DIRECT delivery: the prompt entered THAT session, not the bound one
    expect(taskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "sess_subagent_agent_419b5d75",
        content: "cambiale el título a la carta",
      }),
    );
    expect(taskService.handleInboundMessage ?? null).toBeNull(); // the fake has no such fn — the real check is sendPrompt above
    expect(result).toMatchObject({ type: "inbound_result", id: "ord1", duplicate: false });
    client.destroy();
  });

  it("a steer frame sends the prompt with requestedDelivery guide (the running turn's redirection)", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({
      type: "steer",
      id: "st1",
      taskId: "task-77",
      text: "cambiá el enfoque a la API",
    } as never);
    const result = await client.waitFor(
      (message) => message.type === "inbound_result" && message.id === "st1",
    );
    // the delivery: sendPrompt CARRIES the guide — the CLI admission injects it INSIDE the live turn
    expect(taskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-77",
        content: "cambiá el enfoque a la API",
        requestedDelivery: "guide",
      }),
    );
    expect(result).toMatchObject({ type: "inbound_result", id: "st1", duplicate: false });
    client.destroy();
  });

  it("a steer WITHOUT text or taskId is refused by name (bad_request)", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({ type: "steer", id: "st2", taskId: "", text: "  " } as never);
    const result = await client.waitFor(
      (message) => message.type === "error" && message.id === "st2",
    );
    expect(result).toMatchObject({ type: "error", code: "bad_request" });
    client.destroy();
  });

  it("a steer failure travels AS AN ERROR (the task service's own word)", async () => {
    await startChannel();
    (taskService.sendPrompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no target for task-77"),
    );
    const client = await connectAndHandshake();
    client.send({ type: "steer", id: "st3", taskId: "task-77", text: "probando" } as never);
    const result = await client.waitFor(
      (message) => message.type === "error" && message.id === "st3",
    );
    expect(result).toMatchObject({
      type: "error",
      code: "internal",
      message: expect.stringContaining("steer to task-77 failed: no target for task-77"),
    });
    client.destroy();
  });

  it("quota resolves the account access from the active conversation's provider (the not_configured fix)", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    const sendQuery = (id: string, query: unknown) =>
      client.send({ type: "query", id, query } as never);
    const queryResult = (id: string) =>
      client.waitFor((message) => message.type === "query_result" && message.id === id);
    (taskService.getTaskModelSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      providerId: "account:zai-start-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "max" },
    });
    sendQuery("q9", { kind: "quota", taskId: "task-7" });
    await queryResult("q9");
    // the Start Plan path's gate: the request carries the access hint (the
    // provider resolves the DYNAMIC truth from it) + the active provider
    expect(usageService.getEntitlementSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProviderId: "account:zai-start-plan",
        accountAccess: { type: "zhipu-account", family: "zai", planKind: "start-plan" },
        allowDisabledPreferredProvider: true,
      }),
    );
    client.destroy();
  });

  it("nothing exposes the window: the owner's 1M calibration, marked as such", async () => {
    await startChannel(); // sin registry
    const client = await connectAndHandshake();
    const sendQuery = (id: string, query: unknown) =>
      client.send({ type: "query", id, query } as never);
    const queryResult = (id: string) =>
      client.waitFor((message) => message.type === "query_result" && message.id === id);
    // used is KNOWN, the window is not exposed anywhere → the owner's own
    // calibration (his models are 1M max), travelling its source so the
    // bot renders it approximate
    (taskService.getTaskSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      meta: { taskId: "task-7", title: "T", workspacePath: "/tmp/workspace", model: "meta-model" },
      messages: [],
      runtime: { contextUsage: { used: 200000, size: 0 } },
    });
    (taskService.getTaskModelSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      providerId: "account:zai-start-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "max" },
    });
    sendQuery("cw5", { kind: "contextWindow", taskId: "task-7", workspacePath: "/tmp/workspace" });
    const result = await queryResult("cw5");
    expect(result).toMatchObject({
      type: "query_result",
      result: { usedTokens: 200000, windowTokens: 1_000_000, windowSource: "owner_default" },
    });
    client.destroy();
  });

  it("contextWindow falls back to the registry window when the meter lacks size", async () => {
    const modelSelectionService = {
      getView: vi.fn(async () => ({
        providers: [
          {
            providerId: "account:zai-start-plan",
            models: [
              { modelId: "GLM-5.3-Flash", config: { properties: { contextWindow: 200000 } } },
            ],
          },
        ],
      })),
    };
    await startChannel({ modelSelectionService });
    const client = await connectAndHandshake();
    const sendQuery = (id: string, query: unknown) =>
      client.send({ type: "query", id, query } as never);
    const queryResult = (id: string) =>
      client.waitFor((message) => message.type === "query_result" && message.id === id);
    (taskService.getTaskSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      meta: { taskId: "task-7", title: "T", workspacePath: "/tmp/workspace", model: "GLM-5.3-Flash" },
      messages: [],
    });
    (taskService.getTaskModelSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      providerId: "account:zai-start-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "max" },
    });

    // El meter no sabe la ventana, pero el registry sí: properties.contextWindow.
    sendQuery("cw4", { kind: "contextWindow", taskId: "task-7", workspacePath: "/tmp/workspace" });
    const result = await queryResult("cw4");
    expect(result).toMatchObject({
      type: "query_result",
      result: { model: "GLM-5.3-Flash", usedTokens: null, windowTokens: 200000 },
    });
    client.destroy();
  });

  it("survives malformed JSON lines and answers unknown request types", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.socket.write("{not json}\n");
    const bad = await client.waitFor((message) => message.type === "error" && message.code === "bad_request");
    expect(bad).toBeDefined();
    client.send({ type: "moonwalk", id: "x1" } as never);
    const unknown = await client.waitFor((message) => message.type === "error" && message.code === "unknown_request");
    expect(unknown).toMatchObject({ type: "error", code: "unknown_request" });
    // La conexión sigue viva: un ping responde.
    client.send({ type: "ping", id: "p1" });
    const pong = await client.waitFor((message) => message.type === "pong" && message.id === "p1");
    expect(pong).toMatchObject({ type: "pong" });
    client.destroy();
  });

  it("dispose sends bye, closes clients, and removes socket+token; env=0 disables", async () => {
    const { channel } = await startChannel();
    const client = await connectAndHandshake();
    const bye = client.waitFor((message) => message.type === "bye");
    await channel.dispose();
    await expect(await bye).toMatchObject({ type: "bye", reason: "host-shutdown" });
    await client.waitClose();
    await expect(stat(join(dataDir, "daemon-local.sock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dataDir, "daemon-local.token"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(channel.getState()).toBe("disposed");

    const disabled = createDaemonLocalChannel({
      botsService,
      zcodeTaskService: taskService,
      dataRootDir: () => dataDir,
      env: { ZCODE_DAEMON_LOCAL_CHANNEL: "0" },
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await disabled.start();
    expect(disabled.getState()).toBe("disabled");
  });

  it("a second host loses the socket race and its dispose never deletes the winner's files", async () => {
    const { channel } = await startChannel();
    const winnerToken = await readToken();
    // Segundo canal, MISMO dataDir: el socket vive (host A) ⇒ conflicto, y el
    // token del ganador NO se rota (pertenece a quien posee el socket).
    const loser = createDaemonLocalChannel({
      botsService,
      zcodeTaskService: taskService,
      dataRootDir: () => dataDir,
      env: {},
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await loser.start();
    expect(loser.getState()).toBe("conflict");
    expect(await readToken()).toBe(winnerToken);
    await loser.dispose();
    // El dispose del perdedor no borra los archivos del ganador.
    expect(await readFile(join(dataDir, "daemon-local.token"), "utf8")).toContain(winnerToken);
    const client = await connectAndHandshake();
    client.send({ type: "ping", id: "still-alive" });
    await client.waitFor((message) => message.type === "pong" && message.id === "still-alive");
    client.destroy();
    await channel.dispose();
  });

  it("respects the enabled gate: a disabled daemon bot rejects inbound with botDisabled", async () => {
    const repo = f.createMemoryRepo({
      version: 3,
      bots: [
        {
          id: "daemon-local",
          name: "Daemon local",
          provider: "daemon",
          enabled: false,
          providerUserId: "daemon",
          allowedWorkspaces: ["*"],
          allowedCommands: { ...f.defaultUserCommands },
          currentOptions: {},
          replyMode: "assistant_changes",
        },
      ],
    });
    await startChannel({ config: repo });
    const client = await connectAndHandshake();
    client.send({ type: "inbound", id: "g1", text: "hola" });
    const rejected = await client.waitFor(
      (message) => message.type === "inbound_result" && message.id === "g1",
    );
    expect(rejected.type).toBe("inbound_result");
    if (rejected.type !== "inbound_result") return;
    expect(rejected.replies.length).toBe(1);
    expect(rejected.replies[0]!.text.length).toBeGreaterThan(0);
    expect(taskService.sendPrompt).not.toHaveBeenCalled();
    client.destroy();
  });

  it("a respond frame routes to respondPermission with the event's option (the loop closes)", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({
      type: "respond",
      id: "rs1",
      taskId: "task-1",
      requestId: "perm_req_42",
      kind: "permission",
      optionId: "allow",
      response: { decision: "allow" },
      messageId: "tg-1000",
    } as never);
    const result = await client.waitFor(
      (message) => message.type === "respond_result" && message.id === "rs1",
    );
    // the SAME service API the desktop UI calls, with the EXACT ids
    expect(taskService.respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        requestId: "perm_req_42",
        optionId: "allow",
        response: { decision: "allow" },
      }),
    );
    expect(result).toMatchObject({
      type: "respond_result",
      id: "rs1",
      taskId: "task-1",
      requestId: "perm_req_42",
      kind: "permission",
      ok: true,
    });
    client.destroy();
  });

  it("a permission respond WITHOUT the option's response derives {decision} from the optionId", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({
      type: "respond",
      id: "rs2",
      taskId: "task-1",
      requestId: "perm_req_43",
      kind: "permission",
      optionId: "deny",
      messageId: "tg-1001",
    } as never);
    await client.waitFor((message) => message.type === "respond_result" && message.id === "rs2");
    expect(taskService.respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "perm_req_43",
        optionId: "deny",
        response: { decision: "deny" },
      }),
    );
    client.destroy();
  });

  it("a respond elicitation frame routes to respondElicitation with action + content", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    const content = { answers: { "¿Seguimos?": "Sí" }, answer: "Sí" };
    client.send({
      type: "respond",
      id: "rs3",
      taskId: "task-1",
      requestId: "elicit_7",
      kind: "elicitation",
      action: "accept",
      content,
      messageId: "tg-1002",
    } as never);
    const result = await client.waitFor(
      (message) => message.type === "respond_result" && message.id === "rs3",
    );
    expect(taskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        requestId: "elicit_7",
        action: "accept",
        content,
      }),
    );
    expect(result).toMatchObject({ type: "respond_result", ok: true, kind: "elicitation" });
    client.destroy();
  });

  it("a respond plan frame rides the elicitation door (ExitPlanMode) and defaults to accept", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({
      type: "respond",
      id: "rs4",
      taskId: "task-1",
      requestId: "plan_req_9",
      kind: "plan",
      messageId: "tg-1003",
    } as never);
    await client.waitFor((message) => message.type === "respond_result" && message.id === "rs4");
    expect(taskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "plan_req_9", action: "accept" }),
    );
    client.destroy();
  });

  it("an unknown requestId fails HONESTLY: the CLI's error travels, never a fake ok", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    (taskService.respondPermission as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error("interaction not found: perm_gone");
      },
    );
    client.send({
      type: "respond",
      id: "rs5",
      taskId: "task-1",
      requestId: "perm_gone",
      kind: "permission",
      optionId: "allow",
      messageId: "tg-1004",
    } as never);
    const error = await client.waitFor(
      (message) => message.type === "error" && message.id === "rs5",
    );
    expect(error).toMatchObject({ type: "error", code: "internal" });
    expect((error as { message?: string }).message).toContain("perm_gone");
    // NO respond_result ok after a failure: the tap edits the message with the error
    expect(
      (await Promise.race([
        client.waitFor((message) => message.type === "respond_result" && message.id === "rs5"),
        new Promise((resolve) => setTimeout(resolve, 150)),
      ])) as unknown,
    ).not.toMatchObject({ type: "respond_result", ok: true });
    client.destroy();
  });

  it("a duplicated respond (same messageId) does NOT re-resolve the interaction (the inbound dedupe law)", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({
      type: "respond",
      id: "rs6",
      taskId: "task-1",
      requestId: "perm_44",
      kind: "permission",
      optionId: "allow",
      messageId: "tg-1005",
    } as never);
    await client.waitFor((message) => message.type === "respond_result" && message.id === "rs6");
    client.send({
      type: "respond",
      id: "rs7",
      taskId: "task-1",
      requestId: "perm_44",
      kind: "permission",
      optionId: "allow",
      messageId: "tg-1005",
    } as never);
    const duplicate = await client.waitFor(
      (message) => message.type === "respond_result" && message.id === "rs7",
    );
    expect(duplicate).toMatchObject({ type: "respond_result", ok: true });
    expect(taskService.respondPermission).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it("a respond missing its kind's payload answers bad_request (permission needs optionId, plan needs action)", async () => {
    await startChannel();
    const client = await connectAndHandshake();
    client.send({
      type: "respond",
      id: "rs8",
      taskId: "task-1",
      requestId: "perm_45",
      kind: "permission",
      messageId: "tg-1006",
    } as never);
    const bad1 = await client.waitFor((message) => message.type === "error" && message.id === "rs8");
    expect(bad1).toMatchObject({ type: "error", code: "bad_request" });
    expect(taskService.respondPermission).not.toHaveBeenCalled();
    client.send({
      type: "respond",
      id: "rs9",
      taskId: "task-1",
      requestId: "elicit_8",
      kind: "elicitation",
      messageId: "tg-1007",
    } as never);
    const bad2 = await client.waitFor((message) => message.type === "error" && message.id === "rs9");
    expect(bad2).toMatchObject({ type: "error", code: "bad_request" });
    expect(taskService.respondElicitation).not.toHaveBeenCalled();
    client.destroy();
  });
});
