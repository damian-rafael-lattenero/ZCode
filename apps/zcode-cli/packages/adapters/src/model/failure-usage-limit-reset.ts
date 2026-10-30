/**
 * (FORK) z.ai 用量窗口限制的“等到重置再试”。
 *
 * 官方文档（docs.z.ai/api-reference/api-code）：1308/1310/1316-1321 是用量窗口限制，
 * body/message 携带 next_flush_time（重置时刻）。upstream 把整族标成不可重试的终态；
 * 但拿得到确定性的重置时刻时，等待到点重试比直接杀死长任务更符合 fork 的恢复哲学
 * （见 FORK.md Ola 4/4b）。解析失败则保持终态——没有确定性等待时间就不盲等。
 *
 * 等待本身不一次睡满：runner 以 ≤USAGE_LIMIT_RESET_SEGMENT_MS 的分段 sleep + 重新发请求
 * 探测（配额回补即恢复）；裸 datetime（无时区）不可信，只给保守短等待（时区守卫）。
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
/**
 * (FORK) 裸 datetime（无时区偏移）不可信：z.ai 可能发的是北京时间本地字面量，按 UTC
 * 解析会晚 8 小时（钳在 24h 内）。不信它——只排一个短等待，醒来重新发请求自校正
 * （runner 的分段探测循环，见 USAGE_LIMIT_RESET_SEGMENT_MS）。
 */
export const USAGE_LIMIT_RESET_UNTRUSTED_WAIT_MS = 5 * 60_000;
/**
 * (FORK) 用量重置等待的分段上限：单次 sleep 不超过 5 分钟，睡完一段就重新发出请求。
 * 配额一旦回补，下一次探测立即成功（最坏 ~5 分钟感知恢复），而不是一次性睡满
 * next_flush_time 后才算数。分段是引擎内部机制：model_retry_scheduled 仍按完整等待
 * 发布（nextAttemptAtMs = 真实 flush 点），UI 倒计时保持诚实。
 */
export const USAGE_LIMIT_RESET_SEGMENT_MS = 5 * 60_000;

/** ISO-8601 形态（T 或空格分隔、秒可选、时区可选）。文档模板把时间插值进 message 文案。 */
const ISO_LIKE_DATETIME_PATTERN =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/;

const FLUSH_TIME_FIELD_NAMES = ["next_flush_time", "nextFlushTime"] as const;

/**
 * (FORK) 解析出的重置时刻及其可信度。
 * - `offsetExplicit=false`：裸 datetime（无 Z/±hh:mm）——真实时刻未知（可能差 8h）。
 * - `raw`：解析来源的原始字符串（message 里截取的片段或字段原值），随 retry 决策日志
 *   落盘，用于生产排查 z.ai 实际下发的时间形态。
 */
export interface UsageLimitResetTime {
  atMs: number;
  offsetExplicit: boolean;
  raw: string;
}

/** 解析 next_flush_time。只做解析，不做时钟相关的钳制。 */
export function parseUsageLimitResetTime(input: {
  summary?: Record<string, unknown> | undefined;
  providerMessage?: string | undefined;
  message?: string | undefined;
}): UsageLimitResetTime | undefined {
  const fromSummary = readFlushTimeFromSummary(input.summary);
  if (fromSummary !== undefined) {
    return fromSummary;
  }
  const text = input.providerMessage ?? input.message;
  if (text === undefined) {
    return undefined;
  }
  const match = text.match(ISO_LIKE_DATETIME_PATTERN);
  if (match === null) {
    return undefined;
  }
  const parsed = parseIsoLikeDateTimeToMs(match[0]);
  if (parsed === undefined) {
    return undefined;
  }
  return { atMs: parsed, offsetExplicit: ISO_LIKE_OFFSET_PATTERN.test(match[0]), raw: match[0] };
}

/** 兼容入口：只取解析出的时刻（裸 datetime 仍按 UTC 假设换算 epoch）。 */
export function parseNextFlushTimeAtMs(input: {
  summary?: Record<string, unknown> | undefined;
  providerMessage?: string | undefined;
  message?: string | undefined;
}): number | undefined {
  return parseUsageLimitResetTime(input)?.atMs;
}

/** 把解析出的重置时刻换算成本次等待时长（含钳制与时区守卫）。 */
export interface UsageLimitResetWait {
  waitMs: number;
  /** false → 裸本地时间：真实重置点未知，waitMs 只是保守探测间隔。 */
  offsetExplicit: boolean;
  /** 解析来源的原始字符串（进 retry 决策日志）。 */
  rawTime?: string;
}

export function resolveUsageLimitResetWait(
  input: {
    summary?: Record<string, unknown> | undefined;
    providerMessage?: string | undefined;
    message?: string | undefined;
  },
  nowMs: number,
): UsageLimitResetWait | undefined {
  const parsed = parseUsageLimitResetTime(input);
  if (parsed === undefined) {
    return undefined;
  }
  if (!parsed.offsetExplicit) {
    return {
      waitMs: USAGE_LIMIT_RESET_UNTRUSTED_WAIT_MS,
      offsetExplicit: false,
      rawTime: parsed.raw,
    };
  }
  const waitMs = resolveUsageLimitResetWaitMs(parsed.atMs, nowMs);
  return waitMs === undefined
    ? undefined
    : { waitMs, offsetExplicit: true, rawTime: parsed.raw };
}

/** 显式时区（含 unix 数值时间戳）时的等待换算（含钳制）。 */
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
): UsageLimitResetTime | undefined {
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
function parseScalarTimestamp(value: unknown): UsageLimitResetTime | undefined {
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
  const parsed = parseIsoLikeDateTimeToMs(trimmed);
  if (parsed === undefined) {
    return undefined;
  }
  // 字段里的 ISO 字符串同样可能是裸本地时间——与 message 插值路径同一守卫。
  return { atMs: parsed, offsetExplicit: ISO_LIKE_OFFSET_PATTERN.test(trimmed), raw: trimmed };
}

function unixLikeNumberToMs(value: number): UsageLimitResetTime | undefined {
  // 1e11 ≈ 5138 年（秒级上限）；更大的按毫秒理解。负值/荒谬值交给调用侧钳制。
  if (value <= 0 || !Number.isFinite(value)) {
    return undefined;
  }
  // unix 时间戳是绝对时刻，没有时区歧义。
  const atMs = value <= 1e11 ? value * 1000 : value;
  return { atMs, offsetExplicit: true, raw: String(value) };
}

const ISO_LIKE_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

function parseIsoLikeDateTimeToMs(value: string): number | undefined {
  const normalized = value.includes("T")
    ? value
    : `${value.slice(0, 10)}T${value.slice(11)}`;
  // 无时区时按 UTC 理解（换算 epoch）；是否可信由调用侧的 offsetExplicit 判定。
  const withTimezone = ISO_LIKE_OFFSET_PATTERN.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const parsed = Date.parse(withTimezone);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
