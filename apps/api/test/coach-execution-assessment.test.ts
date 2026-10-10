import assert from "node:assert/strict";
import test from "node:test";
import { assessWorkoutExecution, assessWorkoutExecutionBatch, coachQualityExecutionSummary } from "../src/coach-execution-assessment.js";
import { digest, prescriptionDigest } from "../src/plan-digest.js";
import { EXECUTION_AS_OF, executionFixture, executionEvidenceRef } from "../../../scripts/coach-execution-fixtures.mjs";

const evaluate = (fixture = executionFixture()) => assessWorkoutExecution({
  asOf: EXECUTION_AS_OF, prescription: fixture.prescription,
  workouts: [fixture.workout], associations: [fixture.association]
});

test("AC2-01/04: observed light running and reconstructed groups cannot certify intervals", () => {
  const fixture = executionFixture();
  const measured = evaluate(fixture);
  assert.equal(measured.observation, "observed");
  assert.equal(measured.dose.status, "met");
  assert.equal(measured.dose.requiredReps, 4);
  assert.equal(measured.dose.verifiedReps, 4);
  assert.equal(measured.stimulus.status, "matched");
  assert.equal(measured.completion, "confirmed");
  for (const evidenceLevel of ["summary_only", "reconstructed_segments"] as const) {
    const weak = evaluate({ ...fixture, workout: { ...fixture.workout, evidenceLevel } });
    assert.equal(weak.observation, "observed");
    assert.equal(weak.dose.verifiedReps, null);
    assert.equal(weak.dose.status, "not_assessable");
    assert.equal(weak.stimulus.status, "not_assessable", "plan labels and averages are not time-in-target measurements");
    assert.equal(weak.completion, "unconfirmed");
    assert.ok(weak.reasons.some(reason => reason.code === "rep_evidence_unavailable"));
  }
  const light = evaluate({ ...fixture, workout: { ...fixture.workout, signalIntervals:
    fixture.workout.signalIntervals.map(interval => ({ ...interval, value: 390 })) } });
  assert.equal(light.dose.status, "met");
  assert.equal(light.stimulus.status, "too_easy");
  assert.equal(light.completion, "known_not_met");
});

test("AC2-02/03: no record is unknown; strong dose with no signal stays unconfirmed", () => {
  const fixture = executionFixture();
  const absent = assessWorkoutExecution({ asOf: EXECUTION_AS_OF,
    prescription: fixture.prescription, workouts: [], associations: [] });
  assert.equal(absent.observation, "unknown");
  assert.equal(absent.dose.status, "not_assessable");
  assert.equal(absent.stimulus.status, "not_assessable");
  assert.equal(absent.completion, "unconfirmed");
  assert.ok(!absent.reasons.some(reason => /missed|not_met/.test(reason.code)));
  const noSignal = evaluate({ ...fixture, workout: { ...fixture.workout, signalIntervals: [] } });
  assert.equal(noSignal.dose.status, "met");
  assert.equal(noSignal.stimulus.status, "not_assessable");
  assert.equal(noSignal.completion, "unconfirmed");
});

test("AC2-05: 89.9/90% per-group dose and 79.9/80% signal coverage boundaries are independent", () => {
  const fixture = executionFixture();
  for (const fraction of [0.899, 0.9]) {
    const result = evaluate({ ...fixture, workout: { ...fixture.workout, segments:
      fixture.workout.segments.map(segment => segment.purpose === "work" ?
        { ...segment, distanceMeters: 800 * fraction } : segment) } });
    assert.equal(result.dose.status, fraction === 0.9 ? "met" : "partial");
    assert.equal(result.dose.verifiedReps, fraction === 0.9 ? 4 : 0);
  }
  for (const fraction of [0.799, 0.8]) {
    const result = evaluate({ ...fixture, workout: { ...fixture.workout, signalIntervals:
      fixture.workout.signalIntervals.map(interval => ({ ...interval, durationSeconds: interval.durationSeconds * fraction })) } });
    assert.equal(result.dose.status, "met");
    assert.equal(result.stimulus.status, fraction === 0.8 ? "matched" : "not_assessable");
    assert.equal(result.completion, fraction === 0.8 ? "confirmed" : "unconfirmed");
  }
  for (const fraction of [0.799, 0.8]) {
    const signals = fixture.workout.signalIntervals.flatMap(interval => [
      { ...interval, durationSeconds: interval.durationSeconds * fraction },
      { ...interval, startOffsetSeconds: interval.startOffsetSeconds + interval.durationSeconds * fraction,
        durationSeconds: interval.durationSeconds * (1 - fraction), value: 390 }
    ]);
    const result = evaluate({ ...fixture, workout: { ...fixture.workout, signalIntervals: signals } });
    assert.equal(result.stimulus.status, fraction === 0.8 ? "matched" : "too_easy");
  }
});

