# VERIFICATION — independent adversarial check of the six RAI diagram specs

Auditor: `verifier` (shared task `task-4`). Method: open every `sources` entry in every candidate and read the
cited line range; then follow the real call sites for topology, check documented-vs-implemented, and score
coverage against the user's six requested diagrams.

Repository under audit: `D:\running` @ `60678af97e4710cfd8444b3952df9fff09c2bff3` (`git rev-parse HEAD`;
`git status --short` shows only untracked `.archify/`). All line references below were opened with the read tool
in this session; nothing here relies on a candidate's own prose.

Evidence classes per TEAM-BRIEF: **A** = confirmed by reading the implementing code, **B** = strongly implied,
**C** = not confirmable.

Status legend for verdicts: `verified` / `verified-with-corrections` / `not-verified`.

> NOTE: candidates were revised several times while this file was being written. Each section names the candidate
> revision (sha256) that was actually inspected; where an earlier revision was reviewed first, the section says so
> and lists what changed. All six sections are complete — nothing is left pending.

---

## 0. Cross-cutting conclusions

1. **No fabricated structure anywhere.** Across the six candidates I opened every `sources` entry and found no
   citation to a non-existent path, no invented table, no invented endpoint or protocol string. The defects that
   remain are labelling/ownership/causality issues, listed per diagram.
2. **The audit's own biggest traps were handled correctly**: Rust is drawn as default-off everywhere
   (`native-worker.ts:69-74`), the default import lane is drawn as the in-place `applyDirectSyncImport`
   transaction rather than the candidate file (`direct-sync-plan.ts:47-56`, `direct-sync-ingest.ts:449-613`), and
   "documented only" items are marked UNKNOWN instead of drawn.
3. **Doc-vs-source diffs that I confirmed independently**: `docs/DATA_PIPELINE.md:6` still calls the direct-sync
   lane "设计，未上线" while `direct-sync-ingest.ts:33-34` says it is the production caller; `docs/DATA_PIPELINE.md:55`
   says "migrations 1–32" while the array ends at v36 (`database.ts:1677`); `docs/ARCHITECTURE.md:61` promises
   completeness/generation/model gates on the DB-file swap, while the swap itself only does
   checkpoint → rename → read-check (`import-worker.ts:1718-1729`) — the generation gate lives on the direct lane
   (`direct-sync-ingest.ts:509-524`) and the model gate in recompute publication (`recompute-pipeline.ts:314`).
4. **Gate health**: all six candidates now have `validate/deliver/check/browser-check = pass` with receipts bound
   to the bytes I verified (§7). Two earlier binding/staleness defects (risks HTML built from a spec that no longer
   existed; database receipt bound to a superseded spec) are resolved in the final revisions.
5. **Method limits**: this was static reading, no service was started, no browser was rendered by me, and all
   database/table evidence comes from `CREATE TABLE` statements rather than from inspecting live `var/*.sqlite`.
   Claims that depend on deployment state or on observed runtime behaviour are listed as B/C in §8.

---

## 1. 图1 系统总架构 — `architecture-system/candidate.json`

Verified revision: `candidate.json` sha256 `22b2846ef325756a7350c349b1994c9318ae0788fa9f1c773ae1cc74007e9e8a` (13 434 bytes),
finalize receipt `ok:true` with **validate/deliver/check/browser-check all pass**, artifact
`architecture-system.html` sha256 `146740f328450e8920bad48d1e0085744bd0a2bab729e77c9da2f0b0d42868ba`
(774 912 bytes) — I recomputed both hashes from disk and they match the receipt. Two earlier revisions
(10 981 / 13 377 bytes) were reviewed first; every defect I reported there is closed in this one.

### 1.1 What the diagram claims
**7** components (ios, web, api, ingest, state, algo, db_main), two boundaries (信任边界: 回环 + Bearer wrapping
ingest/api/algo/state; 持久化边界 wrapping db_main/state), 9 connections, 5 cards. The Rust engine is no longer a
component; it is described in the "可选加速" card.

### 1.2 Citation checks (every `sources` entry opened)

| # | Citation | Verdict | What the source actually shows |
|---|---|---|---|
| 1 | `apps/ios/RAI/HealthKitExport.swift:481-503` | A | HK read type set: heartRate/distanceWalkingRunning/activeEnergyBurned/stepCount/runningSpeed/runningPower/runningStrideLength/runningVerticalOscillation/runningGroundContactTime/restingHeartRate/HRV SDNN/vo2Max/bodyMass/respiratoryRate/sleepAnalysis + optional recovery/physicalEffort/wristTemperature. Supports "HealthKit 只读导出". |
| 2 | `apps/ios/RAI/BackgroundUploadSession.swift:62-70` | A | `URLSessionConfiguration.background(withIdentifier:)`, 1 h resource timeout, `isDiscretionary = false`. Supports "后台上传". |
| 3 | `apps/ios/RAI/APIClient.swift:105-133` | A | GET handshake/mobile.today/statistics/trends/goals/run-coach(+POST)/coach-loop; `.ephemeral` config at :93, `Bearer` at :353. Supports "调用的 /v1 读端点". |
| 4 | `apps/web/src/pages/DataModelPage.tsx:94-96` | A | `api("/v1/import-jobs/active")` / `latest`. |
| 5 | `apps/web/src/components/GlobalTaskStatus.tsx:34` | A | polls `/v1/runtime-status`. |
| 6 | `apps/web/src/feedback-command.ts:23,34` | A | POST `/v1/commands` then GET `/v1/commands/:id`. |
| 7 | `apps/api/src/server.ts:129-131` | A | `RAI_API_PORT ?? 8787`, `RAI_API_HOST ?? "127.0.0.1"`, `RAI_API_TOKEN`. |
| 8 | `apps/api/src/read-store-manager.ts:52-64` | A | `use()` acquires a read lease, opens `RaiReadStore`, releases in `finally`. |
| 9 | `apps/api/src/task-admission.ts:9-43` | A | single CPU-heavy writer; FIFO `waiting`; `blockUntilRestart`. |
| 10 | `apps/api/src/routes/import-routes.ts:38-83` | A | `POST /v1/imports/uploads`, MIME/extension check, `saveUpload`, truncation handling. |
| 11 | `apps/api/src/server.ts:465-496` | A | `new ImportWorker(databasePath, projectRoot, runtimeRoot, () => readStores.beginReplace(), …)` with `scope`, `admission: taskAdmission.owner("import")`, `engine`, `onRecoveryRequired`, `onTerminal`. (This is the citation that the earlier revision got wrong by pointing at `import-worker.ts:465-491`; fixed.) |
| 12 | `apps/api/src/import-worker.ts:1718-1729` | A | checkpoint → remove sidecars → `moveDatabaseFile(main → rollback)` → `installDatabase(staging → main)` → `isReadableDatabase(..., "activation_verify")`. |
| 13 | `packages/health-export-parser/src/native-worker.ts:69-74` | A | `importEngine(value = process.env.RAI_IMPORT_ENGINE ?? "typescript")`, `nativeFallback(value = process.env.RAI_RUST_FALLBACK ?? "none")`. |
| 14 | `packages/health-export-parser/src/apple-health-parser.ts:10-20` | A | imports `prepareNative` (:17) and `NativeRecordWriter` (:18) — the parser is the only entry to the native path. |
| 15 | `apps/api/src/server.ts:133-136` | A | throws only when `name === "rust" && fallback === "none" && !existsSync(nativeBinary())`. |
| 16 | `apps/api/src/runtime-state.ts:284-305` | A | `CREATE TABLE runtime_meta / import_sources / import_jobs` in `var/runtime.sqlite`. |
| 17 | `apps/api/src/command-queue.ts:71-74` | A | `CREATE TABLE mutation_commands (sequence, id, scope, status, payload)`. |
| 18 | `apps/api/src/server.ts:127` | A | `RAI_CONTROL_DATABASE ?? var/rai-control.sqlite`. |
| 19 | `packages/application/src/service.ts:77-96` | A | `enqueueFullRecompute` / `enqueueIncrementalRecompute` / `enqueueSnapshotRefresh`. |
| 20 | `packages/application/src/write-gate.ts:15-30` | A | `AnalysisStore {database, pruneSupersededModelRuns}`, `WriteGate.scope/yieldIfStale`, `NO_WRITE_GATE`. |
| 21 | `apps/api/src/write-lease.ts:64-108` | A | sync worker-side lease client; sequence-number handshake; 30 s fail-open. |
| 22 | `apps/api/src/server.ts:126` | A | `RAI_DATABASE ?? var/rai.sqlite`. |
| 23 | `packages/storage-sqlite/src/database.ts:124-126` | A | migration array starts at `version: 1`; supports the corrected tag `migrations v1→v36`. |
| 24 | `apps/api/src/import-publication.ts:12-26` | A | `import_manifest` receipt `rai.applied-import.<id>` read/write with pre-commit assertion. |

No citation in this revision was wrong or unresolvable. Every previously reported defect (wrong path for
"ImportWorker 装配", `publishDatabaseFile` ownership, `algo → engine`, `v2→v36`, Rust "带 TS 回退",
`mobile-goals.ts:1-40` for the control DB, "Ephemeral URLSession" tag) is addressed in the revised text —
except the control-DB citation gap, which survives in weakened form (see 1.6).

