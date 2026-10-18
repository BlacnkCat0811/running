# 训练计划功能详细审查

- 审查日期：2026-10-18（Asia/Shanghai）
- 审查基线：`HEAD 09ed8d0`（`fix(ios): 跑步动态迟到样本补读 + 空窗水位修正`）。审查开始时工作树干净；本轮只新增本交付目录与 `deliverables/README.md` 的一行索引，**未修改任何产品代码、测试或 docs 正文**。
- 审查对象：RAI 的「训练计划」功能全集——服务端目标/周课表/教练计划、计划快照读取、发布操作与回执、周期化/依从性/剂量、iOS 客户端状态机/缓存/WorkoutKit 排期/回执/UI，以及对应的共享契约、文档与门禁。
- 审查方式：5 个并行只读 lane（API 读、API 写、领域算法、iOS 客户端、文档/契约/测试）分头深读 + Lead 交叉复核关键结论 + 本机真实执行验证。分 lane 原始证据见 [01-api-read](training-plan-review-2026-10-18/01-api-read.md)、[02-api-write](training-plan-review-2026-10-18/02-api-write.md)、[03-domain-algorithms](training-plan-review-2026-10-18/03-domain-algorithms.md)、[04-ios-client](training-plan-review-2026-10-18/04-ios-client.md)、[05-docs-contracts-tests](training-plan-review-2026-10-18/05-docs-contracts-tests.md)。
- 口径：本报告不复述文档承诺作为实现证据；每条结论都在源码/探针/测试处给出证据。**P1 = 发布阻断或契约/安全语义被破坏；P2 = 用户可见错误行为或高概率边界缺陷；P3 = 低影响、防御性、文档/可维护性**。分 lane 报告各有自定分级，与本文不一致处按本文重判（理由见 §1.3）。

---

## 1. 审查范围、方法与本机验证

### 1.1 功能地图

| 链路 | 参与者 | 关键文件 |
| --- | --- | --- |
| 目标与周课表（真相源） | 服务端写入 + 历史 + CAS | `apps/api/src/mobile-goals.ts`、`weekly-plan-service.ts`、`weekly-plan-validate.ts`、`manual-plan-policy.ts` |
| 计划快照读取 | 单事务冻结视图 + 控制库回验 | `apps/api/src/data.ts`（`trainingPlanState`）、`mobile-read.ts`、`server.ts`、`read-store-manager.ts` |
| 自适应教练闭环 | 规则教练、决策、剂量、执行评价 | `apps/api/src/coach-loop-runtime.ts`、`coach-loop-*.ts`、`run-coach.ts`、`plan-periodization.ts`、`plan-adherence.ts` |
| 发布操作与回执 | operationId 幂等、90 天 tombstone、回执 v1/v2 | `apps/api/src/plan-publication.ts`、`mobile-goals.ts`、`server.ts`、`schemas.ts` |
| iOS 状态与缓存 | revision 水位、失效、离线、诊断 | `apps/ios/RAI/TrainingPlanStore.swift`、`TrainingPlanRepository.swift`、`PlanStatePolicy.swift`、`CacheStore.swift`、`NativeAppModel.swift` |
| WorkoutKit 排期 | 写前日志、SDK 副作用、强回读、撤回、回执 | `PlanWatchScheduling.swift`、`PlanWatchSyncCoordinator.swift`、`PlanScheduleOperationJournal.swift`、`PlanReceiptMatcher.swift`、`WorkoutPlanMapper.swift`、`WorkoutKitBridge.swift` |
| 共享契约 | 跨端类型与能力协商 | `packages/api-contracts/src/index.ts`、`apps/ios/RAI/APIModels.swift`、`APIClient.swift`、`apps/api/src/schemas.ts` |
| 文档/验收 | 契约解释、验收矩阵、门禁 | `docs/IOS_TRAINING_PLAN_STATE_V1.md`、`IOS_TRAINING_PLAN_IMPLEMENTATION.md`、`TODAY_PLAN_CARDS_REVIEW.md`、`ALGORITHM.md`、`DECISIONS.md`、`docs/PROJECT_REVIEW.md` |

### 1.2 本机真实执行的验证

环境：macOS 26，`node v24.21.0`（DSH 运行时自带，无 npm），`xcrun swiftc` / Xcode 26.6 可用。命令均在仓库根执行；`node scripts/run-ios.mjs gates` 等价于 `npm run test:ios`。

| # | 检查 | 结果 | 关键输出 |
| --- | --- | --- | --- |
| V1 | `tsc --noEmit -p tsconfig.pure.json` | **0** | 0 错误（1 s） |
| V2 | `tsc --noEmit -p tsconfig.json` | **0** | 0 错误（7 s） |
| V3 | `node scripts/run-ios.mjs gates` | **0** | 94 个 Swift 文件类型检查通过（3 个仅依赖高德 SDK 的文件明示跳过）；`106 store regression checks`、`200 presentation checks`、排期/状态机回归全部通过（约 306–313 s） |
| V4 | 21 个不依赖 ONNX 的 plan/coach 测试文件 | **0** | 207/207 通过（19 s） |
| V5 | Lead 的 26 个 plan 相关测试文件（`--test-concurrency=2`） | 1（**环境**） | 200 个测试节点中 191 通过；9 个文件整文件在**导入期** `ERR_DLOPEN_FAILED`，未执行任何断言（见 §1.3） |
| V6 | `node scripts/check-acceptance-matrix.mts` | **0** | §16.1 矩阵 77 条，cited 77，missing 0 |
| V7 | `node scripts/check-doc-links.mjs` | **0**（修交付目录自身引用后） | 含本交付目录在内全部本地链接可解析且从 README 可达 |
| V8 | `node scripts/check-npm-scripts-portable.mjs` | **0** | 18 个 package.json / 104 条 script |
| V9 | `node scripts/check-doc-line-refs.mjs`（默认范围） | **0** | 138 处引用，越界 0、漂移 0 |
| V10 | `node scripts/check-doc-line-refs.mjs docs/TODAY_PLAN_CARDS_REVIEW.md …`（显式 plan 文档） | **1** | 23 处引用，`docs/WEB.md:12` 无法解析（文件已随 Web 退役删除）；`TechViews.swift:477` 锚在空行 |

### 1.3 验证边界与严重度重判

1. **本机无法执行 9 个含预测链依赖的测试文件**：DSH 自带 node 二进制的 codesign 只有 `allow-jit` / `allow-unsigned-executable-memory`，没有 `com.apple.security.cs.disable-library-validation`；而 `node_modules/onnxruntime-node/.../onnxruntime_binding.node` 属另一 Team ID，导入期被 hardened runtime 拒绝（`ERR_DLOPEN_FAILED`）。受影响文件包括 `training-plan-state.test.ts`（快照一致性与发布操作/回执生命周期的**唯一**自动证据）、`mobile.test.ts`、`run-coach.test.ts`、`coach-loop-*.test.ts` 等。这是**主机环境限制，不是仓库缺陷**；本文一律标注“未验证”，不记为失败。
2. 因此本轮**没有**完整 `node scripts/run-tests.mjs` 证据；V4 的 207 例是当前可复核的绿灯。
3. 真机、配对 Apple Watch、Simulator 视觉验收（`run-visual-tests.sh`）、真实 HTTP 端到端（隔离 API 实例）均**未执行**；相关结论只到“代码路径/谓词级复现”一级。
4. **严重度重判**：分 lane 报告各自定级。本文把“文档仍列退役门禁”（lane 5 R-02）、“测试与 ONNX 共进程耦合”（lane 5 R-01）从 lane 的 P1 降为 P2（不直接破坏产品行为，但破坏验证可信度，故仍排在高优先级）；把 lane 4 的今日页 C1–C4 保留为 P3/已知未决（该文档明确状态是“未决、未改代码”）。

