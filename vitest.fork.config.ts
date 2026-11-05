import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// (FORK) upstream v3.17.1 retiró todos los App unit tests (docs/testing/unit-test-quality.md);
// esta config corre únicamente los tests que prueban features propios del fork, dejando
// vitest.config.ts y scripts/engineering-test-files.json 100% idénticos a upstream.
// Se corre con: vitest run -c vitest.fork.config.ts
const forkTestFiles = [
  "packages/desktop/test/desktopRuntimeEnv.test.ts",
  "packages/services/test/daemonChannel.test.ts",
  "packages/services/test/modelSelectionPair.test.ts",
  "packages/services/test/forkModelRetrySpawnEnv.test.ts",
  "packages/services/test/highspeedCardService.test.ts",
  "packages/services/test/manualClaimVerification.test.ts",
  "packages/services/test/manualClaimVerificationAvailable.test.ts",
  "packages/services/test/subagentLaunchAck.test.ts",
  "packages/services/test/subagentSessionRouting.test.ts",
  "packages/services/test/zcodeStdioTransport.test.ts",
  "packages/shared/test/appSettings.test.ts",
  "packages/shared/test/subagent-session.test.ts",
  "packages/shared/test/zcodeApiRetryStatus.test.ts",
  "packages/shared/test/zcodeSessionEventTolerance.test.ts",
  "packages/ui/test/chatApiRetryCountdown.test.ts",
  "packages/ui/test/conversationExpandDefaultStore.test.ts",
  "packages/ui/test/forkCommandModel.test.ts",
  "packages/ui/test/marketingClaimVerificationUnavailable.test.ts",
  "packages/ui/test/reasoningExpandDefault.test.ts",
  "packages/ui/test/toolLayoutDefaultOpen.test.ts",
  "packages/ui/test/useUiPluginRecommendations.test.ts",
  "packages/ui/test/v4ConversationStatusPanelGitReview.test.ts",
  "packages/ui/test/v4ConversationTurnRenderUnits.test.ts",
  "packages/ui/test/v4ToolBackgroundButton.test.ts",
];

export default defineConfig({
  // 与根配置一致：测试固定注入事件上报端点；真实构建由 scripts/build-time-config.mjs 决定。
  define: {
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    silent: "passed-only",
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    // UI 组件测试需要 DOM；services/shared 的纯逻辑测试保持 node 环境。
    environmentMatchGlobs: [["packages/ui/**", "jsdom"], ["packages/desktop/**", "jsdom"]],
    include: forkTestFiles,
  },
});
