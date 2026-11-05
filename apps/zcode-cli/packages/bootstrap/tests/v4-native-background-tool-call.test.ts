// L2：v4 原生 backgroundToolCall 命令（BT 分组 2026-11-05，OpenCode ctrl+b 复刻）——把
// 仍在跑的前台 Bash tool call 移交后台。验证：accepted → 直驱 runtime 原语并立即 resolve
// （不 abort、不 pause goal）、守卫未命中（noop）→ guard.stopTargetChanged、runtime/端口缺
// 能力 → fault.command.backgroundToolCallUnsupported、非 CAS（不携 baseRevision）且信封可解析。
// fake 风格参照 tests/v4-native-background-turn.test.ts（fake host/app，不经旧协议代码）。
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  parseCommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { V4CommandNoopError } from "../src/zcode-protocol-v4/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

function makeApp(overrides: Record<string, unknown> = {}) {
  const runtimeOverrides = (overrides.runtime ?? {}) as Record<string, unknown>;
  const appOverrides = { ...overrides };
  delete appOverrides.runtime;
  return {
    sessionId: "s1",
    readTarget: vi.fn().mockResolvedValue(null),
    updateTargetStatus: vi.fn().mockResolvedValue(null),
    runtime: {
      backgroundRunningToolCall: vi.fn().mockReturnValue({ kind: "noop" }),
      ...runtimeOverrides,
    },
    ...appOverrides,
  };
}

function makeRecord(
  overrides: Partial<V4SessionRecordView> & { app?: ReturnType<typeof makeApp> } = {},
): V4SessionRecordView {
  return {
    app: (overrides.app ?? makeApp()) as unknown as V4SessionRecordView["app"],
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    ...overrides,
  } as V4SessionRecordView;
}

function makeHost(
  record: V4SessionRecordView,
  hostOverrides: Partial<V4CommandCoreHost> = {},
): V4CommandCoreHost {
  return {
    getRecord: (id) => (id === "s1" ? record : undefined),
    waitForProjectionEventCommit: async () => {},
    ...hostOverrides,
  };
}

function envelope(payload: unknown, baseRevision?: number): CommandEnvelope {
  return {
    type: "backgroundToolCall",
    payload,
    sessionId: "s1",
    commandId: "cmd-bt-1",
    clientId: "client-a",
    issuedAt: 1,
    ...(baseRevision === undefined ? {} : { baseRevision }),
  } as unknown as CommandEnvelope;
}

describe("v4 原生 backgroundToolCall handler", () => {
  it("accepted：直驱 runtime 原语并立即 resolve，不 abort、不 pause goal", async () => {
    const controller = new AbortController();
    const backgroundRunningToolCall = vi.fn().mockReturnValue({
      kind: "backgrounded",
      workId: "exec_user_bg",
    });
    const app = makeApp({
      runtime: { backgroundRunningToolCall },
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "active" }),
    });
    const record = makeRecord({ app, activeAbortController: controller });

    const result = await new V4CommandExecutor(makeHost(record)).execute(
      envelope({ toolCallId: "toolu_1" }),
    );

    expect(result).toBeUndefined();
    expect(backgroundRunningToolCall).toHaveBeenCalledWith("toolu_1");
    // 移交只结算 tool call：不动 bootstrap 外层 controller，也不 pause goal（对照 stop）。
    expect(controller.signal.aborted).toBe(false);
    expect(app.readTarget).not.toHaveBeenCalled();
    expect(app.updateTargetStatus).not.toHaveBeenCalled();
  });

  it("守卫未命中（noop）：guard.stopTargetChanged，绝不触碰任何在跑执行", async () => {
    const controller = new AbortController();
    const backgroundRunningToolCall = vi.fn().mockReturnValue({ kind: "noop" });
    const record = makeRecord({
      app: makeApp({ runtime: { backgroundRunningToolCall } }),
      activeAbortController: controller,
    });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope({ toolCallId: "toolu_already_settled" }),
      ),
    ).rejects.toMatchObject({
      reasonCode: "guard.stopTargetChanged",
    } satisfies Partial<V4CommandNoopError>);
    expect(backgroundRunningToolCall).toHaveBeenCalledWith("toolu_already_settled");
    expect(controller.signal.aborted).toBe(false);
  });

  it.each([
    { kind: "unsupported", label: "executionPort 缺外部移交能力（stub/旧端口）" },
    { kind: "missing", label: "runtime 缺方法" },
  ])("unsupported（$label）：fault.command.backgroundToolCallUnsupported", async ({ kind }) => {
    const record = makeRecord({
      app: makeApp({
        runtime:
          kind === "unsupported"
            ? {
                backgroundRunningToolCall: vi
                  .fn()
                  .mockReturnValue({ kind: "unsupported" }),
              }
            : { backgroundRunningToolCall: undefined },
      }),
    });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(envelope({ toolCallId: "toolu_1" })),
    ).rejects.toMatchObject({ reasonCode: "fault.command.backgroundToolCallUnsupported" });
  });
});

describe("v4 backgroundToolCall 非 CAS 语义", () => {
  it("不携 baseRevision 也合法：不在 COMMANDS_REQUIRING_BASE_REVISION，信封可解析", () => {
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("backgroundToolCall")).toBe(false);
    const parsed = parseCommandEnvelope({
      commandId: "cmd-bt-parse",
      clientId: "client-a",
      sessionId: "s1",
      type: "backgroundToolCall",
      payload: { toolCallId: "toolu_1" },
      issuedAt: 1,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope.baseRevision).toBeUndefined();
      expect(parsed.envelope.payload).toEqual({ toolCallId: "toolu_1" });
    }
  });
});
