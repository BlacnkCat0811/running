# ADR-005: Temporal Training Labels

- Status: Accepted
- Date: 2026-10-03
- Scope: Race residual training, manual performance labels and label funnel

## Context

Commit `a5598b7` reused current-evidence leave-one-out calibration for manual
supervised training labels. A sample's baseline and physiology could therefore
depend on evidence after the race while its training-load features described the
race date. Sorting by label availability and applying an embargo does not remove
future information already embedded in a feature vector.

## Decision

Every training outcome, recorded or manual, builds its formula baseline and
features at `observedAt`, excluding every representation of its event (including
training load, preparation, threshold and envelope evidence). Confirming a workout
preserves its server-derived session identity and start/end timestamps. Date-only
results use local midnight as the conservative feature cutoff, not an inferred
noon start. Cross-source outcomes are deduplicated and ordered by absolute instant.
`labelAvailableAt` controls when
the target becomes available; it does not change the feature cutoff. A result
without a computable pre-race baseline is excluded from temporal training.

Indirect event exclusions may use only labels available at the feature cutoff:
recorded by `asOf` and not yet revoked then. A future or revoked date-only label
cannot join independent same-day sessions. Explicit held-out targets retain their
own event identity even before confirmation, so retrospective training can still
exclude the target's measurements. Baseline and load features share the resulting
exclusion set.

Current-evidence leave-one-out remains valid only for prospective personal
self-calibration, with no population coverage or historical evaluation claim.
The label funnel separately reports eligible outcomes, actual training samples,
excluded outcomes, and per-distance training sample counts using the same dataset
builder as preflight and the runner.

## Consequences

Retrospectively entered results without pre-race evidence can contribute only as
personal calibration candidates, not as temporal training samples. Historical
results with independently available pre-race evidence remain eligible. The
personal 24/4 intake floor does not relax release splits or activation gates.

CatBoost v5 intentionally rejects v4 artifacts and runs without changing the
feature schema/hash. Scope is mandatory in new manifests and must match the run.
This bump alone does not change the ability baseline hash: that hash references
the ability model version, not the CatBoost model version.

The event-exclusion correction separately advances the formula baseline to v5.
The health-interval correction advances it to v6: health evidence must have ended
by the feature cutoff, and intervals overlapping the held-out event are excluded,
even if they began before the event. VO2 evidence is dated at sample completion.
Its version participates in the ability baseline hash, so residual models and
intervals using formula v4 or v5 cannot serve or reactivate under the corrected
logic. Retraining and republishing calibration are required; historical audit
rows remain intact and no new migration is needed.

## Verification

- `prediction-training-data.test.ts`: later labels and physiology cannot change
  an earlier sample; retrospective results without prior evidence are excluded;
  funnel counts equal the dataset size.
- `research/tests/test_cli.py`: personal intake reaches Python but cannot bypass
  release-split floors.
- Artifact regressions reject missing, invalid or mismatched scope.
- Event-exclusion regressions preserve explicit targets and historical availability,
  while fixed historical datasets ignore later date-only associations and revocation.
- Health-interval regressions reject samples crossing the cutoff or overlapping
  a held-out event, using absolute instants across timezone offsets.
- Formula-v4/v5 model activation, serving and interval selection fail closed on v6.

Migration 28 adds nullable event identity and clocks without guessing historical
links or rewriting health facts. It retires existing residual pointers. Revocation,
override revision and confirmed source invalidation advance a transactional label
generation included in formula baseline v4. Old models cannot reactivate and old
intervals cannot match the new baseline; artifacts remain auditable. This is a
conservative global invalidation policy, not a claim of per-artifact dependencies.

Migration 29 also invalidates unlinked manual entries that represent an existing
date/distance workout event. Independent date-only entries retain their existing
append behavior. The upgrade advances the label generation and retires potentially
stale residual pointers without changing historical migrations or audit rows.
