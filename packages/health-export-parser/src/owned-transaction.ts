import type { DatabaseSync } from "node:sqlite";

/**
 * 组件级"要么全成要么全退"的边界，**在两种事务所有权下都能用**。
 *
 * 背景（实测出来的，不是设想）：`RaiDatabase` 有 `store` / `caller` 两种写事务所有权
 * （见 `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md` §2.1）。解析器与规范化器原先直接
 * `database.exec("BEGIN IMMEDIATE")` —— 在 caller 模式下那会抛
 * `cannot start a transaction within a transaction`，于是**整条直连车道每一批都失败**，
 * 而报错看起来像"事务配置错了"，与真因（组件擅自开事务）无关。
 *
 * 语义：
 * - `callerOwned === false`（默认）：与历史逐字相同 —— `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`。
 * - `callerOwned === true`：本段边界是一个 **SAVEPOINT**，**不产生新的提交点**；
 *   提交/回滚整个批次仍是调用方的事（§4.2「所有内部组件不能自行 COMMIT」）。
 *
 * 🔴 三种收尾都必须**严格配对**，且失败路径上的收尾不得把真因换掉（F4 的教训）：
 * `rollbackOwnedTransaction` 会吞掉收尾自身的错误，而泄漏的 savepoint 依然会让
 * 调用方的 `commitCallerTransaction()` **拒绝提交**并点名它 —— 不存在"静默提交半批"。
 */
export function beginOwnedTransaction(database: DatabaseSync, savepoint: string, callerOwned: boolean): void {
  if (callerOwned) database.exec(`SAVEPOINT ${assertSavepointName(savepoint)}`);
  else database.exec("BEGIN IMMEDIATE");
}

export function commitOwnedTransaction(database: DatabaseSync, savepoint: string, callerOwned: boolean): void {
  if (callerOwned) database.exec(`RELEASE ${assertSavepointName(savepoint)}`);
  else database.exec("COMMIT");
}

export function rollbackOwnedTransaction(database: DatabaseSync, savepoint: string, callerOwned: boolean): void {
  if (!callerOwned) {
    database.exec("ROLLBACK");
    return;
  }
  try {
    database.exec(`ROLLBACK TO ${assertSavepointName(savepoint)}`);
    database.exec(`RELEASE ${assertSavepointName(savepoint)}`);
  } catch {
    // 收尾失败不换真因；泄漏的 savepoint 由调用方的提交断言兜住（见上）。
  }
}

function assertSavepointName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name)) throw new Error(`Invalid savepoint name: ${JSON.stringify(name)}`);
  return name;
}