### 1.2b Late-added card citations (final revision)
- `native-worker.ts:121-126` — A: `const args = ["--operation", operation, "--input", resolve(input), "--output",
  output]` and `spawn(binary, args, {env, windowsHide, stdio})` with `--staging-database`/`--permit` added for
  `apply-records` (:122-125). The card's "CLI 子进程而非 WASM/napi" claim holds.
- `server.ts:168-169` — A: `RAI_IMPORT_DATA_ONLY_FAST_PATH ?? "1"` and the 0/1 validation.
- `direct-sync-plan.ts:51` — A: the direct lane rejects `engine.name !== "typescript"`.

### 1.3 Topology checks
- `ios → ingest POST /v1/imports/uploads` — A: `HealthKitSync.swift:2168` builds that request; `:2227` posts
  `/v1/import-jobs` afterwards.
- `ingest → algo_engine --engine rust（可选）` — A: `import-worker.ts:485-486` builds `--engine <name>
  --native-version <v> --native-fallback <f>`, passed to the spawned CLI at `:654-682`. The revised label
  ("由导入 CLI 子进程调用") matches the real call site.
- `api → algo FIFO 调度重算` — A: `taskAdmission.owner("recompute")` handed to `RecomputeWorker`
  (`server.ts:460`), `CommandQueue` gets `taskAdmission.owner("command")` (`server.ts:515`).
- `algo → db_main 写派生 run 与快照` — A: `recompute-thread.ts:27-32` runs
  `RaiApplicationService.runNextJob()` against the main DB through the write-gate proxy.
- `db_main → api read-only 快照 → DTO` — A: `data.ts:230` `RaiDatabase.openReadonly`.
- `state → api mutation_commands 队列` — A: `CommandQueue.resume()` (`command-queue.ts:132-148`) executed in
  the API process.
- `ingest → db_main 写事实 + 一致性回执` — A **for the direct-sync lane** (`direct-sync-ingest.ts:449-613`
  writes facts + `writeImportReceiptInDatabase` in one caller-owned transaction). The legacy lane instead writes
  the candidate file and lets the worker rename it (`import-worker.ts:1718-1729`); the edge label covers both but
  the candidate-file hop is only implied by the `ingest` component's third source.

### 1.4 Implemented vs planned
- `algo_engine` is drawn as **optional**, "默认 TS 实现": A — `native-worker.ts:69` default `typescript`,
  `direct-sync-plan.ts:51` rejects any non-typescript engine on the direct lane, and `target/release/` does not
  exist in this worktree (checked: `Test-Path target` = False), so Rust is genuinely off the default path.
- Nothing documented-only is drawn as implemented. The `BGProcessingTask` tag is real:
  `AppDelegate.swift:184` `BGTaskScheduler.shared.register`, `:217-225` `BGProcessingTaskRequest` + `submit`.

### 1.5 Coverage of 图1 ("展示 iOS、Web、API、任务队列、数据处理、数据库、算法模块之间的关系")
Covered: iOS, Web, API, 任务队列 (`state` + CommandQueue + admission), 数据处理 (`ingest` + `algo`),
数据库 (`db_main` + `state`), 算法模块 (`algo`), plus both requested boundary marks. Under-specified:
the queued-job hop inside the main DB (`recompute_jobs`) is not drawn as its own relation — `api → algo` hides
"enqueue row → worker claims row"; a reader cannot see that the queue is durable in SQLite rather than in memory.
Also the two import mechanisms (candidate rename vs direct same-DB transaction) appear only in a card, not as
edges.

### 1.6 Findings (final revision)
| Severity | Claim | Cited evidence | What source actually shows | Required correction |
|---|---|---|---|---|
| minors closed | `state` control-DB contents; 7 components; `ingest → db_main` lane ambiguity; `state → api` label | see §1.2/§1.2b | `mobile-goals.ts:701-725` verified as the control-DB `CREATE TABLE` block; `algo_engine` re-added → 8 components / 10 connections; edge relabelled "直连车道写库"; label is now "取命令队列", which matches the read-then-execute call site (`command-queue.ts:132-168`). | — closed. |
| minor | doc-diff card item 1: the direct lane "已成为默认" | `direct-sync-plan.ts:47-56`, `server.ts:168-169` | Correct only for payloads that pass the lane predicate (queued, fast path on, engine typescript, version match, `preserveAbsent`, DB exists). The amber card states the predicate one screen above; the doc-diff item states it unqualified. | Add "对合格载荷" to the doc-diff item. |

**Verdict: verified** (no blocker, no major; one cosmetic precision note). Gate health: passing receipt bound to
the current bytes. The receipt's `visualReviewRecommendation` still suggests a human look at 2 route crossings /
2 detours; **I did not visually inspect the rendering**, I only read the receipt.

---

## 2. 图2 核心数据流 — `dataflow-core/candidate.json`

Verified revision: sha256 `5d6ab025db73b02b124cce64fd0a9b6386e88aef1c4e1cbefba9bbe5d1462008` (11 871 bytes).
Finalize receipt `ok:true`, all four gates pass; I recomputed the candidate and HTML hashes from disk and both
match the receipt. (Two earlier revisions — one that still drew the candidate lane as the main path, one that
failed `deliver`/`validate` on viewport readability — were reviewed first and are superseded.)

### 2.1 What the diagram claims
4 stages (来源 / 接入与登记 / 落库与派生 / 发布与读取), 9 nodes (hk, api, runtime, direct, facts, derive, runs,
read, clients), 8 flows, 4 cards. The main chain is now the **direct transactional lane**, with the candidate/rename
lane in a fallback card.

### 2.2 Citation checks (opened)

| Citation | Verdict | Note |
|---|---|---|
| `cli.ts:171-176`, `HealthKitSync.swift:2155-2176` | A | `locateHealthXml`; ZIP upload request to `/v1/imports/uploads`. |
| `import-routes.ts:38-83`, `:16-30`, `server.ts:397-436` | A | upload, job enqueue, write gate. |
| `runtime-state.ts:42-47`, `:299-305`, `command-queue.ts:70-74` | A | `var/runtime.sqlite`, `import_jobs`, `mutation_commands`. |
| `direct-sync-plan.ts:47-56` | A | lane predicate (must be `typescript`, version match, `preserveAbsent`, DB exists). |
| `direct-sync-ingest.ts:413-469` | A | `applyDirectSyncImport` → read-only probe → `transactionOwner:"caller"` open → `installDirectSyncWriteGuards` → `PRAGMA synchronous=FULL` **before** `beginCallerTransaction()` → parse. |
| `direct-sync-ingest.ts:470-524` | A | local canonicalization, generation bump, `RecomputeJobRepository.enqueue` inside the same transaction. |
| `direct-sync-ingest.ts:575-587` | A | manifest metadata then `writeImportReceiptInDatabase`, with pre-commit read-backs at :590-612. |
| `server.ts:465-491` | A | `ImportWorker` assembly (`admission: taskAdmission.owner("import")`, `scope`, engine). |
| `database.ts:140-162` | A | `health_records` / `workouts` CREATE TABLE. |
| `recompute-pipeline.ts:195-236` | A | `runFullRecompute`: feature_extraction → training_metrics → model_replay. |
| `recompute-pipeline.ts:451-453` | A | `runDirectSyncAnalysis(job) { this.runFullRecompute(job); }` — the card's "复用同一管线" is literally the code. |
| `recompute-worker.ts:63-84` | A | the analysis drain: no permit held before spawn, early return when the queue is empty. |
| `model-run-repository.ts:212-218` | A | singleton pointer upsert after status/metric/gate checks. |
| `database.ts:483-499` | A | `recompute_jobs` + its `status CHECK (… 'queued','running','succeeded','failed','cancelled')`. |
| `recompute-pipeline.ts:2152-2160` | A | `sealDomainSnapshots` (fitness/readiness/load/zones). |
| `recompute-pipeline.ts:2371-2383` | A | activation inside `jobs.complete(..., beforeComplete)` → `activateSucceeded` + `clearActivePredictionModel`. |
| `read-store-manager.ts:52-64`, `data.ts:217-243`, `server.ts:1290-1296` | A | read lease, `openReadonly`, `/v1/mobile/today`. |
| `APIClient.swift:104-122`, `DashboardPage.tsx:26-31` | A | iOS/Web read endpoints. |
| `import-worker.ts:626-645` | A | maintenance lane: `createCurrentBackup` → `var/backups/rai.before-web-import.<jobId>.sqlite` → `copyFile` to `var/rai.importing.<jobId>.sqlite` (:644). |
| `import-worker.ts:654-682`, `:739-753` | A | candidate CLI with `--owned-candidate`; recompute CLI against the staging file. |
| `import-worker.ts:1696-1735` | A | `beforeActivate()` (= `readStores.beginReplace`) → move aside → install → `isReadableDatabase` (`stage` default `"database_quick_check"`, `:1872`) → commit boundary. |
| `import-worker.ts:632-635` | A | the comment stating first-time pagination and large batches still use this path. |
| `direct-sync-plan.ts:51` | A | non-typescript engine ⇒ lane rejected (`engine_rust`). |
| `native-worker.ts:69-72`, `:122-124`, `server.ts:133-136`, `native-record-writer.ts:76-87` | A | default engine, permit-gated `apply-records`, startup failure rule. |
| `prediction-training-runner.ts:550-560`, `prediction-model-service.ts:824-833` | A | required artifact files + `active_prediction_model` upsert. |

