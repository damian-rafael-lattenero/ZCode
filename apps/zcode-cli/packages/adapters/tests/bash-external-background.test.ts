// BT（2026-11-05）：requestBackgroundByToolCallId —— 用户（v4 backgroundToolCall）把
// 仍在跑的前台 Bash 原子移交后台。验证：foreground 命中 → outcome 以
// {kind:"backgrounded", requestedBy:"user"} 提前 resolve、parent abort 从此脱离（进程不动）；
// 终态后 / 未知 toolCallId → undefined；manual 模式从不自动转后台、超时仍由 run 内部 kill。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRequest } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";

const shell =
  process.platform === "win32"
    ? {
        dialect: "cmd" as const,
        path: process.env.ComSpec ?? "cmd.exe",
        display: { name: "CMD" },
        source: "user-config" as const,
      }
    : { dialect: "posix" as const, path: "/bin/bash", display: { name: "Bash" }, source: "user-config" as const };

/** release 文件门控的慢命令：写 ready 后轮询 PROBE_RELEASE，release 前一直存活。 */
async function gatedFixture() {
  const root = await mkdtemp(join(tmpdir(), "bash-ext-bg-"));
  const script = join(root, "command.cjs");
  const release = join(root, "release");
  await writeFile(
    script,
    `const fs = require('node:fs/promises');
process.stdout.write('ready\\n');
const timer = setInterval(async () => {
  try { await fs.access(process.env.PROBE_RELEASE); clearInterval(timer); }
  catch {}
}, 10);`,
  );
  const adapter = new NodeExecutionAdapter({ outputRootDir: root });
  const request: ExecutionRequest = {
    command: {
      mode: "shell",
      shellProfile: "posix-bash",
      shellOverride: shell,
      command: `"${process.execPath}" "${script}"`,
    },
    env: { set: { PROBE_RELEASE: release } },
    cwd: root,
    timeoutMs: 0,
    trace: { traceId: "trace-1", attributes: { toolCallId: "call-1" } },
  };
  return {
    adapter,
    request,
    release: () => writeFile(release, "done"),
    async close() {
      await writeFile(release, "done");
      await adapter.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

/** 自退出的前台命令：normal exit，验证 foreground settle 后移交入口释放。 */
async function quickFixture(command: string) {
  const root = await mkdtemp(join(tmpdir(), "bash-ext-bg-quick-"));
  const adapter = new NodeExecutionAdapter({ outputRootDir: root });
  const request: ExecutionRequest = {
    command: { mode: "shell", shellProfile: "posix-bash", shellOverride: shell, command },
    cwd: root,
    timeoutMs: 0,
    trace: { traceId: "trace-1", attributes: { toolCallId: "call-1" } },
  };
  return {
    adapter,
    request,
    async close() {
      await adapter.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

async function waitForExternalCommit(
  adapter: NodeExecutionAdapter,
  toolCallId: string,
): Promise<string | undefined> {
  for (let i = 0; i < 200; i += 1) {
    const workId = adapter.requestBackgroundByToolCallId(toolCallId);
    if (workId !== undefined) return workId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

describe("requestBackgroundByToolCallId（BT 外部移交）", () => {
  it("foreground 命中：outcome 以 requestedBy:user 提前 resolve，parent abort 不再波及进程", async () => {
    const fixture = await gatedFixture();
    const controller = new AbortController();
    try {
      const pending = fixture.adapter.runBashWithBackgroundLifecycle(fixture.request, { mode: "manual" }, {
        signal: controller.signal,
      });
      const workId = await waitForExternalCommit(fixture.adapter, "call-1");
      expect(workId).toBeDefined();

      // 移交后立刻断 parent abort：进程信号不受影响，输出仍能走完。
      controller.abort();

      const outcome = await pending;
      expect(outcome.kind).toBe("backgrounded");
      if (outcome.kind !== "backgrounded") throw new Error("expected backgrounded outcome");
      expect(outcome.requestedBy).toBe("user");
      expect(outcome.task.taskId).toBe(workId);

      await fixture.release();
      const done = await fixture.adapter.waitForBackgroundTask(outcome.task.taskId);
      expect(done?.status).toBe("completed");
      expect(done?.result?.stdout.text).toContain("ready");
    } finally {
      await fixture.close();
    }
  });

  it("终态后触发与未知 toolCallId 返回 undefined，不抛错", async () => {
    const fixture = await quickFixture(`"${process.execPath}" -e "process.stdout.write('done\\n')"`);
    try {
      expect(fixture.adapter.requestBackgroundByToolCallId("call-unknown")).toBeUndefined();

      // 前台自然收口后，移交入口随 settle 释放。
      const outcome = await fixture.adapter.runBashWithBackgroundLifecycle(fixture.request, {
        mode: "manual",
      });
      expect(outcome.kind).toBe("foreground");
      expect(fixture.adapter.requestBackgroundByToolCallId("call-1")).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("manual 模式从不自动转后台：前台正常完成语义与裸 run 一致", async () => {
    const fixture = await quickFixture(`"${process.execPath}" -e "process.stdout.write('ready\\n')"`);
    try {
      const outcome = await fixture.adapter.runBashWithBackgroundLifecycle(
        { ...fixture.request, timeoutMs: 30_000 },
        { mode: "manual" },
      );
      expect(outcome.kind).toBe("foreground");
      if (outcome.kind !== "foreground") throw new Error("expected foreground outcome");
      expect(outcome.result.exitCode).toBe(0);
      expect(outcome.result.stdout.text).toContain("ready");
      expect(fixture.adapter.requestBackgroundByToolCallId("call-1")).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("manual 模式超时仍由 run 内部 kill：返回 timed_out 而不是转后台", async () => {
    const fixture = await gatedFixture();
    try {
      const outcome = await fixture.adapter.runBashWithBackgroundLifecycle(
        { ...fixture.request, timeoutMs: 100 },
        { mode: "manual" },
      );
      expect(outcome.kind).toBe("foreground");
      if (outcome.kind !== "foreground") throw new Error("expected foreground outcome");
      expect(outcome.result.status).toBe("timed_out");
      expect(outcome.result.timedOut).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
