import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";
import { RaiDatabase } from "@rai/storage-sqlite";
import { RaiReadStore } from "../src/data.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { PlanOperationError, PlanPublicationService } from "../src/plan-publication.js";
import { prescriptionDigest } from "../src/plan-digest.js";
import { apiErrorPayload } from "../src/api-error.js";
import { assemblePlanCandidates, matchPlanDay } from "../src/workout-segments.js";
import type { MobileRunCoachPlan, MobileSessionStructure } from "@rai/api-contracts";

import { posixOnlyReason } from "./posix-only.js";

const identity = () => ({ serverId: "server", athleteId: "athlete", datasetEpoch: "epoch" });
const config = { goal: "fitness" as const, raceDate: null, raceDistanceKm: null, targetTimeSeconds: null,
  runningDays: [1, 3, 5], longRunDays: [5], targetType: "pace" as const, strengthTraining: false };
const structure: MobileSessionStructure = { warmup: null, blocks: [{ iterations: 1,
  steps: [{ purpose: "work", goal: { type: "distance", meters: 4000 }, alert: null }] }], cooldown: null };

/**
 * 🔴 CI 2026-10-25（`windows-latest`）：本条红在换库那一行 —— 用例把 `planHistory()`
 * 换成"每次读都 `copyFileSync` + `renameSync` 覆盖 facts.sqlite"，Windows 报
 * `EPERM: operation not permitted, rename '…\facts.sqlite.replacement-1' -> '…\facts.sqlite'`，
 * 于是 `read.trainingPlanState()` 抛的是 EPERM，而不是判据要的
 * `plan_snapshot_changed` / 503。机制是 Windows 的文件共享语义：**不允许 rename/unlink
 * 一个仍被打开的文件**（读侧连接正开着），POSIX 允许（rename 只换目录项）。
 *
 * 这条判据要证明的是"读到一半被换库 ⇒ 重试三次后 fail closed 成可重试的 503，而不是
 * 返回混合快照"。换库这个动作在 Windows 上做不出来，所以这条判据在那里没有被检查。
 * 同文件 `P2-02: a WAL checkpoint moving the file mtime does not fail the plan snapshot`
 * 只动 mtime、不换文件，在 Windows 上照常通过。
 */
const FILE_REPLACEMENT_ONLY = posixOnlyReason(
  "Windows 不允许 rename/unlink 仍被打开的文件：读侧还开着 facts.sqlite，用例每次读都覆盖换库，"
  + "`renameSync(staged, path)` 直接 EPERM（CI 2026-10-25：「EPERM: operation not permitted, rename」），"
  + "抛出的错误因此是 EPERM 而不是判据要的 plan_snapshot_changed/503。"
  + "本条判据（读到一半换库 ⇒ 有限重试后 fail closed 成可重试 503）所依赖的换库动作在 Windows 上"
  + "做不出来，因此没有被检查；真正的 Windows 换库路径另立工单。"
);

test("TypeScript and Swift use the same unit, null, array order and six-decimal digest fixtures", () => {
  const fixtures = JSON.parse(readFileSync("apps/ios/tests/fixtures/prescription-digests.json", "utf8")) as Array<{ kind: string; structure: MobileSessionStructure | null; digest: string }>;
  for (const value of fixtures) assert.equal(prescriptionDigest(value.kind, value.structure), value.digest);
});

