import { describe, expect, it } from "vitest";
import {
  buildForkModelRetrySpawnEnv,
  FORK_MODEL_RETRY_MAX_DELAY_MS,
} from "../src/zcode-agent/forkModelRetrySpawnEnv.js";

describe("buildForkModelRetrySpawnEnv（FORK：模型重试退避默认，spec：FORK.md Ola 4/7）", () => {
  it("继承 env 未定义时注入纯指数 cap（第 10 次 = 1024s）与关抖动", () => {
    expect(buildForkModelRetrySpawnEnv({})).toEqual({
      ZCODE_MODEL_RETRY_MAX_DELAY_MS: FORK_MODEL_RETRY_MAX_DELAY_MS,
      ZCODE_MODEL_RETRY_JITTER: "0",
    });
    expect(FORK_MODEL_RETRY_MAX_DELAY_MS).toBe("1024000");
  });

  it("用户显式导出的同名变量优先：不覆盖已有值（含空串=显式清除）", () => {
    expect(buildForkModelRetrySpawnEnv({ ZCODE_MODEL_RETRY_MAX_DELAY_MS: "60000" })).toEqual({
      ZCODE_MODEL_RETRY_JITTER: "0",
    });
    expect(buildForkModelRetrySpawnEnv({ ZCODE_MODEL_RETRY_MAX_DELAY_MS: "" })).toEqual({
      ZCODE_MODEL_RETRY_JITTER: "0",
    });
    expect(buildForkModelRetrySpawnEnv({ ZCODE_MODEL_RETRY_JITTER: "1" })).toEqual({
      ZCODE_MODEL_RETRY_MAX_DELAY_MS: FORK_MODEL_RETRY_MAX_DELAY_MS,
    });
  });

  it("不相关的继承变量不影响注入", () => {
    expect(
      buildForkModelRetrySpawnEnv({ ZCODE_MODEL_RETRY_MAX_RETRIES: "3", PATH: "/bin" }),
    ).toEqual({
      ZCODE_MODEL_RETRY_MAX_DELAY_MS: FORK_MODEL_RETRY_MAX_DELAY_MS,
      ZCODE_MODEL_RETRY_JITTER: "0",
    });
  });
});
