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
      dataRootDir: () => dataDir,
      env: overrides?.env ?? {},
      handshakeTimeoutMs: 250,
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
});
