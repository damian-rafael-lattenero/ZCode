/**
 * (FORK) z.ai 用量窗口限制的“等到重置再试”。
 *
 * 官方文档（docs.z.ai/api-reference/api-code）：1308/1310/1316-1321 是用量窗口限制，
 * body/message 携带 next_flush_time（重置时刻）。upstream 把整族标成不可重试的终态；
 * 但拿得到确定性的重置时刻时，等待到点重试比直接杀死长任务更符合 fork 的恢复哲学
 * （见 FORK.md Ola 4/4b）。解析失败则保持终态——没有确定性等待时间就不盲等。
 */

export const USAGE_LIMIT_RESET_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "1308",
  "1310",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
]);

/** 文档标注的最大窗口是 24h；超出按上限等待（到点后 provider 会给新的 flush 时间）。 */
export const MAX_USAGE_LIMIT_RESET_WAIT_MS = 24 * 3_600_000;
/**
 * reset 时刻已过期（时钟/时区偏差或滚动窗口）：短退避重新采样，而不是 0ms 热循环。
 * 每次重试消耗一个 attempt（maxAttempts 含首次），有界预算兜底。
 */
export const USAGE_LIMIT_RESET_PAST_FLOOR_MS = 120_000;

/** ISO-8601 形态（T 或空格分隔、秒可选、时区可选）。文档模板把时间插值进 message 文案。 */
const ISO_LIKE_DATETIME_PATTERN =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/;

const FLUSH_TIME_FIELD_NAMES = ["next_flush_time", "nextFlushTime"] as const;

/** 解析 next_flush_time 为 epoch ms。只做解析，不做时钟相关的钳制。 */
export function parseNextFlushTimeAtMs(input: {
  summary?: Record<string, unknown> | undefined;
  providerMessage?: string | undefined;
  message?: string | undefined;
}): number | undefined {
  const fromSummary = readFlushTimeFromSummary(input.summary);
  if (fromSummary !== undefined) {
    return fromSummary;
  }
  const text = input.providerMessage ?? input.message;
  if (text === undefined) {
    return undefined;
  }
  const match = text.match(ISO_LIKE_DATETIME_PATTERN);
  return match === null ? undefined : parseIsoLikeDateTimeToMs(match[0]);
}

/** 把解析出的重置时刻换算成本次等待时长（含钳制）。 */
export function resolveUsageLimitResetWaitMs(
  resetAtMs: number | undefined,
  nowMs: number,
): number | undefined {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
    return undefined;
  }
  const rawWaitMs = resetAtMs - nowMs;
  if (rawWaitMs >= MAX_USAGE_LIMIT_RESET_WAIT_MS) {
    return MAX_USAGE_LIMIT_RESET_WAIT_MS;
  }
  if (rawWaitMs < USAGE_LIMIT_RESET_PAST_FLOOR_MS) {
    return USAGE_LIMIT_RESET_PAST_FLOOR_MS;
  }
  return rawWaitMs;
}

function readFlushTimeFromSummary(
  summary: Record<string, unknown> | undefined,
): number | undefined {
  if (summary === undefined) {
    return undefined;
  }
  const nestedError =
    typeof summary.error === "object" && summary.error !== null
      ? (summary.error as Record<string, unknown>)
      : undefined;
  for (const source of [summary, nestedError]) {
    if (source === undefined) {
      continue;
    }
    for (const field of FLUSH_TIME_FIELD_NAMES) {
      const parsed = parseScalarTimestamp(source[field]);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}

/** 字段值可能是 ISO 字符串，也可能是 unix 秒/毫秒数字（或数字字符串）。 */
function parseScalarTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return unixLikeNumberToMs(value);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return unixLikeNumberToMs(Number(trimmed));
  }
  return parseIsoLikeDateTimeToMs(trimmed);
}

function unixLikeNumberToMs(value: number): number | undefined {
  // 1e11 ≈ 5138 年（秒级上限）；更大的按毫秒理解。负值/荒谬值交给调用侧钳制。
  if (value <= 0 || !Number.isFinite(value)) {
    return undefined;
  }
  return value <= 1e11 ? value * 1000 : value;
}

function parseIsoLikeDateTimeToMs(value: string): number | undefined {
  const normalized = value.includes("T")
    ? value
    : `${value.slice(0, 10)}T${value.slice(11)}`;
  // 无时区时按 UTC 理解（服务端时间戳）；偏差最坏是多试一次并拿到新的 flush 时间。
  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const parsed = Date.parse(withTimezone);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
