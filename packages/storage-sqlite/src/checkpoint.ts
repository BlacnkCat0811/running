import type { DatabaseSync } from "node:sqlite";

/**
 * `PRAGMA wal_checkpoint(TRUNCATE)` 的返回语义（SQLite 官方文档）：
 * 第一列 `busy` 非 0 表示 checkpoint **没有完成**（通常是有读事务钉住旧快照），
 * 后两列是日志页数与已 checkpoint 页数。`exec()` 不返回这些列，所以“执行过
 * checkpoint”与“checkpoint 已完成”是两件事。
 *
 * 本模块把两类调用分开，避免用同一种错误处理覆盖不同业务后果：
 *
 * - {@link runWalCheckpointTruncate}：**必须完成**的路径（恢复/换库/删除前），
 *   busy 非 0 直接抛 {@link WalCheckpointBusyError}，调用方不得继续搬文件或删侧车；
 * - {@link tryWalCheckpointTruncate}：**可延后**的维护（例如已成功 COMMIT 的回执），
 *   busy 时返回 `{ busy: ... }`，由调用方记录状态，不能把已提交事务说成未提交。
 */
export interface WalCheckpointResult {
  /** 非 0 = checkpoint 未完成。 */
  readonly busy: number;
  /** WAL 中的日志页数。 */
  readonly log: number;
  /** 已写回主库的页数。 */
  readonly checkpointed: number;
}

export class WalCheckpointBusyError extends Error {
  readonly code = "wal_checkpoint_busy";
  readonly result: WalCheckpointResult;

  constructor(result: WalCheckpointResult) {
    super(`SQLite WAL checkpoint is busy (log=${result.log}, checkpointed=${result.checkpointed})`);
    this.name = "WalCheckpointBusyError";
    this.result = result;
  }
}

function readCheckpointResult(database: DatabaseSync): WalCheckpointResult {
  const row = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
    | { busy?: unknown; log?: unknown; checkpointed?: unknown }
    | undefined;
  if (row === undefined) throw new Error("SQLite WAL checkpoint returned no result row");
  return {
    busy: Number(row.busy ?? 0),
    log: Number(row.log ?? 0),
    checkpointed: Number(row.checkpointed ?? 0)
  };
}

/** 必须完成的 checkpoint；busy 时抛出，调用方不得继续文件替换/删除。 */
export function runWalCheckpointTruncate(database: DatabaseSync): WalCheckpointResult {
  const result = readCheckpointResult(database);
  if (result.busy !== 0) throw new WalCheckpointBusyError(result);
  return result;
}

/** 可延后的 checkpoint；busy 时返回结果而不是抛错（其他 SQLite 错误仍然上抛）。 */
export function tryWalCheckpointTruncate(database: DatabaseSync): WalCheckpointResult {
  return readCheckpointResult(database);
}
