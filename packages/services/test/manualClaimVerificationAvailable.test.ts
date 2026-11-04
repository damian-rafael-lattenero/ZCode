/* [fork] 反证：验证能力可用时，3007 只是普通失败，不能标成 verification-unavailable。
 * 官方构建会替换 verification-policy 桩；这里把 requestVerificationInteractionAvailable
 * mock 成 true，锁住「原因只在能力缺失时出现」这一条件，防止以后无条件贴标签。
 */
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@zcode/shared";

vi.mock("@zcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/shared")>();
  return { ...actual, requestVerificationInteractionAvailable: true };
});

const { BigModelCodingPlanSubscriptionProvider } =
  await import("../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js");

describe("claimManualPlan · 3007 且验证能力可用", () => {
  it("仍尝试领取，但不产生 verification-unavailable 原因", async () => {
    let requestCount = 0;
    const apiClient: ApiClient = {
      request: async () => {
        requestCount += 1;
        return new Response(JSON.stringify({ code: 3007, msg: "verification required" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: async () => "jwt-token" },
    });

    const result = await provider.claimManualPlan({ planId: "global-build" });

    expect(requestCount).toBe(1);
    expect(result.success).toBe(false);
    expect(result.code).toBe(3007);
    expect(result.reason).toBeUndefined();
  });
});
