# 训练计划 API 读路径与快照一致性审查（2026-10-18）

- 审查者：api-read-reviewer（Team Lead 的 teammate），只读审查，未修改仓库任何文件，未读写 `var/rai.sqlite`。
- 共享任务：`task-1`「审查训练计划 API 读路径与快照一致性」。
- 本报告分级：P0（阻断/错误数据）> P1（安全/一致性语义被破坏）> P2（真实缺陷或契约缺口）> P3（观察、文档偏差、待确认）。P3 风格意见 3 条（上限 5）。

## 1. 审查范围

### 1.1 代码（逐个读过）

| 文件 | 关注点 |
|---|---|
| `apps/api/src/data.ts` | `RaiReadStore.trainingPlanState`（515–595）、`factAnalysisBlocks`（479–500）、`coachLoopFacts`（256–305）、`mobileToday`/`mobileTodayWithExecutablePlan`/`mobileTodayWithViews`（597–941）、`mobileWorkoutPlan`/`mobileWeeklyPlanInputs`（948–1046）、`mobilePlanPrescription`（1053–1055）、日期与容量辅助（127–180、1062–1071） |
| `apps/api/src/mobile-read.ts` | `assembleMobileCoach`（156–483）、`assembleMobileWorkoutPlan`（529–591）、恢复/周汇总读取（221–248、677–750） |
| `apps/api/src/server.ts` | `/v1/mobile/training-plan-state`（1325–1328）、`/v1/mobile/today`（1317–1323）、`/v1/mobile/workout-plan`（1344–1347）、`/v1/mobile/goals`（1528–1530）、`/v1/mobile/plan-operations/:id`（1330–1331）、coach-loop 装配（1333–1340）、`withReadStore`（650–658）、读路由数据集门禁（396–435、149–151、596–597）、错误处理（2050–2060）、handshake 能力位（924–953） |
| `apps/api/src/read-store-manager.ts` | 读租约、缓存连接、`beginReplace`/`endReplace`、close 生命周期（全文 153 行） |
| `packages/storage-sqlite/src/read/fact-read-view.ts` | 事务内/外两块视图读（88–155、178–351） |
| `apps/api/src/local-date.ts`、`workout-date-window.ts`、`weekly-plan-service.ts`、`plan-execution.ts` | 真实日期校验、闭区间窗口、执行窗口装配、依从性/执行条 |
| `apps/api/src/mobile-goals.ts`（读侧） | 控制库 `read`/`planHistory` 缓存与失效（207–226、422–470、804–858） |
| `apps/api/src/coach-loop-runtime.ts`、`coach-loop-routes.ts` | `GET /v1/mobile/coach-loop` 的读取与 `executionToken`（89–93、178–181、474–489；路由 24–26） |
| `apps/api/src/api-error.ts`、`packages/api-contracts/src/index.ts` | 错误状态映射；`TrainingPlanStateResponse`（1202–1229） |

### 1.2 测试（定向运行）

- `apps/api/test/training-plan-state.test.ts`：9/9 通过。
- `apps/api/test/pr5-read-side.test.ts` + `apps/api/test/data.test.ts`：44/44 通过。
- 本地 `onnxruntime-node` 原生绑定签名失效（`ERR_DLOPEN_FAILED`），上述运行用 `/tmp` 的 `onnxruntime-node` 替身 loader 注入（仅替换推理依赖，不涉及被测读路径）；这是环境限制，不是仓库问题，见 §6。
- 只做了定向测试与 `/tmp` 探针，未跑全量 `node scripts/run-tests.mjs`（其他 lane 负责）。

### 1.3 作为“承诺行为”基线的文档

`docs/IOS_TRAINING_PLAN_STATE_V1.md`（读取契约、两种摘要、失败语义）、`docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md`、`docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md` §4–5（`coherenceToken` 输入范围、“构建前后核对…最多重建三次”）、`docs/COACH_LOOP_IMPLEMENTATION_STATUS.md`（新合同读取与 409 隔离）、`docs/DECISIONS.md` D5/D6/D13/D14/D16、`docs/ALGORITHM.md`（读侧口径）。

