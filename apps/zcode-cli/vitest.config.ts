import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
    ],
    // (FORK) 剥离 fork 注入 agent spawn env 的泄漏（详见文件头注释）：
    // 在 fork 自己 spawn 的 agent 里跑 vitest 时，ZCODE_MODEL_RETRY_* 会改变被测行为。
    setupFiles: ["test/setup/fork-hermetic-env.ts"],
  },
});
