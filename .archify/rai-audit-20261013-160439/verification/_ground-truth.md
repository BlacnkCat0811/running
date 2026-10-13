# Verifier ground truth (independently read from source at 60678af)

Working notes for my own use while producing VERIFICATION.md. Every line was opened with the read tool.

## Identity
- HEAD = 60678af97e4710cfd8444b3952df9fff09c2bff3; `git status --short` = only `?? .archify/`.

## Process / writer discipline
- `apps/api/src/server.ts:372-374` mutationCoordinator / sourceMutations / taskAdmission constructed.
- `apps/api/src/mutation-coordinator.ts:14-25` acquire() throws MutationConflictError; `:1-9` 409 + code `mutation_conflict`.
- `apps/api/src/task-admission.ts:16-39` owner().acquire() — FIFO via `waiting` Set insertion order (line 20), null when active/blocked/controls>0; `:41` blockUntilRestart; `:46-55` acquireControl pins owner.
- `apps/api/src/server.ts:397-436` preHandler: metadataOnlyMutationRoutes skip lock (`:411`), lock via `mutationCoordinator.acquireWhenAvailable` (`:426`), control-release path for cancel routes (`:422-425`).
- Owners: import `server.ts:475`, recompute `:460`, prediction `:512`, command `:515`.

## Durable write queue
- `apps/api/src/command-queue.ts:71-74` runtime.sqlite `mutation_commands` table.
- `:108` id = sha256([scope, idempotencyKey]); `:109` fingerprint = sha256(canonical{kind,payload}); `:112` mismatch 409 `command_content_mismatch`; `:115` capacity 16 → 429 `command_queue_full`.
- `:132-148` resume() backoff `min(30_000, 250*2^min(failures,7))`; `:149-168` executeNext statuses running/succeeded/failed.
- `:178-231` applyMutationCommand: main DB, `BEGIN IMMEDIATE` (`:185`), receipt in `import_manifest` key `rai.applied-command.<id>` (`:187`, written `:216`), single transaction, ROLLBACK then refusal audit (`:220-228`).
- runtime queue statuses/cancellation: `:124-131`.

## Import / publication
- `apps/api/src/import-worker.ts:476-500` run(): engine from job stamp else executionEngine; staging `var/rai.importing.<job><attempt>.sqlite` (`:491`); reports `docs/DATA_AUDIT.md` (`:494`).
- Candidate lane: `:624-682` removes staging, backup, `copyFile` backup→staging (`:644`), spawns CLI `this.command(["--import","tsx","packages/health-export-parser/src/cli.ts","import"|"incremental-import", ...])` (`:654-682`) with `--owned-candidate <job.id>` (`:663`) and `--engine/--native-*` (`:485-486`).
- Direct-sync lane decision: `:554-556` planDirectSyncLane; apply `:597-598` operation "direct-sync" via `this.databaseTask` worker thread.
- Publication (main DB swap) in API: `:1684-1785` checkout/remove sidecars/moveDatabaseFile→rollback `var/backups/rai.import-rollback.<uuid>.sqlite` (`:1691`), installDatabase(staging→main) `:1726`, isReadableDatabase verify `:1727`, commit boundary `:1730-1732`, rollback `:1736-1767`.
- `installDatabase` = `rename()` `:1912-1918`; moveDatabaseFile = rename `:1916`.
- `publishDatabaseFile` is called ONLY from `packages/health-export-parser/src/cli.ts:214` (activateStagingDatabase, defined `:207`, called `:471` with args.database). API never imports it (grep).
- `apps/api/src/import-publication.ts:48-118` ImportPublicationJournal in runtime.sqlite `import_publications` (`:52-53`), prepare/commit/clear, recover() rules `:79-118`.
- `:12-26` receipt read/write in `import_manifest` key `rai.applied-import.<id>` (`:10`).
- `apps/api/src/runtime-state.ts:46` runtime path `var/runtime.sqlite`; `:287-305` CREATE TABLE import_sources/import_jobs (+ ALTERs `:306-327`); `:245-258` finalizeImportJob deletes import_publications row in same BEGIN IMMEDIATE.
- Direct-sync write path: `apps/api/src/direct-sync-ingest.ts:413-623` — probe `RaiDatabase.openReadonly` `:419`, open with `transactionOwner:"caller"` `:426`, write guards `:429`, `PRAGMA synchronous=FULL` before BEGIN `:448`, `store.beginCallerTransaction()` `:449`, parse XML+GPX `:461-469`, local canonicalize `:478-488`, generations `:495-500`, enqueue analysis job in same txn `:509-524`, receipt `:587`, pre-commit assertions `:590-612`, `commitCallerTransaction()` `:613`.
- `packages/storage-sqlite/src/database.ts:2242-2276` begin/commit/rollbackCallerTransaction require transactionOwner="caller" (`:2243-2245` etc.); `:1885-1896` caller mode refuses migrations/backup, disallows migrationPolicy apply.
- `packages/storage-sqlite/src/database-file-publisher.ts:19-35` publishDatabaseFile order: prepareOriginal → move target→rollback → install candidate → validateInstalled.
- `packages/storage-sqlite/src/publication-lock.ts:160-186` lock = `<db>.import.lock`; candidate `wx` write `:179`, hard `linkSync` `:183`, unlink candidate `:185`; stale handling `:193-241` (tombstone `.stale.<sha16>` `:212-213`, incomplete `.stale.incomplete.<uuid>` `:203`); liveness `processIsAlive` `:114-137`.

