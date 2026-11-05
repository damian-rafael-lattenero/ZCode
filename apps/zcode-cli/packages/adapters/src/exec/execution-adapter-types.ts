import type { SpawnOptions } from "node:child_process";
import type { BashFileOutput } from "./bash-file-output.js";
import type { ZCodeToolExecResource } from "@zcode/shared";
import type { NetworkEgressEnvPolicy } from "../network/subprocess-env.js";
import type { ResolvedSpawnCommand } from "./execution-command.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
} from "@zcode/contracts";

export interface ExitState {
  code?: number;
  signal?: string;
  error?: Error;
}

export interface BackgroundTaskRecord extends BackgroundExecutionSnapshot {
  sessionId?: string;
  isBash: boolean;
  legacyOutputEncoding: string | null;
  completion: Promise<BackgroundExecutionSnapshot>;
  controller: AbortController;
  externalAbort?: () => void;
  resolveCompletion: (snapshot: BackgroundExecutionSnapshot) => void;
}

export interface ExecutionOutputPaths {
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
}

export interface InternalExecutionRunOptions extends ExecutionRunOptions {
  preparedBashOutput?: PreparedBashOutput;
  onOutputEncodingResolved?: (encoding: string | null) => void;
  /** Bash 移交时停止前台预览并重启文件 watchdog；不复制进程或输出。 */
  bashLifecycle?: {
    isBackgrounded: () => boolean;
    onBackgrounded?: () => void;
    onExit?: () => void;
  };
  onPersistedLimit?: () => void;
  sharePersistedOutputLimitAcrossStreams?: boolean;
  shouldStopOnPersistedLimit?: () => boolean;
  shouldRetainExecutionAfterRootExit?: () => boolean;
}

export interface PreparedBashOutput {
  file: BashFileOutput;
  legacyOutputEncoding: string | null;
  /** 准备与执行交接期间仍由 close() 等待，执行接管后释放准备记录。 */
  releasePreparation: () => void;
}

/**
 * "manual"（2026-11-05 BT 分组）：普通前台 Bash 也走 lifecycle，前台语义与裸 run 逐字一致
 * （timeout 仍由 run 内部 kill、无 auto-background deadline），唯一新增能力是外部触发
 * requestBackgroundByToolCallId 可把仍在跑的前台命令原子移交后台。
 */
export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout" | "manual";

export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
      /** 仅外部（用户 backgroundToolCall）触发时置位：handler 据此改写合成输出文案。 */
      requestedBy?: "user";
    };

export interface PreparedChildSpawn {
  command: ResolvedSpawnCommand;
  cwdDialect: ExecutionShellDialect;
  cwdFilePath?: string;
  spawnOptions: SpawnOptions;
}

export interface ActiveExecutionRecord {
  completion: Promise<void>;
  resolveCompletion: () => void;
  stop: (reason: StopReason) => void;
}

export interface NodeExecutionAdapterOptions {
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  outputRootDir?: string;
  /** 仅 Bash 输出优先使用的临时父目录；不可用时复用 outputRootDir。 */
  bashOutputTempDir?: string;
  maxPersistedOutputBytes?: number;
  network?: NetworkEgressEnvPolicy;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  progressIntervalMs?: number;
  progressTailBytes?: number;
  progressThresholdMs?: number;
}

export type OutputPersistenceMode = "none" | "on_truncate" | "always";

export type StopReason = "timeout" | "cancelled" | "output_limit";
