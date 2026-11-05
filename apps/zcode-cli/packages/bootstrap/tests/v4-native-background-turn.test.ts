// L2：v4 原生 backgroundTurn 命令（DT 分组 2026-11-04）——把运行中的 primaryTurn demote
// 为 backgroundTurn。验证：身份守卫与 stop 同源（mismatch/idle → guard.stopTargetChanged
// noop，绝不 abort）、accepted demote 立即 resolve 不等收口、不可移交执行报
// fault.command.backgroundTurnUnsupported、非 CAS（不携 baseRevision）且进 CommandInbox
// ACK 账本。fake 风格参照 tests/v4-native-queue.test.ts（fake host/app，不经旧协议代码）。
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
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";
import type { CommandInboxHost } from "../src/zcode-protocol-v4/command-inbox.js";

function makeApp(overrides: Record<string, unknown> = {}) {
  const runtimeOverrides = (overrides.runtime ?? {}) as Record<string, unknown>;
  const appOverrides = { ...overrides };
  delete appOverrides.runtime;
  return {
    sessionId: "s1",
    readTarget: vi.fn().mockResolvedValue(null),
    updateTargetStatus: vi.fn().mockResolvedValue(null),
    runtime: {
      backgroundActiveForegroundExecution: vi.fn().mockReturnValue({ kind: "idle" }),
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
    type: "backgroundTurn",
    payload,
    sessionId: "s1",
    commandId: "cmd-dt-1",
    clientId: "client-a",
    issuedAt: 1,
    ...(baseRevision === undefined ? {} : { baseRevision }),
  } as unknown as CommandEnvelope;
}

describe("v4 原生 backgroundTurn handler", () => {
  it("accepted demote：直驱 runtime 原语并立即 resolve，不 abort、不 pause goal、不等收口", async () => {
    const controller = new AbortController();
    const backgroundActiveForegroundExecution = vi.fn().mockReturnValue({
      kind: "demoted",
      foregroundExecutionId: "runtime_command_1",
      workId: "turn_runtime_command_1",
    });
    const app = makeApp({
      runtime: { backgroundActiveForegroundExecution },
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "active" }),
    });
    const record = makeRecord({ app, activeAbortController: controller });

    const result = await new V4CommandExecutor(makeHost(record)).execute(
      envelope({ expectedForegroundExecutionId: "runtime_command_1" }),
    );

    expect(result).toBeUndefined();
    expect(backgroundActiveForegroundExecution).toHaveBeenCalledWith({
      expectedForegroundExecutionId: "runtime_command_1",
    });
    // demote 只转移归属：不动 bootstrap 外层 controller，也不 pause goal（对照 stop）。
    expect(controller.signal.aborted).toBe(false);
    expect(app.readTarget).not.toHaveBeenCalled();
    expect(app.updateTargetStatus).not.toHaveBeenCalled();
  });

  it("身份守卫 mismatch：noop guard.stopTargetChanged（同 stop 源），绝不 abort 新执行", async () => {
    const controller = new AbortController();
    const backgroundActiveForegroundExecution = vi.fn().mockReturnValue({
      kind: "mismatch",
      activeForegroundExecutionId: "runtime_command_2",
    });
    const record = makeRecord({
      app: makeApp({ runtime: { backgroundActiveForegroundExecution } }),
      activeAbortController: controller,
    });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope({ expectedForegroundExecutionId: "runtime_command_stale" }),
      ),
    ).rejects.toMatchObject({
      reasonCode: "guard.stopTargetChanged",
    } satisfies Partial<V4CommandNoopError>);
    expect(backgroundActiveForegroundExecution).toHaveBeenCalledWith({
      expectedForegroundExecutionId: "runtime_command_stale",
    });
    expect(controller.signal.aborted).toBe(false);
  });

  it("turn 已收口（idle）：同样 noop guard.stopTargetChanged", async () => {
    const record = makeRecord({
      app: makeApp({
        runtime: {
          backgroundActiveForegroundExecution: vi.fn().mockReturnValue({ kind: "idle" }),
        },
      }),
    });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(envelope({})),
    ).rejects.toMatchObject({ reasonCode: "guard.stopTargetChanged" });
  });

  it.each([
    { kind: "unsupported", label: "不可移交执行（compact/verifier/notification 轮）" },
    { kind: "missing", label: "runtime 缺方法" },
  ])("unsupported（$label）：fault.command.backgroundTurnUnsupported", async ({ kind }) => {
    const record = makeRecord({
      app: makeApp({
        runtime:
          kind === "unsupported"
            ? {
                backgroundActiveForegroundExecution: vi
                  .fn()
                  .mockReturnValue({ kind: "unsupported", activeForegroundExecutionId: "exec-9" }),
              }
            : { backgroundActiveForegroundExecution: undefined },
      }),
    });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(envelope({})),
    ).rejects.toMatchObject({ reasonCode: "fault.command.backgroundTurnUnsupported" });
  });
});

describe("v4 backgroundTurn 非 CAS 语义与 ACK 账本", () => {
  it("不携 baseRevision 也合法：不在 COMMANDS_REQUIRING_BASE_REVISION，信封可解析", () => {
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("backgroundTurn")).toBe(false);
    const parsed = parseCommandEnvelope({
      commandId: "cmd-dt-parse",
      clientId: "client-a",
      sessionId: "s1",
      type: "backgroundTurn",
      payload: { expectedForegroundExecutionId: "runtime_command_1" },
      issuedAt: 1,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope.baseRevision).toBeUndefined();
      expect(parsed.envelope.payload).toEqual({
        expectedForegroundExecutionId: "runtime_command_1",
      });
    }
  });

  it("进 CommandInbox ACK 账本：accepted 登记幂等边界，同 commandId 重试回 duplicate", async () => {
    const inbox = new CommandInbox({
      getRevision: () => 7,
      getLogEpoch: () => "epoch-current",
    } satisfies Partial<CommandInboxHost> as CommandInboxHost);

    const outcome = await inbox.handle(
      envelope({ expectedForegroundExecutionId: "runtime_command_1" }),
    );
    expect(outcome.kind).toBe("execute");
    if (outcome.kind !== "execute") return;
    expect(outcome.ack).toEqual({
      commandId: "cmd-dt-1",
      status: "accepted",
      revisionAtDecision: 7,
    });

    outcome.settle({ status: "accepted" });
    const retry = await inbox.handle(
      envelope({ expectedForegroundExecutionId: "runtime_command_1" }),
    );
    expect(retry.kind).toBe("ack");
    if (retry.kind !== "ack") return;
    expect(retry.ack.status).toBe("duplicate");
  });

  it("noop 结论进幂等表：重试 duplicate 回放原 reasonCode，不二次执行", async () => {
    const inbox = new CommandInbox({
      getRevision: () => 7,
      getLogEpoch: () => "epoch-current",
    } satisfies Partial<CommandInboxHost> as CommandInboxHost);

    const outcome = await inbox.handle(envelope({}));
    if (outcome.kind !== "execute") throw new Error("expected execution");
    outcome.settle({ status: "noop", reasonCode: "guard.stopTargetChanged" });
    const retry = await inbox.handle(envelope({}));
    expect(retry.kind).toBe("ack");
    if (retry.kind !== "ack") return;
    // 账本契约（同 command-inbox.test.ts）：settle 后的重试是 duplicate，携带原 noop reasonCode。
    expect(retry.ack).toMatchObject({
      status: "duplicate",
      reasonCode: "guard.stopTargetChanged",
    });
  });
});
