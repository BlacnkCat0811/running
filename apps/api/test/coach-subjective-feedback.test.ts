import assert from "node:assert/strict";
import test from "node:test";
import type { SubjectiveFeedback } from "@rai/api-contracts";
import { buildSubjectiveFeedback, effectiveSubjectiveFeedback, retractSubjectiveFeedback } from "../src/coach-subjective-feedback.js";
import { digest } from "../src/plan-digest.js";

const scope = { athleteId: "synthetic", datasetEpoch: "synthetic-v1" };
const fields = (): Parameters<typeof buildSubjectiveFeedback>[0]["fields"] => ({
  phase: "pre_run", observedAt: "2026-10-08T01:00:00Z", workoutId: null,
  fatigue: null, soreness: null, discomfort: null, requestedAction: null,
  interruptionReason: null, replacementReason: null, rpeOverrideRef: null
});
const build = (overrides: Partial<Parameters<typeof buildSubjectiveFeedback>[0]> = {}) => buildSubjectiveFeedback({
  id: "synthetic-feedback", revision: 1, scope, fields: { ...fields(), fatigue: "elevated" },
  recordedAt: "2026-10-08T02:00:00Z", availableAt: "2026-10-08T02:00:00Z",
  knownWorkoutIds: ["workout-1"], knownRpeOverrides: [{ workoutId: "workout-1", revision: 2 }], ...overrides
});
const effective = (revisions: SubjectiveFeedback[], asOf = "2026-10-08T04:00:00Z") =>
  effectiveSubjectiveFeedback({ asOf, scope, revisions });

test("AC5-01 candidate: skipping creates no record and does not invent normal or poor recovery", () => {
  assert.equal(build({ fields: fields() }), null);
  const empty = effective([]);
  assert.equal(empty.evidenceStatus, "none");
  assert.equal(empty.restRequested, false);
  assert.equal(empty.qualityBlocked, false);
  assert.equal(empty.extensionBlocked, false);
  assert.deepEqual(empty.activeFeedbackIds, []);
  const elevated = effective([build()!]);
  assert.equal(elevated.evidenceStatus, "available");
  assert.equal(elevated.restRequested, false);
  assert.equal(elevated.qualityBlocked, false, "fatigue alone is not an unreviewed mandatory-rest rule");
  assert.ok(elevated.reasons.some(reason => reason.code === "subjective_fatigue_reported"));
  assert.ok(!("recoveryScore" in elevated) && !("trueAbility" in elevated) && !("currentAbility" in elevated));
});

test("AC5-02/03 candidate: fixed Shanghai midnight, late availability and post-run comments cannot become tomorrow's pre-run state", () => {
  const row = build()!;
  assert.equal(row.localDate, "2026-10-08");
  assert.equal(Date.parse(row.validUntil), Date.parse("2026-10-08T16:00:00Z"));
  assert.equal(effective([row], "2026-10-08T15:59:59Z").evidenceStatus, "available");
  assert.equal(effective([row], "2026-10-08T16:00:00Z").evidenceStatus, "expired");
  const late = build({ recordedAt: "2026-10-09T01:00:00Z", availableAt: "2026-10-09T01:00:00Z",
    fields: { ...fields(), requestedAction: "rest" } })!;
  assert.equal(effective([late], "2026-10-08T04:00:00Z").evidenceStatus, "none");
  assert.equal(effective([late], "2026-10-09T04:00:00Z").restRequested, false);
  const post = build({ fields: { ...fields(), phase: "post_run", workoutId: "workout-1",
    interruptionReason: "fatigue", requestedAction: "rest" } })!;
  assert.equal(effective([post]).restRequested, false);
  assert.equal(effective([post], "2026-10-09T04:00:00Z").qualityBlocked, false);
});

test("AC5-04 candidate: explicit rest/easy requests and discomfort remain separate from device opinions", () => {
  const rest = build({ fields: { ...fields(), requestedAction: "rest" } })!;
  assert.equal(effective([rest]).restRequested, true);
  assert.equal(effective([rest]).qualityBlocked, true);
  assert.equal(effective([rest]).extensionBlocked, true);
  const easy = build({ fields: { ...fields(), requestedAction: "easy_only" } })!;
  assert.equal(effective([easy]).qualityBlocked, true);
  assert.equal(effective([easy]).restRequested, false);
  assert.equal(effective([easy]).extensionBlocked, false, "an easy preference neither raises nor by itself spends capacity");
  const discomfort = build({ fields: { ...fields(), discomfort: "present" } })!;
  assert.equal(effective([discomfort]).extensionBlocked, true);
  const combined = build({ fields: { ...fields(), fatigue: "high", soreness: "marked" } })!;
  assert.equal(effective([combined]).qualityBlocked, true);
});

test("AC5-05/06 candidate: RPE remains an existing override reference, not a duplicate feedback value", () => {
  assert.throws(() => build({ fields: { ...fields(), rpeOverrideRef: { workoutId: "workout-1", revision: 2 } } }),
    /Pre-run feedback/);
  assert.throws(() => build({ fields: { ...fields(), phase: "post_run", workoutId: "not-in-scope", requestedAction: "none" } }),
    /real workout/);
  assert.throws(() => build({ fields: { ...fields(), phase: "post_run", workoutId: "workout-1",
    rpeOverrideRef: { workoutId: "workout-1", revision: 1 } } }), /Unknown RPE override/);
  const post = build({ fields: { ...fields(), phase: "post_run", workoutId: "workout-1",
    rpeOverrideRef: { workoutId: "workout-1", revision: 2 } } })!;
  assert.deepEqual(post.rpeOverrideRef, { workoutId: "workout-1", revision: 2 });
  assert.ok(!("rpe" in post));
  assert.throws(() => build({ fields: { ...fields(), rpe: 6 } as ReturnType<typeof fields> }), /Unknown subjective feedback field/);
  assert.throws(() => build({ fields: { ...fields(), phase: "post_run", workoutId: "workout-1",
    rpeOverrideRef: { workoutId: "workout-1", revision: 2, value: 6 } as NonNullable<SubjectiveFeedback["rpeOverrideRef"]> } }),
    /Unknown RPE override/);
  assert.throws(() => build({ fields: { ...fields(), observedAt: "2026-10-09T01:00:00Z", requestedAction: "rest" } }), /future/);
});

test("AC5-07 candidate: append-only tombstones respect the decision clock and never fill gaps", () => {
  const original = build({ fields: { ...fields(), requestedAction: "rest" } })!;
  const before = digest(original);
  const tombstone = retractSubjectiveFeedback(original, {
    revision: 2, recordedAt: "2026-10-08T05:00:00Z", availableAt: "2026-10-08T05:00:00Z"
  });
  assert.equal(effective([original, tombstone], "2026-10-08T04:00:00Z").restRequested, true);
  assert.equal(effective([original, tombstone], "2026-10-08T06:00:00Z").restRequested, false);
  assert.equal(digest(original), before);
  assert.equal(effective([original], "2026-10-09T04:00:00Z").evidenceStatus, "expired");
  assert.equal(effectiveSubjectiveFeedback({ asOf: "2026-10-08T04:00:00Z", scope: { ...scope, datasetEpoch: "another" },
    revisions: [original] }).evidenceStatus, "none");
  assert.throws(() => effective([original, { ...original, fatigue: "high" }]), /Ambiguous feedback revision/);
  assert.throws(() => effective([{ ...original, validUntil: "2026-10-10T16:00:00Z" }]), /validity boundary/);
});
