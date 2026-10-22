# Phase 1 HTTP acceptance benchmarks

## Source selection

`RAI_PHASE1_MODE` selects one persisted source snapshot:

| mode | role |
|---|---|
| `baseline` | pre-phase-1 no-op receipt transaction (HEAD versions of the four phase-1 files), with all other working-tree changes preserved |
| `phase1-prefix` | worker-offload implementation before the 2026-10-21 close/receipt repairs |
| `repaired` | current implementation after the repairs |

The benchmark materialises `<snapshot>/apps/api/src` into a temp directory,
symlinks the repository `node_modules`, and spawns that API subprocess. It does
not import the current `apps/api/src` tree and does not call `ImportWorker.run()`.

Fingerprints and file hashes are in `../snapshots/manifest.json` and each
snapshot's `SHA256SUMS`.

## Lock-window benchmark

```bash
RAI_PHASE1_MODE=baseline node --import tsx deliverables/phase1-main-thread-blocking/bench/noop-lock-bench.ts
RAI_PHASE1_MODE=phase1-prefix node --import tsx deliverables/phase1-main-thread-blocking/bench/noop-lock-bench.ts
RAI_PHASE1_MODE=repaired RAI_PHASE1_ENFORCE=1 node --import tsx deliverables/phase1-main-thread-blocking/bench/noop-lock-bench.ts
```

Defaults: 5 rounds, 60 seconds per round, one real HTTP no-op import per round,
external SQLite writer holding `BEGIN IMMEDIATE` for 1.2 seconds, four concurrent
health/dashboard request loops.

Per round:

1. start a fresh API subprocess on an ephemeral port with all paths under one
   experiment root;
2. warm the resident ingest worker with a real no-op import;
3. reset the event-loop-delay window;
4. start external traffic, acquire the external write lock, drive
   upload → inspect → import-jobs → poll;
5. sample event-loop max/p95 immediately at lock release (inside the lock
   window), then let traffic run for the rest of the 60-second round.

Metrics are split by `locked` vs `unlocked` phase. Raw per-request samples are
written next to the JSON as `*.requests.ndjson.gz`.

## Cold start / 100 batches

```bash
RAI_PHASE1_MODE=phase1-prefix node --import tsx deliverables/phase1-main-thread-blocking/bench/noop-resource-bench.ts
RAI_PHASE1_MODE=repaired RAI_PHASE1_ENFORCE=1 node --import tsx deliverables/phase1-main-thread-blocking/bench/noop-resource-bench.ts
```

The first job is explicitly recorded as `coldStartMs`; the next 100 sequential
no-op jobs are the warm resource sample. Final `/v1/performance.importPending`,
process RSS, and temp-file residue are recorded.

## Thresholds

- lock-hold event-loop max ≤ 100 ms;
- locked health-check client P95 ≤ 250 ms;
- no new 5xx;
- final `importPending=false`, no import temp files;
- no-contention no-op P95 is compared separately against baseline.

All numbers are from an isolated local API subprocess on the development host;
they are not a 2-core / 2 GiB production capacity claim.
