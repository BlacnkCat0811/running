import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import {
  AnalysisInputReadBudgetExceeded, SegmentedFactView, probeFactSize, type AnalysisInputBudget
} from "../src/services/analysis-fact-view.js";

/**
 * 读取预算的两条判据：
 *
 * 1. **字节按真实 UTF-8 计**。旧实现用 `LENGTH(col)`，对 TEXT 返回字符数 —— 中文/emoji
 *    会被低估 2–4 倍，于是 256 MiB 的物化上限在小语种数据上从来没真正生效。
 * 2. **超限是硬失败，不是记账**。旧实现 `statement.all()` 先把结果集整个物化，再"事后
 *    记账"；那时无论记什么都不可能阻止内存被吃掉。现在逐行消费、到上限抛错，
 *    且**绝不返回截断后的半份结果**（那会被下游当成完整输入算出一份看起来正常的错值）。
 */

const budget = (overrides: Partial<AnalysisInputBudget> = {}): AnalysisInputBudget => ({
  maxRows: 1_000_000,
  maxBytes: 1_000_000_000,
  maxReadRows: 1_000_000,
  maxReadMs: 60_000,
  ...overrides
});

async function withDatabase(work: (store: RaiDatabase) => void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "rai-read-budget-"));
  const store = await RaiDatabase.open(join(directory, "rai.sqlite"), { createMigrationBackup: false });
  try {
    work(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("byte probe counts real UTF-8 bytes, not characters", async () => {
  await withDatabase((store) => {
    store.database.exec("CREATE TABLE probe_fixture (label TEXT)");
    // 4 个汉字 = 12 字节；字符数是 4。旧口径会把这一行算成 32 + 4 字节。
    store.database.prepare("INSERT INTO probe_fixture (label) VALUES (?)").run("苹果手表");
    const probe = probeFactSize(store.database, ["probe_fixture"]);
    assert.equal(probe.rows, 1);
    assert.ok(probe.bytes >= 32 + 12, `expected >= 44 bytes, got ${probe.bytes}`);
    assert.notEqual(probe.bytes, 32 + 4, "字符数口径必须已经被替换");
  });
});

test("a segmented read that exceeds the row cap throws instead of truncating", async () => {
  await withDatabase((store) => {
    store.database.exec("CREATE TABLE probe_big (value INTEGER)");
    const insert = store.database.prepare("INSERT INTO probe_big (value) VALUES (?)");
    store.database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 1_000; index += 1) insert.run(index);
    store.database.exec("COMMIT");
    const view = new SegmentedFactView(store.database, { raw: 0, dependency: 0 }, budget({ maxReadRows: 10 }), 0);
    assert.throws(
      () => view.database.prepare("SELECT value FROM probe_big").all(),
      (error: unknown) => error instanceof AnalysisInputReadBudgetExceeded
        && error.detail.table === "probe_big"
        && error.detail.rows >= 11
    );
    // 失败后视图仍可读（事务已回滚），且没有把"读了一半"的结果交给调用方。
    const rows = view.database.prepare("SELECT value FROM probe_big LIMIT 5").all();
    assert.equal(rows.length, 5);
  });
});

test("within-budget reads keep their exact shape and report the probe estimate", async () => {
  await withDatabase((store) => {
    store.database.exec("CREATE TABLE probe_small (value INTEGER)");
    const insert = store.database.prepare("INSERT INTO probe_small (value) VALUES (?)");
    for (let index = 0; index < 10; index += 1) insert.run(index);
    const view = new SegmentedFactView(store.database, { raw: 0, dependency: 0 }, budget(), 4096);
    const rows = view.database.prepare("SELECT value FROM probe_small ORDER BY value").all() as Array<{ value: number }>;
    assert.deepEqual(rows.map((row) => Number(row.value)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const stats = view.stats();
    assert.equal(stats.bytes, 4096, "分段模式的 bytes 必须是探针估计，不是假 0");
    assert.deepEqual(stats.nearLimit, []);
    assert.equal(stats.reads, 1);
  });
});