### 2.3 Topology checks
- `api → direct` "worker 线程执行" — A: the import worker dispatches `{operation:"direct-sync"}` through
  `databaseTask` → `new Worker(import-database-bootstrap.mjs)` (`import-worker.ts:597,997`).
- `direct → facts` "单事务提交" — A: facts, ledger, job and receipt share one caller-owned transaction that ends
  with `store.commitCallerTransaction()` (`direct-sync-ingest.ts:613`).
- `facts → derive` "读任务与事实" — A: the recompute worker reads `recompute_jobs` and the facts from the same DB
  (`recompute-worker.ts:113-123`, `recompute-thread.ts:27-32`).
- `derive → runs` "写快照与指针" — A.
- `runs → read → clients` — A.
- The fallback card correctly states that the candidate lane is still the first-import/large-batch path and that
  enabling Rust forces it — A (`direct-sync-plan.ts:51`).

### 2.4 Implemented vs planned
No planned-only element is drawn. Rust and the ONNX/Python branch are marked optional with their enable conditions;
the UNKNOWN about deployment env is stated rather than guessed.

### 2.5 Coverage of 图2
Covered: HealthKit → upload → durable job → direct transactional ingest (parse XML + GPX → canonicalize →
generations → analysis job) → feature/metric/model computation → snapshot/pointer publication → read-only DTO →
Web/iOS. Under-specified: (i) GPX appears only inside a card item, not as a flow; (ii) the receipt/anchor
read-back that proves the batch landed (`import-worker.ts:825-835`) is absent; (iii) the title says "核心数据流"
yet only the default lane is drawn as the chain — acceptable because the fallback is a full card, but a reader
could miss that both lanes end in the same tables.

### 2.6 Findings
| Severity | Claim | Cited evidence | What source actually shows | Required correction |
|---|---|---|---|---|
| minor | node `direct` sublabel `DirectSyncImport` | `direct-sync-ingest.ts:222,230,413` | The real identifiers are `DirectSyncImportInput`, `DirectSyncImportResult`, `applyDirectSyncImport`; `DirectSyncImport` alone is not a symbol in the tree. | Use `applyDirectSyncImport` or `DirectSyncImportInput`. |
| minor | card "解析与归一在同一事务内联执行" | `direct-sync-ingest.ts:461-488` | Correct — but the same transaction also registers the analysis job (`:509-524`) and writes the receipt (`:587`), all covered by the card's earlier item. Fine. | — |
| info | 8 flows vs 9 nodes | — | Row/stage layout passes every gate; no orphan node. | — |
| info | earlier "ability_assessments + daily_ability_snapshots" citation gap | — | **Resolved**: the card now cites `recompute-pipeline.ts:1109-1166` only for `workout_features`, and the published-run visibility claim cites `database.ts:545-553`, which *is* the `active_ability_assessments` / `active_daily_ability_snapshots` view block. No third citation needed. | — |
| info | stage merge 5 → 4 | `stages` | No segment lost: 来源 / 接入与登记 / 落库与派生 / 发布与读取, with hk=0; api,runtime=1; direct,facts,derive=2; runs,read,clients=3. | — |

**Verdict: verified** (source fidelity clean; no blocker, no major; two cosmetic notes). Gate health: passing
receipt bound to the current bytes.


## 3. 图3 服务端执行时序 — `sequence-analysis/candidate.json`

Verified revision: sha256 `fc1edbb21e78b91de23ea1c15412184864748dab6e51ae4ef1bbcc5c71383105` (10 817 bytes).
Finalize receipt `ok:true`, all four gates pass.

### 3.1 What the diagram claims
8 participants (client, api, runtime, worker, rx, main, recompute, read), 23 messages, 6 activations, 4 cards.
The drawn sequence is the **default direct lane**: upload → 202 → ImportWorker → `databaseTask(direct-sync)` →
one `BEGIN IMMEDIATE` transaction → analysis job registration → RecomputeWorker claim → three-stage compute →
pointer upsert → client polls job + `/v1/mobile/today` through `RaiReadStore`.

### 3.2 Participant identity and message checks (opened)

| Citation / message | Verdict | Note |
|---|---|---|
| `HealthKitSync.swift:2155-2176` (上传 ZIP) | A | `X-RAI-Sync-Batch` is set to `payloadHash` (:2176) and the comment at :2172-2173 states 幂等键恒等于 payloadHash, matching the card claim and `import-routes.ts:39-46`. |
| `HealthKitSync.swift:2214-2241` (发起导入) | A | `startImport` → `submitImport` → `POST /v1/import-jobs` with `{sourceId}`, plus a 409 `mutation_conflict` retry (`HealthSyncMutationRetry`, :2215-2222). |
| `import-routes.ts:16-30` | A | `sourceMutations.acquire("import source enqueue")` → `importWorker.create(...)` → `202` with the job. |
| `server.ts:1290-1296` | A | `GET /v1/mobile/today` calls `store.mobileTodayWithViews(...)` — the message label `store.mobileTodayWithViews()` is a real method (`data.ts:612`). |
| `runtime-state.ts:42-47`, `:299-305` | A | `var/runtime.sqlite`; `import_jobs`. |
| `import-worker.ts:340-392` (`create`) | A | dedupe by `sourceId`, queue cap (`maxPending ?? 8`), `export.xml`/`导出.xml` check, and the enqueue commit point: on persist failure the job is removed from the `jobs` map (:384-392). Message `persistJobs() → import_jobs` and its ordering are correct. |
| `import-worker.ts:303-338` (`scheduleNext`) | A | finds unfinalised queued jobs in scope, acquires admission, then runs. |
| `import-worker.ts:564-602` (直连车道分派) | A | `planDirectSyncLane` then `databaseTask({operation:"direct-sync"})`. |
| `import-database-thread.ts:8-13` | A | worker-thread switch: `case "direct-sync": await applyDirectSyncImport(task.input)`. |
| `direct-sync-ingest.ts:413-469` | A | probe → caller-owned open → guards → `synchronous=FULL` → `beginCallerTransaction` (i.e. `BEGIN IMMEDIATE`, `database.ts:2248`) → parse. |
| `direct-sync-ingest.ts:470-524` | A | canonicalize, generations, `recompute_jobs` insert. |
| `direct-sync-ingest.ts` receipt/commit | A | `analysisStatus: "queued"` is set in the same transaction (:551) and `commitCallerTransaction()` closes it (:613) — the message `COMMIT → analysisStatus=queued` is literally the code. |
| `database.ts:483-499` | A | `recompute_jobs.status` CHECK = queued/running/succeeded/failed/cancelled; card item matches exactly. |
| `recompute-job-repository.ts:109-120` | A | `claimNext` writes `status='running'`, `progress_phase='claimed'` under `BEGIN IMMEDIATE`. |
| `recompute-worker.ts:63-84` | A | the analysis drain. |
| `recompute-pipeline.ts:195-236` | A | feature_extraction → training_metrics → model_replay. |
| `model-run-repository.ts:212-218` | A | `active_model_run` singleton upsert (the `clearActivePredictionModel()` call is at `:220`, one line outside the cited range). |
| `database.ts:545-553` | A | `active_ability_assessments` / `active_daily_ability_snapshots` join `active_model_run` — only published runs are visible. |
| `read-store-manager.ts:52-64`, `data.ts:217-243` | A | read lease + `openReadonly`. |
| `import-worker.ts:280-301` (cancel) | A | queued → `cancelled`; running → `queue.cancelRequested` + `terminateProcessTree(activeChild)` + `activeAnalysis.terminate()` → `requested`; `phase === "activate"` → `"publishing"` (not cancellable). The card reproduces this exactly. |
| `mutation-coordinator.ts:1-25`, `task-admission.ts:9-39`, `write-gate.ts:20-31`, `read-store-manager.ts:94-122` | A | 409/code, FIFO single writer, `scope`/`yieldIfStale`, 20 s lease drain → `database_busy`. |
| `direct-sync-plan.ts:47-56`, `:51` | A | the reject reasons; for a rust engine the reason string is exactly `engine_rust`. |
| `prediction-training-runner.ts:550-560` | A | the artifact file set — supports "Python/ONNX 是独立支路". |

### 3.3 The default-lane question (the Lead's main concern)
Correct. The chain drawn is `applyDirectSyncImport` in a `transactionOwner:"caller"` single transaction on the live
DB, **not** the candidate-file lane; the candidate lane appears only in the rose card, together with the exact
reject conditions and the `engine_rust` consequence. Status strings are the real ones (`queued/running/succeeded/
failed/cancelled`, `analysisStatus: queued`, `progress_phase: claimed`, `202`, `409 mutation_conflict`).

