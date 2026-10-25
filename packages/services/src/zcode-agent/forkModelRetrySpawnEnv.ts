/**
 * FORK (damian): 模型 API 重试退避的 fork 默认值（FORK.md「Ola 4」）。
 *
 * 背景（2026-10-25 实测）：api.z.ai 的 Anthropic SSE 端点出现持续 502，单次请求 10-33s
 * 后失败；上游默认退避 2s→60s × 10 次重试在 ~5 分钟内耗尽，长任务整个丢失。fork 选择
 * 拉长单次等待上限（指数曲线不变，cap 60s→15min）：等待 2s→4s→…→512s→900s，总计约
 * 32 分钟的恢复窗口，覆盖十几分钟的网关故障而不丢任务。重试次数与分类保持上游语义。
 *
 * 注入点：Host 的 agent spawn env（node.ts resolveSpawnEnv）。spawn env 在继承的
 * process.env 之后合入，会覆盖用户 shell 里显式导出的同名变量——因此这里只在
 * 继承 env 未定义该键时注入，用户显式配置永远优先。
 */

/** 单次重试等待上限（毫秒）：15 分钟。 */
export const FORK_MODEL_RETRY_MAX_DELAY_MS = "900000";

const FORK_MODEL_RETRY_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  // 上游读取处：apps/zcode-cli packages/adapters/src/model/retry-policy.ts（runner-retry 按
  // min(base*factor^n, maxDelayMs) 计算实际等待）。
  ZCODE_MODEL_RETRY_MAX_DELAY_MS: FORK_MODEL_RETRY_MAX_DELAY_MS,
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
