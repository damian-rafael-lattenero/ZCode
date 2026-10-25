import { describe, expect, it } from "vitest";
import {
  MAX_USAGE_LIMIT_RESET_WAIT_MS,
  USAGE_LIMIT_RESET_PAST_FLOOR_MS,
  parseNextFlushTimeAtMs,
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

  it("treats a timezone-less datetime as UTC", () => {
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