## 2. 结论摘要

1. **聚合端点本身的冻结视图机制是成立的**：`trainingPlanState` 用一次 `BEGIN DEFERRED` 固定主库 WAL 快照，构建前后用 `data_version` + 控制库 goals/history 摘要 + `datasetEpoch` + 上海业务日期做回验，失败重建（上限 3 次）后抛 `503 plan_snapshot_changed`。代码路径与现有回归（9/9、44/44）一致，未发现 P0。
2. **但该保证只覆盖 `/v1/mobile/training-plan-state`，而当前 iOS 实际用于手表排期的主读路径是 `/v1/mobile/coach-loop`**：coach-loop 的读取把 control 库状态（saved/goals/history）分多次独立读出后才开主库读事务，且事后没有任何回验（R-1，P1）。文档 §5.1 只对聚合端点作承诺，因此这更像“新主路径未继承契约”的实现缺口。
3. **HTTP 缓存硬化不一致**：只有 `training-plan-state`/`coach-loop` 设 `Cache-Control: no-store`；`today`、`workout-plan`、`goals`、`run-coach`、`plan-operations/:id` 全部没有（R-2，P2，已用真实 HTTP 响应头证实）。
4. **错误语义有两处缺口**：`statSync` 的任何文件系统错误（含 TOCTOU、EACCES/EIO）未经分类直落 `500 internal_error`（R-3，P2）；`503 plan_snapshot_changed` 对新快照客户端没有任何前台重试（iOS 侧 retries=0），也没有 `Retry-After`（R-4，P2）。
5. **身份/时区/日期/窗口/availability 校验是完整的**：`Asia/Shanghai` 固定、真实日期、7 天连续唯一窗口、`availability` 与 `workoutPlan.days` 同源；iOS 的 fail-closed 校验所需字段在响应中都存在（§5）。
6. `coherenceToken` 覆盖处方级决策输入与发布摘要（`import_manifest`/`active_model_run`/zone settings/恢复证据）及有效执行窗口内容；未覆盖 plan history 派生的展示字段与 `versions`/`freshness`（后者按 PR5 C9 是刻意放在 token 之后），未发现处方级 fail-open（R-5，P3 待确认）。

## 3. 发现

### R-1（P1）coach-loop 读路径没有跨存储域冻结/回验，可能返回“从未同时存在过”的 control+facts 组合

- **位置**：
  - `apps/api/src/coach-loop-runtime.ts:89-93`（`read()` 先读 control、再读 facts，事后无回验）
  - `apps/api/src/coach-loop-runtime.ts:474-489`（`executionToken` 用 `goals.revision`，响应同时带 `goals`/`today`/`days`）
  - `apps/api/src/data.ts:256-305`（`coachLoopFacts` 的 `BEGIN DEFERRED` 只包住主库读，goals/history 由调用方传入）
  - `apps/api/src/server.ts:1337-1340`（生产装配：`(goals, history) => withReadStore(store => store.coachLoopFacts(...))`）
- **关键代码**：
  ```ts
  // coach-loop-runtime.ts:89-93
  read(): CoachLoopRuntimeResponse {
    const saved = this.saved(), goals = this.store.read();
    const facts = this.readFacts(this.effectiveGoals(goals, saved?.settings ?? null), this.store.planHistory(200));
    return this.evaluate(goals, facts, saved, saved?.settings ?? null).response;
  }
  ```
  ```ts
  // coach-loop-runtime.ts:474-477
  const executionToken = digest({ scope, factsHash: facts.factsHash, revision: goals.revision, ...
  const response:CoachLoopRuntimeResponse={contractVersion:1,scope,...,revision:goals.revision,factsHash:facts.factsHash,...}
  ```
