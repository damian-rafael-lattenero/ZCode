/* [fork 2026-10-30] bot-channel-continuous 连续流「burst-then-silence」的根因回归：
 * CLI 比 app 新时，strict zcodeSessionEventSchema 会把携带未知 payload 字段的 live
 * session/event 整条丢弃（机器日志实测 2026-10-20 起每天 350-4600 条，agentic 回合的
 * live 流几乎全是 tool.updated）。本文件钉死两层修复：
 *  1) 已审计的新 CLI 字段进入协议 schema（直接通过，不再剥除）；
 *  2) 未来再出现的未知字段经 safeParseStrippingUnrecognizedKeys 剥除后投递，
 *     未审计字段不穿透 renderer（fail-closed 的本意），事件不再丢失。
 */
import { describe, expect, it } from "vitest";
import {
  safeParseStrippingUnrecognizedKeys,
  zcodeSessionEventSchema,
} from "../src/zcode-protocol/index.js";

const envelopeBase = {
  eventId: "evt-1",
  sessionId: "session_abc",
  seq: 7,
  timestamp: 1730000000000,
} as const;

describe("zcodeSessionEventSchema — 已审计的新 CLI 字段", () => {
  it("tool.updated 携带 readOnly/sideEffectScope 直接通过（实测漂移字段，2026-10-30 审计）", () => {
    const parsed = zcodeSessionEventSchema.safeParse({
      ...envelopeBase,
      type: "tool.updated",
      payload: {
        kind: "started",
        toolCallId: "call_1",
        startedAt: "2026-10-30T12:00:00.000Z",
        readOnly: true,
        sideEffectScope: "workspace",
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const payload = parsed.data.payload as { readOnly?: boolean; sideEffectScope?: string };
      expect(payload.readOnly).toBe(true);
      expect(payload.sideEffectScope).toBe("workspace");
    }
  });

  it("turn.steerQueued 携带 inputPresentation 直接通过", () => {
    const parsed = zcodeSessionEventSchema.safeParse({
      ...envelopeBase,
      type: "turn.steerQueued",
      payload: {
        pendingInputId: "p1",
        input: "hi",
        inputPreview: "hi",
        inputSize: 2,
        targetTurnId: "t1",
        queueLength: 1,
        inputPresentation: "compact",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("permission.requested 携带 fullAccessSupported 直接通过", () => {
    const parsed = zcodeSessionEventSchema.safeParse({
      ...envelopeBase,
      type: "permission.requested",
      payload: {
        toolCallId: "call_2",
        toolName: "Bash",
        riskLevel: "low",
        reason: "r",
        input: {},
        options: [
          {
            optionId: "allow",
            kind: "allow_once",
            name: "Allow",
            response: { decision: "allow" },
          },
        ],
        fullAccessSupported: true,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("turn.completed 携带 preserveQueueAutoDrainOnCancel 直接通过", () => {
    const parsed = zcodeSessionEventSchema.safeParse({
      ...envelopeBase,
      type: "turn.completed",
      payload: {
        response: "done",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1,
        resultType: "success",
        preserveQueueAutoDrainOnCancel: true,
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("safeParseStrippingUnrecognizedKeys — 未来未知字段的容错", () => {
  const futureEvent = {
    ...envelopeBase,
    type: "tool.updated",
    payload: {
      kind: "started",
      toolCallId: "call_3",
      startedAt: "2026-10-30T12:00:00.000Z",
      someFutureField: { nested: true },
    },
  };

  it("直接 strict parse 失败（回归前提：未知字段确实会丢弃整条事件）", () => {
    expect(zcodeSessionEventSchema.safeParse(futureEvent).success).toBe(false);
  });

  it("剥除未知字段后投递，并报告剥了什么（审计线索）", () => {
    const result = safeParseStrippingUnrecognizedKeys(zcodeSessionEventSchema, futureEvent);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const payload = result.value.payload as Record<string, unknown>;
      expect(payload.someFutureField).toBeUndefined();
      expect(payload.toolCallId).toBe("call_3");
      expect(result.strippedKeys).toEqual(["someFutureField"]);
    }
  });

  it("干净事件零剥除直接通过", () => {
    const result = safeParseStrippingUnrecognizedKeys(zcodeSessionEventSchema, {
      ...envelopeBase,
      type: "tool.updated",
      payload: {
        kind: "started",
        toolCallId: "call_4",
        startedAt: "2026-10-30T12:00:00.000Z",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strippedKeys).toEqual([]);
  });

  it("非 unrecognized_keys 的真实协议故障保持丢弃（缺必需字段不参与容错）", () => {
    const broken = {
      ...envelopeBase,
      type: "tool.updated",
      payload: { kind: "started", startedAt: "2026-10-30T12:00:00.000Z" },
    };
    expect(zcodeSessionEventSchema.safeParse(broken).success).toBe(false);
    const result = safeParseStrippingUnrecognizedKeys(zcodeSessionEventSchema, broken);
    expect(result.ok).toBe(false);
  });
});