## Runtime state / control DB
- `apps/api/src/runtime-state.ts:351-358` RuntimeStateStore.open (busy_timeout 5000); quarantine corrupt `:366-373`.
- Control DB: `server.ts:127` `var/rai-control.sqlite`; `server.ts:455-457` MobileGoalsStore + PlanPublicationService; `apps/api/src/mobile-goals.ts:215-218` constructor (control DB optional), `:221` read() prefers control DB, `:701-725` CREATE TABLE mobile_goals/history/plan_pushes/plan_operations/coach_loop_receipts; fallback JSON `var/mobile-goals.json` (`:37`, `:216`, `:222-225`).

## Read path
- `apps/api/src/read-store-manager.ts:9` BEGIN_REPLACE_TIMEOUT_MS = 20_000; `:52-64` use() lease; `:66-92` lease/useDatabase/useDatabaseAsync (openReadonly); `:94-122` beginReplace waits for lease drain, 409 `database_busy`; `:124-126` endReplace.
- `apps/api/src/data.ts:200-230` RaiReadStore uses `RaiDatabase.openReadonly` (`:230`).
- `packages/storage-sqlite/src/database.ts:1948-1952` openReadonly: readOnly + foreign_keys + busy_timeout.
- `apps/api/src/server.ts:647-677` withReadStore/withReadDatabase/withReadDatabaseAsync; readiness probe `:593-621` counts 5 tables incl. workouts/recompute_jobs/prediction_model_runs.

## Recompute
- `apps/api/src/recompute-worker.ts:63-110` drain(): no longer takes the write permit before spawn (`:65-70`); `:76` early-return when no pending job; `:77` recoverInterruptedJobs; loop `:78-84`.
- `:141-175` runOneInWorkerThread: SharedArrayBuffer lease per attempt (`:147-150`), Worker `recompute-worker-bootstrap.mjs` (`:151`), `lease?.dispose()` on exit (`:157-160`).
- `apps/api/src/recompute-thread.ts:10` opens RaiDatabase (refuse migrations), `:17-23` withWriteGate proxy + pruneSupersededModelRuns explicit wrap, `:27-32` RaiApplicationService.runNextJob with gate, `:36-40` postMessage ran/jobId/lease stats.
- `apps/api/src/write-lease.ts:36-40` DEFAULT_TIMEOUT 30s, YIELD 50ms, POLL 1ms; `:78-108` client acquire (sequence number, Atomics.notify, fail-open on timeout `:91-101`); `:128-139` yieldIfStale; `:173-267` server: event-driven step(), releases on stale (`:205-208`), retries while pending (`:210-218`), dispose `:256-262`; `:280-311` withWriteGate proxies prepare().run and exec.
- `packages/storage-sqlite/src/recompute-job-repository.ts:46-88` enqueue INSERT status 'queued' + logEvent, no BEGIN (`:43-44`); `:104-129` claimNext BEGIN IMMEDIATE; `:131-162` requestCancellation; `:164-247` recoverInterrupted (running → queued for consumable, failed for external; `isApplicationConsumableJob` `:209`); `:300-358` complete BEGIN IMMEDIATE + beforeComplete; `:419-430` failOutstanding.
- `packages/application/src/service.ts:77-98` enqueueFullRecompute/enqueueIncrementalRecompute/enqueueSnapshotRefresh/recoverInterruptedJobs; `:122` BEGIN IMMEDIATE for zone settings; `:288` runNextJob.
- `packages/application/src/write-gate.ts:15-31` AnalysisStore {database, pruneSupersededModelRuns}, WriteGate scope/yieldIfStale, NO_WRITE_GATE default.