### 3.4 Finding — the wake-up of the analysis consumer is not drawn and has no dedicated call site
| Severity | Claim | Cited evidence | What source actually shows | Required correction |
|---|---|---|---|---|
| major | messages imply that immediately after `COMMIT → analysisStatus=queued`, `recompute` claims the queued job | `recompute-worker.ts:63-84`, `recompute-job-repository.ts:109-120` | The *claim* mechanism is real, but nothing in the import path schedules the consumer: `recomputeWorker.schedule()` is called only at `server.ts:517` (CommandQueue `afterApply`), `:786` (zone backfill — **only if that check itself queued a job**), `:804` (startup), `:1251` (override PATCH), `:1851` (`POST /v1/model-runs`), `:1978` (restore). `finalizeImportSource` (`import-source-finalization.ts`, whole file) and the `onTerminal` wiring (`server.ts:483-490`) contain no schedule call, and `drain()` stops its poll chain as soon as `hasPendingJob()` is false (`recompute-worker.ts:76`). | Draw a wake-up edge (or an explicit "由启动/区域刷新/写命令触发" note) between the direct lane and the recompute worker, and state the latency honestly instead of implying an immediate hand-off. |

**Verdict: verified-with-corrections** (participants, order, directions and status strings all check out; one
major causal-link defect). Gate health: passing receipt bound to the current bytes.

Evidence classes: the enumeration of `schedule()` call sites is **A**; the conclusion that a queued job can wait
for the next trigger is **B** (any of those triggers may fire first, and the 5-minute zone-refresh timer will
schedule the worker whenever it decides to queue a snapshot refresh).

---

## 4. 图4 数据库读写关系 — `architecture-database/candidate.json`

Verified revision: `candidate.json` 15 875 bytes (16:27:37 local). Content is identical to the 13 371-byte
revision I checked line-by-line except that the file is pretty-printed and the trust-boundary region was narrowed
to `["api"]` (see §4.7). Finalize receipt at audit time: `ok:false, status:"running"`, all gates `not-run`,
no `.html`.

### 4.1 What the diagram claims
Final revision (verified): sha256 `38269f315e8b59a3fd516789f50c63f4a2f8f0e3644313e04c2eb25013c4bc75` (16 707 bytes),
finalize receipt `ok:true` with all four gates pass, artifact `architecture-database.html` sha
`a4fa96738734fd42ac4a66885f78dd3cc8c6168abb90d4640e08547aaf914743`. The candidate was **restructured** after my
first pass: 12 components (main_facts, main_derived, main_publish, main_jobs, import_write, req_write,
analysis_write, read_path, runtime_db, control_db, candidate_files, artifact_store), 3 boundaries, 15 connections,
5 cards. The single `api` hub was replaced by three writer components (导入 / 请求 / 分析) plus an explicit
`read_path`; the old `cli` component is gone (the migration CLI now appears as a source of `import_write`).

Consequences for my earlier findings on the pre-restructure revision:
- **closed** — `api → main_derived` (write ownership) no longer exists; derivation is `analysis_write → main_derived`.
- **closed** — `api → main_jobs（同事务）` no longer exists; batch/ledger registration is `import_write → main_jobs`.
- **closed** — `api → main_publish` was added in that earlier revision and is now `analysis_write → main_publish`
  (the release path); the *request-path* activation (`POST /v1/model-runs/:id/activate`, `server.ts:1858-1889`,
  which does write `active_model_run` + `model_release_refusals` from the API process) is now **undrawn** — see 4.7.
- the `main_jobs.sublabel` shortening (`"recompute_jobs · import_batches"`) lost **no** claim: `schema_migrations`
  is still the component's third citation (`database.ts:1962-1984`) and still appears in the 表清单 card.

### 4.1b Structures drawn and their real definitions
main_facts: health_records/workouts/route_points (`database.ts:140-245`) + route_versions/route_version_points
(`v35-migration.ts:22-48`). main_derived: feature_runs/workout_features/model_runs/ability_assessments/
daily_ability_snapshots (`:351-465`), training_metric_runs/workout_training_loads/daily_training_metrics
(`:720-790`), canonical_nights/canonical_hrv_days (`:1299-1343`). main_publish: model_validation_gates/
model_release_refusals (`v24:35-70`), model_release_bundles/active_model_release (`v2:23-47`), active_model_run
(`:517-521`). main_jobs: recompute_jobs/events (`:483-515`), prediction_model_runs/events (`:614-666`),
schema_migrations (`:1962-1984`). Without a passing receipt none of this would matter, so: receipt matches the
file bytes (I recomputed both hashes).

### 4.2 Every table named in the diagram, traced to a real `CREATE TABLE` (Lead's check (a))

| Named structure | Real definition | Verdict |
|---|---|---|
| health_records / workouts / workout_statistics / workout_events / workout_routes / route_points | `database.ts:140,162,183,200,210,225` | A |
| route_versions / route_version_points | `v35-migration.ts:22,34` | A |
| feature_runs / workout_features / model_runs / ability_assessments / daily_ability_snapshots | `database.ts:351,366,397,416,450` | A |
| training_metric_runs / workout_training_loads / daily_training_metrics | `database.ts:720,739,770` | A |
| canonical_nights / canonical_hrv_days | `database.ts:1299,1328` | A |
| recompute_jobs / recompute_job_events | `database.ts:483,504` | A |
| prediction_model_runs / prediction_model_events | `database.ts:614,647` | A |
| import_batches / import_batch_files | `database.ts:974,991` | A |
| import_batch_partitions | `v35-migration.ts:50` | A |
| model_validation_gates / model_release_refusals | `v24-migration.ts:35,61` | A |
| model_checkpoints / recompute_validations | `database.ts:1065,1083` | A |
| model_release_bundles / active_model_release / prediction_calibration_artifacts | `v2-migration.ts:23,33,37` | A |
| active_model_run / active_prediction_model | `database.ts:517,661` | A |
| schema_migrations / import_manifest | `database.ts:1965,130` | A |
| import_generations / import_fact_history | `v34-migration.ts:42,27` | A |
| import_entity_generations | `database.ts:1037` | A |
| runtime_meta / import_sources / import_jobs | `runtime-state.ts:288,289,299` | A |
| mutation_commands | `command-queue.ts:71` | A |
| import_publications | `import-publication.ts:53` | A |
| mobile_goals / mobile_goals_history / mobile_plan_pushes / mobile_plan_operations / mobile_coach_loop_receipts | `mobile-goals.ts:701,707,713,721,725` | A |

No table in this diagram is invented or merely implied by a repository method name. The main-vs-runtime-vs-control
split is also correct (`runtime-state.ts:46` `var/runtime.sqlite`; `server.ts:127` `var/rai-control.sqlite`;
`server.ts:126` `var/rai.sqlite`) — no conflation found.

### 4.3 Citation checks (opened)

| Citation | Verdict | Note |
|---|---|---|
| `migrate-cli.ts:34-46` | A | `--apply` path takes `acquireDatabasePublicationLock(path, "cli")` at :35 then opens with `migrationPolicy:"apply"` at :39-42. |
| `health-export-parser/src/cli.ts:203-241` | A | `acquireImportLock` + `activateStagingDatabase` with `publishDatabaseFile`. |
| `server.ts:124-128`, `:631-645` | A | paths; `openMainDatabase` uses `migrationPolicy:"refuse"`. |
| `task-admission.ts:8-39` | A | as above. |
| `recompute-thread.ts:8-34` | A | worker thread opens the DB and wraps writes in the lease proxy. |
| `server.ts:465-491` | A | ImportWorker assembly. |
| `prediction-worker.ts:22-62` | A | `train()` spawns `node --import tsx packages/application/src/prediction-training-runner.ts … --artifact-directory`. |
| `database.ts:140-245` | A | fact-layer CREATE TABLE block. |
| `database.ts:2083-2144` | A | prepared INSERT/UPDATE statements for health_records, workouts, workout_statistics, workout_events, workout_routes, route_points — this is the write side of the "api writes facts" edge. |
| `v35-migration.ts:22-48`, `:50-64` | A | route_versions (+ points, + `published_route_version_id`) and import_batch_partitions. |
| `database.ts:351-465`, `:720-790`, `:1299-1343` | A | derived-layer tables. |
| `database.ts:483-515`, `:614-666` | A | job tables and their status CHECKs (`queued/running/succeeded/failed/cancelled`; `queued/running/validating/succeeded/rejected/failed/cancelled`). |
| `v24-migration.ts:35-70` | A | gates + refusals; `candidate_model_run_id REFERENCES model_runs(id)` supports `derived_to_publish`. |
| `v2-migration.ts:23-47` | A | bundles / active release / calibration artifacts, incl. `status IN ('passed','failed','not_evaluable')`. |
| `database.ts:517-521` | A | `active_model_run` singleton. |
| `database.ts:1962-1984`, `:130-133` | A | `schema_migrations` (+checksum column) and `import_manifest`. |
| `v34-migration.ts:42-53` | A | `import_generations` + the two `valid_from_generation` ALTERs. (The card also names `import_fact_history`, which is defined a little earlier — `v34-migration.ts:27-40`; not covered by the cited range.) |
| `runtime-state.ts:284-305`, `command-queue.ts:70-74`, `import-publication.ts:51-53` | A | runtime-DB tables. |
| `mobile-goals.ts:694-735` | A | control-DB tables incl. `mobile_coach_loop_receipts`. |
| `server.ts:126-127` | A | main/control paths. |
| `import-worker.ts:489-495` | A | `var/rai.importing.<jobId><attempt>.sqlite` + staged report paths. |
| `import-worker.ts:1690-1729` | A | rollback path `var/backups/rai.import-rollback.<uuid>.sqlite`, move/install/verify. |
| `publication-lock.ts:160-186` | A | `<db>.import.lock`, `wx` candidate + `linkSync`. |
| `prediction-training-runner.ts:545-561` | A | `requiredFiles = ["model.onnx","feature-schema.json","evaluation.json","onnx-golden.json"]`. |
| `prediction-training-runner.ts:280-305` | A | `spawn(process.execPath, ["research/scripts/python-env.mjs","--train", …])`. |
| `cli.ts` staging names | A | `prepareStagingDatabase` builds `` `${target}.importing.${randomUUID()}` `` (`cli.ts:184-196`), matching the `cli_publish_candidate` label. |