- **现象**：`saved`、`goals`、`planHistory(200)` 是 control 库上三次（`effectiveGoals` 前再读一次）独立读取，之后才由 `readFacts` 在主库开一个 `BEGIN DEFERRED`。control 状态的时间点都早于主库快照；两次快照之间若发生一次 control 写（例如周一 `ensureWeeklyPlan` 生成课表、另一台设备的 refresh/update）再叠加一次数据写（导入/直连同步），响应就会是「旧 weekPlan/settings + 新训练事实」，该组合在任一真实时刻都不同时成立。iOS 侧 `TrainingPlanStore.refresh()` 在 `coachLoopContractVersion == 1` 时直接消费该响应并进入系统排期（`apps/ios/RAI/TrainingPlanStore.swift:188-210`），`executionToken` 里绑的却是旧 `goals.revision`。
- **证据 / 验证状态**：已证实（代码路径；`data.ts:259` 的 `BEGIN DEFERRED` 只从 `coachLoopFacts` 第一次读开始取快照，`mobile-goals.ts:220-226` 的 `read()` 与 `422-432` 的 `planHistory()` 都在事务外）。实际触发需要并发写，未做压测，故“设备上真实发生概率”待确认。
- **影响**：可能把旧配置下的处方（甚至已暂停/结束状态下不该出现的课）写进手表，随后服务端回执核验用当前 `executionToken` 会得到 `matchesCurrent=false`（`apps/api/src/coach-loop-device-sync.ts:33`），于是设备上留下一条“无法核验/需撤回”的系统排期。安全上是 fail-closed，但用户可见且需要人工撤回。
- **建议修复**：
  1. 把 control 读取也纳入同一窗口并回验：读完后复算 `digest({goals, history, saved})` 与 `executionToken` 依赖值，变化则最多重建 3 次后返回显式 409/503（可复用 `trainingPlanState` 的模式，或把 `coachLoopFacts` 的入参 goalse/history 改为在事务前读取、事务后回验）。
  2. 至少在 `read()` 返回前断言 `this.store.read().revision === goals.revision` 且 `saved === this.saved()`，失败返回 `coach_facts_changed` 类可重试错误。
  3. 若确定只允许单写者，也应把该限制写进 `COACH_LOOP_IMPLEMENTATION_STATUS.md` 的读取契约，并让 iOS 侧不把该响应视作可排期快照。
- **同类未受保护端点**（仅记录，不单列发现）：`/v1/mobile/today`（`server.ts:1319-1322`，goals 在进读事务前读）、`/v1/mobile/workout-plan`（`1344-1346`）、`/v1/mobile/run-coach`（`run-coach.ts:336-339`）、`/v1/mobile/goals`（`server.ts:1530`）。这些端点在文档中已明确不承诺强事实快照（`IOS_TRAINING_PLAN_STATE_V1.md:14`），属于 known limitation；但 R-1 的 coach-loop 是当前排期主路径，不能沿用该豁免。

### R-2（P2）plan 读端点的 `Cache-Control: no-store` 覆盖不全，客户端/中间层可能拿到旧计划

- **位置**：
  - 有 `no-store`：`apps/api/src/server.ts:1326`（training-plan-state）、`apps/api/src/coach-loop-routes.ts:25`（coach-loop）、`:32`（coach-execution）
  - 没有 `no-store`：`apps/api/src/server.ts:1317-1323`（`/v1/mobile/today`）、`:1344-1347`（`/v1/mobile/workout-plan`）、`:1530`（`/v1/mobile/goals`）、`run-coach.ts:336-339`（`/v1/mobile/run-coach`）、`server.ts:1330-1331`（`/v1/mobile/plan-operations/:id`）；全局 `onSend` 只加了 `X-Frame-Options`/`nosniff`/CSP（`server.ts:210-214`），没有统一缓存策略。