---

## 2. 结论摘要

**总体判断：训练计划服务端的“单写者 + 事务发布 + 冻结快照 + fail-closed 客户端”骨架是成立的，主要算法与安全校验也经得起复核；但当前**不能**按“可发布”签收：有 3 个 P1 阻断点，其中 2 个会在正常使用路径上把客户端带进错误终局。**

- **P1×3**
  1. **回执 v2 的线格式与 Swift `Codable` 不兼容**：非教练闭环路径发出的 `structure` 缺少显式 `null`（`warmup`/`cooldown`/`alert`），服务端会 `TypeError → 500` 或 `422 plan_receipt_evidence_mismatch`。前者让回执永久待登记，后者被客户端视为终局，**把已经强回读核验过的系统排期误判为“需要撤回”**。
  2. **`MobileGoalsRevisionConflictError` 没有 `statusCode`，`/v1/mobile/coach-loop` 与 `/v1/mobile/lock` 未捕获**：一次正常的 revision 冲突变成 `500 internal_error`，客户端按 5xx 保留待确认发布，随后用**过期 payload 永久重放**，`plan_publication_pending` 守卫会拒绝该 scope 的后续计划写与排期。
  3. **`GET /v1/mobile/coach-loop` 是当前 iOS 排期主路径，但读取没有跨存储域回验**：control 库（goals/saved/history）分多次先读、主库事实后读，事后不核对。并发写时可能返回“旧 weekPlan/settings + 新事实”这种从未同时存在的组合；排期后回执 `matchesCurrent=false`，用户需要人工撤回。已证实代码路径，触发概率未压测。
- **P2×18**：覆盖 iOS 旧协议降级校验、错误分类/提示、能力协商混读、教练模式提醒静默失效、赛事日期时区、读取失败的 500/503 语义、回执身份/幂等键、无数据库时绕过人工计划策略、周期化 24 周边界、TS/Swift 六位小数半值不一致、`plan-operations` 响应无共享类型、核心计划测试与 ONNX 耦合、验收矩阵缺行、文档行号门禁范围、三份现行文档仍列退役 Web 入口。
- **P3×21**：见 §6 汇总表（防御性缺口、已知限制、文档/可维护性）。

**建议的放行顺序**：先修 3 个 P1 并补 HTTP/线格式回归（§8 批次 A），再处理 P2 中会污染用户判断或状态所有权的 8 项（批次 B），最后收口文档/门禁（批次 C）。P1 修复前，不宜把“计划快照/发布操作/回执 v2”标为已验证。

---

## 3. P1 详情

### P1-1 回执 v2 线格式与 Swift `Codable` 不兼容：合法回执被 422 终局拒绝或 500

**位置**

- 服务端校验：`apps/api/src/server.ts:1210-1220`（`/v1/mobile/workout-plan/synced`），核心是 `digest(normalizeSessionStructure(body.structure)) !== digest(body.structure)`（`:1218`）。
- 摘要函数：`apps/api/src/plan-digest.ts:18-22` 的 `step()` 只对 `null` 返回 `["~"]`，对 `undefined` 继续读 `value.purpose` ⇒ `TypeError`。
- 规范化：`apps/api/src/session-structure.ts:80-96`（步内 `alert` 恒写出，缺省为 `null`）、`:123-135`（`warmup`/`blocks`/`cooldown` 恒写出，缺省为 `null`）。
- 客户端线格式：`apps/ios/RAI/APIModels.swift:398-413` 的 `MobileWorkoutStep.alert`、`MobileSessionStructure.warmup/cooldown` 均为 Optional，合成 `Codable` 在编码时**省略 nil 键**；`apps/ios/RAI/APIClient.swift:176-219` 的 `recordPlanSync` 只对 `receipt.coachLoop != nil` 分支手工补 `warmup/cooldown/alert/lower/upper/decisionRef` 的显式 null，**普通 `/v1/mobile/workout-plan/synced` 分支直接发送原始 Codable**；`apps/ios/RAI/NativeAppModel.swift:1578-1589` 的 `enrichPlanReceipts` 只要快照有 `coherenceToken` + `serverIdentity` 就把回执升级为 v2，与是否教练闭环无关。

**证据（谓词级复现，Lead 亲自复算）**

`/tmp/lead-probe-receipt.mjs`（直接用仓库的 `prescriptionDigest` 与 `normalizeSessionStructure`）：

```text
api-shaped  : { canonicalMismatch: false, prescriptionDigestOk: true }
swift-shaped: { canonicalMismatch: true, prescriptionDigestOk: true }   # 仅删掉 recovery step 的 alert 键
missing warmup prescriptionDigest: TypeError: Cannot read properties of undefined (reading 'purpose')
missing warmup canonical mismatch: true
```

即：只要结构里有**任一 nil 可选键**（recovery 步的 `alert` 最常见），服务端就会 422；若 `warmup`/`cooldown` 整键缺失（旧手工/锁定处方可能如此），先抛 `TypeError` → 500。两条独立 lane 分别从服务端与 iOS 侧得到同一结论（[02-api-write](training-plan-review-2026-10-18/02-api-write.md) R-1、[04-ios-client](training-plan-review-2026-10-18/04-ios-client.md) R-01），且 iOS 侧已用 `xcrun swiftc`/脚本复算摘要差异。

**影响**

- 422 `plan_receipt_evidence_mismatch` 在 `PlanMutationDisposition.swift:44-52` 属**终局** → `NativeAppModel.swift:1499-1510` 丢弃回执、把当前 ledger 标 `requiresWithdrawal`、`watchState = .stale`，并提示撤回。用户看到的是“手表排期需要撤回”，而实际是本机已强回读成功的正确排期。
- 500 不属终局 → 回执留在待登记账目反复重试；`hasPendingPlanReceipts` 恒真，`NativeAppModel.swift:437-441` 的切换门槛会**永久阻止**从旧计划切到新版教练闭环。
- 该缺陷只在非教练闭环路径暴露；教练闭环分支因手工补 null 而正常，这也正好解释了为什么现有测试只覆盖了教练分支。

**建议修复**

1. 服务端以**规范化后的结构**为准：`const normalized = normalizeSessionStructure(body.structure)`，用 normalized 计算 `prescriptionDigest` 与“可接受性”，并把 normalized 落库；`step()` 对 `undefined` 做与 `null` 同等的防御。
2. 客户端把 v2 回执的显式 null 编码统一为**所有** v2 回执（不只是 coachLoop 分支），或给 wire DTO 写显式 `encode(to:)`；legacy v1 与缓存解码保持省略语义不变。
3. 增加回归：① HTTP 级 `/synced` 用“Swift 形状”（缺 `warmup/cooldown/alert` 键）断言 200 或明确的非终局错误码；② iOS 侧断言非 coachLoop 的 v2 回执 JSON 形状；③ 摘要函数对 `undefined` 的防御用例。