test("AC2-06: recovery run too fast is too hard, never improved completion credit", () => {
  const fixture = executionFixture("recovery");
  const result = evaluate({ ...fixture, workout: { ...fixture.workout, signalIntervals:
    fixture.workout.signalIntervals.map(interval => ({ ...interval, value: 250 })) } });
  assert.equal(result.dose.status, "met");
  assert.equal(result.stimulus.status, "too_hard");
  assert.equal(result.completion, "known_not_met");
});

test("AC2-07: one associated run is not combined with another; many obligations cannot reuse a run", () => {
  const fixture = executionFixture();
  const second = { ...fixture.workout, id: "other-run" };
  const result = assessWorkoutExecution({ asOf: EXECUTION_AS_OF, prescription: fixture.prescription,
    workouts: [second, fixture.workout], associations: [fixture.association] });
  assert.deepEqual(result.workoutIds, [fixture.workout.id]);
  assert.equal(result.dose.verifiedReps, 4);
  const both = assessWorkoutExecution({ asOf: EXECUTION_AS_OF, prescription: fixture.prescription,
    workouts: [second, fixture.workout],
    associations: [fixture.association, { ...fixture.association, workoutId: second.id }] });
  assert.equal(both.association.status, "ambiguous");
  assert.equal(both.completion, "unconfirmed");
  const batch = assessWorkoutExecutionBatch({ asOf: EXECUTION_AS_OF, prescriptions: [fixture.prescription,
    { ...fixture.prescription, day: { ...fixture.prescription.day, localDate: "2026-10-07" } }],
    workouts: [fixture.workout], associations: [fixture.association] });
  assert.ok(batch.every(row => row.association.status === "ambiguous" && row.completion === "unconfirmed"));
});

test("AC2-08: late training/signals, retracted receipts and after-the-run prescriptions cannot rewrite past evidence", () => {
  const fixture = executionFixture();
  const input = { prescription: fixture.prescription,
    workouts: [{ ...fixture.workout, availableAt: "2026-10-09T00:00:00Z" }],
    associations: [fixture.association] };
  const before = assessWorkoutExecution({ ...input, asOf: EXECUTION_AS_OF });
  assert.equal(before.observation, "unknown");
  assert.equal(before.completion, "unconfirmed");
  const after = assessWorkoutExecution({ ...input, asOf: "2026-10-09T04:00:00Z" });
  assert.equal(after.completion, "confirmed");
  assert.deepEqual(assessWorkoutExecution({ ...input, asOf: EXECUTION_AS_OF }), before);
  const retracted = evaluate({ ...fixture, association: { ...fixture.association, retractedAt: "2026-10-08T00:00:00Z" } });
  assert.equal(retracted.association.status, "unmatched");
  const expired = evaluate({ ...fixture, association: { ...fixture.association, validUntil: fixture.workout.startedAt } });
  assert.equal(expired.association.status, "unmatched");
  const afterRun = evaluate({ ...fixture, prescription: { ...fixture.prescription, createdAt: "2026-10-08T02:00:00Z" } });
  assert.equal(afterRun.association.status, "unmatched");
  const lateSignal = evaluate({ ...fixture, workout: { ...fixture.workout, signalIntervals:
    fixture.workout.signalIntervals.map(interval => ({ ...interval, availableAt: "2026-10-09T00:00:00Z" })) } });
  assert.equal(lateSignal.dose.status, "met");
  assert.equal(lateSignal.stimulus.status, "not_assessable");
});

test("actual work cannot pool one long group into four reps; missing recoveries and partial steps remain bounded", () => {
  const fixture = executionFixture();
  const first = fixture.workout.segments.find(segment => segment.purpose === "work")!;
  const oneGroup = evaluate({ ...fixture, workout: { ...fixture.workout,
    segments: [{ ...first, distanceMeters: 3200 }] } });
  assert.equal(oneGroup.dose.verifiedReps, 1);
  assert.notEqual(oneGroup.dose.status, "met");
  assert.equal(oneGroup.completion, "known_not_met");
  const partial = evaluate({ ...fixture, workout: { ...fixture.workout, measuredStepsComplete: false } });
  assert.equal(partial.dose.verifiedReps, null);
  assert.equal(partial.dose.status, "not_assessable");
  const noRecoveries = evaluate({ ...fixture, workout: { ...fixture.workout,
    segments: fixture.workout.segments.filter(segment => segment.purpose !== "recovery") } });
  assert.equal(noRecoveries.dose.status, "partial");
});

