# Phase 1 evidence index

## Final lock-window evidence

- `http-lock-repaired.json` — current code; 5 rounds × 60 s, one 1.2 s external
  write lock per round, real HTTP no-op import, 4 concurrent health/dashboard
  request loops.
- `http-lock-phase1-prefix.json` — worker version before the close/receipt repairs.
- `http-lock-baseline.json` — pre-phase-1 source snapshot (no-op receipt
  transaction on the main thread).
- `*.requests.ndjson.gz` — per-request samples (phase, route, status, latency,
  timestamp) for the corresponding run.

Each snapshot's exact source tree and SHA256SUMS are under
`../snapshots/`. The JSON records the snapshot fingerprint actually executed.

## Final cold-start / 100-batch evidence

- `http-resource-baseline.json`
- `http-resource-phase1-prefix.json`
- `http-resource-repaired.json`

## Thresholds

- lock-window event-loop max ≤ 100 ms;
- locked health-check client P95 ≤ 250 ms;
- no new 5xx;
- `importPending=false` and no import temp files after 100 batches.

## Superseded

[superseded/](superseded/README.md) contains the earlier label-only baseline/patched files and the
private-`run()` resource measurement. They are provenance only; see
[superseded/README.md](superseded/README.md).