- **证据**：真实 HTTP 探针（临时 runtime，空库，`node apps/api/src/server.ts`）输出：
  ```
  /v1/mobile/training-plan-state -> 200 cache-control= no-store
  /v1/mobile/today               -> 200 cache-control= null
  /v1/mobile/workout-plan        -> 200 cache-control= null
  /v1/mobile/goals               -> 200 cache-control= null
  /v1/mobile/run-coach           -> 200 cache-control= null
  /v1/mobile/plan-operations/:id -> 200 cache-control= null
  ```
  已证实（HTTP 层）。
- **影响**：这是“旧响应”风险面。对旧客户端（无 `planSnapshotContractVersion`，`TrainingPlanRepository.swift:44-53` 并发三个 GET）尤其致命：三个响应本来就不保证同快照，如果其中某个被 URLSession/代理/HTTP 缓存重放，混合程度更高；对 `workout-plan`，请求头里也没有 ETag/Last-Modified 可作校验。iOS 的 `URLSession` 默认可按协议缓存策略保存响应，是否真的命中缓存依赖部署与客户端配置（待确认），但服务端把“不能复用”的语义只写在其中一个端点上，属于契约自卫不足。
- **建议修复**：对 `/v1/mobile/*` 的所有读路由统一 `Cache-Control: no-store`（可放在 `app.addHook("onSend")` 里按前缀设置，避免逐路由遗漏）；`plan-operations/:id` 同样加（其结果即便不可变，也不应被共享缓存跨 scope 复用）。

### R-3（P2）`trainingPlanState` 的 `statSync` 文件系统错误未经分类，落成 `500 internal_error`（且该分支不重试）

- **位置**：`apps/api/src/data.ts:517`、`:587`（两次 `statSync` 都在 try/catch 之外；整段只在 524–583 有事务 try/catch）
  ```ts
  const fileIdentity = statSync(this.path);        // 517
  ...
  const currentFile = statSync(this.path);          // 587
  if (fileIdentity.ino !== currentFile.ino || fileIdentity.mtimeMs !== currentFile.mtimeMs) { throw ... 503 }
  ```
- **证据**：探针（临时库、暖 store 后删除数据库文件，直接调用 `read.trainingPlanState`）得到：
  ```
  error name: Error | code: ENOENT | errno: -2 | message: ENOENT: no such file or directory, stat '.../facts.sqlite'
  apiErrorPayload -> {"status":500,"body":{"code":"internal_error","message":"本地服务处理请求失败"}}
  ```
  已证实（错误对象与映射）。在真实路由里，`ReadStoreManager.use` 会先 `existsSync`（`read-store-manager.ts:55`），所以“文件恰好被删除”通常会先变成 409 `database_not_ready`；**但仍是 TOCTOU**：`existsSync` 通过后到 `statSync` 之间的极小窗口、以及 `EACCES`/`EIO`/`ESTALE`（NFS/SMB、权限切换、磁盘故障）都会直接 500。应用自带的恢复/导入路径通过 `beginReplace` 排空读租约（`read-store-manager.ts:94-122`）不会命中此窗口，主要是外部运维替换/网络存储场景。
- **影响**：客户端收到“服务器内部错误”而不是可重试的 409/503；`internal_error` 文案还会掩盖真实原因（`api-error.ts:17-33` 只在 500 时保留白名单 code）。该分支还**不进入**重建循环（在 `for` 内直接 throw），与文档“构建前后核验…发生变化丢弃整个候选，最多重建三次”（`IOS_TRAINING_PLAN_STATE_V1.md:26`）的表述不完全一致。
- **建议修复**：把 517/587 的 `statSync` 包进 try/catch，将 `ENOENT`/`EACCES`/`EIO` 映射为 409 `database_not_ready` 或 503 `plan_snapshot_changed`（视能否重新打开判断），并记录日志；文件身份变化时视为“需要重新打开 store 并从零重建”，或按文档明确写清“文件身份变化直接失败、不重建”的例外。

### R-4（P2）`503 plan_snapshot_changed` 与客户端重试策略不匹配，且无 `Retry-After`

