import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { healthTypes, SLEEP_ANALYSIS_VALUES } from "@rai/contracts";
import { canonicalizeNights } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

import { loadDatedReadiness } from "../src/index.js";

/**
 * §15.3「事实可得时间」的**端到端**验收：重新导入不得**抹掉**已经存在的到达时间。
 *
 * 机制在 `canonicalize-nights.ts`：它原本是全量 `DELETE` + 重建，而两条 INSERT 都不带
 * `computed_at`（列有 `DEFAULT now`），于是每次重建都把全部行的到达时间改写成"现在"。
 * `model-v2-snapshots.ts` 读的正是 `computed_at AS availableAt`，而 readiness 只在
 * `availableAt <= asOf` 时承认事实可得 —— 所以同一份事实、同一个 `asOf`，答案会因为
 * 一次重建而改变（独立探针在修复前的修订上复现：sleep/hrv 的 value 由 490/62 变成 null）。
 *
 * ⚠️ **这条用例只声明能被声明的那一半**：
 * · 它验证的是"**本来就有的**到达时间在重建后仍在"。
 * · 它**不**验证、也不应验证"历史日都能评估" —— 第一次重建本来就没有可保留的值，
 *   而"当时确实还没导入的事实"就是不可得，那是诚实的数据缺口，不是可以修掉的 bug。
 * · 因此在本工作区的 `var/rai.sqlite` 上（canonical 表 0 行）这个修复**没有任何可观测效果**，
 *   效果只能由合成用例钉住。
 */

const TIMEZONE = "Asia/Shanghai";
const AS_OF = "2026-09-01T15:59:59.999Z"; // 该本地日的最后一毫秒
const LOCAL_DATE = "2026-09-01";

async function withDatabase(run: (store: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-arrival-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 连续 9 个主夜 —— 睡 baseline 需要 28 日窗口里至少 7 个值。 */
function insertNights(store: RaiDatabase, wakeDates: readonly string[]): void {
  const insert = store.database.prepare(`INSERT INTO health_records
    (id,type,source_name,source_category,unit,value_text,start_at,end_at,metadata_json,raw_attributes_json)
    VALUES (?,?,'Watch','apple_watch','',?,?,?,'{}','{}')`);
  for (const wakeDate of wakeDates) {
    const previous = new Date(`${wakeDate}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const evening = previous.toISOString().slice(0, 10);
    insert.run(`inbed-${wakeDate}`, healthTypes.sleepAnalysis, SLEEP_ANALYSIS_VALUES.inBed,
      `${evening}T14:00:00Z`, `${wakeDate}T00:00:00Z`);
    insert.run(`asleep-${wakeDate}`, healthTypes.sleepAnalysis, SLEEP_ANALYSIS_VALUES.asleepCore,
      `${evening}T14:30:00Z`, `${evening}T22:30:00Z`);
  }
}

test("a re-import does not destroy an already-established assessment", async () => {
  await withDatabase((store) => {
    const dates: string[] = [];
    for (let offset = 8; offset >= 0; offset -= 1) {
      const value = new Date(`${LOCAL_DATE}T00:00:00Z`);
      value.setUTCDate(value.getUTCDate() - offset);
      dates.push(value.toISOString().slice(0, 10));
    }
    insertNights(store, dates);
    canonicalizeNights(store.database, TIMEZONE);

    // 这些夜是**很早以前**导入的：把到达时间钉在一个远早于 asOf 的时刻。
    // 这一步模拟的是"当时确实已经到过"，不是在伪造可得性。
    const arrival = "2026-01-01T00:00:00.000Z";
    store.database.prepare("UPDATE canonical_nights SET computed_at = ?").run(arrival);

    const before = loadDatedReadiness(store.database, AS_OF, TIMEZONE);
    const beforeCounted = before.signals.sleep.value !== null;
    assert.ok(
      before.signals.sleep.availableAt !== null,
      "前提：钉过到达时间之后，这一天应当是可评估的（否则这条用例测不到东西）"
    );
    assert.ok(before.signals.sleep.baseline !== null, "前提：9 个夜足够形成 28 日睡 baseline");

    // 重新导入：数据一条没变，只重跑 canonicalize。
    canonicalizeNights(store.database, TIMEZONE);

    const after = loadDatedReadiness(store.database, AS_OF, TIMEZONE);
    assert.equal(
      after.signals.sleep.value, before.signals.sleep.value,
      "内容未变的夜必须仍然可得：重新导入不能把历史改写成'现在才到'"
    );
    assert.equal(after.signals.sleep.availableAt, before.signals.sleep.availableAt);
    assert.equal(after.signals.sleep.baseline, before.signals.sleep.baseline);
    assert.equal(after.signals.sleep.value !== null, beforeCounted);
  });
});