**验证状态**：谓词级已证实（Lead 独立复算）；真实 HTTP 端到端未跑（受 §1.3 环境限制）。修复任一侧即可止血，但两侧都补回归，避免互相回退。

---

### P1-2 `MobileGoalsRevisionConflictError` 无 `statusCode`，coach-loop 与 lock 路由未捕获 → 500 且待确认发布永不结清

**位置**

- 错误类：`apps/api/src/mobile-goals.ts:871-876`——只有 `code`，没有 `statusCode`。
- 全局映射：`apps/api/src/api-error.ts:20-33`——无 `statusCode` ⇒ 500，body code 被压成 `internal_error`。
- 未捕获点：`apps/api/src/coach-loop-routes.ts:27-28`（`POST /v1/mobile/coach-loop` 直接 `args.runtime.command(...)`）→ `apps/api/src/coach-loop-runtime.ts:105-106` 抛该错误；`apps/api/src/server.ts:1583-1612`（`/v1/mobile/lock`）经 `lockSession` → CAS 失败抛出。
- 对照：`/v1/mobile/goals`（`server.ts:1566-1575`）、`/v1/mobile/run-coach`（`run-coach.ts:404-407`）、`confirm`（`server.ts:1478`）、`generate`（`server.ts:1501`）均显式映射为 409 + `mobile_goals_revision_conflict`。

**证据**

`/tmp/rai-review/probe1.mjs`（隔离 control DB）：

```text
stale expectedRevision inside publish -> revision conflict
  MobileGoalsRevisionConflictError code=mobile_goals_revision_conflict status=500 bodyCode=internal_error
```

**影响**

- 同一错误类在 goals 路由是 409 + 可读 code，在 coach-loop 路由是 500 + `internal_error`，破坏客户端契约。
- 客户端 `publishPlan` 的清账条件是“4xx 且 code 不以 `plan_operation_` 开头”（`NativeAppModel.swift` 的 `publishPlan` catch 段，约 1303-1307）；500 会保留 pending。`resolvePendingPublication` 查到 `notFound` 后**重放同一份过期 payload**，再次 500 ⇒ 永久重放；`plan_publication_pending` 守卫（`NativeAppModel.swift:1290`）从此拒绝该 scope 的全部计划写与手表排期。客户端虽有“放弃本次未确认发布”的显式出口，但用户通常不会理解该出口的代价。
- 触发条件不是日常路径（需要读后写前有别的写者推进 revision），但一旦发生没有自愈出口。

**建议修复**

1. 给 `MobileGoalsRevisionConflictError` 加 `readonly statusCode = 409`（与 `WeeklyPlanConfirmationRequiredError`、`PlanPreviewError` 一致）。
2. 在 `/v1/mobile/coach-loop` 与 `/v1/mobile/lock` 补与 goals 相同的 catch（409 + `currentRevision`）。
3. 在 `server-runtime.test.ts` 增加“coach-loop 过期 revision → 409 + code”的 HTTP 断言。

**验证状态**：类定义缺失 + 错误映射 + 路由无 catch 均已读码证实；错误映射已用隔离探针实测。触发窗口未做并发 HTTP 压测。

---

### P1-3 `GET /v1/mobile/coach-loop` 读取没有跨存储域冻结/回验

**位置**

- `apps/api/src/coach-loop-runtime.ts:89-93`：

```ts
read(): CoachLoopRuntimeResponse {
  const saved = this.saved(), goals = this.store.read();
  const facts = this.readFacts(this.effectiveGoals(goals, saved?.settings ?? null), this.store.planHistory(200));
  return this.evaluate(goals, facts, saved, saved?.settings ?? null).response;
}
```

- `apps/api/src/data.ts:256-305`（`coachLoopFacts`）：`BEGIN DEFERRED` 只包住主库事实读取；`goals`/`history` 是调用方在事务外传入。
- `apps/api/src/coach-loop-runtime.ts:474-477`：`executionToken` 绑定 `goals.revision`、`factsHash`、`settings`、`days` 等。
- 生产装配：`apps/api/src/server.ts:1337-1340`。

**现象**：`saved`（coach-loop receipt）、`goals`、`planHistory(200)` 是 control 库上的三次独立读取（`effectiveGoals` 前还会再读一次），之后才开主库读事务；读取结束后没有任何回验。若两次快照之间发生一次 control 写（周一自动生成、另一设备 refresh/update）再叠加一次数据写（导入/直连同步），响应就是“旧 weekPlan/settings + 新训练事实”的组合。iOS 在 `coachLoopContractVersion == 1` 时直接消费该响应进入系统排期（[04-ios-client](training-plan-review-2026-10-18/04-ios-client.md) §4.2），而 `executionToken` 绑的是旧 revision。

**影响**：可能把旧配置下的处方写进手表；随后服务端回执核验用当前 `executionToken` 会得到 `matchesCurrent=false`（`apps/api/src/coach-loop-device-sync.ts:26-44`），设备上留下“无法核验/需撤回”的系统排期。安全方向是 fail-closed，但用户可见且需要人工撤回。触发需要并发写，概率未测；这是“新排期主路径未继承聚合端点的冻结契约”，不是既有文档承诺的回归。

**建议修复**

1. 在 `read()` 返回前复算 `this.store.read().revision` 与 `this.saved()`/`planHistory` 摘要，与开头读取一致才返回；不一致最多重建 3 次后抛可重试的 409/503（可复用 `trainingPlanState` 的模式）。
2. 或把 control 读取与主库读取放进同一个可验证窗口（先读 control、后开主库事务、事后再验 control 摘要），并让客户端把该端点视为可排期快照。
3. 补一条并发写回归（control 与主库交替提交时不得返回混合快照）。

**验证状态**：代码路径已证实；并发触发与设备真实概率未压测。lane 1 将其列为 P1，本报告维持 P1，但明确其“条件触发”属性。

---

## 4. P2 详情

### 4.1 回执与发布语义

**P2-1 回执身份按字节比较，与文档“等价 ISO 时刻不改变身份”不符**
- 位置：`apps/api/src/mobile-goals.ts:484-497`（v2 以 `json_extract(...$.workoutID)` + `scheduledAt` 精确匹配）、`:498-525`（幂等键分支）、`:526-534`（同事件早退）、`:556-563`（`planPushIsActive`）；文档见 `docs/IOS_TRAINING_PLAN_STATE_V1.md:70`。
- 现象：服务端从不规范化 `scheduledAt`/`workoutID`；`2026-10-19T07:00:00+08:00` 与 `2026-10-18T23:00:00Z` 是两条不同记录，`withdrawn` 只停用同字符串的那条。客户端 `PlanReceiptMatcher` 做了 UUID/ISO 规范化，服务端未镜像。
- 影响：跨客户端/升级改变时刻拼写时，撤回/替换不再停用旧回执 → `activePlanPushes` 误计占用、`matchesCurrent`/教练决策误判。单一客户端固定序列化下不触发。
- 建议：入口规范化（UUID 大写、`scheduledAt` → UTC ISO）并用于所有查找/去重；或删掉文档中“服务端不改变身份”的暗示。
- 验证：已用合成用例证实等价时刻被当成两条；影响程度待客户端序列化变化确认。

