import type { DatabaseSync } from "node:sqlite";

import { isWriteTransactionScope, withDatabaseTransaction } from "@rai/storage-sqlite";

import type { WriteGate } from "../write-gate.js";

/**
 * 一次短事务最多写多少行（O07 步骤 4 的初始预算）。
 *
 * 🔴 这个数字是**待基准校准**的初值，不是测出来的最优解。它约束的是"一个许可窗口有多长"：
 * 太小 ⇒ 退回逐语句取许可（每次握手成本直接乘上行数）；太大 ⇒ 单次事务把 SQLite 写锁
 * 按行数时长握住。真正的判据是**实测事务耗时**（`transactionMs`/`slowTransactions`），
 * 不是行数本身 —— 单条耗时 SQL 要单独治理，100 行不等于短事务。
 */
export const WRITE_CHUNK_ROWS = 100;

/**
 * 分块短事务写入器（O07：许可覆盖完整短事务）。
 *
 * ## 为什么需要它
 *
 * pipeline 里有六处逐行写入循环（特征、复用前缀、逐日分区、训练负荷、能力评估、日快照）。
 * 它们今天是"一行一条语句、每条语句一个许可窗口"：正确但昂贵 —— 每次窗口都要跨线程握手，
 * 而 O08 的目标（200 空窗口 < 100ms）只在窗口数被压下来之后才可达。
 *
 * 把 ≤{@link WRITE_CHUNK_ROWS} 行放进**一个** `BEGIN IMMEDIATE … COMMIT`，
 * 让许可覆盖整个短事务，窗口数直接除以批大小。
 *
 * ## 让路点在**提交之后**
 *
 * `yieldIfStale` 在事务开着时必须什么都不做（交回许可会制造"许可空闲但库仍被锁"）。
 * 所以这里在 `flush()` **提交之后**才让路 —— 那是唯一安全的让路位置。
 *
 * ## 没有写租约时行为逐字节不变
 *
 * CLI、单测、任何没有代理连接的场景都不开事务，逐行写（与今天相同）。
 * 原因不只是"少一层开销"：`RaiDatabase` 自己有一个 `inTransaction` 标志，而它**看不见**
 * 我们在这里开的事务 —— 在外面套一层会让 store 方法发出嵌套 `BEGIN IMMEDIATE` 并直接报错。
 * 只有拿到代理连接（`withWriteTransaction`）时才由代理统一管事务与许可。
 */
export class ChunkedWriter {
  private pending: Array<() => void> = [];
  private chunkCount = 0;
  private rowCount = 0;
  private readonly transactional: boolean;

  constructor(
    private readonly database: DatabaseSync,
    private readonly gate: WriteGate | undefined = undefined,
    private readonly maxRows: number = WRITE_CHUNK_ROWS
  ) {
    this.transactional = isWriteTransactionScope(database);
  }

  /** 收下一行写；收满一批就立刻提交，不等循环结束。 */
  add(write: () => void): void {
    this.pending.push(write);
    if (this.pending.length >= this.maxRows) this.flush();
  }

  /** 提交剩余的行。**必须在循环结束后调用**，否则最后不足一批的行不会落库。 */
  flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const run = (): void => {
      for (const write of batch) write();
    };
    if (this.transactional) withDatabaseTransaction(this.database, run);
    else run();
    this.chunkCount += 1;
    this.rowCount += batch.length;
    // 事务已经提交（或本来就没有事务）⇒ 这里是安全的让路点。
    this.gate?.yieldIfStale();
  }

  /** 实际写入的分块数与行数（观测面：证明"窗口数 = 分块数"而不是"行数"）。 */
  stats(): { chunks: number; rows: number; transactional: boolean } {
    return { chunks: this.chunkCount, rows: this.rowCount, transactional: this.transactional };
  }
}
