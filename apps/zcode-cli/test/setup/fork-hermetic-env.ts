/**
 * (FORK) 测试环境的 env 密封。
 *
 * fork 给 agent spawn 注入 ZCODE_MODEL_RETRY_* / ZCODE_DYNAMIC_WORKFLOW_MODE
 * （forkModelRetrySpawnEnv / desktopRuntimeEnv）。当测试跑在 fork 自己 spawn 的
 * agent 里（bot headless、桌面 app 内的会话）时，这些变量会随进程环境漏进
 * vitest，改变被测行为：实测 2026-10-25~28，runner.test.ts 的「one-minute cap」
 * 期望 60000 却拿到 64000——cap 被 spawn 注入的 1024000 顶掉，曾被误判为
 * upstream baseline 失败。upstream CI 没有这些变量，同一测试是绿的。
 *
 * 测试要覆盖 env 行为时应显式传 env 对象（如 `env: { ZCODE_MODEL_RETRY_JITTER: "0" }`），
 * 不依赖进程环境；这里删除的只是 fork 的注入泄漏。
 */
for (const key of [
  "ZCODE_MODEL_RETRY_MAX_RETRIES",
  "ZCODE_MODEL_RETRY_BASE_DELAY_MS",
  "ZCODE_MODEL_RETRY_BACKOFF_FACTOR",
  "ZCODE_MODEL_RETRY_MAX_DELAY_MS",
  "ZCODE_MODEL_RETRY_JITTER",
  "ZCODE_DYNAMIC_WORKFLOW_MODE",
]) {
  delete process.env[key];
}
