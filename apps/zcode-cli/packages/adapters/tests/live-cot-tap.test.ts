import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLiveCotSidecar, createLiveCotTap } from "../src/model/runner-debug.js";

// FORK CHANGE (damian): tests for the live-CoT sidecar tap.
// The tap throttles itself with Date.now(), so each case fixes the clock
// and advances it explicitly between feeds.
describe("live cot sidecar tap", () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    dir = mkdtempSync(join(tmpdir(), "zcode-live-cot-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const metadata = { sessionId: "sess_live_1", querySource: "main_turn", turnId: "t1" };
  const sidecar = () => join(dir, "live-io-sess_live_1.jsonl");

  function feed(lines: string[], advanceMs = 0) {
    const tap = createLiveCotTap({
      attempt: 1,
      debugDir: dir,
      isDev: false,
      metadata,
      recordModelIO: true,
      requestId: "req-1",
      startedAt: Date.now(),
    });
    for (const text of lines) {
      tap({ type: "reasoning_delta", text });
      if (advanceMs) {
        vi.setSystemTime(new Date(Date.now() + advanceMs));
      }
    }
  }

  function records() {
    return readFileSync(sidecar(), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("flushes the first partial at once and then one per throttle window", () => {
    const tap = createLiveCotTap({
      attempt: 1,
      debugDir: dir,
      isDev: false,
      metadata,
      recordModelIO: true,
      requestId: "req-1",
      startedAt: Date.now(),
    });
    tap({ type: "reasoning_delta", text: "a".repeat(100) });
    expect(records()).toHaveLength(1); // the first lands at once
    tap({ type: "reasoning_delta", text: "b".repeat(100) });
    tap({ type: "reasoning_delta", text: "c".repeat(100) });
    expect(records()).toHaveLength(1); // same ms window: throttled
    vi.setSystemTime(new Date(Date.now() + 1500));
    tap({ type: "reasoning_delta", text: "d".repeat(100) });
    expect(records()).toHaveLength(2);
    const last = records()[1];
    expect(last).toMatchObject({
      type: "live_io_partial",
      sessionId: "sess_live_1",
      querySource: "main_turn",
      attempt: 1,
    });
    expect(last.reasoningChars).toBe(400);
    expect(last.reasoningTail).toBe(
      "a".repeat(100) + "b".repeat(100) + "c".repeat(100) + "d".repeat(100),
    );
  });

  it("caps the reasoning tail and mixes text deltas", () => {
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    const tap = createLiveCotTap({
      attempt: 2,
      debugDir: dir,
      isDev: false,
      metadata,
      recordModelIO: true,
      requestId: "req-2",
      startedAt: Date.now(),
    });
    tap({ type: "reasoning_delta", text: "r".repeat(5000) });
    vi.setSystemTime(new Date(Date.now() + 2000));
    tap({ type: "text_delta", text: "t".repeat(500) });
    const [first, second] = records();
    expect(String(first.reasoningTail)).toHaveLength(3000);
    expect(String(first.reasoningTail)).toBe("r".repeat(3000));
    expect(second.textChars).toBe(500);
    expect(String(second.textTail)).toBe("t".repeat(500));
    expect(second.reasoningChars).toBe(5000);
  });

  it("rewrites the sidecar per request (one request per file)", () => {
    feed(["first"]);
    expect(records()).toHaveLength(1);
    feed(["second"]);
    expect(records()).toHaveLength(1); // truncated by the new request
    expect(String(records()[0].reasoningTail)).toBe("second");
  });

  it("ignores non-delta events and stays silent without a session", () => {
    feed(["x"]);
    const tap = createLiveCotTap({
      attempt: 1,
      debugDir: dir,
      isDev: false,
      metadata: { querySource: "main_turn" },
      recordModelIO: true,
      requestId: "r",
      startedAt: Date.now(),
    });
    tap({ type: "tool_call" });
    expect(existsSync(join(dir, "live-io-.jsonl"))).toBe(false);
  });

  it("keeps the tail a true suffix of the whole reasoning across windows", () => {
    // FORK CHANGE (damian): the bot's F75 cajitas RECONSTRUCT the text
    // from the tail window (reasoningTail of reasoningChars) — across
    // throttle windows and past the cap the tail must remain a strict
    // SUFFIX of everything generated so far, and updatedAt must track
    // the clock (the bot freshness-gates the file on it).
    const tap = createLiveCotTap({
      attempt: 1,
      debugDir: dir,
      isDev: false,
      metadata,
      recordModelIO: true,
      requestId: "req-suffix",
      startedAt: Date.now(),
    });
    const whole: string[] = [];
    for (let i = 0; i < 6; i++) {
      const chunk = String.fromCharCode(97 + i).repeat(1000);
      whole.push(chunk);
      tap({ type: "reasoning_delta", text: chunk });
      vi.setSystemTime(new Date(Date.now() + 1500));
      const last = records().at(-1)!;
      const full = whole.join("");
      expect(last.reasoningChars).toBe(full.length);
      expect(String(last.reasoningTail)).toBe(full.slice(-3000));
      expect(typeof last.updatedAt).toBe("string");
    }
  });

  it("[fork] F81b counts tool-call argument streaming (the composing edit's growing lines)", () => {
    const tap = createLiveCotTap({
      attempt: 1,
      debugDir: dir,
      isDev: false,
      metadata,
      recordModelIO: true,
      requestId: "req-1",
      startedAt: Date.now(),
    });
    tap({ type: "tool_input_start", toolName: "Edit" } as never);
    for (const chunk of ["line-1\n", "line-2\n", "line-3\n"]) {
      tap({ type: "tool_input_delta", delta: chunk } as never);
      vi.setSystemTime(new Date(Date.now() + 1100));
    }
    const last = records().at(-1)!;
    expect(last.toolName).toBe("Edit");
    expect(last.toolChars).toBe(21); // 3 chunks of "line-N\n" = 7 chars each
    expect(String(last.toolTail).split("\n").length).toBeGreaterThanOrEqual(3);
    // a second composition resets the counter: THIS edit, not the sum
    tap({ type: "tool_input_start", toolName: "Write" } as never);
    tap({ type: "tool_input_delta", delta: "x" } as never);
    vi.setSystemTime(new Date(Date.now() + 1100));
    const after = records().at(-1)!;
    expect(after.toolName).toBe("Write");
    expect(after.toolChars).toBe(1);
  });

  it("clearLiveCotSidecar removes the sidecar after the full record", () => {
    feed(["hello"]);
    expect(existsSync(sidecar())).toBe(true);
    clearLiveCotSidecar({ debugDir: dir, isDev: false, metadata });
    expect(existsSync(sidecar())).toBe(false);
  });
});
