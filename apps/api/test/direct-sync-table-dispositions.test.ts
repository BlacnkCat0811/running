// 直连写守卫的「表分类清单」必须与**迁移产物**一致 —— 这条规则此前只活在注释里。
//
// 为什么这是编译期/提交期的门禁，而不是一条运行期断言：
//   `installDirectSyncWriteGuards` 是 fail-closed 的 —— 库里出现一张没在
//   `INGEST_TABLE_DISPOSITIONS` 里表态的表，**每一次**直连接收都会被整体拒收
//   （`write_guard_triggered`）。2026-10-16 实测过这个代价：v41 加表未表态期间，
//   三条直连用例整批红，而根因在另一个包里。维护责任的正确位置是提交时，不是线上。
//
// 为什么**动态**跑迁移再查 `sqlite_master`，而不是 grep `CREATE TABLE`：
//   `packages/storage-sqlite/src/v30-migration.ts` 先建临时表
//   `import_source_tombstones_v30`、搬数据、再 DROP + RENAME；`daily_training_metrics` /
//   `workout_training_loads` / `model_validation_gates` 各被重建过两次。
//   静态扫 DDL 会得到 1 个假阳性 + 3 条重复，而"跑完迁移的库"就是事实本身。
//
// 为什么也在 `apps/api/test/` 而不是 `packages/storage-sqlite/test/`：
//   判据要同时拿到迁移产物（storage-sqlite）与白名单（apps/api）。放进 package 会构成
//   package → app 的依赖倒置，被 `scripts/check-package-boundaries.mjs` 拦下。
//
// 触发面见 `.githooks/pre-commit`：`packages/storage-sqlite/**`、
// `apps/api/src/direct-sync-ingest.ts`、`.githooks/pre-commit`、以及本文件自己；
// 且这些路径有**未暂存**改动时 hook 会直接拒 —— 否则门禁读工作树、提交的是 index，
// 绿可能只证明了一个不会被提交的版本。
//
// ⚠️ 边界：本判据只覆盖**迁移产物**。若将来有代码对**主库**做运行期 `CREATE TABLE`
// （当前生产代码没有；复核确认所有运行期 DDL 都在独立库或 TEMP），本测试看不见，
// 而运行期写守卫会 fail-closed —— 届时需另加静态判据。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import {
  INGEST_TABLE_DISPOSITIONS,
  installDirectSyncWriteGuards,
  unclassifiedIngestTables
} from "../src/direct-sync-ingest.js";

/**
 * 必须与 `installDirectSyncWriteGuards` 里那条语句**逐字相同**（下面有一条断言检查它确实
 * 出现在生产源码里）。口径一旦漂移（比如守卫改成排除 `rai_%` 临时表），这条测试就会开始
 * 回答另一个问题，而它的绿会变得毫无意义 —— 所以宁可在这里抄一遍并注明出处。
 */
const PRODUCTION_TABLE_QUERY =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";

/**
 * 只在 vault 之外的地方建库：`RaiDatabase.open` 会把**全部迁移**跑一遍。
 * 用 `mkdtemp` 而不是固定路径：并发跑测试时不共享状态。
 */
async function migratedTables(
  run: (context: { tables: readonly string[]; triggers: readonly string[] }) => void
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-ingest-dispositions-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const tables = (store.database.prepare(PRODUCTION_TABLE_QUERY).all() as { name: string }[])
      .map((row) => row.name)
      .sort();
    // 端到端：守卫在一张**真实迁移产物**上必须装得上。方向 1 已经证明了差集为空，
    // 但"差集为空"与"守卫真的能装"是两件事 —— 后者还要过存在性判断与触发器 DDL。
    installDirectSyncWriteGuards(store.database);
    // 装上之后还要证明**装齐了**：只断言"不抛"的话，循环里漏装某张 analysis 表
    // （比如 kind 写错、过滤条件写错）不会被发现，而漏装 = 写守卫对该表静默放行。
    const triggers = (store.database.prepare(
      "SELECT name FROM sqlite_temp_master WHERE type = 'trigger'"
    ).all() as { name: string }[]).map((row) => row.name);
    run({ tables, triggers });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("迁移产物与 INGEST_TABLE_DISPOSITIONS 双向一致（漏表态 = 整条同步车道被拒）", async () => {
  await migratedTables(({ tables, triggers }) => {
    // 防空转：迁移没跑起来时下面两条会各自报一堆"僵尸条目"，读起来像是清单全错，
    // 而真正的原因是库是空的。先给一条指认得清楚的判据。
    assert.ok(tables.includes("schema_migrations"), "迁移账本表不存在：迁移似乎没跑");
    assert.ok(tables.includes("analysis_job_merges"), "v42 的表不存在：迁移没跑完");
    assert.ok(tables.length >= 60, `只看到 ${tables.length} 张表，迁移似乎没跑完`);

    // 判据的"生产 SQL 抄本"必须仍然逐字出现在生产源码里（防止两侧口径静默漂移）。
    const productionSource = readFileSync(
      new URL("../src/direct-sync-ingest.ts", import.meta.url), "utf8"
    );
    assert.ok(productionSource.includes(PRODUCTION_TABLE_QUERY),
      "生产守卫的表枚举 SQL 已漂移：同步更新本文件的 PRODUCTION_TABLE_QUERY 与判据");

    // 方向 1（与生产 fail-closed 同一判据）：库里有的表，必须都表过态。
    assert.deepEqual(unclassifiedIngestTables(tables), [],
      "这些表存在于迁移产物里，但没有在 INGEST_TABLE_DISPOSITIONS 里表态；"
      + "新增迁移必须同批写一行『它属于哪一类、为什么』，否则每次直连接收都会被整体拒绝");

    // 方向 2（生产**没有**的判据）：清单里的每一条都必须真是一张表。
    // 生产对"清单有、库里没有"是静默 continue 的 —— 一条僵尸条目永远不会被发现，
    // 而它会让「每张表都表过态」这句话变成假话。
    const declared = INGEST_TABLE_DISPOSITIONS.map((row) => row.table);
    assert.equal(new Set(declared).size, declared.length, "清单不得有重复条目");
    assert.deepEqual(declared.filter((table) => !tables.includes(table)), [],
      "清单里有库里不存在的僵尸条目：删掉它们（不要反过来往白名单里加东西）；"
      + "若某张表仍被 SQL 引用，说明它的 analysis 触发器今天根本没装上，那是另一个真缺陷");

    // 清单不只看表名：`why` 是这张清单唯一的维护依据，`kind` 决定写权限方向。
    for (const row of INGEST_TABLE_DISPOSITIONS) {
      assert.ok(row.table.trim().length > 0, "清单条目必须有表名");
      assert.ok(row.why.trim().length > 0,
        `表 ${row.table} 的 why 不得为空：新增迁移时必须同批写下它属于哪一类、为什么`);
      assert.ok(row.kind === "ingest" || row.kind === "analysis",
        `表 ${row.table} 的 kind 非法：${String(row.kind)}`);
    }

    // 方向 3（生产**没有**的判据）：kind=analysis 的每张表都要真的装上三个触发器。
    // 只断言 install 不抛会漏掉"某张表被循环静默跳过"，而那正是写守卫失效的形态。
    const installed = new Set(triggers);
    for (const row of INGEST_TABLE_DISPOSITIONS) {
      if (row.kind !== "analysis") continue;
      for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
        const name = `rai_direct_sync_${row.table}_${event}`;
        assert.ok(installed.has(name), `analysis 表 ${row.table} 缺 ${event} 触发器：写守卫没有真的装上`);
      }
    }
  });
});
