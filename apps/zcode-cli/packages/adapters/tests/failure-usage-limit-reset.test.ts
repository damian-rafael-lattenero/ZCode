import { describe, expect, it } from "vitest";
import {
  MAX_USAGE_LIMIT_RESET_WAIT_MS,
  USAGE_LIMIT_RESET_PAST_FLOOR_MS,
  USAGE_LIMIT_RESET_UNTRUSTED_WAIT_MS,
  parseNextFlushTimeAtMs,
  parseUsageLimitResetTime,
  resolveUsageLimitResetWait,
  resolveUsageLimitResetWaitMs,
} from "../src/model/failure-usage-limit-reset.js";

const NOW_MS = Date.parse("2026-10-25T18:00:00Z");

describe("(FORK) parseNextFlushTimeAtMs", () => {
  it("reads an ISO string from the summary top level", () => {
    expect(
      parseNextFlushTimeAtMs({ summary: { next_flush_time: "2026-10-26T02:00:00Z" } }),
    ).toBe(Date.parse("2026-10-26T02:00:00Z"));
  });

  it("reads the field from the nested error record", () => {
    expect(
      parseNextFlushTimeAtMs({
        summary: { error: { code: "1308", next_flush_time: "2026-10-26T02:00:00Z" } },
      }),
    ).toBe(Date.parse("2026-10-26T02:00:00Z"));
  });

  it("accepts unix seconds and unix milliseconds numbers", () => {
    const resetAtSec = Math.floor(Date.parse("2026-10-26T02:00:00Z") / 1000);
    expect(parseNextFlushTimeAtMs({ summary: { next_flush_time: resetAtSec } })).toBe(
      resetAtSec * 1000,
    );
    const resetAtMs = Date.parse("2026-10-26T02:00:00Z");
    expect(parseNextFlushTimeAtMs({ summary: { nextFlushTime: resetAtMs } })).toBe(resetAtMs);
  });

  it("accepts a numeric string", () => {
    expect(
      parseNextFlushTimeAtMs({ summary: { next_flush_time: String(NOW_MS + 3_600_000) } }),
    ).toBe(NOW_MS + 3_600_000);
  });

  it("extracts the datetime interpolated into the provider message", () => {
    expect(
      parseNextFlushTimeAtMs({
        providerMessage:
          "Error code: 1308 - Your usage limit has been reached. Your limit will reset at 2026-10-26T02:00:00Z.",
      }),
    ).toBe(Date.parse("2026-10-26T02:00:00Z"));
  });

  it("treats a timezone-less datetime as UTC (epoch conversion; trust handled separately)", () => {
    expect(
      parseNextFlushTimeAtMs({ providerMessage: "Your limit will reset at 2026-10-26 02:00:00." }),
    ).toBe(Date.parse("2026-10-26T02:00:00Z"));
  });

  it("returns undefined when nothing parseable is present", () => {
    expect(parseNextFlushTimeAtMs({ summary: { code: "1308" } })).toBeUndefined();
    expect(
      parseNextFlushTimeAtMs({ providerMessage: "usage limit reached, top up your balance" }),
    ).toBeUndefined();
    expect(parseNextFlushTimeAtMs({ summary: { next_flush_time: -5 } })).toBeUndefined();
    expect(parseNextFlushTimeAtMs({})).toBeUndefined();
  });
});