**P2-2 `/synced` 的 `matchesCurrent` 在控制库事务外计算（TOCTOU）**
- 位置：`apps/api/src/server.ts:1221-1225`（`withReadStore` 读快照并算 `matchesCurrent`）与 `:1228-1244`（另开 `BEGIN IMMEDIATE` 写回执）。
- 现象：计算结论与落库之间没有锁；另一发布可在中间提交，使“已登记回执”对应一个已被替换的 revision。
- 影响：客户端据 `matchesCurrent` 决定 `requiresWithdrawal`；错误方向会误导用户，下一次刷新通常能纠正，但已登记结论不可重算。文档要求“当前覆盖必须匹配当前处方与事实令牌”，只在计算瞬间成立。
- 建议：把“读当前快照 + 计算 + 插入”放进同一 `publicationOperation`，或先取得控制库写锁再读主库。
- 验证：代码路径已证实；窗口窄，未构造并发 HTTP 用例。

**P2-3 回执幂等/去重键缺 scope 与 localDate**
- 位置：`apps/api/src/mobile-goals.ts:498-525`（幂等键分支不含 scope）、`:526-534`（`repeated` 早退不比较 localDate）、`:732-734`（幂等索引是全局表达式唯一索引，不按 scope 分区）。
- 现象：同 `workoutID+scheduledAt+lifecycleEvent`、不同 `localDate` 的回执被当成重复（合成用例：`different localDate accepted as same entry: true`）；跨数据域（恢复/删除后 epoch 变更）可能静默复用旧域 `pushed_at`，当前域查不到回执。
- 建议：把 scope 加入幂等键/唯一索引组成，`repeated` 早退前比较 `localDate`；把数据域切换后的旧回执语义写进文档。
- 验证：localDate 部分已证实；跨 scope 为读码推导。

**P2-4 数据库未就绪时 `goals` PUT 完全跳过 `manual-plan-policy`**
- 位置：`apps/api/src/server.ts:1550`（`if (request.body.weekPlan !== undefined && databaseIsReady())`）、`:1522-1581`、`apps/api/src/manual-plan-policy.ts:28-58`；`/v1/mobile/goals` 属于 `metadataOnlyMutationRoutes`，不受 `databaseRequiredMutationRoutes` 的 409 门禁。
- 现象：无主库/恢复窗口内保存 `weekPlan` 时，`validateManualPlan` 不安装；`normalizeWeekPlan` 只做逐字段边界，**不做**周跑量预算、质量课数量、长距离上限、伤情限制与“历史/已完成/锁定/迁移保留日期不能改写”的冻结保护。
- 影响：无数据库状态下可保存违反策略的周计划，甚至改写过去日期；之后不会重新校验，`planHistory` 会把未校验内容当作“当时的计划”。
- 建议：校验的静态部分不依赖主库；或在主库未就绪时对 `weekPlan` 返回 409 `database_not_ready`，其余字段照常。
- 验证：代码路径已证实；未构造 `databaseIsReady()=false` 的 HTTP 用例。

### 4.2 读取一致性与错误语义

**P2-5 `trainingPlanState` 的文件系统错误直落 500 且绕过重建**
- 位置：`apps/api/src/data.ts:518-520`（读前 `statSync`）、`:588-595`（提交后 `statSync` + 比较）；两次 `statSync` 都在 try/catch 外。
- 现象：数据库被恢复/删除/替换的瞬间，`ENOENT/EACCES/EIO` 不会被分类为“快照变化”，直接变成 `500 internal_error`，且不进入“最多 3 次重建”。
- 影响：恰好在维护/恢复窗口访问计划页的用户看到通用服务器错误，而不是可重试的 `plan_snapshot_changed`；也无法自动恢复。
- 建议：把两次 `statSync` 的失败归入 `plan_snapshot_changed`（503）或显式 `database_not_ready`（409），纳入重试路径。
- 验证：代码路径与映射已证实；未在真实恢复窗口复现。

**P2-6 `503 plan_snapshot_changed` 对新快照客户端无前台重试，且无 `Retry-After`**
- 位置：`apps/ios/RAI/TrainingPlanStore.swift:185`（`retries` 在 `planSnapshotContractVersion != nil` 时为 0）；服务端 503 来源 `apps/api/src/data.ts:588-595`。
- 现象：服务端明确用 503 表示“读期间事实变化，请重读”，这是瞬态可重试信号；客户端却只在**旧服务**（无聚合契约）时重试，拿到 503 直接进入 `unavailable`。服务端也没有 `Retry-After`。
- 影响：导入/发布活跃期，计划页显示“尚未确认今天的安排”而非自动恢复；`retryable` 分类对新契约成为死代码。
- 建议：对 `plan_snapshot_changed` 做有界退避重试（例如 2 次、短延迟），服务端补 `Retry-After: 1`。
- 验证：客户端分支已读码证实；503 在真实负载下的频率未测。

### 4.3 iOS 状态机与展示

**P2-7 legacy 三 GET 刷新缺本地安全日期/窗口校验却置 `current`**
- 位置：`apps/ios/RAI/TrainingPlanStore.swift:328-343`（`guard let aggregate = value.aggregate else { return }` 在日期/窗口校验之前直接返回）、`:341-366`（聚合路径才校验）、`:231-244`（legacy 成功分支无条件 `isCurrent = true; availability = .current`）；`apps/ios/RAI/NativeAppModel.swift:91-93`（`currentWorkoutPlan` 直接采用 `executablePlan`）。
- 现象：旧服务返回的 `today.localDate` 非当前业务日、`windowDays` 越界、逐日不唯一/不连续、时区不可解析时，仍被标 current；`executablePlan` 只比较 `planRevision == revision`。
- 影响：不会错误下发到手表（排期前 `planSyncSnapshot` 与 `PlanWatchScheduling` 会二次校验），但展示会 fail-open：`refreshPlanState` 返回成功、`workoutPlanError` 清空；`watchNeedsUpdate/watchNeedsClear` 用未校验 plan 计算，可能把旧系统日程判成已核验。
- 建议：legacy 分支至少补可本地判定的安全校验（today 业务日、时区可解析且与 plan 一致、windowDays 1..14、逐日唯一连续且首日==today），失败置 `savedAwaitingRefresh`/`unavailable`，不要置 current。
- 验证：已读码证实；现有测试只覆盖聚合路径同类校验与 legacy revision 不匹配，无 legacy 日期/窗口负例。

