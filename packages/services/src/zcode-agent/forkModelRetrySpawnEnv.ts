/**
 * FORK (damian): 模型 API 重试退避的 fork 默认值（FORK.md「Ola 4/7」）。
 *
 * 背景（2026-10-25 实测）：api.z.ai 的 Anthropic SSE 端点出现持续 502，单次请求 10-33s
 * 后失败；上游默认退避 2s→60s × 10 次重试在 ~5 分钟内耗尽，长任务整个丢失。
 *
 * Ola 7（2026-10-25 深夜，Damian 选择）：**纯指数、无抖动**——每次等待是干净的
 * 2 的幂：2s→4s→8s→…→512s→1024s（17:04），10 次重试的恢复窗口合计 34:06。
 * 抖动会让等待落在 [0.5,1)× 区间，UI 倒计时读数永远不是 2 的幂，被判定为缺陷。
 * cap 设为 1024000 正好等于第 10 次的纯值（曲线全程不被截断）。
 *
 * 注入点：Host 的 agent spawn env（node.ts resolveSpawnEnv）。spawn env 在继承的
 * process.env 之后合入，会覆盖用户 shell 里显式导出的同名变量——因此这里只在
 * 继承 env 未定义该键时注入，用户显式配置永远优先。
 */

/** 单次重试等待上限（毫秒）：第 10 次重试的纯指数值 1024s。 */
export const FORK_MODEL_RETRY_MAX_DELAY_MS = "1024000";

const FORK_MODEL_RETRY_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  // 上游读取处：apps/zcode-cli packages/adapters/src/model/retry-policy.ts（runner-retry 按
  // min(base*factor^n, maxDelayMs) 计算实际等待）。
  ZCODE_MODEL_RETRY_MAX_DELAY_MS: FORK_MODEL_RETRY_MAX_DELAY_MS,
  // (FORK·Ola 7) 关闭抖动：读数必须是干净的 00:02/00:04/…/17:04。
  ZCODE_MODEL_RETRY_JITTER: "0",
};

/**
 * 只为「继承 env 中不存在」的键返回 fork 默认；存在（哪怕空串视为用户显式清除）则跳过。
 * 返回值并入 resolveSpawnEnv 的最终 env。
 */
export function buildForkModelRetrySpawnEnv(
  inheritedEnv: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(FORK_MODEL_RETRY_ENV_DEFAULTS)) {
    if (inheritedEnv[key] === undefined) {
      result[key] = value;
    }
  }
  return result;
}