- **位置**：`apps/api/src/data.ts:589`、`:594`；`apps/api/src/server.ts:2058`（只对 429 设置 `Retry-After`）
  ```ts
  throw new PlanOperationError("plan_snapshot_changed", "训练事实在读取期间变化，请重试完整快照。", 503); // 594
  ```
  iOS 侧：`apps/ios/RAI/TrainingPlanStore.swift:185`
  ```swift
  let retries = max(0, min(2, handshake?.planSnapshotContractVersion == nil ? legacyRetryCount : 0))
  ```
  `TrainingPlanStore.swift:247-263` 把错误统一映射为 `PlanReadIssue.network(...)`，`PlanStatePolicy.swift:177` 虽把 `serverUnavailable` 标成 retryable，但 `attempt < retries` 恒为 false（新契约 retries=0），503 直接表现为 `.unavailable`。
- **证据**：已证实（代码路径；`plan_snapshot_changed` 状态与 code 在 `api-error.ts:26-31` 白名单中保留，HTTP 断言见 `training-plan-state.test.ts:66-92` 的 `statusCode: 503`）。服务端在持续直连同步/重算期间会连续 3 次重建失败——这不是“罕见竞态”，而是“有写入活动时不可读”，客户端却只保留一次失败展示。
- **影响**：用户刷新计划时看到“服务不可用”，需要手动再点一次；在手表侧计划同步窗口内会错过本次刷新。不是数据错误，但把“显式可重试错误”做成了终态错误。
- **建议修复**：二选一或并用——(a) 服务端在重试用尽前等待写者空闲（可参考 `isDatabaseWriteBusy` 的语义，但注意不要无条件 409）；(b) 在 503 响应上加 `Retry-After: 1` 并在 iOS 侧对 `plan_snapshot_changed` 做 1–2 次前台重读（与旧协议一致）；文档同步说明。

### R-5（P3，待确认）`coherenceToken` 未覆盖 plan history 派生的展示字段与 `versions`/`freshness`

- **位置**：token 输入 `apps/api/src/data.ts:547-555`；today 里由 `planHistory` 派生的字段 `apps/api/src/mobile-read.ts:147-153`（`adherence`/`replan`）、`431` 附近的 `planSurfaces(args)`，以及 `apps/api/src/data.ts:875`（`recentPlanExecution`）、`:578`（`versions`/`freshness` 在 token 之后追加）。
- **现象**：同一 `coherenceToken` 下，`today.adherence`/`today.recentPlanExecution`/`metadata.freshness` 可能不同。token 的输入是“有效处方内容 + 发布摘要 + goalsRevision + 决策数字”，plan history 只影响展示型依从性。
- **证据 / 验证状态**：待确认。常规写路径中 history 行只由 `writeControlGoals` 写入且必定同时抬高 revision（`mobile-goals.ts:826-858`），因此被 `goalsRevision` 覆盖；只有外部进程/迁移直接改 `mobile_goals_history` 时才会出现 token 不变而展示变化。`versions`/`freshness` 放在 token 之后是 PR5 C9 的刻意决定（`pr5-read-side.test.ts:463-491` 用源码级断言钉住），不算缺陷。
- **建议**：在 `IOS_TRAINING_PLAN_STATE_V1.md` 的 token 定义里补一句“显示型依从性/新鲜度不进入 token；执行内容由 `prescriptionDigest`/`content` 约束”，避免后续误以为 token 是全响应摘要。

### R-6（P3，文档契约偏差）handshake 恒宣告 `planSnapshotContractVersion=1`，但该路由在教练闭环管理态下返回 409

- **位置**：能力位 `apps/api/src/server.ts:932-935`（无条件 `planSnapshotContractVersion: 1`）；运行时门禁 `apps/api/src/server.ts:398-408`：
  ```ts
  if (managed && ["/v1/mobile/today","/v1/mobile/run-coach","/v1/mobile/training-plan-state","/v1/mobile/workout-plan", ...]
      .some(...)) return reply.code(409).send({ code: "coach_loop_contract_required", ... });
  ```
  回归证据：`apps/api/test/server-runtime.test.ts:71`（启用教练闭环后三个旧读端点均 409）。