**P2-8 安全校验失败被归类为“协议版本不兼容”**
- 位置：`apps/ios/RAI/TrainingPlanRepository.swift:57-69`（`RaiAPIClientError.decoding → .contractMismatch`）；抛出点 `TrainingPlanStore.swift:355/365`、`:295/307`、`:313`；面板分类 `NativeAppModel.swift:544-546`。
- 现象：身份/窗口/逐日唯一/摘要校验失败与协议形状不兼容共用 `contractMismatch`，`refreshAll` 会提示“数据格式与当前版本不兼容，其余已刷新”，把用户引向“升级 App”。
- 影响：误导升级方向；诊断码记为 contract mismatch；该错误不可重试。
- 建议：增加 `securityValidationFailed`/`corruptSnapshot` 分类与文案；诊断码单独 `snapshot_validation_failed`；同步更新现有断言。
- 验证：已读码证实（分类逻辑确定，无需服务端变异）。

**P2-9 `refreshRunCoach` 与 `TrainingPlanStore` 的能力协商判定不一致**
- 位置：`apps/ios/RAI/NativeAppModel.swift:341-375`（按 `planSnapshotContractVersion != nil` 转发）vs `apps/ios/RAI/TrainingPlanStore.swift:188-213`（按 `coachLoopContractVersion != nil` 走新合同）；`:372-374` 为不可达死代码。
- 现象：在“coachLoop=1、无 snapshot”混合能力（错峰上线允许）下，同一次前台刷新先走新教练合同（`today=nil`、`coachLoop` 设置），随后 `refreshRunCoach` 走旧合同并把旧 `MobileRunCoachResponse` 写进 `coach`；状态所有权被破坏，UI 可能短暂显示两套教练状态。
- 影响：不会错误下发（排期租约要求 `isCoachLoopManaged` 与当前快照），但违反“计划状态只有一个写入所有者”的架构约束；未知旧状态还会让 `executablePlan` 判 nil。
- 建议：能力判定收敛为单一 computed 属性；`acceptCoach` 在 `coachLoop != nil` 时拒绝旧教练写入；删除死分支；补混合能力组合回归。
- 验证：已读码证实；现有测试只有“全给/全 nil”两种组合。

**P2-10 教练闭环模式下“训练提醒”静默不排程，且 UI 没有说明**
- 位置：`apps/ios/RAI/NativeViews.swift:61-66`（`reconcile(..., plan: native.currentWorkoutPlan, available: native.canConfirmToday)`）；`NativeAppModel.swift:46-51`（`canConfirmToday` 需要 `today`）；`TrainingPlanStore.swift:205`（闭环路径 `today = nil`）；`TrainingReminders.swift:72`（`guard enabled, available, 授权 … else { return }`）；`TechTrainingReminderView.swift:17-35`。
- 现象：闭环模式下 `today` 恒 nil → `canConfirmToday == false` → `reconcile` 直接返回，一条通知都不排；但设置页仍允许开启并提示“仅提醒已读取的未来训练”。
- 影响：用户授权后永远收不到提醒，且没有说明；与“当前可执行课存在”的界面语义矛盾。
- 建议：`available` 改为明确的“当前可执行计划存在且属于当前业务日”；闭环下用 `loop.today`/`devicePlan` 生成今日提醒，或显式声明“闭环模式暂不提醒未来日”。
- 验证：已读码证实；测试只覆盖纯函数 `slots`，无 `reconcile`/闭环场景。

**P2-11 赛事目标日期使用设备本地时区，与固定业务时区不一致**
- 位置：`apps/ios/RAI/NativeFormat.swift:475-483`（`dateFormatter` 未设 `timeZone`）；`TechRaceGoalEditor.swift:54-56,117-122`（“所选日期已过”比较服务端业务日与设备时区格式化日期）；对照 `TechRunCoachSetup.swift:23-36,71-74` 已显式使用 plan 时区。
- 影响：设备时区 ≠ 亚洲/上海时，保存的 `raceTarget.date` 可能差一天；倒计时/准备度与用户输入错位；午夜附近误报“已过”。
- 建议：统一用业务时区格式化/比较；`today` 缺失时不要用设备日期兜底。
- 验证：已读码证实；未构造跨时区设备场景。

### 4.4 领域算法

**P2-12 距比赛恰好 24 自然周时，骨架丢掉当前周**
- 位置：`apps/api/src/plan-periodization.ts:247-250`（只拒绝 `>24`）、`:255-265`（`firstOffset = weeksToRace - 23`，offset=0 被排除）、`:291-292`（`current` 为 null）。
- 证据（Lead 用仓库函数复算，half_marathon，today=2026-10-05）：

```text
weeksToRace=23 rows=24 current=base@2026-10-05
weeksToRace=24 rows=24 current=null first=2026-10-12 reasons=current_week_outside_window
```

- 影响：距比赛 168 天的那一周，今天页 `periodization.current == null` → 阶段/量带卡不渲染，但教练页 `runCoachPhase` 仍返回 `base`（同一周两个界面一个有阶段、一个没有）；`weeklyCapacity` 的 phase 变 null，半马 baseline 35 而非 36.75；`replanAdvice` 的“计划高于量带上限”也不参与。文档口径是“≤24 周”，测试只测了 40 周，未测 23/24/25 边界。
- 建议：先定口径——若“≤24 周”含当前周，边界应允许 25 行或把超限判定改为 `>24` 之外；若 24 行是“比赛周+23 周预备”，则显式拒绝 24 周并更新文档。补恰好 24/23 周的断言。
- 验证：合成输入复算已证实。

**P2-13 `rai-prescription-v1` 六位小数在 TS/Swift 十进制半值上不一致**
- 位置：`apps/api/src/plan-digest.ts:17`（JS `toFixed(6)`）vs `apps/ios/RAI/PlanStatePolicy.swift:130-133`（`String(format: "%.6f", locale: en_US_POSIX)`）。
- 证据（真实 Swift 编译 + 同一 JSON 输入）：

```text
1.0000005  TS 1.000001   Swift 1.000000   → SHA-256 不同
1.0000015  TS 1.000001   Swift 1.000002   → 不同
1e21       TS 1e+21      Swift 1000000000000000000000.000000 → 不同
```

- 现状与影响：当前生产路径**不可达**——持久化结构先经 `normalizeSessionStructure` 取整，且回执先要求“结构等于规范化结果”，半值/1e21 会被拒；但 `prescriptionDigest` 是导出函数、文档称其为跨端身份，未来任何绕过规范化的调用点都会变成真实分歧（回执冲突/租约失效）。
- 建议：两端先做十进制规范化（例如 `Math.round(value*1e6)/1e6`）或契约层明确“只接受整数”并在函数内断言；fixture 只有 3 例，补半值、`heart_rate`、多 block、`-0`、上界等用例。
- 验证：差异已用真实 Swift 编译证实；生产不可达已用规范化闸门证实。

### 4.5 契约、测试与门禁

**P2-14 `GET /v1/mobile/plan-operations/:id` 的响应没有共享类型，OpenAPI 漏一种状态**
- 位置：`apps/api/src/plan-publication.ts:21-23`（`result(): unknown`）、`apps/api/src/mobile-goals.ts:250-263`（返回 `committed`/`notFound`/`expired`/`scopeMismatch`）、`apps/api/src/schemas.ts:932`（描述只写三种）、`apps/ios/RAI/PlanStatePolicy.swift:180-184`（iOS 自建 struct）。
- 影响：发布链路“重试语义唯一出口”没有契约单源；服务端改名/加字段不会触发编译或契约门禁失败；iOS 未知状态会降级为“不重放”的错误。
- 建议：在 `packages/api-contracts` 增加四状态可辨识联合类型，`result()` 返回该类型，路由声明 response schema，描述补 `scopeMismatch`；补契约 parity 断言。
- 验证：三方差一处已读码证实。

