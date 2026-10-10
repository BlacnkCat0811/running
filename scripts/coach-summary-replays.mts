import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { PhysiologyPredictionReport } from "@rai/contracts";
import type { CoachPredictionSummary } from "@rai/api-contracts";
import { SqliteCoachFactsRepository } from "@rai/storage-sqlite";
import { coachPredictionIdentity, publishCoachPredictionCompanion } from "../apps/api/src/coach-prediction-companion.js";
import { coachGoalGap } from "../apps/api/src/coach-goal-gap.js";
import { repairCoachPlan } from "../apps/api/src/coach-plan-repair.js";
import { digest } from "../apps/api/src/plan-digest.js";
import { syntheticRepairEasy, syntheticRepairRest } from "./coach-repair-fixtures.mjs";
import { runtimeReplayScope as scope } from "./coach-runtime-fixtures.mjs";
import { replayAcceptanceCases, type AcceptanceReplayCase } from "./coach-acceptance-trace.mjs";

const cases: AcceptanceReplayCase[] = [
  { id: "R08-acceptance-companion-publication-and-scenario", evidenceBoundary:
    "synthetic_report_real_sqlite_transaction_not_prediction_accuracy", execute(check) {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE active_model_run(singleton INTEGER,model_run_id TEXT);
      CREATE TABLE model_release_bundles(model_run_id TEXT,snapshot_hash TEXT,status TEXT);
      INSERT INTO active_model_run VALUES(1,'bundle');
      INSERT INTO model_release_bundles VALUES('bundle','sealed','passed');
      CREATE TABLE import_manifest(key TEXT,value TEXT);
      INSERT INTO import_manifest VALUES('generation','1');
      CREATE TABLE effective_workout_overrides(training_session_id TEXT);
      CREATE TABLE performance_entries(id TEXT);
      CREATE TABLE active_prediction_model(singleton INTEGER,model_run_id TEXT);
      CREATE TABLE training_sessions(anchor_end_at TEXT,status TEXT);
      INSERT INTO training_sessions VALUES('2026-10-09T01:00:00Z','active');
      CREATE TABLE coach_prediction_summaries(scope TEXT,id TEXT,identity_hash TEXT,available_at TEXT,payload_json TEXT,PRIMARY KEY(scope,id));
    `);
    try {
      const identity = coachPredictionIdentity(db, scope)!;
      const report = { predictionPolicy: { mode: "current_prepared" }, generatedAt: "2026-10-10T01:00:00Z",
        snapshot: { races: [{ distance: "ten_k", predictedSeconds: 3000, method: "formula" }] } } as unknown as PhysiologyPredictionReport;
      const summary = publishCoachPredictionCompanion(db, identity, report, "2026-10-10T02:00:00Z");
      const input = { asOf: "2026-10-10T03:00:00Z", distance: "ten_k" as const, targetSeconds: 2700,
        summary, currentIdentity: identity };
      const out = coachGoalGap(input);
      check("AC6-02", "uncalibrated-is-not-probability", input, out, () => {
        assert.equal(out.referenceSeconds, 3000); assert.equal(out.gapSeconds, 300);
        assert.equal(out.calibrationStatus, "uncalibrated");
        assert.equal(summary.entries[0]!.range, null);
        assert.ok(!("probability" in out) && !("successRate" in out) && !("confidence" in out));
      });
      const potential = { ...summary, scenario: "neutral_potential" as CoachPredictionSummary["scenario"],
        entries: [{ ...summary.entries[0]!, referenceSeconds: 2000 }] };
      const potentialGap = coachGoalGap({ ...input, summary: potential });
      check("AC6-08", "potential-never-replaces-current-prepared", { ...input, summary: potential }, potentialGap, () => {
        assert.equal(summary.scenario, "current_prepared");
        assert.equal(out.referenceSeconds, 3000);
        assert.equal(potentialGap.status, "incompatible"); assert.equal(potentialGap.gapSeconds, null);
        assert.throws(() => publishCoachPredictionCompanion(db, identity,
          { ...report, predictionPolicy: { ...report.predictionPolicy, mode: "neutral_potential" } } as PhysiologyPredictionReport,
          "2026-10-10T04:00:00Z"), /current_prepared/);
      });
      const before = digest(db.prepare("SELECT * FROM coach_prediction_summaries").all());
      db.exec("CREATE TRIGGER fail_summary AFTER INSERT ON coach_prediction_summaries BEGIN SELECT RAISE(ABORT,'injected summary fault'); END");
      assert.throws(() => publishCoachPredictionCompanion(db, identity, report, "2026-10-10T04:00:00Z"), /injected/);
      check("AC6-07", "summary-insert-fault-is-atomic", { identity, report }, { summaryHash: before }, () => {
        assert.equal(digest(db.prepare("SELECT * FROM coach_prediction_summaries").all()), before);
        assert.deepEqual(new SqliteCoachFactsRepository(db).summary(JSON.stringify([scope.athleteId, scope.datasetEpoch]),
          digest(identity), "2026-10-10T05:00:00Z"), summary);
      });
      db.exec("DROP TRIGGER fail_summary; UPDATE import_manifest SET value='2'");
      const current = coachPredictionIdentity(db, scope)!;
      assert.throws(() => publishCoachPredictionCompanion(db, identity, report, "2026-10-10T06:00:00Z"), /changed/);
      check("AC6-07", "changed-input-rejects-in-flight-summary", { identity, current }, { summaryHash: before }, () => {
        assert.equal(digest(db.prepare("SELECT * FROM coach_prediction_summaries").all()), before);
        assert.equal(new SqliteCoachFactsRepository(db).summary(JSON.stringify([scope.athleteId, scope.datasetEpoch]),
          digest(current), "2026-10-10T07:00:00Z"), null);
        assert.equal(db.prepare("SELECT snapshot_hash FROM model_release_bundles").get()?.snapshot_hash, "sealed");
      });
    } finally { db.close(); }
  } },
  { id: "R10-acceptance-independent-small-window-oracle", evidenceBoundary:
    "synthetic_easy_rest_enumeration_not_independent_human_review_or_all_templates", execute(check) {
    const dates = ["2026-10-08", "2026-10-10"], previous = dates.map(syntheticRepairEasy);
    // Independent fixture-owned durations/costs: retain 30m, alternate 40m,
    // rest 0m; production cost helpers are not used by the oracle.
    const options = dates.map((date, i) => {
      const longer = structuredClone(previous[i]!);
      longer.day.structure!.blocks[0]!.steps[0]!.goal = { type: "time", seconds: 1800 };
      return [
        { ...previous[i]!, templateId: "keep-original", originDate: date, preferenceRank: 0 },
        { ...longer, templateId: "longer", originDate: date, preferenceRank: 1 },
        { ...syntheticRepairRest(date), templateId: "rest", originDate: null, preferenceRank: 2 }
      ];
    });
    const oracle: number[][] = [];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      const selected = [a, b], seconds = selected.reduce((sum, i) => sum + [1800, 2400, 0][i]!, 0);
      if (seconds > 1800) continue;
      oracle.push([selected.filter(i => i !== 0).length, 0, selected.filter(i => i === 2).length,
        selected.filter(i => i === 1).length * .5, a + b]);
    }
    oracle.sort((a, b) => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
      return 0;
    });
    const solve = () => repairCoachPlan({
      previous, windowDates: dates, affectedDates: dates, protectedDates: [], requiredIntentDates: [],
      candidates: Object.fromEntries(dates.map((date, i) => [date, options[i]!.slice(1)])),
      maximumEvaluations: 9, inputDigest: digest(previous), reasonsByDate: {},
      validate: days => ({ feasible: days.reduce((sum, day) => sum + (day.kind === "rest" ? 0 :
        600 + (day.structure!.blocks[0]!.steps[0]!.goal as { seconds: number }).seconds), 0) <= 1800,
      effectiveDays: days.map(day => ({ day, executable: day.kind !== "rest", authorizedDecisionRef: null })), reasons: [] })
    });
    const result = solve();
    check("AC3-09", "nine-combinations-independent-optimum", { previous, options }, result, () => {
      assert.equal(result.evaluatedCandidates, 9);
      assert.deepEqual(Object.values(result.cost!), oracle[0]);
      assert.equal(result.status, "patched");
    });
    check("AC3-07", "equal-cost-deterministic-tie-break", { previous, options }, result,
      () => assert.deepEqual(solve(), result));
  } }
];
export function coachSummaryReplays() { return replayAcceptanceCases(cases); }