### 4.4 Topology checks
- `cli → candidate_files` + `cli_write_ledger (schema_migrations --apply)` — A (`migrate-cli.ts:35-42`,
  `cli.ts:184-196,214,471`).
- `workers → main_*` — A (`recompute-thread.ts:27-32`, `prediction-worker.ts:171-199`,
  `import-worker.ts:476-500`).
- `derived_to_publish` — A via the FK (`v24-migration.ts:37`).
- `api_publishes_candidate "跨进程原子 rename 发布"` — the cross-process part is the *lock*
  (`server.ts:170-177` + `publication-lock.ts:195-197`); the rename itself is a single-process `rename()`
  (`import-worker.ts:1912-1918`). Label is loose; arrow direction (api → candidate_files) is defensible.
- `api_writes_derived` is mis-attributed — see findings.
- `api_registers_job "（同事务）"` is true only for the direct-sync lane — see findings.

### 4.5 Implemented vs planned
No planned-only element drawn. The Rust worker is correctly described as off by default ("RAI_IMPORT_ENGINE
默认 typescript，且 target/release/rai-data-worker 不在工作区里"): A — `Test-Path target` is False in this
worktree, and `native-worker.ts:69` defaults to `typescript`.

### 4.6 Coverage of 图4 ("SQLite 数据库、任务状态、候选数据库、正式数据库以及分析结果之间的关系")
Covered: main DB vs candidate file vs backup/rollback path, runtime DB, control DB, artifact dir; job status
tables (`main_jobs`); analysis results (`main_derived`); the publish gate + pointers (`main_publish`).
Under-specified: (i) the read-only path is drawn only once (`workers_read_jobs`, `api_reads_ledger`) although the
dominant read path is `ReadStoreManager` → `RaiReadStore` (`read-store-manager.ts:52-64`, `data.ts:230`);
(ii) `data:recompute`/`data:refresh-snapshots` — an unlocked writer of the main DB — is deliberately dropped from
this diagram (it is only in 图6); a reader of 图4 alone cannot see that a non-API writer exists;
(iii) `import_publications` (the durable rename intent) is listed under `runtime_db` but has no edge, so the
"candidate → published" story loses its journal.

### 4.7 Findings
| Severity | Claim | Cited evidence | What source actually shows | Required correction |
|---|---|---|---|---|
| major | `api → main_derived 写：ability_assessments / daily_*` | `database.ts:351-465`, `:720-790` (definitions only) | Nothing in the API process writes those tables. They are written by `RecomputePipeline` inside the recompute worker thread / CLI (`recompute-thread.ts:27-32` → `service.runNextJob()` → `recompute-pipeline.ts`). The API's own maintenance path only *enqueues* (`server.ts:764-786`). | Move the edge to `workers → main_derived` (already present as `workers_write_derived`), or relabel the api edge "入队触发". |
| major | `api → main_jobs 写：登记 recompute_jobs（同事务）` | `database.ts:483-515` | Two different call sites: `POST /v1/model-runs` (`server.ts:1841-1856`) enqueues in the API process with **no** surrounding transaction, while the facts+job single transaction is `direct-sync-ingest.ts:449-524`, executed by the import worker thread. | Drop "（同事务）" from this edge and keep it on the import/workers side, or state "直连车道同事务". |
| minor | "model_validation_gates.status 在 v24 由**两态**扩到含 not_evaluable" | `v24-migration.ts:35-46` | The pre-v24 table (migration 18, `database.ts:1347-1369`) already had **three** states: `'passed','failed','skipped'`. v24 widened it to `'passed','failed','not_evaluable','skipped'`. | Say "3 → 4 态" or "补入 not_evaluable". |
| minor | `control_db` sublabel "周目标 / 计划推送 / 操作幂等" | `mobile-goals.ts:694-735` | The tables are real, but the weekly *volume* target was retired (`docs/DECISIONS.md:104-108`, D14: 容量改为推导). Columns are training-goal/plan-push/plan-operation state. | Use "训练目标 / 计划推送 / 操作幂等" (mirroring `docs/ARCHITECTURE.md:53`). |
| minor | `main_ledger` sublabel + card name `import_fact_history` | `v34-migration.ts:42-53` | The table exists (`v34-migration.ts:27-40`) but the cited range starts after it. | Extend the citation to `:27-53`. |
| minor | card "候选库文件 … 只有安装后通过 quick_check / 结构探针才保留" | `import-worker.ts:1690-1729` | The API runs `isReadableDatabase(..., "activation_verify")`; the CLI's `publishDatabaseFile` runs `probeDatabaseStructure` (`cli.ts:234-240`). Both exist, but the sentence mixes the two implementations. | Say which process runs which check. |

| minor | 信任边界 region wraps only `["api"]` | boundary label "apps/api 进程" + `server.ts:465-491` | The import/recompute/prediction workers that this diagram draws as the separate `workers` box are worker threads **of the same API process** (and the CLI child it spawns); as drawn they sit outside a boundary labelled "apps/api 进程". | Wrap `api` + `workers` together (the earlier revision did), or relabel the region "HTTP/鉴权边界". |
| minor | `api_publishes_candidate` "跨进程原子 rename 发布" | `import-worker.ts:1912-1918` + `publication-lock.ts:160-186` | The rename is a plain single-process `rename()`; the cross-process element is the lock, taken at `server.ts:170-177`. | "持跨进程锁的原子 rename" or split the two facts. |
| minor | `derived_to_publish` — meaning of the arrow | `v24-migration.ts:35-46` | Correct as an FK/data relation, but the actual write order is the release path writing gates and then the singleton pointer; an FK drawing can read as "derived rows write the gate". | Optional: label "run 被 gate/指针引用（FK）". |

### 4.8 Findings for the final (restructured) revision
§4.4 and §4.7 above describe the superseded pre-restructure revision; their two majors are closed (see 4.1). The
findings that survive, plus the new ones:

| Severity | Claim | Cited evidence | What source actually shows | Required correction |
|---|---|---|---|---|
| minor | rose card: "model_validation_gates.status 在 v24 由**两态**扩到含 not_evaluable（重建表 + 逐列拷贝，v24-migration.ts:34-55）" | `v24-migration.ts:34-46` | The pre-v24 table (migration 18, `database.ts:1347-1369`) already had **three** states — `CHECK (status IN ('passed','failed','skipped'))`; v24 rebuilds it as `'passed','failed','not_evaluable','skipped'`. The "重建表 + 逐列拷贝" half is exactly right (`ALTER … RENAME` → `CREATE` → `INSERT … SELECT` → `DROP`). | Say "3 → 4 态，补入 not_evaluable". |
| minor | `import_write` label "导入写路径" carries `migrate-cli.ts:34-46` | that range | The migration CLI is an **offline** writer of `schema_migrations`, taken under the CLI publication lock; it is not part of the import path, and after the restructure no component or edge represents it. | Either add a small `离线 CLI` component with `cli → main_jobs` (schema_migrations), or move that source to `main_jobs` and note it in the card. |
| minor | request-path writes are now under-drawn | `server.ts:1841-1856`, `:1858-1889` | `POST /v1/model-runs` enqueues a `recompute_jobs` row and `POST /v1/model-runs/:id/activate` writes `active_model_run` + `model_release_refusals`, both from the API request path. The new graph has `req_write → main_derived / runtime_db / control_db` but neither `req_write → main_jobs` nor `req_write → main_publish`. | Add the two request-path edges (they are the manual activation path the user asked to see). |
| minor | `req_write → main_derived` labelled "写 用户输入" | `database.ts:467` (`workout_overrides`), `v26/v27` (privacy zones, performance entries) | True: overrides, privacy zones and performance entries all live in this bucket, but `main_derived`'s other members are pipeline outputs written by `analysis_write`. | Optional: name the three tables in the label. |
| minor | 持久化边界 region excludes the offline writer | boundary `wraps` | The migration CLI writes `var/rai.sqlite` under the same publication lock; as drawn it lives outside both boundaries. | Fold it in if the `离线 CLI` component is added. |
| info | three boundaries | `boundaries` | `主库 var/rai.sqlite（单文件·WAL·单写者）`, `信任边界：写路径互斥`, `var/ 下其余持久化` — all three are source-backed (single writer: `mutation-coordinator.ts:14-25` + `task-admission.ts:16-39`; file paths: `server.ts:126-128`). | — |

**Verdict: verified-with-corrections** (0 invented entities; every drawn table backed by a real `CREATE TABLE`;
no blocker; 5 minor). Gate health: passing receipt bound to the current bytes.

---

## 5. 图5 模块依赖 — `architecture-modules/candidate.json`

Verified revision: sha256 `db0f244617791878f3596f0caf270434c734588e3c18f16cad558ad9533698cc` (12 129 bytes).
Finalize receipt `ok:true`, all four gates pass. (Authored by the Lead; verified adversarially like the rest.)

### 5.1 What the diagram claims
9 components (api, application, storage, parser, algo, contracts, inference, rust, python), one security-group
boundary labelled after `check-package-boundaries`, 9 connections, 4 cards.

### 5.2 Citation checks (opened)

| Citation | Verdict | Note |
|---|---|---|
| `apps/api/package.json:16-25` | A | exactly the ten `@rai/*` packages the card lists: api-contracts, application, contracts, dynamics, health-export-parser, model-eval, physiology, readiness, storage-sqlite, training-load. |
| `server.ts:29-43` | A | the API's import block, incl. `@rai/storage-sqlite` (:43). |
| `server.ts:465-496` | A | worker assembly. |
| `service.ts:55-71` | A | `RaiApplicationService` builds `RecomputeJobRepository` / `SqliteModelRunRepository` / `SqliteTrainingSessionRepository` / `RecomputePipeline`. |
| `service.ts:288`, `write-gate.ts:15-30` | A | `runNextJob()`; narrowed `AnalysisStore` + `WriteGate`. |
| `database.ts:124-126`, `publication-lock.ts:160-186`, `recompute-job-repository.ts:104-129` | A | migration start, cross-process lock, `claimNext`. |
| `apple-health-parser.ts:428` | A | `new SaxesParser({ xmlns: false })` — the SAX claim. |
| `canonicalize.ts:240`, `identity-algorithm.ts:127` | A | `canonicalizeRunningWorkouts`, `identityAlgorithmFingerprint`. |
| `scoring/src/index.ts:13` | A | `SCORING_MODEL_VERSION = "rai-v2.0.0"`. |
| `scoring/src/model.ts:425`, `recompute-pipeline.ts:213` | A | `scoreFeature`; the `extractFeatures` call site. |
| `packages/scoring/package.json:1-13` | A | dependencies = `@rai/contracts` only — scoring really is a leaf. |
| `server.ts:50` | A | `DATABASE_TIMEZONE` from `@rai/contracts`. |
| `prediction-inference/src/index.ts:5`, `:134-139` | A | `onnxruntime-node` import; `OnnxCatBoostResidualModel.load` (manifest.json + model.onnx). |
| `prediction-model-service.ts:39-45` | A for the floors, weak for this component | It is the minimum-label block, not an inference statement. |
| `native-worker.ts:69-74`, `:121-126`, `server.ts:133-136` | A | Rust default-off, spawn shape, startup failure rule. |
| `package.json:79-83`, `README.md:18` | A | `ml:*` scripts; "Python 只用于可选训练，不是 Web/API 启动依赖". |

### 5.3 Edge-direction checks (the Lead's questions)
- `api → application` — A. `apps/api/package.json:17` declares `@rai/application`, the API imports it, and the
  direction is one-way: `check-package-boundaries.mjs:132-143` forbids `packages/*` from importing `apps/*`.
- `application → storage / parser / algo / inference` — A. `application` declares and imports all four
  (`check-package-boundaries.mjs:41-53`: application → contracts, durability, features, health-export-parser,
  model-eval, normalization, physiology, prediction-inference, readiness, scoring, storage-sqlite, training-load,
  training-zones). The parser edge is real but the label "canonical 化" names only one of its uses: the other is
  the engine adapter (`application/src/cli.ts:5-6` imports `RecomputePlan`, `importEngine`, `nativeFallback`,
  `nativeElevationGains`, `NATIVE_VERSION`) and `backfill-canonical-nights.ts:4` imports `canonicalizeNights`.
- `scoring` leaf — A (`packages/scoring/package.json:9-11`), and `check-package-boundaries.mjs:79-84` additionally
  forbids scoring → readiness / storage-sqlite / application / model-eval.
- Rust default-off — A; ONNX requires an artifact — A (`load()` reads `manifest.json` + `model.onnx`, and
  `prediction-report.ts:30` is the consumer); Python offline-only — A (`README.md:18`).

### 5.4 Findings
| Severity | Claim | Cited evidence | What source actually shows | Required correction |
|---|---|---|---|---|
| major | edge `algo → contracts` labelled "只依赖契约" | `scoring/package.json:1-13`, `server.ts:50` | True for `scoring`, false for the component that is drawn: its sublabel is "features · scoring · readiness · training-load". `check-package-boundaries.mjs` whitelists `features -> normalization` (:59) and `training-load -> readiness` (:70), and the live code matches — `recompute-pipeline.ts:3` imports `@rai/normalization`, `training-load-data.ts:4` imports `@rai/readiness`. | Split the node (e.g. `features`+`training-load` vs `scoring`+`readiness`), or relabel the edge "以 contracts 为共同契约（features→normalization、training-load→readiness 另计）" and add those two edges. |
| minor | boundary label "npm run check:package-boundaries 禁线" wraps `api` | `check-package-boundaries.mjs:166-173` | The edge whitelist and the forbidden-edge rules are applied to `scope === "packages"` only; `apps/api` is checked by rule A (`packages` must not import apps), not by the edge whitelist. | Move `api` outside the boundary or relabel it "packages 依赖禁线（apps 不在其内）". |
| minor | card: "本次未逐条阅读规则表，判为无法确认" | `check-package-boundaries.mjs:39-84` | I did read the rule table: `ALLOWED_EDGES` (30 edges) and 4 `FORBIDDEN_EDGES`; they confirm the doc's claim about package→app and Fitness(scoring)→Readiness. | Upgrade that item to A with `scripts/check-package-boundaries.mjs:39-84`; the doc-vs-source item then reads "matches". |
| minor | `inference` component source `prediction-model-service.ts:39-45` | that range | Minimum-label floors, not an inference/fallback statement. | Replace with `prediction-report.ts:30` (ONNX model construction) or the artifact-boundary check. |
| minor | missing edges | ALLOWED_EDGES / imports | `apps/api` also imports `@rai/storage-sqlite` (`server.ts:43`) and `@rai/health-export-parser` (`server.ts:72`) — neither `api → storage` nor `api → parser` is drawn; `storage-sqlite -> model-eval` is also whitelisted and undrawn. | Add them or state that the diagram shows the primary path only. |

**Verdict: verified-with-corrections** (directions and default states all correct; one major over-generalised
edge, four minors). Gate health: passing receipt bound to the current bytes.

---

## 6. 图6 风险与边界 — `architecture-risks/candidate.json`

Verified revision: sha256 `7eace9855c29d345be30c2cad9380af212807c47ff146215d4091ea6c0a94aa7` (14 526 bytes).
Finalize receipt `ok:true`, all four gates pass, artifact `architecture-risks.html` sha
`81ec0e9ab15ef5544ced6bce8f419f3b9eac4bf76ca9c6e48e0104e34e320577` (784 614 bytes); I recomputed both hashes and
they match. History worth recording: an **earlier** passing receipt was bound to a 17 380-byte spec while a
different 14 526-byte file sat on disk (delivered HTML out of sync with the spec) — that binding defect is fixed
in the current receipt. I re-read the current bytes in full; components, connections, cards and every citation are
identical to the version I verified line-by-line, only `pos`/`size` and two labels changed (`http-in` is now
"Bearer /v1").
The DOC-SOURCE-DIFF.md companion file was also read and spot-checked (§6.6).

### 6.1 What the diagram claims
12 components, 2 boundaries, 12 connections, 7 cards: 3 "已保护（A）" cards, 3 "缺口（A）" cards, 1 doc-diff card.

### 6.2 Citation checks (opened)

| Citation | Verdict | Note |
|---|---|---|
| `import-routes.ts:38-51` | A | upload route + ZIP MIME/extension checks. |
| `import-sources.ts:98-106` | A | `DEFAULT_LIMITS.maxArchiveBytes = 4 * 1024 ** 3` (also 12 GiB extracted, 100 000 entries, ratio 1 000, 16 GiB stored, 512 MiB free). Supports the "ZIP ≤ 4 GiB" tag. |
| `local-request-security.ts:116-135` | A for the gate, weak for the `client` component | `isTrustedUnsafeRequest` — bearer/remote/trusted-origin rule. The ZIP claim comes from the other two citations. |
| `local-request-security.ts:137-172` | A | `installLocalRequestSecurity`: Bearer compare, remote-origin 403, anonymous public read, 401/403 fallback. |
| `local-request-security.ts:57-68` | A | `isAnonymousPublicRead` requires safe method + listed route + listed host + resolved route. |
| `mutation-coordinator.ts:11-37` | A | `acquire()` 409 `mutation_conflict`; `acquireWhenAvailable` default 2 000 ms. |
| `server.ts:426-435` | A | the preHandler call site + post-wait re-check. |
| `task-admission.ts:9-59` | A | FIFO waiting set; `blockUntilRestart`; `acquireControl`. |
| `server.ts:412-414`, `:422-424` | A | blocked → 409 `publication_recovery_required`; control-owner pinning for cancel routes. |
| `import-payload-identity.ts:120-136` | A | `importPayloadSha256` folds contractVersion / preserve-replace / engine / content sha (identityAlgorithm optional at :134-136). |
| `import-payload-identity.ts:204-223` | A | `writeImportPayloadAnchor` under `synchronous=FULL` + `wal_checkpoint(TRUNCATE)`. |
| `import-payload-identity.ts:50-59` | A | text states `CONTRACT_VERSION` is the manual half and "No function can compute that one". |
| `import-payload-identity.ts:62-66` | A | the two `import_manifest` keys. |
| `identity-algorithm.ts:127-137` | A | fingerprint = sha256 over every probe's `stableId`. |
| `identity-algorithm.ts:50-137` | A | probe list is the whole input to the fingerprint — the "probes only" claim holds. |
| `import-worker.ts:1678-1740` | A | `activateStagedDatabase` incl. journal prepare/commit. |
| `import-worker.ts:1716-1729`, `:1787-1824` | A | activation order and rollback. |
| `import-publication.ts:47-118` | A | journal in `var/runtime.sqlite`, `recover()` with `quick_check` + receipt rules. |
| `direct-sync-ingest.ts:426-468` | A | caller-owned open, write guards, synchronous=FULL before BEGIN, begin/parse. |
| `direct-sync-ingest.ts:584-613` | A | batch receipt, three pre-commit read-backs, `commitCallerTransaction()`. |
| `command-queue.ts:107-146` | A | idempotency key/fingerprint/capacity 16/backoff. |
| `command-queue.ts:177-230` | A | one `BEGIN IMMEDIATE` for effect + receipt. |
| `write-lease.ts:78-108`, `:269-311` | A | client acquire, fail-open, `withWriteGate`. |
| `write-lease.ts:35-36`, `:49-50`, `:87-103` | A | 30 s default, "非 0 就是异常" comment, timeout branch that keeps writing. |
| `recompute-thread.ts:6-23` | A | proxy + explicit `pruneSupersededModelRuns` wrap. |
| `publication-lock.ts:160-186`, `:195-213` | A | lock path, `wx`+`linkSync`, live-owner refusal, tombstone construction. |
| `server.ts:170-177` | A | API acquires the publication lock at startup and releases on exit/close. |
| `server.ts:372-374`, `:1390`, `import-routes.ts:17` | A | second `MutationCoordinator` (`sourceMutations`), independent `TryAcquireGate`, source-lock acquisition. |
| `maintenance.ts:105-109` | A | `ABANDONED_DATABASE_FILE_PATTERN = /\.(?:replaced\.[0-9a-fA-F-]{36}\|importing\.[^/\\]+)$/`. |
| `maintenance.ts:729-768` | A | `reclaimDisplacedDatabases` filters by that pattern and skips non-files (`:750`). |
| `restore-journal.ts:24-63` | A | separate `<target>.restore-journal.sqlite`, phase validation, manual-recovery errors. |
| `direct-sync-plan.ts:47-56`, `:68-96` | A | lane predicate (requires engine=typescript!) and the type-level `preserveAbsent: true` + runtime field rejection. |
| `data-only-import.ts:97-99` | A | the same runtime shape assertion. |
| `recompute-pipeline.ts:314` | A | `evaluateModelTransitionGateV2` is called in the release path. |
| `package.json:60`, `:69`, `application/src/cli.ts:39`, `:57` | A | `data:recompute` / `data:refresh-snapshots` scripts; `RaiDatabase.open(databasePath)` then `runNextJob()`; the whole 99-line file imports no lock and calls no `acquireDatabasePublicationLock`. |

### 6.3 Are the claimed gaps real? (Lead's check (b) — searched for the terms a fix would use)

| Gap claim | Counter-search | Verdict |
|---|---|---|
| Lease fail-open lets a write window run without the single-writer permit | `write-lease.ts:91-101` stores `LEASE_REQUEST=0`, bumps `stats.timeouts`, calls `onTimeout` (default stderr) and continues; no branch flips the writer to read-only, and no caller consumes `stats.timeouts` other than the worker's `postMessage` (`recompute-thread.ts:36-40`) | **A — real gap**, correctly described. |
| `data:recompute` / `data:refresh-snapshots` write the main DB with no lock | whole-file read of `application/src/cli.ts`; `acquireDatabasePublicationLock` callers are only `server.ts:170`, `health-export-parser/src/cli.ts:204`, `migrate-cli.ts:35` | **A — real gap.** The lock is advisory anyway: `RaiDatabase.open` never checks it, so a second writer is refused only when it *asks* for the lock. |
| `.import.lock.stale.*` / `.import.lock.candidate.<uuid>` have no reclaimer | only writer is `publication-lock.ts` (constructs both names by template at `:177`, `:203`, `:213`); the only sweeper is `reclaimDisplacedDatabases`, whose regex and `isFile()` guard exclude both | **A — real gap.** |
| Two independent locks in-process | `server.ts:372-374`; `TryAcquireGate` at `:1390` | **A — real**, though `sourceMutations` only guards import-source bookkeeping, so no consequence was demonstrated (the card says so honestly). |

Observed artifact count: I counted **79** `rai.sqlite.import.lock.stale.*` directories (the card says 80) and
**12** `rai.sqlite.import.lock.candidate.<uuid>` files (matches). The directory is live, so the exact number is
not a stable claim — see findings.

### 6.4 Implemented vs planned
Nothing planned-only is drawn. Conversely, every protection claimed as present is real: the publication journal,
the three-step activation order, the hard-link lock, the shared idempotency receipt, and the direct-sync
pre-commit assertions all exist where claimed. No invented protection found.

### 6.5 Coverage of 图6 (重复执行 / 并发写入 / 数据一致性 / 原子发布 / 失败恢复 / 增量同步)
Covered: 重复执行 (idempotency keys, receipts, replay short-circuit), 并发写入 (single-writer + admission +
lease + process lock, including the two gaps), 数据一致性 (pre-commit read-backs, anchors, generation counters),
原子发布 (journal + activation order + lock), 失败恢复 (recover() rules, restore journal, reclaimer scope),
增量同步 (preserveAbsent double gate, generations, dirty window). Under-specified: (i) the **restore/delete**
path (`server.ts:1961-2007`) is only referenced through `maintenance`, although it is the other operation that
replaces the main DB; (ii) the prediction training **DB lease** with heartbeat
(`prediction-worker.ts:254-267`) is a second, DB-level concurrency mechanism that the diagram does not mention;
(iii) the `.restoring.` staging prefix (`restore-journal.ts:47`) is not drawn.

### 6.6 Findings
| Severity | Claim | Cited evidence | What source actually shows | Required correction |
|---|---|---|---|---|
| minor | "全仓搜索 `import.lock.candidate` / `import.lock.stale` 只命中 publication-lock.ts 自身" | `publication-lock.ts:177,203,212-213,222-238` | A literal repo-wide search for `import\.lock\.(stale\|candidate)` returns **zero** matches — the strings are composed from `` `${lockPath}.stale.${…}` `` / `` `${lockPath}.candidate.${…}` ``, so even `publication-lock.ts` does not contain the literal. The substantive point (no reclaimer) still holds. | Rephrase: "两处名字都由 `lockPath` 模板拼出，没有任何读取/回收它们的代码路径". |
| minor | "var/ 现有 **80** 个 …stale.* 目录" | observation | I counted **79** at 16:2x on 2026-10-13; the count moves with every acquisition. | Say "约 80（审计时实测 79–80）" or drop the exact number. |
| minor | `client` component source `local-request-security.ts:116-135` | — | That range is the trusted-unsafe-request rule; it does not evidence "本地 / 公网调用方" or the ZIP limit. | Replace with `server.ts:129-132` + `import-routes.ts:49-51`, or move it to the `security` component. |
| minor | `maintenance` tag "显式跳过目录 / API 启动即持有(publishlock)" | `maintenance.ts:750`, `server.ts:170-177` | Both true. The reclaimer also runs on a daily timer (`server.ts:841-853`) and after backups (`maintenance.ts:211`), which is why stale artifacts persist — worth one clause. | Optional clarification. |
| info | DOC-SOURCE-DIFF.md `C4` marks ALGORITHM.md:330 as `cannot confirm` | `model-transition-gate.ts:302-303,313` | The gate sets `status = "not_evaluable"` when only `notEvaluableReasons` are non-empty and sets `blocksActivation = status !== "passed"`. The doc's claim is therefore **confirmed**, not unknown. | Upgrade C4 (ALGORITHM.md:330) from C to A: cite `packages/storage-sqlite/src/model-transition-gate.ts:302-303,313`. |
| info | DOC-SOURCE-DIFF.md `B1` | `database.ts:2256-2267` | `commitCallerTransaction()` throws `Refusing to commit with N unreleased savepoint(s)` when the stack is non-empty, so B1's guard is implemented, not just documented. | Upgrade B1 to A. |

Separately verified as accurate: DOC-SOURCE-DIFF entries #1 (`README.md:18` vs `package.json:126`), #2
(`README.md:34` / `ARCHITECTURE.md:66` vs `server.ts:129-131`), #5 (no generation column in
`command-queue.ts:71-74`), #6 (activation gate = checkpoint + rename + read check,
`import-worker.ts:1718-1729`), #8 (`server.ts:1969-1975`, `:1994-2002`), #13 (`database.ts:1677`), #15
(`direct-sync-plan.ts:55`, `import-worker.ts:556-616`), #16 (`cli.ts:189-195`, `import-worker.ts:1171-1192`),
#17 (`import-sources.ts:604-613`), #19, #20/#21 (`native-record-writer.ts:80-84`, `:250-253`, incl. the correct
precision note that the regex accepts any 36 `[a-f0-9-]` characters), #24 (`ALGORITHM.md:38` text matches).