**P2-15 计划核心测试与 ONNX 原生依赖同进程耦合（本机不可执行）**
- 位置：`apps/api/test/training-plan-state.test.ts:10` → `apps/api/src/data.ts:41`（`from "@rai/application"`）→ `packages/application/src/index.ts:4`（`export * from "./prediction-report.js"`）→ `packages/prediction-inference/src/index.ts`（`onnxruntime-node`）；`apps/api/src/coach-loop-routes.ts:4`、`mobile-read.ts:4` 同理。
- 影响：快照 503、发布操作幂等/过期、回执 v2 生命周期这三类核心断言集中在受影响的测试文件里；任何不具备可加载 ONNX 宿主的机器都会整文件失败。本轮因此**无法**为本功能最重要的三类契约提供自动证据（§1.3）。
- 建议：把预测/ONNX 依赖改为惰性导入，或把 `prediction-report` 拆出 `@rai/application` barrel；让 `RaiReadStore` 的导入闭包不含 ONNX；短期在文档中明示该前置条件。
- 验证：本机命令 + 依赖链已证实（`ERR_DLOPEN_FAILED`）；不是产品缺陷。

**P2-16 §16.1 验收矩阵没有 plan 快照/发布操作/回执行**
- 位置：`docs/ALGORITHM.md:349-430`（77 行；只有 G01–G05 覆盖周期化/依从性），`scripts/check-acceptance-matrix.mts` 只校验“被测试引用的 ID 存在”。
- 影响：新增最重要的三类契约没有验收行；门禁仍然全绿，无法发现这种缺失。
- 建议：新增 G06/G07/G08 三行，把 `training-plan-state.test.ts` 相关用例标题挂上对应 ID（该文件正是 P2-15 里跑不起来的文件）。

**P2-17 文档行号门禁默认范围不含任何 plan 文档**
- 位置：`scripts/check-doc-line-refs.mjs:79-94`（`DEFAULT_DOCS` 不含 plan 文档）；`docs/TODAY_PLAN_CARDS_REVIEW.md:76` 引用已删除的 `docs/WEB.md:12`。
- 影响：默认门禁全绿，但把 plan 文档显式传进去立刻 exit 1；这份文档正是 README 指向的现行说明之一，却不在自动守门范围。`check:doc-refs` 也不在 pre-commit/CI 中。
- 建议：把三份 plan 文档加入 `DEFAULT_DOCS`；修 `docs/WEB.md` 死引用，改指 D17/ADR-006；把检查接入钩子或 CI。

**P2-18 三份现行 plan 文档仍把已退役 Web 门禁写成“自动入口”**
- 位置：`docs/IOS_TRAINING_PLAN_STATE_V1.md:88`（`npm run build`）、`docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md:62-63`、`docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md:24,324,326`（`npm run test:e2e:web` / 冻结窄屏）。
- 对照：`docs/DECISIONS.md` D17 与 `AGENTS.md` 明确禁止把 `npm run build`/`test:e2e:*` 加回；`package.json` 已无 `build`、`apps/web` 已删除。
- 影响：读者按文档执行会得到不存在的命令；把退役门禁重新表述为当前义务，正是 D17 禁止的形态。功能描述本身与代码一致，漂移集中在“验证入口/Web 遗留”。
- 建议：三处改为 D17 后的入口清单；带日期的实施记录允许保留历史，但加显式时点标注；`STATE_V1:88` 属现状陈述，必须直接更正。

---

## 5. 已核实成立的部分（避免把正常设计当缺陷）

以下结论经代码复核/定向测试/合成输入确认，建议保留：

1. **聚合快照冻结机制成立**：`trainingPlanState` 用一次 `BEGIN DEFERRED` + `PRAGMA data_version` + 控制库 goals/history 摘要 + 文件 inode/mtime + identity/业务日期回验，失败重建 ≤3 次后显式 `503 plan_snapshot_changed`（`apps/api/src/data.ts:515-595`）。`availability` 与 `workoutPlan.days` 同源，逐日连续/唯一、真实日期、固定 `Asia/Shanghai` 校验完整。
2. **发布事务与幂等成立**：goals 业务数据、`mobile_goals_history`、`mobile_plan_operations` 同一 `BEGIN IMMEDIATE` 提交；action 抛错全回滚；同键同请求返回冻结结果、同键不同请求 409、跨路由/跨域拒绝、重启后可查；90 天 `expires_at <= now` 边界、tombstone 保留、重放 410；CAS `UPDATE ... WHERE revision=?` + `changes===1` 无丢更新（隔离探针/定向测试证实）。
3. **iOS 安全账目与排期状态机成立**：revision 水位单调且与展示缓存隔离（清缓存不擦水位/ledger/待登记回执）；refresh 的 requestID/epoch/scope/isValid 取消语义有测试锁定；排期是“写前日志 → SDK 副作用 → 强回读 → 原子提交”，部分成功/撤回失败/存储失败都不伪装成成功。
4. **算法口径主体成立**：D16 单一来源（`PHASE_BOUNDARIES`）、D14 生成/展示同源与“基线 vs 已收敛上限”角色分离、依从性“未观测≠没练/未来用最新版/每日本地午夜冻结”、14 天赛前保护、剂量阈值、闰年/跨年/DST 日期数学均通过复核；摘要 12 组边界输入中 10 组 TS/Swift 完全一致。
5. **契约兼容机制成立**：handshake 能力位全部可选，publication 能力按 control DB 是否存在条件发布，回执 v2 必填在运行时强制、legacy 回执不被伪装成新核验；iOS 对未知更高能力版本 fail-closed。
6. **文档承诺与代码一致的部分**：`IOS_NATIVE_API_CONTRACT.md` 的三能力独立协商、`IOS_NATIVE_RUNBOOK.md` 的“真机/手表不可由模拟器替代”、D13/D14/D16 的计划口径，均与实现一致；COACH_LOOP 状态文档对“未签收”的表述诚实。

---

## 6. P3 汇总（防御性/低影响/文档）

