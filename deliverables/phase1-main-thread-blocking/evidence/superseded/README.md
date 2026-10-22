# Superseded phase-1 evidence (2026-10-21)

These files are retained for provenance, **not** as reproducible acceptance evidence.

The original `noop-lock-bench.ts` accepted `RAI_PHASE1_MODE=baseline|patched`
but only changed the JSON `mode` label: both runs imported the same working-tree
source. Therefore the old "baseline" numbers cannot prove a before/after source
comparison. The old resource benchmark also called the private `ImportWorker.run()`
instead of the real HTTP entry point.

Current evidence is produced by:

- `bench/noop-lock-bench.ts` — selects one of the persisted source snapshots in
  `snapshots/`, starts an isolated API subprocess from it, and drives
  upload → inspect → import-jobs over HTTP.
- `bench/noop-resource-bench.ts` — same source-snapshot selection and HTTP path,
  cold start plus 100 sequential no-op batches.

Do not relabel these superseded files as current baseline.
