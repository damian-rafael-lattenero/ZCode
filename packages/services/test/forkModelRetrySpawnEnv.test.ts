import { describe, expect, it } from "vitest";
import {
  buildForkModelRetrySpawnEnv,
  FORK_MODEL_RETRY_MAX_DELAY_MS,
} from "../src/zcode-agent/forkModelRetrySpawnEnv.js";

describe("buildForkModelRetrySpawnEnv（FORK：模型重试退避默认，spec：FORK.md Ola 4）", () => {
  it("继承 env 未定义时注入 15min 上限", () => {
    expect(buildForkModelRetrySpawnEnv({})).toEqual({
      ZCODE_MODEL_RETRY_MAX_DELAY_MS: FORK_MODEL_RETRY_MAX_DELAY_MS,
    });
    expect(FORK_MODEL_RETRY_MAX_DELAY_MS).toBe("900000");
  });

  it("用户显式导出的同名变量优先：不覆盖已有值（含空串=显式清除）", () => {
    expect(buildForkModelRetrySpawnEnv({ ZCODE_MODEL_RETRY_MAX_DELAY_MS: "60000" })).toEqual({});
    expect(buildForkModelRetrySpawnEnv({ ZCODE_MODEL_RETRY_MAX_DELAY_MS: "" })).toEqual({});
  });

  it("不相关的继承变量不影响注入", () => {
    expect(
      buildForkModelRetrySpawnEnv({ ZCODE_MODEL_RETRY_MAX_RETRIES: "3", PATH: "/bin" }),
    ).toEqual({ ZCODE_MODEL_RETRY_MAX_DELAY_MS: FORK_MODEL_RETRY_MAX_DELAY_MS });
  });
});
