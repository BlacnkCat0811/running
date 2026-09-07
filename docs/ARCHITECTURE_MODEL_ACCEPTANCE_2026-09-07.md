# Architecture and Model Acceptance

Date: 2026-09-07. Independent reviewer: Astra, medium.
Scope: final uncommitted changes against baseline `18b3298`, desktop Web,
API and required shared packages. Verdict: **PASS** for the bounded audit
implementation. No unresolved actionable product defects were found in the
final changes.

## Reviewed Behavior

- Inactivity never increases valid ability values from 0 through 100. Values
  at or above 20 retain the existing floor; lower values decay toward zero.
  Nonfinite inputs fail explicitly.
- Nonfinite raw scoring signals become unavailable evidence. Invalid baseline
  scales fail explicitly; valid inputs preserve the existing scoring formula.
- Calibration and replay sort by actual time, then stable training-session
  identity. Changing feature-run IDs does not reorder distinct equal-time
  sessions. Invalid dates fail explicitly.
- Recovery reads use canonical HRV when its table exists, including returning
  missing evidence when that table has no matching facts. Legacy absence uses
  raw HRV. Completion boundaries, recent sleep, and timezone isolation were
  checked. Missing-table compatibility does not suppress malformed SQL.
- The original sleep, resting-heart-rate and HRV clamps and arithmetic mean
  remain intact. Unused training-load reads were removed.
- Model configuration v4 participates in checkpoint version and configuration
  predicates. Formula baseline v2 participates in the residual-model baseline
  hash, which is checked before inference. These version gates were inspected
  in code; existing incompatible-model tests also passed.
- The temporary API-only timezone environment setting was removed after
  review identified a mismatch with canonical writes. The final API has no
  semantic diff and retains its existing Shanghai default.

## Verification Evidence

Executed independently by this reviewer:

- Focused suite: `node --import tsx --test --test-reporter=dot
  packages/scoring/test/scoring.test.ts
  packages/storage-sqlite/test/prediction-recovery-read-repository.test.ts
  packages/application/test/prediction-data.test.ts
  packages/application/test/prediction-model-service.test.ts
  packages/application/test/service.test.ts`: 70 tests passed, exit 0.
- Additional in-memory checks: six ability values over eight inactivity
  durations, including extreme finite duration; NaN and both infinities;
  invalid baseline scales; known finite score; mixed-offset chronological
  ordering and changed run IDs; raw future completion filtering; timezone
  isolation; original aggregate result 0.5; malformed sleep SQL propagation.
- Read the final product diff, new repository, tests, model-version gates,
  canonical timestamp production, audit scope and implementation record.

Reported by the root agent on the final snapshot:

- Typecheck passed, including the pure-package configuration.
- Full tests passed: 446 Node/API/package tests and 59 Web tests.
- Web build passed.
- Desktop Web E2E stable rerun: 10 passed, 0 failed, 1 frozen narrow-screen
  test skipped. The initial run had one heading timeout in the external zone
  revision flow; its cause was not established. The subsequent stable rerun
  passed without Web or E2E code changes. This remains a test-stability
  observation, not evidence of a confirmed product regression.

The initial reviewer run during test edits failed one legacy fixture assertion;
the corrected fixture and final focused suite passed. An extra reviewer check
initially used an incorrect expected z-scale of 12; correcting it to the
existing configured value 10 passed. Neither failure established a product bug.

## Limits and Follow-Up

No real health database was modified, recomputed or activated. No native or
frozen responsive implementation was changed. No mobile verification was run.

Acceptance establishes implementation correctness for the reviewed boundaries,
not scientific predictive accuracy. There was no new race-label evaluation,
weight fitting, clinical validation, or production-scale performance benchmark.
Legacy schemas without completion timestamps cannot establish a completion time
that they did not store; that fallback retains start-time semantics.

Some additional edge checks above were one-off reviewer checks rather than
committed regression tests. Old checkpoint exclusion was verified through its
explicit version predicates, not a newly constructed v3 checkpoint migration
fixture. Existing replay and model incompatibility tests passed.

The remaining SQL in prediction-data and the large recompute pipeline still
need staged decomposition, preserving transaction boundaries, cancellation,
checkpoint compatibility, activation gates and incremental/full replay parity.
Those architecture stages and scientific evaluation remain future work, as
defined in the audit document; they are not included in this PASS verdict.
