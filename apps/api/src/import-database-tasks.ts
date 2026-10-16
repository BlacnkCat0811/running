import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildAudit, type DataAudit } from "@rai/health-export-parser";
import type { DataOnlyImportResult } from "./data-only-import.js";
import type { DirectSyncImportResult, DirectSyncRejection } from "./direct-sync-ingest.js";

/**
 * 两条导入车道在**同一个任务 Worker** 内的尝试顺序（WP-41 / O12 第一阶段）。
 *
 * 运行期的顺序判据在 `import-worker.ts` 的 `IMPORT_LANE_ATTEMPTS`（主线程按它下发、
 * worker 按它执行，并**拒绝**任何别的顺序）。这里提供类型与取值校验。
 *
 * 🔴 为什么顺序是数据而不是 worker 里的语句序：`data-only` 的入口判据（记录白名单 +
 * 基线合同戳）比统一接收器**更严**，它必须先跑 —— 反过来那两道闸门就失去意义。
 * 把它变成一份显式的、主线程与 worker 双向校验的清单，是为了让"顺序被改动"
 * 在**两侧**都留下痕迹，而不是只存在于某个函数体的语句顺序里。
 */
export const IMPORT_LANE_ATTEMPTS = ["data-only", "direct-sync"] as const;
export type ImportLaneAttempt = (typeof IMPORT_LANE_ATTEMPTS)[number];

export function isImportLaneAttempt(value: unknown): value is ImportLaneAttempt {
  return (IMPORT_LANE_ATTEMPTS as readonly unknown[]).includes(value);
}

/**
 * `import-lanes` 任务的输入：一次准入的预检结果加上不可变的载荷身份。
 *
 * `payloadSha256` 是主线程在准入时算出的载荷身份；两条车道各自拿它复核自己真正要写的
 * 那份内容（`data-only-import.ts:120` / `direct-sync-ingest.ts:483`）。
 * ⛔ 不用 mtime／文件大小等"零成本"判据替代它：上传目录的不可变性没有被证明。
 */
export interface ImportLanesInput {
  databasePath: string;
  inputPath: string;
  jobId: string;
  payloadSha256: string;
  startedAtMs: number;
  /** 主线程下发的尝试顺序；worker 侧**校验**它等于 {@link IMPORT_LANE_ATTEMPTS}，否则拒绝执行。 */
  laneAttempts: readonly ImportLaneAttempt[];
}

/** 车道耗时账本（worker 线程内测得；不含线程启动／tsx 注册，也不含 IPC）。 */
export interface ImportLaneTimings {
  /** 每条**真的跑过**的车道的净耗时。没跑过的车道不出现（"跳过"与"跑了 0 ms"必须可分辨）。 */
  laneMs: Partial<Record<ImportLaneAttempt, number>>;
  /** 线程内「收到任务 → 产出结果」的总耗时（= Σ laneMs + 车道间准备）。 */
  taskMs: number;
}

/**
 * `import-lanes` 的结果。
 *
 * `laneAttempts` 是**实际执行过的车道序列**（不是下发的那份计划）：`["data-only"]` 表示
 * record-only 快通路接住了、统一接收器根本没被启动；`["data-only","direct-sync"]` 表示
 * 快通路拒收后由接收器接手。这条序列是 WP-41 对"两条车道的顺序与闸门"的可观测判据 ——
 * 它在 worker 线程内产生，因此比"主线程投递了什么"更接近事实。
 */
export type ImportLanesOutcome =
  | { kind: "applied"; lane: "data-only"; laneAttempts: ImportLaneAttempt[]; result: NonNullable<DataOnlyImportResult>; timings: ImportLaneTimings }
  | { kind: "applied"; lane: "direct-sync"; laneAttempts: ImportLaneAttempt[]; result: DirectSyncImportResult; timings: ImportLaneTimings }
  | { kind: "rejected"; laneAttempts: ImportLaneAttempt[]; rejection: DirectSyncRejection; timings: ImportLaneTimings };

/** 统一接收器**拒收**（不是抛错）：调用方据此带稳定码终态失败。 */
export function isImportLanesRejection(
  outcome: ImportLanesOutcome
): outcome is Extract<ImportLanesOutcome, { kind: "rejected" }> {
  return outcome.kind === "rejected";
}

export type ImportDatabaseTask =
  | { operation: "verify"; path: string }
  | { operation: "audit"; path: string }
  | { operation: "checkpoint"; path: string }
  | { operation: "import-lanes"; input: ImportLanesInput };

/**
 * 常驻 ingest Worker 的**消息协议**（WP-41 第二阶段）。
 *
 * 为什么任务要用 `taskId` 而不是"一次线程一个任务"：同一个线程会连着跑很多批，
 * 回复必须能对上**是哪一批** —— 否则丢失/错配的回复会把 A 批的结论记到 B 批头上。
 * 崩溃时主线程按 taskId 逐个 reject，绝不静默把某个批当成"没跑"。
 */
export interface IngestWorkerTaskMessage {
  kind: "task";
  taskId: number;
  task: ImportDatabaseTask;
}

export interface IngestWorkerReadyMessage {
  kind: "ready";
  /** 线程内 tsx 注册与模块加载已经完成 —— 主线程据此单独计量启动成本。 */
  startupMs: number;
}

export interface IngestWorkerResultMessage {
  kind: "result";
  taskId: number;
  ok: true;
  value: unknown;
  /** 线程报告的常驻 RSS（KiB），供多批之后核对"有没有持续增长"。 */
  rssKiB: number;
  /** 线程观测到的换库／恢复次数（同路径换了文件 ⇒ 上一批的调查结论作废）。 */
  targetResets: number;
}

export interface IngestWorkerErrorMessage {
  kind: "result";
  taskId: number;
  ok: false;
  error: string;
  rssKiB: number;
  targetResets: number;
}

export type IngestWorkerReply = IngestWorkerResultMessage | IngestWorkerErrorMessage;
export type IngestWorkerMessage = IngestWorkerTaskMessage | IngestWorkerReply | IngestWorkerReadyMessage;

/** Startup recovery also uses this; normal imports execute it in a Worker. */
export function databaseReadable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare("PRAGMA quick_check").get()?.quick_check === "ok";
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

export function buildImportAudit(path: string): DataAudit {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return buildAudit(database);
  } finally {
    database.close();
  }
}

export function checkpointImportDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result?.busy !== 0) throw new Error("Import database checkpoint is busy");
  } finally {
    database.close();
  }
}