describe("(FORK·时区守卫) parseUsageLimitResetTime 可信度", () => {
  it("marks an explicit Z offset as trusted and carries the raw match", () => {
    expect(
      parseUsageLimitResetTime({
        providerMessage: "Your limit will reset at 2026-10-26T02:00:00Z.",
      }),
    ).toEqual({
      atMs: Date.parse("2026-10-26T02:00:00Z"),
      offsetExplicit: true,
      raw: "2026-10-26T02:00:00Z",
    });
  });

  it("marks an explicit +hh:mm offset as trusted", () => {
    expect(
      parseUsageLimitResetTime({ summary: { next_flush_time: "2026-10-26T10:00:00+08:00" } }),
    ).toEqual({
      atMs: Date.parse("2026-10-26T10:00:00+08:00"),
      offsetExplicit: true,
      raw: "2026-10-26T10:00:00+08:00",
    });
  });

  it("marks a bare datetime (no offset) as UNTRUSTED — z.ai may emit Beijing-local literals", () => {
    expect(
      parseUsageLimitResetTime({
        providerMessage: "Your limit will reset at 2026-10-26 02:00:00.",
      }),
    ).toEqual({
      atMs: Date.parse("2026-10-26T02:00:00Z"),
      offsetExplicit: false,
      raw: "2026-10-26 02:00:00",
    });
  });

  it("treats unix timestamps as absolute (trusted) and keeps the raw value", () => {
    const resetAtSec = Math.floor(Date.parse("2026-10-26T02:00:00Z") / 1000);
    expect(parseUsageLimitResetTime({ summary: { next_flush_time: resetAtSec } })).toEqual({
      atMs: resetAtSec * 1000,
      offsetExplicit: true,
      raw: String(resetAtSec),
    });
  });
});

describe("(FORK·时区守卫) resolveUsageLimitResetWait", () => {
  it("explicit offset: exact wait with the documented clamps", () => {
    expect(
      resolveUsageLimitResetWait(
        { summary: { next_flush_time: "2026-10-26T02:00:00Z" } },
        NOW_MS,
      ),
    ).toEqual({
      waitMs: 8 * 3_600_000,
      offsetExplicit: true,
      rawTime: "2026-10-26T02:00:00Z",
    });
  });

  it("bare datetime: conservative 5-minute probe instead of an 8h-late UTC assumption", () => {
    // 北京时间字面量按 UTC 解析会晚 8h——不信它，交给 runner 的分段探测循环自校正。
    expect(
      resolveUsageLimitResetWait(
        { providerMessage: "Your limit will reset at 2026-10-26 02:00:00." },
        NOW_MS,
      ),
    ).toEqual({
      waitMs: USAGE_LIMIT_RESET_UNTRUSTED_WAIT_MS,
      offsetExplicit: false,
      rawTime: "2026-10-26 02:00:00",
    });
  });

  it("untrusted wait equals the runner's segment length (one probe segment)", () => {
    expect(USAGE_LIMIT_RESET_UNTRUSTED_WAIT_MS).toBe(5 * 60_000);
  });

  it("returns undefined when nothing parseable is present", () => {
    expect(resolveUsageLimitResetWait({ providerMessage: "top up" }, NOW_MS)).toBeUndefined();
  });
});

describe("(FORK) resolveUsageLimitResetWaitMs", () => {
  it("returns the exact wait for a future reset", () => {
    expect(resolveUsageLimitResetWaitMs(NOW_MS + 3 * 3_600_000, NOW_MS)).toBe(3 * 3_600_000);
  });

  it("clamps to the 24h documented maximum window", () => {
    expect(resolveUsageLimitResetWaitMs(NOW_MS + 72 * 3_600_000, NOW_MS)).toBe(
      MAX_USAGE_LIMIT_RESET_WAIT_MS,
    );
  });

  it("applies a floor instead of 0ms hot-looping when the reset already passed", () => {
    expect(resolveUsageLimitResetWaitMs(NOW_MS - 5_000, NOW_MS)).toBe(
      USAGE_LIMIT_RESET_PAST_FLOOR_MS,
    );
  });

  it("returns undefined for missing or invalid reset times", () => {
    expect(resolveUsageLimitResetWaitMs(undefined, NOW_MS)).toBeUndefined();
    expect(resolveUsageLimitResetWaitMs(Number.NaN, NOW_MS)).toBeUndefined();
    expect(resolveUsageLimitResetWaitMs(0, NOW_MS)).toBeUndefined();
  });
});
