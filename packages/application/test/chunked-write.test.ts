// `ChunkedWriter` 的判据（O07 步骤 4：许可覆盖完整短事务 + 让路点在提交之后）。
//
// 为什么单独测它：pipeline 的六个逐行写入循环都改走这个类，而它同时承担两件事 ——
// ①把"每行一个许可窗口"压成"每 ≤100 行一个事务"；②保证让路发生在**提交之后**。
// 两件事错任何一件都不会让别处报错：前者只是慢，后者会把 O07 的缺口重新引回来。

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { ChunkedWriter, WRITE_CHUNK_ROWS } from "../src/services/chunked-write.js";
import type { WriteGate } from "../src/write-gate.js";

/**
 * 把一条连接包成"事务感知"的替身：形状与 `apps/api/src/write-lease.ts` 的代理一致。
 * 计数事务开合，供判据看清"窗口数 = 分块数"还是"窗口数 = 行数"。
 */
function wrapTransactional(raw: DatabaseSync): { database: DatabaseSync; open: () => number; transactions: () => number } {
  let open = 0;
  let transactions = 0;
  const database = new Proxy(raw, {
    get(target, property) {
      if (property === "withWriteTransaction") {
        return <T,>(operation: () => T): T => {
          transactions += 1;
          open += 1;
          raw.exec("BEGIN IMMEDIATE");
          try {
            const value = operation();
            raw.exec("COMMIT");
            return value;
          } catch (error) {
            try { raw.exec("ROLLBACK"); } catch { /* 原始错误优先 */ }
            throw error;
          } finally {
            open -= 1;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args)
        : value;
    }
  }) as unknown as DatabaseSync;
  return { database, open: () => open, transactions: () => transactions };
}

test("分块：≤100 行一批，一个许可窗口 = 一个短事务（不是一行一个）", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  const { database, transactions } = wrapTransactional(raw);

  const insert = raw.prepare("INSERT INTO t (id) VALUES (?)");
  const writer = new ChunkedWriter(database);
  const total = WRITE_CHUNK_ROWS * 2 + 7;
  for (let index = 0; index < total; index += 1) writer.add(() => insert.run(index));
  writer.flush();

  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n), total,
    "分块不得改变落库结果");
  assert.equal(transactions(), 3,
    `${total} 行应当分成 3 个事务（100/100/7），实际 ${transactions()} —— ` +
    "分块失效时窗口数会退回行数，O08 的成本目标就不可达");
  assert.deepEqual(writer.stats(), { chunks: 3, rows: total, transactional: true });
  raw.close();
});

test("分块：没有事务代理时**不开事务**（CLI / 单测路径行为逐字节不变）", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  const insert = raw.prepare("INSERT INTO t (id) VALUES (?)");
  const writer = new ChunkedWriter(raw);
  for (let index = 0; index < 250; index += 1) writer.add(() => insert.run(index));
  writer.flush();

  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n), 250);
  assert.equal(writer.stats().transactional, false,
    "没有代理连接时开事务会和 RaiDatabase 自己的 inTransaction 标志打架（嵌套 BEGIN），" +
    "所以必须退回逐行写 —— 这里钉住的就是那条回落");
  raw.close();
});

test("分块：让路点在**提交之后**（事务开着时不得让路）", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  const wrapped = wrapTransactional(raw);
  const yieldStates: number[] = [];
  const gate: WriteGate = {
    scope: <T,>(fn: () => T): T => fn(),
    yieldIfStale: () => yieldStates.push(wrapped.open())
  };
  const insert = raw.prepare("INSERT INTO t (id) VALUES (?)");
  const writer = new ChunkedWriter(wrapped.database, gate);
  for (let index = 0; index < WRITE_CHUNK_ROWS * 2; index += 1) writer.add(() => insert.run(index));
  writer.flush();

  assert.equal(yieldStates.length, 2, "每个分块之后恰好一次让路（含最后不足一批的那次）");
  assert.deepEqual(yieldStates, [0, 0],
    "让路发生时事务必须已经提交 —— 事务中途交回许可就是 O07 的病灶");
  raw.close();
});

test("分块：批量写失败时整批回滚，且错误原样抛出", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  const { database } = wrapTransactional(raw);
  const insert = raw.prepare("INSERT INTO t (id) VALUES (?)");
  const writer = new ChunkedWriter(database);
  writer.add(() => insert.run(1));
  writer.add(() => { throw new Error("boom"); });
  assert.throws(() => writer.flush(), /boom/);
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n), 0,
    "同一批里的写必须一起回滚 —— 半批落库会让『这一轮算了什么』说不清");
  raw.close();
});