test("complete snapshot is stable across request clocks, captures recovery and publication inputs at the same goals revision", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-state-"));
  const path = join(root, "facts.sqlite");
  const database = await RaiDatabase.open(path);
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const read = new RaiReadStore(path);
  try {
    const first = read.trainingPlanState(store, identity);
    assert.equal(first.metadata.goalsRevision, first.today.recommendation.planRevision);
    assert.equal(first.metadata.goalsRevision, first.workoutPlan.planRevision);
    assert.equal(first.metadata.windowStart, "2026-10-09");
    assert.equal(first.metadata.windowEnd, "2026-10-15");
    assert.equal(first.workoutPlan.days.length, 7);
    assert.equal(first.coachSummary.plan, null);
    context.mock.timers.setTime(Date.parse("2026-10-09T04:01:00Z"));
    assert.equal(read.trainingPlanState(store, identity).metadata.coherenceToken, first.metadata.coherenceToken);
    database.database.prepare(`INSERT INTO canonical_nights(id, wake_date, timezone_identifier, kind, source_name, source_category,
      source_rank, has_stages, sleep_onset_at, wake_at, asleep_union_minutes, stage_minutes_json, segment_count, provenance_json)
      VALUES ('night','2026-10-09','Asia/Shanghai','main','fixture','apple_watch',1,0,'2026-10-08T15:00:00Z','2026-10-08T23:00:00Z',480,'{}',1,'{}')`).run();
    const recovery = read.trainingPlanState(store, identity);
    assert.equal(recovery.metadata.goalsRevision, first.metadata.goalsRevision);
    assert.notEqual(recovery.metadata.coherenceToken, first.metadata.coherenceToken);
    database.database.prepare("UPDATE canonical_nights SET asleep_union_minutes=120 WHERE id='night'").run();
    const shorter = read.trainingPlanState(store, identity);
    assert.notEqual(shorter.metadata.coherenceToken, recovery.metadata.coherenceToken);
    database.database.prepare("INSERT INTO import_manifest(key,value) VALUES ('dataset_version','import-2')").run();
    const imported = read.trainingPlanState(store, identity);
    assert.notEqual(imported.metadata.coherenceToken, shorter.metadata.coherenceToken);
    database.database.prepare(`INSERT INTO training_zone_profile_settings(id,revision,effective_from_local_date,resting_mode,
      maximum_mode,threshold_pace_mode) VALUES ('zone',1,'2026-10-09','auto','auto','auto')`).run();
    assert.notEqual(read.trainingPlanState(store, identity).metadata.coherenceToken, imported.metadata.coherenceToken);
    assert.equal(store.read().revision, 0, "aggregate reads never refresh or publish the coach");
  } finally { read.close(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("G06: main read view stays pinned and a control revision change discards the complete mixed candidate", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-state-race-"));
  const path = join(root, "facts.sqlite");
  const database = await RaiDatabase.open(path);
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const other = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const read = new RaiReadStore(path);
  try {
    // Inject the concurrent publication right after the attempt's control pair is
    // read (goals then history) and before its post-commit re-read: the mixed
    // candidate must be discarded, not returned or patched in place.
    const originalHistory = store.planHistory.bind(store);
    let changes = 0;
    store.planHistory = (limit?: number) => {
      const value = originalHistory(limit);
      if (changes++ === 0) {
        database.database.prepare("INSERT INTO import_manifest(key,value) VALUES ('dataset_version','new-facts')").run();
        other.write({ expectedRevision: 0, qualitySessionCap: 1 });
      }
      return value;
    };
    const result = read.trainingPlanState(store, identity);
    assert.equal(result.metadata.goalsRevision, 1);
    assert.equal(result.today.recommendation.planRevision, 1);
    assert.equal(result.workoutPlan.planRevision, 1);
    assert.ok(changes >= 2, "the candidate was rebuilt, not patched in place");
    store.planHistory = () => { other.write({ qualitySessionCap: 1 }); return originalHistory(); };
    assert.throws(() => read.trainingPlanState(store, identity), { code: "plan_snapshot_changed", statusCode: 503 });
  } finally { read.close(); other.close(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("P2-02: a WAL checkpoint moving the file mtime does not fail the plan snapshot", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-state-mtime-"));
  const path = join(root, "facts.sqlite");
  const database = await RaiDatabase.open(path);
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const read = new RaiReadStore(path);
  try {
    // A WAL checkpoint (import/recompute writer) writes pages back into the main
    // database file and moves its mtime *without* replacing it. That used to be
    // read as "published": `fileIdentity.mtimeMs !== currentFile.mtimeMs` threw
    // `plan_snapshot_changed` 503 even though the snapshot was consistent
    // (review P2-02). `planHistory` runs inside the snapshot build, i.e. between
    // the two stat calls, so bumping mtime here reproduces the checkpoint in the
    // middle of the read deterministically.
    const originalHistory = store.planHistory.bind(store);
    let bumped = 0;
    store.planHistory = (limit?: number) => {
      const value = originalHistory(limit);
      if (bumped++ === 0) {
        const at = new Date();
        utimesSync(path, at, new Date(at.getTime() + 5_000));
      }
      return value;
    };
    const state = read.trainingPlanState(store, identity);
    // Two control reads per successful attempt (build + post-build verification);
    // the mtime bump landed after the first one, i.e. between the two stat calls.
    assert.equal(bumped, 2, "the mtime change happened inside the snapshot read, after the opening stat");
    assert.equal(state.metadata.goalsRevision, 0);
  } finally { read.close(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("P2-02: replacing the database file mid-read retries and then fails closed with a retryable 503", { skip: FILE_REPLACEMENT_ONLY }, async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-state-replace-"));
  const path = join(root, "facts.sqlite");
  const database = await RaiDatabase.open(path);
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const read = new RaiReadStore(path);
  try {
    // A real import publication replaces the file (new inode). The snapshot built
    // from the old file must not be returned; the read retries and, when the
    // replacement keeps landing inside the read, answers the retryable 503
    // instead of an immediate throw (review P2-02).
    const originalHistory = store.planHistory.bind(store);
    let replacements = 0;
    store.planHistory = (limit?: number) => {
      const value = originalHistory(limit);
      replacements += 1;
      const staged = `${path}.replacement-${replacements}`;
      copyFileSync(path, staged);
      renameSync(staged, path);
      return value;
    };
    assert.throws(() => read.trainingPlanState(store, identity),
      { code: "plan_snapshot_changed", statusCode: 503 });
    assert.equal(replacements, 3, "one replaced file per attempt, then fail closed instead of returning a mixed snapshot");
  } finally { read.close(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("P3-2: a history-only change changes coherenceToken without moving goalsRevision", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-state-history-token-"));
  const path = join(root, "facts.sqlite");
  const database = await RaiDatabase.open(path);
  const controlPath = join(root, "control.sqlite");
  const store = new MobileGoalsStore(root, controlPath);
  const read = new RaiReadStore(path);
  try {
    const before = read.trainingPlanState(store, identity);
    // An external writer/migration can append a plan-history revision without
    // touching mobile_goals (the normal write path always bumps both). Today's
    // adherence/recentPlanExecution are derived from history, so the token has
    // to cover it as well (review P3-2).
    const writer = new DatabaseSync(controlPath);
    try {
      writer.prepare("INSERT INTO mobile_goals_history (revision, payload_json, changed_at) VALUES (?,?,?)")
        .run(before.metadata.goalsRevision,
          JSON.stringify({ weekPlan: [], lockedSession: null }), "2026-10-09T03:00:00.000Z");
    } finally { writer.close(); }
    const after = read.trainingPlanState(store, identity);
    assert.equal(after.metadata.goalsRevision, before.metadata.goalsRevision,
      "a history-only change must not move the goals revision");
    assert.notEqual(after.metadata.coherenceToken, before.metadata.coherenceToken,
      "history is an input of the aggregate (adherence/recentPlanExecution) and must invalidate the token");
  } finally { read.close(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a stopped programme has a complete empty execution window, not a read failure", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-12-29T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-state-empty-"));
  const path = join(root, "facts.sqlite");
  (await RaiDatabase.open(path)).close();
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const read = new RaiReadStore(path);
  try {
    const plan: MobileRunCoachPlan = { ...config, id: randomUUID(), startedOn: "2026-12-01", status: "ended",
      pausedOn: null, endedOn: "2026-12-28", adaptationKey: null, adaptedAt: null };
    store.write({}, { runCoach: plan });
    const result = read.trainingPlanState(store, identity);
    assert.equal(result.availability, "empty");
    assert.equal(result.metadata.windowEnd, "2027-01-04");
    assert.ok(result.workoutPlan.days.every(day => !day.executable));
    assert.equal(result.coachSummary.plan?.status, "ended");
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("G07: publication response, history and CAS survive restart and reject changed request, scope or expired keys", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publication-"));
  const path = join(root, "control.sqlite");
  let store = new MobileGoalsStore(root, path);
  const operationId = randomUUID();
  const input = { operationId, operationScope: identity(), expectedRevision: 0, qualitySessionCap: 1 };
  try {
    const first = new PlanPublicationService(store, () => "scope", identity).publish("goals", input, () => store.write(input));
    store.close(); store = new MobileGoalsStore(root, path);
    const publication = new PlanPublicationService(store, () => "scope", identity);
    assert.deepEqual(publication.publish("goals", input, () => { throw new Error("must not replay"); }), first);
    assert.equal(store.read().revision, 1);
    assert.equal(store.planHistory().filter(item => item.revision === 1).length, 1);
    assert.equal((publication.result(operationId) as { status: string }).status, "committed");
    assert.throws(() => publication.publish("goals", { ...input, qualitySessionCap: 2 }, () => store.write(input)), { code: "plan_operation_key_conflict" });
    assert.throws(() => new PlanPublicationService(store, () => "other-epoch",
      () => ({ ...identity(), datasetEpoch: "other" })).publish("goals", input, () => store.write(input)), { code: "plan_operation_scope_mismatch" });
    const database = new DatabaseSync(path);
    database.prepare("UPDATE mobile_plan_operations SET expires_at='2000-01-01T00:00:00Z'").run();
    database.close();
    assert.throws(() => publication.publish("goals", input, () => store.write(input)), { code: "plan_operation_expired" });
    assert.equal((publication.result(operationId) as { status: string }).status, "expired");
    assert.equal(store.read().revision, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("operation-result persistence failure rolls back both goals and history", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publication-rollback-"));
  const path = join(root, "control.sqlite");
  const store = new MobileGoalsStore(root, path);
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON mobile_plan_operations BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => new PlanPublicationService(store, () => "scope", identity)
      .publish("goals", { operationId: randomUUID(), operationScope: identity() }, () => store.write({ qualitySessionCap: 1 })), /injected/);
    assert.equal(store.read().revision, 0);
    assert.equal(store.planHistory().length, 1);
  } finally { database.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an uncommitted intent is bound to its original dataset, not only keys already present on the server", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-intent-scope-"));
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  let epoch = "old";
  const publication = new PlanPublicationService(store, () => epoch, () => ({ ...identity(), datasetEpoch: epoch }));
  const input = { operationId: randomUUID(), operationScope: { ...identity(), datasetEpoch: epoch }, expectedRevision: 0 };
  try {
    epoch = "replacement";
    assert.throws(() => publication.publish("goals", input, () => store.write(input)), { code: "plan_operation_scope_mismatch" });
    assert.equal(store.read().revision, 0);
    assert.throws(() => publication.publish("goals", { operationId: randomUUID() }, () => store.write({})), { code: "plan_operation_contract_mismatch" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("coach command same-key retry after server reconstruction returns its original response before CAS", () => {
  // The /v1/mobile/run-coach route is retired (410). The publication contract it
  // exercised is still live for every remaining writer, so pin the same idempotency
  // at the PlanPublicationService boundary: a rebuilt service returns the stored
  // result before touching CAS, and a different request under the same key conflicts.
  const root = mkdtempSync(join(tmpdir(), "rai-coach-operation-"));
  let store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const publication = () => new PlanPublicationService(store, () => "scope", identity);
  try {
    const payload = { operationId: randomUUID(), operationScope: identity(), expectedRevision: 0 };
    const first = publication().publish("run-coach", payload, () => store.write({ qualitySessionCap: 1 }));
    store.close();
    store = new MobileGoalsStore(root, join(root, "control.sqlite"));
    const retry = publication().publish("run-coach", payload, () => store.write({ qualitySessionCap: 1 }));
    assert.deepEqual(retry, first);
    assert.equal(store.read().revision, 1);
    assert.throws(() => publication().publish("run-coach", { ...payload, expectedRevision: 1 },
      () => store.write({ qualitySessionCap: 2 })), { code: "plan_operation_key_conflict" });
    assert.equal(store.read().revision, 1, "the conflicting replays must not write");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
test("G08: receipt lifecycle preserves immutable history and bounds execution associations to validity time", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-receipt-events-"));
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const workoutID = randomUUID();
  const base = { localDate: "2026-10-09", kind: "easy" as const, revision: 1, structure, workoutID, scheduledAt: "2026-10-09T00:00:00Z",
    idempotencyKey: workoutID, operationId: randomUUID(), scope: identity(), coherenceToken: "a".repeat(64),
    verifiedAt: "2026-10-08T20:00:00Z", timezone: "Asia/Shanghai", prescriptionDigest: prescriptionDigest("easy", structure),
    lifecycleEvent: "verified" as const, contractVersion: 2 as const, matchesCurrent: false, pushedAt: "2026-10-08T21:00:00Z" };
  try {
    const recordedAt = store.recordPlanPush(base);
    assert.equal(store.recordPlanPush({ ...base, matchesCurrent: true, pushedAt: "2026-10-08T22:00:00Z" }), recordedAt);
    assert.equal(store.recordPlanPush({ ...base, idempotencyKey: "another-retry-key", pushedAt: "2026-10-08T22:01:00Z" }), recordedAt,
      "the same UUID/time/event is idempotent even if a caller supplies a different retry key");
    store.recordPlanPush({ ...base, idempotencyKey: workoutID + ":withdrawn", lifecycleEvent: "withdrawn",
      verifiedAt: "2026-10-09T01:00:00Z", pushedAt: "2026-10-09T01:01:00Z" });
    assert.equal(store.planPushes("2026-10-01").length, 2);
    const candidates = assemblePlanCandidates(store.planPushes("2026-10-01"), []);
    assert.equal(candidates.length, 1);
    assert.notEqual(matchPlanDay({ candidates, startedAtMs: Date.parse("2026-10-09T00:00:00Z"), localDate: base.localDate, distanceKm: 4 }), null);
    assert.equal(matchPlanDay({ candidates, startedAtMs: Date.parse("2026-10-09T02:00:00Z"), localDate: base.localDate, distanceKm: 4 }), null);
    assert.throws(() => store.recordPlanPush({ ...base, idempotencyKey: "other", prescriptionDigest: "b".repeat(64) }), PlanOperationError);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