### 6.7 Agreed evidence-class upgrades (recorded here because DOC-SOURCE-DIFF.md is frozen)
The Lead accepted both of my upgrade proposals; they are recorded in this file only, as instructed:
- **C4 → A**: `docs/ALGORITHM.md:330` ("not_evaluable 是正式状态，不能按'不是 failed'绕过激活") is confirmed by
  `packages/storage-sqlite/src/model-transition-gate.ts:302-303` (`status = failureReasons.length > 0 ? "failed" :
  notEvaluableReasons.length > 0 ? "not_evaluable" : "passed"`) and `:313` (`blocksActivation: status !== "passed"`).
- **B1 → A**: the "leaked savepoint refuses the caller's commit" guard is implemented, not merely documented:
  `packages/storage-sqlite/src/database.ts:2261-2263` throws
  `Refusing to commit with N unreleased savepoint(s): …` before `COMMIT`; `rollbackCallerTransaction()` clears the
  savepoint stack at `:2274`.
- One item I could **not** resolve is recorded as C5 in §8 — and I corrected it there myself: DOC-SOURCE-DIFF.md
  §6's `check-geometry.mjs` reproduction command is valid (the tool exists under `.archify/tools/`).

**Verdict: verified-with-corrections** (all six risk claims stand — no invented gap and no invented protection;
4 minor wording/citation defects remain; 2 doc-diff evidence classes can be strengthened).
**Gate health: passing**, receipt bound to the current bytes.

