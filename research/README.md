# RAI CatBoost residual training

This directory is the isolated Python training environment. Production
inference does not import Python or CatBoost and loads only the validated
`model.onnx` artifact; user-triggered model training runs this environment in a
separate process.

## Environment

Python 3.12 is the reference runtime. Python 3.13 is accepted for local
development. The production start command runs this same preflight and fails
early with bootstrap guidance when the environment is unavailable.

```powershell
npm run ml:bootstrap
npm run ml:test
```

The bootstrap installs the fully pinned `research/requirements.lock`, then the
local package without dependency resolution. Set `RAI_PYTHON` to use an
equivalent managed environment instead of `research/.venv`.

## Input contract

Input is UTF-8 JSONL, sorted by the absolute instant represented by `observedAt`
and then `sampleId`. Every row must
use `schemaVersion: "race-residual-feature-v2"`. The TypeScript exporter owns
feature calculation and must use only information available strictly before the
labeled test or race starts. `null` is the only valid representation of a
missing numeric value; it is converted to `NaN` for CatBoost.

Training also requires `--data-through-at`. Every label must be completed by
that locked cutoff. Walk-forward fitting uses only labels whose `completedAt`
is no later than the prediction sample's `observedAt`, so overlapping workouts
and equal-start-time samples cannot leak outcomes into one another.

The complete ordered contract is emitted in `feature-schema.json` and enforced
by `rai_ml.contract`. The target is always:

```text
targetLogResidual = log(actualSeconds / baselinePredictedSeconds)
```

## Train

```powershell
npm run ml:train -- --input var/ml-datasets/race-residual-v2.jsonl --output var/model-artifacts/prediction/<run-id> --data-through-at 2026-07-11T00:00:00Z
```

The output directory must not already exist. Publication is atomic and contains:

- `model.onnx`
- `manifest.json`
- `feature-schema.json`
- `evaluation.json`

The worker may equivalently invoke
`python research/rai_ml/train.py --input <jsonl> --output-dir <directory> --data-through-at <ISO-8601>`.
Exit code `0` means the activation gate accepted the model, `2` means valid
artifacts were produced but the model was rejected, and `1` means training or
contract validation failed. A rejected model must never become active.

The manifest records the exact input-file SHA-256 and hashes for `model.onnx`,
`feature-schema.json`, and `evaluation.json`. The TypeScript runner verifies all
of them, along with CatBoost parameters, activation thresholds, exit-code/status
agreement, and ONNX parity before returning a result to the activation service.

Residual corrections are multiplicative. The predicted, optimistic, and
pessimistic times are all scaled by the same bounded factor, preserving the
relative interval shape used by offline and production inference.