- **现象**：`docs/IOS_TRAINING_PLAN_STATE_V1.md:20` 写“`planSnapshotContractVersion = 1` 时调用 `GET /v1/mobile/training-plan-state`”，未提“若已启用 coach loop 则 409、应先走 `/v1/mobile/coach-loop`”。当前 iOS 恰好先判断 `coachLoopContractVersion`（`TrainingPlanStore.swift:188-214`）所以能工作，但一个新客户端只按文档实现就会在管理态下失败。
- **证据 / 验证状态**：已证实（测试 + 代码）。
- **建议**：在 handshake 增加“快照端点当前是否可服务”的上下文，或在 `IOS_TRAINING_PLAN_STATE_V1.md` 读取契约里显式声明该 409 前置条件（与 `COACH_LOOP_IMPLEMENTATION_STATUS.md` §5.1 的隔离说明对齐）。

### R-7（P3，known limitation）缓存读连接固定旧 inode，文件身份检查无法发现“带外替换”

- **位置**：`apps/api/src/read-store-manager.ts:52-64`（`this.store ??= new RaiReadStore(...)` 长期缓存连接）、`apps/api/src/data.ts:517`/`587`（只 stat 路径）。
- **现象**：如果主库文件被**应用外**的操作替换（运维手工 `cp`/`sqlite3 .restore`，未停服务），缓存的只读连接仍指向已 unlink 的旧 inode；每次重建尝试的 `statSync(path)` 前后都看到同一个新文件（ino/mtime 一致），`PRAGMA data_version` 也看不出旧 inode 与新文件的关系，于是 `trainingPlanState` 会基于旧库返回 200。应用自身的导入发布与备份恢复都会 `beginReplace → 排空租约 → closeStore`（`read-store-manager.ts:94-122`），因此这是“文档已要求停服才能带外恢复”的边界（`README.md` 运维章节/`docs/OPERATIONS.md` 语义）。
- **证据 / 验证状态**：待确认（未做带外替换实验，避免影响真实库；代码路径可复现）。属于已知限制，不计为缺陷；但 `IOS_TRAINING_PLAN_STATE_V1.md:26` “核验…文件发布身份”容易让人以为该检查保护了连接身份，建议文档澄清“只核验路径身份，不核验连接指向”。
- **建议**：在 `RaiReadStore` 记录打开时的 `stat` 身份，每次请求开始与当前路径身份比对，不一致则 close+reopen（并在重开前保持 503/409 语义）。

## 4. 已核查、未发现问题的点