test("corrupt/overlapping signals cannot fake 80% coverage; interval HR without lag policy does not confirm", () => {
  const fixture = executionFixture();
  const overlapped = evaluate({ ...fixture, workout: { ...fixture.workout,
    signalIntervals: [...fixture.workout.signalIntervals, fixture.workout.signalIntervals[0]!] } });
  assert.equal(overlapped.stimulus.status, "not_assessable");
  const heartRate = structuredClone(fixture);
  for (const block of heartRate.prescription.day.structure!.blocks) for (const step of block.steps) {
    if (step.purpose === "work") step.alert = { kind: "heart_rate", lower: 160, upper: 172 };
  }
  heartRate.association.prescriptionDigest = prescriptionDigest(heartRate.prescription.day.kind, heartRate.prescription.day.structure!);
  heartRate.workout.signalIntervals = heartRate.workout.signalIntervals.map(interval => ({
    ...interval, channel: "heart_rate", value: 165
  }));
  assert.equal(evaluate(heartRate).stimulus.status, "not_assessable");
  assert.ok(evaluate(heartRate).reasons.some(reason => reason.code === "interval_hr_lag_policy_unavailable"));
});

test("rest is not applicable; input stays immutable and candidate conclusions are deterministic", () => {
  const fixture = executionFixture();
  const original = digest(fixture);
  assert.deepEqual(evaluate(fixture), evaluate(fixture));
  assert.equal(digest(fixture), original);
  assert.equal(evaluate(fixture).policyStatus, "candidate");
  const resting = assessWorkoutExecution({ asOf: EXECUTION_AS_OF, prescription: { ...fixture.prescription,
    day: { ...fixture.prescription.day, kind: "rest", structure: null } },
    workouts: [fixture.workout], associations: [] });
  assert.equal(resting.observation, "observed");
  assert.equal(resting.completion, "not_applicable");
  const corroborating = assessWorkoutExecution({ asOf: EXECUTION_AS_OF, prescription: fixture.prescription,
    workouts: [fixture.workout], associations: [{ ...fixture.association, method: "plan_history",
      evidenceRef: executionEvidenceRef("plan_history", "history-binding") }, fixture.association] });
  assert.equal(corroborating.association.method, "measured_steps_with_plan");
  assert.equal(corroborating.completion, "confirmed");
});

test("candidate quality summary preserves observed semantics, unknown denominator and one frozen fact clock", () => {
  const fixture = executionFixture();
  const unknown = { ...fixture.prescription, day: { ...fixture.prescription.day, localDate: "2026-10-07" } };
  const weak = evaluate({ ...fixture, workout: { ...fixture.workout, evidenceLevel: "summary_only" } });
  const summary = coachQualityExecutionSummary({
    asOf: EXECUTION_AS_OF, prescriptions: [fixture.prescription, unknown],
    observedDates: [fixture.prescription.day.localDate], assessments: [weak]
  });
  assert.equal(summary.qualityPlanned, 2);
  assert.equal(summary.qualityObserved, 1);
  assert.equal(summary.qualityConfirmed, 0);
  assert.equal(summary.qualityKnownNotMet, 0);
  assert.equal(summary.qualityUnconfirmed, 2);
  assert.equal(coachQualityExecutionSummary({ asOf: EXECUTION_AS_OF, prescriptions: [fixture.prescription],
    observedDates: [fixture.prescription.day.localDate], assessments: [evaluate(fixture)] }).qualityConfirmed, 1);
  assert.throws(() => coachQualityExecutionSummary({ asOf: EXECUTION_AS_OF,
    prescriptions: [fixture.prescription], observedDates: [], assessments: [{ ...weak, asOf: "2026-10-09T04:00:00Z" }] }),
    /mix fact clocks/);
  assert.throws(() => coachQualityExecutionSummary({ asOf: EXECUTION_AS_OF,
    prescriptions: [fixture.prescription, fixture.prescription], observedDates: [], assessments: [weak] }),
    /one frozen obligation/);
});