---

## 7. Summary table (final revisions — all six present, all six passing)

| Diagram | Candidate sha256 inspected | Verdict | Blockers | Majors | Minors |
|---|---|---|---|---|---|
| 图1 系统总架构 | `22b2846e…` (13 434 B) | **verified** | 0 | 0 | 0 |
| 图2 核心数据流 | `5d6ab025…` (11 871 B) | **verified** | 0 | 0 | 2 (cosmetic) |
| 图3 服务端执行时序 | `fc1edbb2…` (10 817 B) | verified-with-corrections | 0 | 1 (analysis-consumer wake-up not drawn; no schedule call site in the import path) | 0 |
| 图4 数据库读写关系 | `38269f31…` (16 707 B) | verified-with-corrections | 0 | 0 | 5 |
| 图5 模块依赖 | `db0f2446…` (12 129 B) | verified-with-corrections | 0 | 1 (`algo → contracts` "只依赖契约" is false for features/training-load) | 4 |
| 图6 风险与边界 | `7eace985…` (14 526 B) | verified-with-corrections | 0 | 0 | 4 |

No blocker remains in any candidate. The two majors that survive are *labelling/causality* defects, not fabricated
facts: every drawn structure, table, protocol string and status string I opened is real.

### Gate health (check 5) — receipt↔file hash binding recomputed from disk
I recomputed sha256 for every `candidate.json` and every delivered `.html` and compared them with the receipt's
`specification.sha256` / `artifact.sha256`; "✓ bound" means both match.