1. **身份/scope**：`metadata` 的 `serverId/athleteId/datasetEpoch` 来自进程级身份，`trainingPlanState` 在构建前后各调用一次 `identity()` 并用 `digest(scope) === digest(identity())`（`data.ts:586`）检测恢复导致的数据域变化；恢复期间读路由经 `assertDatasetAccepting()` 返回 409（`server.ts:149-151`、`650-651`），早于任何读。
2. **固定时区/真实日期**：`DATABASE_TIMEZONE = "Asia/Shanghai"`（`packages/contracts/src/timezone.ts:28`、固定 `+08:00` 的理由见同文件 32-47），`mobileLocalDate()` 用 `Intl` 按该时区取日（`data.ts:127/150`）；`local-date.ts:2-12` 对真实公历日期做逐日校验，`workout-date-window.ts:4-16` 用 `Date.parse` + ISO 回读校验；`plan-execution.ts:20` 用 `+08:00` 边界。窗口内日期由 `shiftMobileDate` 逐日生成，不依赖本机时区。
3. **7 天闭区间/逐日连续唯一**：`assembleMobileWorkoutPlan` 先放 today，再按 `localDate > today && <= windowEnd` 追加存储日，最后对缺失日期补 `"未生成"` rest（`mobile-read.ts:543-579`），排序后返回；探针在空库上得到 `2026-10-18..2026-10-24` 连续 7 天、`windowDays=7`、`availability` 与 `days.some(executable && kind !== "rest")` 一致。
4. **availability 与窗口内容一致**：服务端由同一 `effective.days` 计算（`data.ts:564`），iOS 用同一判据复核（`TrainingPlanStore.swift:364`），两边定义一致。
5. **无嵌套事务**：两块视图事务内有专门入口 `readFactReadViewInTransaction`（`fact-read-view.ts:122-155`）；`trainingPlanState`（`data.ts:558`）、`workoutExportSnapshot`（`data.ts:503-513`）、`mobileTodayWithViews`/`workoutsWithViews`（`data.ts:458-500`、`612-619`）都使用同一层入口，未发现“事务中再 BEGIN”的读路径。
6. **读连接生命周期/并发**：`use` 同步租约 + `beginReplace` 等待排空 + `closeStore`（`read-store-manager.ts:52-71、94-122`）；读路由在 `restoringDatabase`/`isReplacing` 下分别得到 409 `database_restore_in_progress`/`database_busy`（`server.ts:149-151、650-658`；`read-store-manager.ts:128-131`）；慢查询为同步 SQLite（事件循环内完成），未发现读写锁竞争导致的挂起路径。
7. **`goals` 读两次的一致性**：`store.read()`（`data.ts:519`）与 `store.read({ prescription })`（`:539`）的差异由构建后的 `controlDigest === digest({ goals: store.read(), history: store.planHistory(200) })`（`:584-585`）兜底；由于 control 写必然 monotonically 抬高 revision（`mobile-goals.ts:826-858`），任何期间的 revision 变化都会使摘要不等并触发重建，未发现“不同 revision 被拼进同一响应”的路径。现有回归 `training-plan-state.test.ts:66-92` 覆盖了“构建过程中 control revision 变化 → 重建/最终 503”。
8. **主库固定视图/发布摘要**：`publications` 在同一事务内读取（import manifest、active model run、zone settings、70 天恢复证据，`data.ts:526-538`），`publicationDigest` 进入 token；`data_version` 前后比对覆盖了“另一连接在读取窗口内提交”的常见情况。
9. **读失败不伪装成“无计划/空计划”**：聚合端点无 `try/catch` 降级；控制库 JSON 损坏会抛错（500），不会返回 `emptyGoals`；`availability: "empty"` 只在“完整窗口全部不可执行”时出现（`data.ts:564`，回归 `training-plan-state.test.ts:94-111`）。
10. **iOS fail-closed 字段齐全**：响应含 `metadata.contractVersion/serverId/athleteId/datasetEpoch/goalsRevision/coherenceToken/timezone/localDate/windowStart/windowEnd/ruleVersion/publicationDigest`、`availability`、`goals/today/workoutPlan/coachSummary`（`packages/api-contracts/src/index.ts:1202-1229`）；iOS 据此校验真实日期、连续唯一窗口、revision 全等、时区一致、availability 与 executable 一致（`TrainingPlanStore.swift:333-365`），缺字段/不支持版本时拒绝执行而不是猜测。`plan_snapshot_changed` 的 code 在 5xx 白名单内保留可读消息（`api-error.ts:26-31`），客户端可以区分。

## 5. 与文档契约的偏差