| ID | 问题 | 证据/位置 |
| --- | --- | --- |
| P3-1 | `Cache-Control: no-store` 只覆盖 `training-plan-state`/`coach-loop`/`coach-execution`；`today`/`workout-plan`/`goals`/`run-coach`/`plan-operations` 无 | `apps/api/src/server.ts:1326`、`coach-loop-routes.ts:25/32`；iOS 侧 `reloadIgnoringLocalCacheData` 使当前不可利用 |
| P3-2 | `coherenceToken` 不含 plan-history 派生展示字段 | `apps/api/src/data.ts:546-560`；常规写路径被 `goalsRevision` 覆盖，处方级无 fail-open |
| P3-3 | handshake 恒宣告 `planSnapshotContractVersion=1`，但管理态下该路由 409 | `apps/api/src/server.ts:396-406, 931-935` |
| P3-4 | 读缓存连接固定旧 inode（带外替换的 known limitation） | `apps/api/src/read-store-manager.ts`；应用内导入/恢复已排空租约 |
| P3-5 | 预览最多 8 条，第 9 次会提前淘汰未满 15 分钟的候选，`confirm` 报“已过期” | `apps/api/src/weekly-plan-preview.ts:10-24` |
| P3-6 | `confirm` 的 `remember=false` 让带 operationId 的首次成功不留内存结果 | `apps/api/src/server.ts:1471`、`weekly-plan-preview.ts:20-24` |
| P3-7 | 普通 `/synced` v2 不校验 `operationId` 是否对应已提交发布 | `apps/api/src/server.ts:1210-1225`；教练通道会校验 |
| P3-8 | control DB 被其他连接持锁时同步阻塞约 5.1 s 并返回 500 | `apps/api/src/mobile-goals.ts:270,697-700`；合成用例证实 |
| P3-9 | `PlanPublicationService` 的 `identity` 可选，忘传时静默失去身份校验 | `apps/api/src/plan-publication.ts:10-18`；当前生产均传 |
| P3-10 | 周期化/容量模块内重复且宽松的 `isLocalDate`（接受 `2026-02-30` 并移到 03-02） | `apps/api/src/plan-periodization.ts:120`、`weekly-capacity.ts:68` |
| P3-11 | `prescriptionDigest` 的 `kind` 未限制分隔符，`"easy\|~\|0"` 可与空结构撞哈希（TS/Swift 一致地撞） | `apps/api/src/plan-digest.ts:23`；未发现利用路径 |
| P3-12 | 赛卡“减量”硬编码 `<=14`，未用共享 `PRE_RACE_EXECUTION_PROTECTION_DAYS`；比赛日当天仍算 taper | `apps/api/src/mobile-coach.ts:1340`、`race-plan-policy.ts:7` |
| P3-13 | DECISIONS D13 称 `phases` 仍以 `"base"` 填充，代码已改为空数组并由测试锁定 | `docs/DECISIONS.md:144` vs `apps/api/src/run-coach.ts:303-311` |
| P3-14 | `generateWeeklyPlan` 忽略 `automaticDosePolicy` 形参；`rejectedCount`/`clampedCount` 恒 0 | `apps/api/src/weekly-plan-service.ts:113-146` |
| P3-15 | legacy/单条缓存路径丢失 `cachedAt`，离线文案无法说明缓存时间 | `apps/ios/RAI/TrainingPlanStore.swift:154-170`、`PlanStatePolicy.swift:21-31` |
| P3-16 | 撤回 cleanup 只按 UUID 判断残留，不核对精确时刻 | `apps/ios/RAI/PlanWatchScheduling.swift:287-292` vs `WorkoutKitBridge.swift:30-39` |
| P3-17 | 两处主线程强制 `as!`（编码形状变化即 trap） | `apps/ios/RAI/APIClient.swift:185-186`、`NativeAppModel.swift:1284` |
| P3-18 | 今日页计划卡 C1–C4（权威性/两个“本周”/窗口/方向）仍未决 | `docs/TODAY_PLAN_CARDS_REVIEW.md`、`TechViews.swift:344-490`；文档明确“未决”，非回归 |
| P3-19 | README 写“54 项验收合同”，实际矩阵 77 条 | `README.md:62`、V6 |
| P3-20 | pre-commit 不跑任何 plan 回归；CI 在 gitee 远端不触发 | `.githooks/pre-commit`、`.github/workflows/ci.yml:38` |
| P3-21 | 各文档验证节并列 84/87/89/90 份 iOS 源码、1508/1518/1522 项等数字，无“对齐提交/是否现状”标注 | `docs/IOS_TRAINING_PLAN_STATE_V1.md:88,103`、`IMPLEMENTATION.md:62,85-88`、`ARCHITECTURE_PROPOSAL.md:332`、`COACH_LOOP_IMPLEMENTATION_STATUS.md:106,148,208` |

---

## 7. 文档/契约偏差汇总（与缺陷分开列）

| # | 文档承诺 | 实现 | 判定 |
| --- | --- | --- | --- |
| D-1 | “过期键…返回 expired / HTTP 410” | GET 恒 200 + `status:"expired"`；只有**写入重放**返回 410 | 文档歧义（实现本身自洽，建议改文档措辞） |
| D-2 | “UUID 大小写与等价 ISO 时刻表示不改变身份” | 服务端字节比较；仅 iOS ledger 规范化 | 与文档不符（P2-1） |
| D-3 | “候选预览 15 分钟有效” | 另有最多 8 条、先淘汰最旧 | 偏差（P3-5） |
| D-4 | “当前覆盖必须匹配当前处方与事实令牌” | 只在计算瞬间匹配 | 时点未声明（P2-2） |
| D-5 | “≤24 周”骨架支持 | 恰好 24 周丢当前周 | 边界偏差（P2-12） |
| D-6 | D13 “`phases` 无骨架仍以 base 填充” | 已改为空数组 | 文档过时（P3-13） |
| D-7 | 验收矩阵覆盖“必需 Golden/Metamorphic” | 无 plan 快照/操作/回执行 | 覆盖缺口（P2-16） |
| D-8 | “自动入口 typecheck/test/build/test:ios” | Web 已退役 | D17 冲突（P2-18） |

另：`PLAN_ADHERENCE` 的两处已知未决（“低于量带下限无建议”、`completedWeeks` 判据却写“当前周量可能已经不现实”）经复核**仍与 `docs/TODAY_PLAN_CARDS_REVIEW.md` 的“未决”状态一致**，不算文档漂移，也不计入本轮缺陷；建议作为 UX 整改项纳入批次 C。

---

## 8. 修复优先级建议（可执行）

> **批次 A 已落地（2026-10-18）**：3 个 P1 的代码修复、回归与本机验证见
> [FIXES_BATCH_A_2026-10-18](training-plan-review-2026-10-18/FIXES_BATCH_A_2026-10-18.md)。
>
> **批次 B/C 已落地（2026-10-18）**：批次 A 的 3 项残留风险、P2×18、P3×21 的修复与验证见
> [FIXES_BATCH_BC_2026-10-18](training-plan-review-2026-10-18/FIXES_BATCH_BC_2026-10-18.md)
> （含跨库 publication guard、`server-runtime` 31/31、全量套件 2024/2032 的环境限制清单）。
> 以下保留原建议原文作为审查结论；P3-18 的 B1 仍为产品决定未实现。

### 批次 A — P1，发布前必须完成

1. **回执 v2 线格式**（P1-1）：服务端以 normalized 结构计算/落库 + `step()` 对 `undefined` 防御；客户端统一 v2 wire 编码（所有回执，不只 coachLoop）；补 HTTP 级“Swift 形状”回归与 iOS 线格式断言。
2. **revision 冲突 500**（P1-2）：给 `MobileGoalsRevisionConflictError` 加 `statusCode = 409`；coach-loop/lock 路由补 catch；补 HTTP 断言。
3. **coach-loop 读取回验**（P1-3）：返回前复算 control 摘要/revision 与 `saved`，不一致重建 ≤3 次后返回可重试错误；补并发写回归。
4. 验收：`typecheck`、受影响的 HTTP/单元测试（先解决 P2-15 的 ONNX 导入耦合或在可加载 ONNX 的主机跑）、`test:ios`；真机复测非教练闭环的回执 200 与教练切换不被卡。

