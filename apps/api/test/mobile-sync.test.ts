import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ImportJobResponse } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "../src/data.js";
import {
  mobileLockRejection,
  mobileRefreshOutcome,
  mobileSyncStatus,
  type MobileRefreshOutcome
} from "../src/mobile-sync.js";

const job = (status: ImportJobResponse["status"], overrides: Partial<ImportJobResponse> = {}): ImportJobResponse => ({
  id: "job-1",
  status,
  phase: "parseImport",
  message: "",
  createdAt: "2026-09-19T02:00:00.000Z",
  completedAt: status === "succeeded" || status === "failed" ? "2026-09-19T02:20:00.000Z" : null,
  error: null,
  ...overrides
});

const failed = (attemptedAt: string, error: string | null): MobileRefreshOutcome => ({
  lastCompleted: "failed",
  attemptedAt,
  error
});

test("a refresh that never ran is never, not a judgement about the data", () => {
  assert.deepEqual(mobileSyncStatus(null, null), {
    status: "never",
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null
  });
  // A database imported straight from the CLI has a published import but no job log.
  assert.deepEqual(mobileSyncStatus("2026-09-18T06:10:06.000Z", null), {
    status: "ok",
    lastAttemptAt: "2026-09-18T06:10:06.000Z",
    lastSuccessAt: "2026-09-18T06:10:06.000Z",
    error: null
  });
});

test("a cancelled or in-flight import is not a failure and does not erase the last outcome", () => {
  assert.equal(mobileRefreshOutcome(job("queued"))?.lastCompleted, null);
  assert.equal(mobileRefreshOutcome(job("running"))?.lastCompleted, null);
  assert.equal(mobileRefreshOutcome(job("cancelled"))?.lastCompleted, null);
  assert.equal(mobileRefreshOutcome(job("succeeded"))?.lastCompleted, "ok");
  assert.equal(mobileRefreshOutcome(job("failed", { error: "解压失败" }))?.lastCompleted, "failed");
  assert.equal(mobileRefreshOutcome(null), null);
  // An in-flight attempt keeps the previous outcome and reports its own start time.
  const attempt = mobileRefreshOutcome(job("running"));
  const sync = mobileSyncStatus("2026-09-18T06:10:06.000Z", attempt);
  assert.equal(sync.status, "ok");
  assert.equal(sync.lastAttemptAt, "2026-09-19T02:00:00.000Z");
  assert.equal(sync.lastSuccessAt, "2026-09-18T06:10:06.000Z");
  assert.equal(sync.error, null, "只有失败的刷新才带错误信息");
});

test("a failed refresh is reported only while nothing newer has been published", () => {
  const attempt = "2026-09-19T02:00:00.000Z";
  const stillFailed = mobileSyncStatus("2026-09-18T06:10:06.000Z", failed(attempt, "解压失败"));
  assert.equal(stillFailed.status, "failed");
  assert.equal(stillFailed.error, "解压失败");
  assert.equal(stillFailed.lastSuccessAt, "2026-09-18T06:10:06.000Z");

  // A published import at or after the failed attempt means the refresh recovered:
  // reporting the older failure would be a stale warning, which is the class of
  // mistake this field replaced.
  const recovered = mobileSyncStatus("2026-09-19T03:00:00.000Z", failed(attempt, "解压失败"));
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.error, null, "恢复之后不得继续携带旧错误");

  // A rejected import with no message still reads as failed rather than as ok.
  const silent = mobileSyncStatus(null, failed(attempt, null));
  assert.equal(silent.status, "failed");
  assert.equal(silent.error, null);
});

test("the store reports a failed refresh and never calls a missing night stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-sync-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  store.database.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)").run(
    "import_completed_at",
    "2026-09-18T06:10:06.000Z"
  );
  store.close();
  let outcome: MobileRefreshOutcome | null = null;
  const read = new RaiReadStore(databasePath, () => outcome);
  try {
    const ok = read.mobileToday();
    assert.equal(ok.sync.status, "ok");
    assert.equal(ok.sync.lastSuccessAt, "2026-09-18T06:10:06.000Z");
    assert.equal(ok.freshness.state, "valid");
    // No canonical night at all, and the data status still reads as a successful
    // refresh: the sleep date no longer decides it.
    assert.equal(ok.coverage.sleep.state, "none");
    assert.equal(ok.coverage.sleep.latestDate, null);

    outcome = failed("2026-09-19T02:00:00.000Z", "导出包缺少 workout 记录");
    const broken = read.mobileToday();
    assert.equal(broken.sync.status, "failed");
    assert.equal(broken.sync.error, "导出包缺少 workout 记录");
    assert.equal(broken.sync.lastAttemptAt, "2026-09-19T02:00:00.000Z");
    assert.equal(broken.freshness.state, "stale", "只有真正失败的刷新才把数据状态标成过期");
    assert.equal(
      broken.recommendation.recoveryAdjustment,
      "no_evidence",
      "刷新失败与有没有恢复数据是两件事"
    );
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirming a session is refused only by the refresh, not by a missing night", () => {
  const revision = "revision-current";
  // No recovery record for today is not represented here at all — it used to be the
  // blocking condition, and the point of this gate is that it no longer can be.
  assert.equal(mobileLockRejection({ syncStatus: "never", recommendationRevision: revision }), null);
  assert.equal(
    mobileLockRejection({ syncStatus: "ok", recommendationRevision: revision, expectedRevision: revision }),
    null,
    "一个健康的刷新加一个当前版本的建议不该被拒"
  );
  assert.equal(
    mobileLockRejection({ syncStatus: "ok", recommendationRevision: revision, expectedRevision: null }),
    null,
    "不带版本号的确认仍然放行（老客户端）"
  );

  assert.deepEqual(
    mobileLockRejection({ syncStatus: "ok", recommendationRevision: revision, expectedRevision: "revision-old" }),
    { code: "mobile_recommendation_stale", message: "今日建议已更新，请重新查看后再确认安排" }
  );
  assert.deepEqual(
    mobileLockRejection({ syncStatus: "failed", recommendationRevision: revision, expectedRevision: revision }),
    { code: "mobile_refresh_failed", message: "上次同步健康数据失败，请重新同步后再确认安排" }
  );
});

test("a failed refresh is reported before a stale revision so one round trip is enough", () => {
  // Both gates would refuse. The refresh wins on purpose: re-reading hands back the
  // same recommendation because nothing new was published, so answering with the
  // revision conflict would only deliver the "resync first" instruction on the
  // runner's second attempt.
  const both = mobileLockRejection({
    syncStatus: "failed",
    recommendationRevision: "revision-current",
    expectedRevision: "revision-old"
  });
  assert.equal(both?.code, "mobile_refresh_failed");
});
