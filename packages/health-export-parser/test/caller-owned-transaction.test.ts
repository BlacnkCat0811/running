// PR4 步骤 2b：解析器进入**调用方持有**的写事务（docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md §2.2）。
//
// 这个模式要证明的不是"我们约定解析器不提交"，而是**解析器提不了**：
//   · 它的批次边界是一个 SAVEPOINT（不产生提交点），提交权只在调用方手里；
//   · 它失败时只撤自己那一段，调用方**仍能继续做完别的事**再决定提交 —— 这是"同库短事务接收"
//     能做下去的前提（一个失败批次不该把调用方已经做好的工作一起毁掉）；
//   · 两种事务所有权（`callerOwnedTransaction` vs `recordDelta`）同时要求时**直接抛错**，
//     而不是让其中一方静默生效。
//
// 🔴 每条判据都配了"期望抛错"或"第二个连接看不到"的对照，因为只断言"正常路径能走通"
// 无法区分"约束生效"与"约束被删掉"。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { healthTypes } from "@rai/contracts";

import { CALLER_OWNED_PARSE_SAVEPOINT, parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";

const restingHeartRate = healthTypes.restingHeartRate;

function recordXml(start: string, value: string): string {
  return `<Record type="${restingHeartRate}" sourceName="Watch" unit="count/min" `
    + `creationDate="${start}" startDate="${start}" endDate="${start}" value="${value}"/>`;
}

function exportXml(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-01-03 00:00:00 +0800"/>
${rows}
</HealthData>`;
}

interface Ctx {
  store: RaiDatabase;
  /** 第二个连接：用来区分"本连接内可见"与"真的提交了"。 */
  observer: DatabaseSync;
  xmlPath: string;
  writeXml(text: string): void;
}

async function withCallerStore(run: (ctx: Ctx) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-caller-owned-parse-"));
  const path = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  // 与生产一致的顺序：**启动时**由 store 模式建立 schema，热路径再以 caller 模式打开。
  (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
  const store = await RaiDatabase.open(path, { transactionOwner: "caller" });
  const observer = new DatabaseSync(path, { readOnly: true });
  try {
    await run({
      store, observer, xmlPath,
      writeXml: (text) => writeFileSync(xmlPath, text)
    });
  } finally {
    observer.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const countIn = (database: DatabaseSync, table: string): number =>
  Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);

const manifestIn = (database: DatabaseSync, key: string): string | null => {
  const row = database.prepare("SELECT value FROM import_manifest WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
};

/** 解析前先落一条批次行：`import_entity_changes.batch_id` 有外键指向 `import_batches`。 */
function openBatch(store: RaiDatabase, batchId: string): void {
  store.database.prepare(
    "INSERT OR IGNORE INTO import_batches(id, xml_sha256, status, import_mode) VALUES (?, 'test', 'running', 'incremental')"
  ).run(batchId);
}

test("两种事务所有权不得同时成立：callerOwnedTransaction 与 recordDelta / atomic:false 互斥", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-caller-owned-guard-"));
  const xmlPath = join(root, "export.xml");
  writeFileSync(xmlPath, exportXml(recordXml("2026-01-02 08:00:00 +0800", "50")));
  // 两条判定都在函数最前面，所以这里不需要真库（传一个假 store 即可 —— 走到 store 就已经失败了）。
  const unreachableStore = {} as RaiDatabase;
  try {
    await assert.rejects(
      parseAppleHealthXml(xmlPath, unreachableStore, {
        fileSize: statSync(xmlPath).size,
        callerOwnedTransaction: true,
        recordDelta: { xmlText: "<HealthData/>", onBegin() {}, beforeCommit() {} }
      }),
      /mutually exclusive/,
      "recordDelta 自带 BEGIN/COMMIT，与「提交权归调用方」不可能同时成立"
    );
    await assert.rejects(
      parseAppleHealthXml(xmlPath, unreachableStore, {
        fileSize: statSync(xmlPath).size,
        callerOwnedTransaction: true,
        atomic: false
      }),
      /requires the default atomic mode/,
      "atomic:false 的意思是「每 N 个对象自行提交」，与调用方持有提交点相反"
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("解析器不自提交：commit 之前第二个连接看不到，commit 之后看得到；savepoint 不泄漏", async () => {
  await withCallerStore(async ({ store, observer, xmlPath, writeXml }) => {
    writeXml(exportXml([
      recordXml("2026-01-02 08:00:00 +0800", "50"),
      recordXml("2026-01-03 08:00:00 +0800", "52")
    ].join("\n")));
    store.beginCallerTransaction();
    openBatch(store, "batch-1");
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      callerOwnedTransaction: true,
      incremental: { generation: "batch-1", batchId: "batch-1", preserveAbsent: true }
    });

    assert.equal(result.recordCount, 2, "解析器必须真的写入了本批事实");
    assert.equal(countIn(store.database, "health_records"), 2, "同一连接内应当可见");
    // 🔴 关键判据：解析器没有提交。第二个连接（只读）看不见未提交的行。
    assert.equal(countIn(observer, "health_records"), 0,
      "commit 之前第二个连接就看到了行 ⇒ 解析器自己提交了（事务所有权已经被破坏）");

    // 解析器若泄漏了 savepoint，这一句会抛 "Savepoint ... is already active"。
    store.savepoint(CALLER_OWNED_PARSE_SAVEPOINT);
    store.releaseSavepoint(CALLER_OWNED_PARSE_SAVEPOINT);

    store.commitCallerTransaction();
    assert.equal(countIn(observer, "health_records"), 2, "提交后第二个连接必须看得到");
  });
});

test("解析失败只撤自己那一段：调用方的其它写入仍能提交，半批事实一行不落", async () => {
  await withCallerStore(async ({ store, observer, xmlPath, writeXml }) => {
    // 第一条记录完整、第二条中途截断 ⇒ 解析器在写完一部分之后失败。
    writeXml(`<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">${recordXml("2026-01-02 08:00:00 +0800", "50")}
<Record type="${restingHeartRate}" sourceName="Watch" startDa`);
    store.beginCallerTransaction();
    openBatch(store, "batch-fail");
    store.setManifest("probe_before_parse", "kept");

    await assert.rejects(
      parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        callerOwnedTransaction: true,
        incremental: { generation: "batch-fail", batchId: "batch-fail", preserveAbsent: true }
      }),
      "截断的 XML 必须让本批失败，而不是被当成空批成功"
    );

    // 失败之后调用方**继续做事**：这正是 savepoint 而不是整体回滚的意义。
    store.setManifest("probe_after_parse", "kept");
    store.commitCallerTransaction();

    assert.equal(manifestIn(observer, "probe_before_parse"), "kept", "调用方失败前的写入必须保留");
    assert.equal(manifestIn(observer, "probe_after_parse"), "kept", "调用方失败后的写入也必须保留");
    assert.equal(countIn(observer, "health_records"), 0, "失败批次的半成品一行都不许落库");
  });
});

test("机械保证：store 不是 caller 模式时要求 callerOwnedTransaction ⇒ 抛错，不静默退回组件提交", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-caller-owned-mode-"));
  const path = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  writeFileSync(xmlPath, exportXml(recordXml("2026-01-02 08:00:00 +0800", "50")));
  const store = await RaiDatabase.open(path, { createMigrationBackup: false });
  try {
    // 默认模式（store 自己管事务）下要求调用方持有 ⇒ 必须响亮地失败。
    // 若某天有人把它改成"自动改用组件提交"，这条会转红 —— 那正是要防的静默降级。
    await assert.rejects(
      parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        callerOwnedTransaction: true,
        incremental: { generation: "batch-x", batchId: "batch-x", preserveAbsent: true }
      }),
      /transactionOwner="caller"/,
      "默认模式的 store 不具备 caller 事务，必须在开口之前就拒绝"
    );
    assert.equal(countIn(store.database, "health_records"), 0, "被拒绝的解析不得留下任何写入");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