### 批次 B — P2，同期或紧随其后

- 状态/展示：P2-7 legacy 校验、P2-8 错误分类、P2-9 能力单源、P2-10 提醒语义、P2-11 赛事时区。
- 读取语义：P2-5 `statSync` 分类、P2-6 503 重试/Retry-After。
- 回执语义：P2-1 身份规范化、P2-2 `matchesCurrent` 原子化、P2-3 幂等键作用域、P2-4 无数据库时的策略校验。
- 算法/契约：P2-12 24 周边界、P2-13 摘要格式统一 + fixture 扩充、P2-14 操作响应类型。
- 验收：新增 HTTP/并发/跨时区/线格式回归；`check:acceptance-matrix` 加入 G06–G08 后重新执行；`test:ios` 全绿；至少一次真机计划排期 + 回执登记的完整走查。

### 批次 C — P3/门禁/文档

- 三份现行文档的验证入口与 D17 对齐（P2-18）；`check:doc-refs` 范围扩到 plan 文档并修 `docs/WEB.md` 死引用（P2-17）；README 数字（P3-19）；pre-commit 增补 19 s 的 plan 定向测试（P3-20）；P3-1~P3-18 量力清理。
- 今日页 C1–C4（P3-18）建议按 `TODAY_PLAN_CARDS_REVIEW` 的 A1/A2/A3 落文案分层，并为这两句加门禁断言。

---

## 9. 未验证边界（不得计入通过）

1. 真机 + 配对 Apple Watch：UUID/时刻稳定、表端可见、读回延迟、授权各状态、部分成功、定向/全部撤回、每步副作用后强杀重启、跨午夜、新旧服务组合（`docs/IOS_NATIVE_RUNBOOK.md:245-262`）。
2. Simulator 视觉验收（`apps/ios/tests/run-visual-tests.sh`，需要已启动 Simulator 与隔离数据库）。
3. ~~真实 HTTP 端到端未跑~~ → **批次 B/C 已补**：`server-runtime.test.ts` 31/31 在隔离 API 实例上执行；收尾轮另加真实 HTTP 503 负载（10×20 读者 / 2×25 写者 + 跨进程发布者），503 全部带 `Retry-After: 1`、200 快照无不一致、p95 112–149 ms（见 [批次 B/C 修复记录](training-plan-review-2026-10-18/FIXES_BATCH_BC_2026-10-18.md) §4.5.5）。
4. ~~9 个 ONNX 测试文件未执行~~ → **P2-15 已解耦导入**：这些文件现在本机可跑；全量套件串行 **2038/2038（0 失败，3 个平台条件 skip）** 通过；原 5 个失败已通过补齐本机 Node/npm、Rust 工具链并修复重建后暴露的 Rust parity 与过期测试断言全部消除（见批次 B/C 修复记录 §4.6）。ONNX 真正推理已在官方 Node 上实测通过。
5. ~~并发写压测缺失~~ → **批次 B/C 已补**：guard 双进程 2000 轮不变量压测 violations=0（detected 50.7–57.6%）；HTTP 503 负载 3/3 稳定。仍未覆盖生产 import worker 的 worker_threads 跨线程发布与 Windows。
6. 真实健康数据库与生产数据规模：`var/rai.sqlite` 仍未被读取或修改；批次 B/C 收尾轮用 ≈42,600 行合成库测得 `trainingPlanState` p50 13.7–14.7 ms / p95 19.7–21.4 ms（同 row-count 的**下界近似**，未 seed model/loads/assessment 链）。

---

## 10. 附录

### A. 本机验证命令（复现用）

```bash
export PATH=/Users/tp/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:/Users/tp/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin:$PATH
cd /Users/tp/running

node_modules/.bin/tsc --noEmit -p tsconfig.pure.json
node_modules/.bin/tsc --noEmit -p tsconfig.json
node scripts/run-ios.mjs gates
node --import tsx --test <21 个不依赖 ONNX 的 plan/coach 测试文件>
node --import tsx scripts/check-acceptance-matrix.mts
node scripts/check-doc-links.mjs
node scripts/check-npm-scripts-portable.mjs
node scripts/check-doc-line-refs.mjs
```

### B. 关键复现脚本（均在 `/tmp`，未入库）

- `/tmp/lead-probe-receipt.mjs`：回执 v2 的 Swift 形状 → `canonicalMismatch=true`、缺 `warmup` → `TypeError`（Lead 复算）。
- `/tmp/lead-period24.mts`：23/24/25 周骨架的 `current`/行数/原因码（Lead 复算）。
- `/tmp/fmt.swift` + `/tmp/fmt`：Swift `String(format:"%.6f")` 半值/1e21 输出（Lead 复算）。
- `/tmp/rai-review/probe1/3/4.mjs`（lane 2）：发布幂等/回滚/90 天、回执谓词、控制库 busy、等价 ISO 身份。
- `/tmp/periodize-check.mts`、`/tmp/boundary24.mts`、`/tmp/digest-ts.mts`、`/tmp/digestswift/`（lane 3）：周期化边界与 TS/Swift 摘要对照。
- `/tmp/rai-ios-plan-receipt-probe.mjs`（lane 4）：iOS 侧回执摘要差异。
- `/tmp/ios-gates-full.log`、`/tmp/lead-plan-tests.log`：门禁/测试原始输出（lane 5 与 Lead）。

### C. 分 lane 证据索引

| Lane | 报告 | 主要贡献 |
| --- | --- | --- |
| API 读 | [01-api-read.md](training-plan-review-2026-10-18/01-api-read.md) | 快照机制复核、P1-3、P2-5、P2-6、P3-1~P3-4 |
| API 写 | [02-api-write.md](training-plan-review-2026-10-18/02-api-write.md) | 发布事务/幂等复核、P1-1、P1-2、P2-1~P2-4、P3-5~P3-9 |
| 领域算法 | [03-domain-algorithms.md](training-plan-review-2026-10-18/03-domain-algorithms.md) | D14/D16 复核、P2-12、P2-13、P3-10~P3-14 |
| iOS 客户端 | [04-ios-client.md](training-plan-review-2026-10-18/04-ios-client.md) | P1-1 客户端侧、P2-7~P2-11、P3-15~P3-18 |
| 文档/契约/测试 | [05-docs-contracts-tests.md](training-plan-review-2026-10-18/05-docs-contracts-tests.md) | 本机验证、P2-14~P2-18、P3-19~P3-21 |

### D. 本轮对仓库的改动

- 新增：`deliverables/TRAINING_PLAN_REVIEW_2026-10-18.md`、`deliverables/training-plan-review-2026-10-18/`（5 份 lane 报告 + 索引 README）。
- 修改：`deliverables/README.md` 的「当轮审查」新增一行索引（使交付产物可被 `check:docs` 的链接门禁接受）。
- 未修改：任何 `apps/`、`packages/`、`scripts/`、`docs/` 文件；未提交、未推送。
