/* [fork] Claim 3007 + 桩版验证能力：诚实翻译服务端的验证要求。
 * 本构建的 requestVerificationInteractionAvailable 恒为 false（安全版桩），
 * 服务端对需要验证的领取回 3007。服务的契约：
 *  - 绝不本地提前拒绝领取，POST 必须照常发出（未来活动可能不需要验证）；
 *  - 服务端要验证且本构建做不到时，把窄原因 "verification-unavailable" 交给边界；
 *  - 成功路径与其它错误码不受影响。
 */
import { describe, expect, it } from "vitest";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import { BigModelCodingPlanSubscriptionProvider } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";

interface RecordedRequest {
  input: string | URL;
  init?: ApiRequestInit;
}

function createProvider(payload: unknown) {
  const calls: RecordedRequest[] = [];
  const apiClient: ApiClient = {
    request: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const provider = new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: { load: async () => "jwt-token" },
  });
  return { calls, provider };
}

describe("claimManualPlan · 3007 且本构建无验证能力", () => {
  it("POST 照常发出（不本地拒绝），失败结果带窄原因", async () => {
    const { calls, provider } = createProvider({
      code: 3007,
      msg: "verification required",
      data: { message: "captcha required" },
    });

    const result = await provider.claimManualPlan({ planId: "global-build" });

    // 关键不变量：请求确实发了；服务端才是裁决者，本地不提前拒绝。
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toContain("/api/v1/zcode-plan/billing/claim");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ plan_id: "global-build" });

    expect(result.success).toBe(false);
    expect(result.code).toBe(3007);
    expect(result.reason).toBe("verification-unavailable");
    expect(result.message).toBe("captcha required");
  });

  it("code 0 + data.plan 仍是成功，且不带原因", async () => {
    const { provider } = createProvider({
      code: 0,
      msg: "ok",
      data: {
        server_time: 1_700_000_000_000,
        plan: {
          user_plan_id: "user-plan-1",
          plan_id: "global-build",
          status: "active",
          starts_at: 1,
          ends_at: 2,
          entitlements: [{ entitlement_id: "ent-1", show_name: "GLM", effective_at: 0 }],
        },
      },
    });

    const result = await provider.claimManualPlan({ planId: "global-build" });

    expect(result.success).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.plan?.userPlanId).toBe("user-plan-1");
    expect(result.plan?.entitlements).toEqual([
      { entitlementId: "ent-1", showName: "GLM", effectiveAt: 0 },
    ]);
  });

  it("非 3007 的失败不带验证原因", async () => {
    const { provider } = createProvider({ code: 1003, msg: "already claimed", data: {} });

    const result = await provider.claimManualPlan({ planId: "global-build" });

    expect(result.success).toBe(false);
    expect(result.code).toBe(1003);
    expect(result.reason).toBeUndefined();
  });
});