## Storage engine
- `packages/storage-sqlite/src/database.ts:124-1677` migrations array v1..v36 (v1 `:126`, v35 `:1676`, v36 `:1677`); MIGRATION_VERSIONS `:1760`; `schema_migrations` CREATE `:1965`.
- PRAGMAs: `:1830-1875` journal_mode WAL with retry + read-back, foreign_keys ON `:1857`, busy_timeout 5000 `:1860`, synchronous NORMAL `:1862`; caller mode requires WAL + synchronous>=1 (`:1866-1874`).
- checksum policy: `migrationChecksum`/FROZEN_MIGRATION_CHECKSUMS `:1762-1779`, refusal at `:1934`/`:2046`.
- `:1882-1903` open(): migrationPolicy default apply (store) / refuse (caller); `:1912-1934` pendingMigrations read-only probe.

## Modules / edges
- `scripts/check-package-boundaries.mjs:39-73` ALLOWED_EDGES (30 edges, packages only); `:79-84` FORBIDDEN_EDGES (scoring↛readiness/storage-sqlite/application/model-eval); `:132-143` packages must not import apps; `:153-163` declaration↔import both ways; `:166-173` edge whitelist applies to `packages` only (apps not covered); `:180-182` dead whitelist entries fail.
- 16 workspace packages under `packages/`, 3 apps (`api`, `ios`, `web`), 1 crate `crates/rai-data-worker`.
- `package.json:6-9` workspaces; `:39-48` verification scripts; `:125-127` engines node >=22.12 <23 || >=24 <25; `:118-124` devDeps tsx/typescript/playwright-core/concurrently.

## Rust worker (optional)
- `packages/health-export-parser/src/native-worker.ts:69-81` importEngine default `RAI_IMPORT_ENGINE ?? "typescript"`, nativeFallback default `"none"`, nativeBinary default `target/release/rai-data-worker`.
- `apps/api/src/server.ts:133-136` throws only when engine==rust && fallback==none && binary missing.
- `packages/health-export-parser/src/cli.ts:101-102` engine/fallback from argv/env.
- `scripts/rust-worker.mjs:5-27` cargo build --release --locked --workspace; verify runs cargo test + TS native tests with RAI_REQUIRE_RUST_TESTS=1.
- `native-worker.ts:40` NATIVE_OPERATIONS = health/gpx/aggregate/apply-records; `:9-10` protocol 1, version 0.1.0.
- Consumers of native spawn: `apple-health-parser.ts:17-18`, `gpx-parser.ts:9`, `native-record-writer.ts:7` — all inside health-export-parser. Nothing in features/scoring/application imports it.

## Clients
- iOS: `HealthKitExport.swift:478-508` read types; `BackgroundUploadSession.swift:58-80` background URLSession (deliberately NOT ephemeral, `:6-8`); `APIClient.swift:93` ephemeral config, `:353` Bearer; `HealthKitSync.swift:2168` POST /v1/imports/uploads, `:2203` /v1/imports/inspect, `:2227` POST /v1/import-jobs, `:2245` /v1/import-jobs/active, `:2353` GET /v1/import-jobs/:id, `:2370-2371` Bearer.
- Web: `apps/web/src/api.ts:58-71` fetch + Bearer from localStorage; `pages/DataModelPage.tsx:94-96` poll active/latest, `:144` POST /v1/imports/uploads, `:556` inspect, `:628` POST /v1/import-jobs; `WorkoutDetailPage.tsx:382` GET /v1/jobs/:id; `feedback-command.ts:23,34` POST /v1/commands + poll; `components/GlobalTaskStatus.tsx:34` polls /v1/runtime-status. No EventSource/WebSocket anywhere in apps/web/src.

## Docs vs source
- `docs/DATA_PIPELINE.md:6` calls SQLITE_DIRECT_SYNC "设计，未上线" — but `apps/api/src/direct-sync-ingest.ts:33-34` says it is the production caller since 2026-10-13 and `import-worker.ts:597` runs it. Doc stale.
- `docs/DATA_PIPELINE.md:55` "migrations 1–32" — actual v1..v36 (`database.ts:1676-1677`).
- `docs/ARCHITECTURE.md:11,13,53` claims; `docs/RUST_DATA_ENGINE.md:33` default RAI_IMPORT_ENGINE=typescript matches source.