| Folder | `meta.repository` | `meta.output` | Candidate bound | HTML bound | Gates |
|---|---|---|---|---|---|
| architecture-system | gitee URL + revision `60678af…` ✓ | `architecture-system.html` ✓ | ✓ `22b2846e` | ✓ `146740f3` (774 912 B) | **pass** ×4 |
| dataflow-core | ✓ | `dataflow-core.html` ✓ | ✓ `5d6ab025` | ✓ `4c313996` (769 920 B) | **pass** ×4 |
| sequence-analysis | ✓ | `sequence-analysis.html` ✓ | ✓ `fc1edbb2` | ✓ `79982be4` (775 340 B) | **pass** ×4 |
| architecture-database | ✓ | `architecture-database.html` ✓ | ✓ `38269f31` | ✓ `a4fa9673` (791 213 B) | **pass** ×4 |
| architecture-modules | ✓ | `architecture-modules.html` ✓ | ✓ `db0f2446` | ✓ `b737a5d0` (772 548 B) | **pass** ×4 |
| architecture-risks | ✓ | `architecture-risks.html` ✓ | ✓ `7eace985` | ✓ `81ec0e9a` (784 614 B) | **pass** ×4 |

Every candidate carries the exact required `meta.repository.url` / `provider` / `revision`
(`60678af97e4710cfd8444b3952df9fff09c2bff3`) and writes its HTML inside its own folder.

Caveat recorded honestly: passing `browser-check` is a gate, not my own visual inspection. For system, risks and
modules the receipts additionally emit a `visualReviewRecommendation` (route crossings / 3-bend detours); I did
**not** look at the rendered pages, so I cannot claim visual quality — only that the automated gates passed and
that the receipts are bound to the bytes I verified.

---

## 8. Claims I could not verify (B / C)

**B — inferred, no single line asserts it**
- B1. 图3: that a `recompute_jobs` row registered by the default direct lane is picked up *without* another
  trigger. The lack of a `recomputeWorker.schedule()` call in the import path is A (I enumerated every call site),
  but whether the 5-minute `zoneRefreshTimer` (`server.ts:809-814`) or a later write command always wakes it in
  practice is an inference. If the wake-up can be delayed, the "analysis updated" UX claim in 图2/图3 is a
  *registration*, not a completion, guarantee.
- B2. 图1/图2: that the direct lane is the lane a real iOS sync takes. The predicate is source-provable
  (`direct-sync-plan.ts:47-56`) and the fast-path default is `"1"` (`server.ts:168`), but the payload the phone
  actually sends (sync manifest present, `preserveAbsent` true, dataset size class) is deployment data, not
  repository data.
- B3. 图4/图6: that `var/` really contains 80 stale `import.lock.stale.*` directories *because of* the missing
  reclaimer. I counted 79 at one instant and 12 `.candidate.` files; the causal link is inference, as the risk
  author already labels it.
- B4. 图6: that the two-lock situation (`sourceMutations` vs `mutationCoordinator`) can interleave badly. Both are
  A as facts; the absence of an observed consequence is what keeps it B.

**C — could not confirm from this repository**
- C1. `docs/ALGORITHM.md:331-333` (bundle rollback rules, checkpoint reuse, override-snapshot matching at
  activation). The risk author marked these C; I only read `model-transition-gate.ts` (which resolves :330 — see
  the upgrade note in §6) and did **not** read `model-release-repository.ts` or the checkpoint-reuse predicate.
- C2. `docs/ARCHITECTURE.md:62` ("原始记录不能随模型回滚重写"): the rollback implementation was not read.
- C3. Deployment-only facts: Nginx/TLS, systemd unit, PM2 absence, whether `RAI_IMPORT_ENGINE`,
  `RAI_RUST_FALLBACK` or `RAI_IMPORT_DATA_ONLY_FAST_PATH` are set in production. None of the six diagrams draws
  them as fact; 图2 and 图3 mark the engine question as UNKNOWN, which I confirm is the honest treatment.
- C4. iOS credential isolation (`docs/ARCHITECTURE.md:68`): I read `APIClient`/`HealthKitSync` auth usage and
  `Keychain.swift` exists, but I did not audit keychain access control.
- C5. **Corrected during my own audit**: I first recorded that DOC-SOURCE-DIFF.md §6's reproduction command
  (`.archify/tools/check-geometry.mjs`) could not be run because the path was missing. That was wrong — the tool
  exists (`.archify/tools/check-geometry.mjs`, 6 856 B, along with `apply-layout.mjs`, `check-artifacts.mjs`,
  `layout-search.mjs`, `restore-database-layout.mjs`). The command in §6 is therefore reproducible as written; I
  did not execute it because it is a geometry pre-check, not a source-fidelity check.
- C6. `docs/README.md` "54 项验收合同" completeness — not cross-checked against the acceptance matrix.
