// 补种与删除判定必须**成对**（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §2.3 与文档 §1.1）。
//
// 这两件事原本分成两处各写一份条件：补种看 `!recordDelta`，删除判定看 `!preserveAbsent`。
// 单看代码"恰好等价"，但两处独立的条件意味着只改一处就能造出两种坏法：
//   · 补种了却不判删除 ⇒ 每次增量白做一次整库 `INSERT OR IGNORE ... SELECT`（§1.1 明确要取消）；
//   · 判删除却没补种 ⇒ 上一批盖的代次全部相对本批"陈旧" ⇒ **误判整库删除**。
//
// 所以下面的用例是**正反两面**，缺一不可：
//   · 完整快照：必须仍然补种 —— 否则"载荷里没有的实体"找不到代次行，**漏删**（数据留着不报错）。
//   · 增量（preserve-absent）：必须**不**补种 —— 用"另一条实体的代次行不会凭空出现"来证明。
//
// 只测其中一面是没有意义的：只测"增量不补种"，把补种整段删掉也照样绿。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workoutTypes } from "@rai/contracts";
import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";
import { RecordDeltaNotEligibleError } from "../src/record-delta-policy.js";

/** 两条训练：alpha（2026-01-01）、beta（2026-01-02）。 */
function workoutXml(dates: readonly ("alpha" | "beta")[]): string {
  const windows = { alpha: "2026-01-01 08:00:00 +0800", beta: "2026-01-02 08:00:00 +0800" } as const;
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-01-03 00:00:00 +0800"/>
${dates.map((key) => `<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
  startDate="${windows[key]}" endDate="${windows[key].replace("08:00:00", "08:30:00")}"
  duration="30" durationUnit="min"/>`).join("\n")}
</HealthData>`;
}

async function withStore(run: (store: RaiDatabase, xmlPath: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "rai-seeding-pairing-"));
  const xmlPath = join(root, "export.xml");
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try { await run(store, xmlPath); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

function generationRows(store: RaiDatabase): Map<string, string> {
  return new Map((store.database.prepare(
    "SELECT entity_id AS id, generation FROM import_entity_generations WHERE entity_kind = 'workout'"
  ).all() as { id: string; generation: string }[]).map((row) => [row.id, row.generation]));
}

function workoutId(store: RaiDatabase, day: "01" | "02"): string {
  return (store.database.prepare(`SELECT id FROM workouts WHERE start_at LIKE '2026-01-${day}%'`).get() as { id: string }).id;
}

test("增量（preserve-absent）不补种：未被载荷触及的实体不会凭空得到代次行", async () => {
  await withStore(async (store, xmlPath) => {
    writeFileSync(xmlPath, workoutXml(["alpha", "beta"]));
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });

    // 造出"这一行没有代次行"的状态 —— 补种如果发生，它一定会被写上一行。
    const beta = workoutId(store, "02");
    store.database.prepare("DELETE FROM import_entity_generations WHERE entity_kind='workout' AND entity_id=?").run(beta);
    store.flush();

    writeFileSync(xmlPath, workoutXml(["alpha"]));
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "delta-generation", preserveAbsent: true }
    });

    const rows = generationRows(store);
    assert.equal(rows.has(beta), false,
      "增量载荷不得补种：beta 未被本批触及，它的代次行不该出现（出现即说明跑了整库补种）");
    // 反面：alpha 是被本批触及的，它的代次必须被更新到本批 —— 否则上面那条可能只是因为"整段代次写入坏了"。
    assert.equal(rows.get(workoutId(store, "01")), "delta-generation");
    // beta 必须还在（preserve-absent 不判删除）。
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM workouts").get()!.n, 2);
  });
});

test("完整快照仍然补种：载荷里没有的实体会被删掉，而不是因为缺代次行而留下", async () => {
  await withStore(async (store, xmlPath) => {
    writeFileSync(xmlPath, workoutXml(["alpha", "beta"]));
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });

    // 关键前置：把两条的代次行都删掉，模拟"只有当前行、没有代次行"的库。
    // 此时若补种被跳过，下面 finalize 就找不到 beta 是"陈旧的" ⇒ beta 静默留下。
    const beta = workoutId(store, "02");
    store.database.prepare("DELETE FROM import_entity_generations WHERE entity_kind='workout'").run();
    store.flush();

    writeFileSync(xmlPath, workoutXml(["alpha"]));
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "snapshot-generation" }
    });

    assert.equal(result.removedWorkoutCount, 1, "完整快照必须把载荷里没有的训练判为删除");
    // 🔴 软删（v36）：行**保留**并标 `deleted_at`，而不是物理消失 —— 物理删会沿
    // workouts→workout_routes→route_versions→route_version_points 级联删掉已发布路线的证据。
    // 所以这里钉两件事：它不再是"仍在的训练"，以及它**确实**被标记了（不是"其实没删"）。
    const betaRow = store.database.prepare("SELECT deleted_at AS deletedAt FROM workouts WHERE id=?").get(beta) as
      { deletedAt: string | null } | undefined;
    assert.ok(betaRow, "软删必须保留行（保留路线版本证据）");
    assert.ok(betaRow.deletedAt, "被删除的训练必须有 deleted_at 标记");
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NULL").get()!.n, 1);
  });
});

test("直连（recordDelta）恒为增量：缺 preserveAbsent 或显式关闭都不合格", async () => {
  await withStore(async (store, xmlPath) => {
    const recordOnly = `<HealthData><Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch"
      unit="count" value="10" startDate="2026-01-01 00:00:00 +0000"
      endDate="2026-01-01 00:01:00 +0000"><MetadataEntry key="RAIHealthKitSampleUUID"
      value="00000000-0000-0000-0000-00000000000a"/></Record></HealthData>`;
    writeFileSync(xmlPath, recordOnly);
    const eligible = {
      fileSize: statSync(xmlPath).size,
      healthKitRecordIdentity: true,
      recordDelta: { xmlText: recordOnly, onBegin() {}, beforeCommit() {} }
    };
    // 正面：完整资格不会被**资格门**拒掉。这里刻意不去跑通整条增量链路（那需要
    // data-only-import 那一整套 fixture），只要求它失败时**不是** `RecordDeltaNotEligibleError` ——
    // 否则下面两条反面断言就可能只是"这个门什么都拒"，而不是"专拒快照语义"。
    const allowed = await parseAppleHealthXml(xmlPath, store, {
      ...eligible, incremental: { generation: "ok", preserveAbsent: true }
    }).then(() => null, (error: unknown) => error);
    assert.ok(!(allowed instanceof RecordDeltaNotEligibleError),
      `完整资格不应被资格门拒绝，实际：${String(allowed)}`);
    // 反面 1：没有 preserveAbsent。
    await assert.rejects(parseAppleHealthXml(xmlPath, store, {
      ...eligible, incremental: { generation: "no-flag" }
    }), (error: unknown) => {
      assert.ok(error instanceof RecordDeltaNotEligibleError, String(error));
      return true;
    });
    // 反面 2：显式声明为"缺省即删除"——那会让部分载荷按完整快照处理。
    await assert.rejects(parseAppleHealthXml(xmlPath, store, {
      ...eligible, incremental: { generation: "explicit-snapshot", preserveAbsent: false }
    }), (error: unknown) => {
      assert.ok(error instanceof RecordDeltaNotEligibleError, String(error));
      return true;
    });
  });
});

/**
 * 🔴 这条是给"不补种"的**副作用**补的门禁（2026-10-12 修复）。
 *
 * `import_issues` 的重建原先是 `seedImportGenerations` 的**副产品**（那个方法无条件
 * `DELETE FROM import_issues`）。一旦"增量不补种"，副产品就跟着没了 ⇒ 旧链路的
 * `incremental-import` 的问题清单变成跨批累积（实测的行为变更）。
 * 修法是把清清单抽成独立入口 `clearImportIssues()`，并在 preserve-absent 分支显式调用。
 * 这条用例就是那个"显式调用"的守卫：**漏调用 ⇒ 这里红**。
 *
 * 只断言"清空了"是不够的，所以另配一条**负面对照**：无 `incremental` 的调用
 * （老的全量/首次导入入口）**不**清 —— 修复不得顺手扩大清空范围。
 */
function issueCount(store: RaiDatabase): number {
  return (store.database.prepare("SELECT COUNT(*) AS n FROM import_issues").get() as { n: number }).n;
}

test("preserve-absent 增量不补种，但仍必须按批重建问题清单", async () => {
  await withStore(async (store, xmlPath) => {
    writeFileSync(xmlPath, workoutXml(["alpha"]));
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    // 造一条"上一批遗留的问题"。
    store.database.prepare(
      "INSERT INTO import_issues (severity, code, message) VALUES ('warning', 'LEGACY_ISSUE', 'left by a previous batch')"
    ).run();
    store.flush();
    assert.equal(issueCount(store), 1, "前置：旧问题必须先真的写进去，否则下面那条可能只是因为表是空的");

    writeFileSync(xmlPath, workoutXml(["alpha"]));
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "delta-issues", preserveAbsent: true }
    });

    assert.equal(issueCount(store), 0,
      "preserve-absent 增量必须按批重建问题清单：这条路径不补种，但清清单是独立的一件事，" +
      "漏调用会让 import_issues 跨批累积");
    // 同一条路径的**另一面**同时成立：代次行没有被凭空补种（上一批用例的不变量不能被本修复改坏）。
    assert.equal(generationRows(store).get(workoutId(store, "01")), "delta-issues");
  });
});

test("负面对照：没有 incremental 的调用不重建问题清单（修复不得扩大清空范围）", async () => {
  await withStore(async (store, xmlPath) => {
    writeFileSync(xmlPath, workoutXml(["alpha"]));
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    store.database.prepare(
      "INSERT INTO import_issues (severity, code, message) VALUES ('warning', 'LEGACY_ISSUE', 'left by a previous batch')"
    ).run();
    store.flush();

    writeFileSync(xmlPath, workoutXml(["beta"]));
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });

    assert.equal(issueCount(store), 1,
      "无 incremental 的调用不得清空问题清单 —— 旧行为如此，清空只属于那三条带 incremental 的分支");
  });
});