| 文档承诺 | 实现 | 偏差 |
|---|---|---|
| `IOS_TRAINING_PLAN_STATE_V1.md:26` “构建前后核验…文件发布身份…发生变化丢弃整个候选，最多重建三次” | `data.ts:587-590` 文件身份变化直接 `throw 503`，不进入第 2/3 次重建 | 机制偏差；安全方向正确，但“最多三次”不适用于该输入 |
| `IOS_TRAINING_PLAN_STATE_V1.md:20` “`planSnapshotContractVersion = 1` 时调用 `GET /v1/mobile/training-plan-state`” | `server.ts:932` 恒宣告；`server.ts:398-408` 在 coach loop 管理态对同一路由返回 409 | 能力位与运行时可用性不一致（R-6） |
| `IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md` §5.1 “控制库和健康主库…在构建前后核对 goalsRevision、datasetEpoch 及实际参与决策的发布版本” | 聚合端点：`data_version` + control digest + identity + localDate 回验；`publicationDigest` 只在事务内算一次（依赖 `data_version` 覆盖外部提交） | 等价性成立的前提是 `data_version`/路径 stat 能观测到全部相关写者；带外替换不成立（R-7）。coach-loop 路径完全未实现该条（R-1） |
| `IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md` §4.3 “coherenceToken 应覆盖…有效处方结构、执行资格、完成状态，以及参与决策的数据发布版本、分区版本和规则版本” | token 含处方内容/`prescription`/`publicationDigest`/规则版本/窗口/完成日期/关键决策数字；不含 plan history 派生展示字段（R-5） | 处方级覆盖成立；展示级未覆盖（文档未区分，建议补一句） |
| `IOS_TRAINING_PLAN_STATE_V1.md:28` 新客户端“缺安全字段或不支持更高能力版本时拒绝执行” | 服务端字段齐全，iOS 校验完整 | 无偏差 |

## 6. 未覆盖或无法验证项

1. **并发写压测未执行**：R-1/R-4 的影响（真实导入+control 写同时发生时设备侧是否会出现失败排期）只做了代码路径推理，未做“边导入边刷新”的端到端实验；建议后续在隔离库上用后台循环写 + 100 次 GET 复测。
2. **iOS 网络缓存行为未验证**：R-2 只证实服务端响应头缺失；`URLSession` 是否真的缓存无验证器的 200 响应、以及 Nginx 层是否缓存，取决于客户端与部署配置，未在本机验证（本机没有启动 Nginx/Simulator）。
3. **带外数据库替换未实验**（R-7）：为避免触碰真实健康库与当前运行中的服务，未做手工 `cp` 替换实验；结论来自代码路径与生命周期阅读。
4. **`coach-loop` 的设备级消费未验证**：R-1 的 iOS 消费点按代码阅读（`TrainingPlanStore.swift:188-215`）确认，但排期/回执的真实手表行为属于 iOS lane 与物理设备验收。
5. **本地测试环境限制**：`onnxruntime-node` 原生绑定在本机因代码签名（`ERR_DLOPEN_FAILED`）不可加载，定向测试通过 `/tmp` loader 注入空实现后运行；被替换的只是预测推理依赖，读路径与断言均未改动。全量 `node scripts/run-tests.mjs` 未运行（按要求由其他 lane 负责）。
6. **未验证的已知限制**（引用文档，不计缺陷）：旧三 GET 协议本来就不保证同快照（`IOS_TRAINING_PLAN_STATE_V1.md:14`）；`generatedAt` 不参与稳定内容版本；`versions`/`freshness` 刻意不进入 `coherenceToken`（PR5 C9）。

## 7. 附：验证命令与产物

- 定向回归：
  - `node --import tsx --import /tmp/onnx-register.mjs --test apps/api/test/training-plan-state.test.ts` → 9/9 通过。
  - `... --test apps/api/test/pr5-read-side.test.ts apps/api/test/data.test.ts` → 44/44 通过。
- `/tmp` 探针（未写入仓库）：`/tmp/probe-api.mjs`（真实服务器进程 + 临时 runtime，采集读端点响应头/窗口/版本一致性）、`/tmp/probe-time.mjs`（空库延迟：training-plan-state 中位 ~9.9ms、today ~8.0ms、workout-plan ~6.1ms、coach-loop ~19.9ms）、`/tmp/probe-stat.mjs`（`statSync` ENOENT → `500 internal_error` 映射）。
- 仓库工作树未做任何修改（本报告文件除外）。
