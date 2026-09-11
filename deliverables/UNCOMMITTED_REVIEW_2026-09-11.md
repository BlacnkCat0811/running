# 未提交改动审查（2026-09-11）

审查对象：工作区 29 项变更 —— 17 个已跟踪文件（+1348 / −48）+ 11 个未跟踪新文件 + 1 张截图。
改动主体：**P1-2「缺失 ≠ 删除」判据反转 + 墓碑持久化（migration v19/v20）** 与 **P1-1 派生层 run GC**，外加 iOS 像素皮肤解耦。

方法：逐文件读 diff → 核对 schema/FK → 跑验证 → 反向验证测试有效性。
所有结论均落到 `文件:行号` 或命令输出。

---

## 一、结论摘要

| # | 级别 | 结论 | 证据 |
|---|---|---|---|
| 1 | 🔴 必修 | `data:prune-tombstones` 缺 Node 门禁钩子，`npm test` 红 | `node-version.test.ts:36` |
| 2 | 🟡 待决策 | 1 个既有测试在全量并发下超时失败（非本次逻辑引入） | `server-runtime.test.ts:298` |
| 3 | 🟡 待决策 | `isHealthKitUploadSource` 不认 `apple-health-full-snapshot`，会把最该保留的归档清掉 | `import-sources.ts:201-210` |
| 4 | 🟡 待决策 | manifest 有 **3 处独立解析**，查找深度互不相同 | 见 §三.3 |
| 5 | 🟡 待决策 | 显式删除由 LIKE 子串收紧为精确匹配，未命中无任何信号 | `database.ts:2310-2327` |
| 6 | 🔡 清理 | `snapshotReason` 是死字段；`removal_guard_json` 存而无出口 | `worker.ts:582/660` |
| 7 | ✅ 通过 | FK 级联链、GC 顺序、血缘保护、墓碑时机、守卫防伪造、iOS 皮肤解耦 | 见 §四 |

**正面评价**：改动方向正确，安全姿态是"默认不删"。测试质量高且**非空转**（反向验证：拆掉墓碑拦截 → 4 例失败；关掉守卫 → 1 例失败）。

---

## 二、🔴 必修：`data:prune-tombstones` 缺 Node 门禁

```
not ok 116 - every public runtime command executes the Node gate through npm lifecycle hooks
  data:prune-tombstones must have a Node gate
  + actual: undefined
  - expected: 'npm run check:node'
  location: apps/api/test/node-version.test.ts:36
```

`node-version.test.ts:30-37` 要求**每个** `data:*` / `ml:*` 脚本都必须有 `pre<script> = "npm run check:node"`。本次新增的 `data:prune-tombstones`（`package.json:55`）没有配套 `pre` 钩子。

**两次全量 `npm test` 均复现，100% 由本次改动引入。**

修复（`package.json` scripts 内，与 `predata:analyze` 并列）：

```json
"predata:prune-tombstones": "npm run check:node",
```

---

## 三、🟡 待决策项

### 3.1 失败 131：全量并发下的时序失败

```
not ok 131 - runtime status includes persisted prediction work and restore recovers recompute jobs
  apps/api/test/server-runtime.test.ts:298  assert.equal(busy, false)  → true !== false
```

| 实验 | 结果 |
|---|---|
| 单文件 + `--test-name-pattern` 单跑 | **ok**，14.3 s |
| 全量 `npm test` 第 1 次 | **not ok**，22.1 s |
| 全量 `npm test` 第 2 次 | **not ok**，22.1 s |

`busy` 的组成（`apps/api/src/server.ts:573-579`）：`importWorker.isRunning || recomputeWorker.isRunning || predictionModelWorker.isRunning || predictionModelJobActive || recomputeJob?.status ∈ {queued,running}`。

判断与依据：
- 测试自身在 `:288` 直接把 `prediction_model_runs.status` 改成 `failed`，随后 5 s 轮询等 `busy` 变 false；
- 全量跑时该测试耗时比单跑**慢 55%**，说明是 CPU/IO 争抢导致 5 s 窗口不够，而非逻辑错误；
- **本次改动未触碰** prediction / restore / runtime-status 的任何代码路径（只给 `import_jobs` 加了一列）。

⚠️ 未做的对照：没有在 `HEAD`（不含改动）上跑全量验证。原因：未跟踪的新测试文件（`tombstone-deletion` 等）在 HEAD 上必然失败，会引入额外负载反而污染实验；`git worktree` 方案会因 npm workspaces 的 `node_modules/@rai/*` 符号链接解析到当前工作区的 packages 而失去对照意义。**因此这项归因标注为"高置信、未对照"。**

处置建议（任选其一）：
1. 本次改动的**新增 8 个 apps/api 重型测试**（`worker.test.ts` +5、`import-sources.test.ts` +3，其中 guard 测试会真实拉起 CLI 子进程）提升了该目录的并发负载 —— 把 `server-runtime.test.ts` 移入独立批次/降低 `--test-concurrency`；
2. 把该测试的 5 s 空闲窗口放宽（`:291`）。

### 3.2 `isHealthKitUploadSource` 不认全量快照

`apps/api/src/import-sources.ts:201-210` 的 manifest 分支只匹配 `"healthkit"`：

```ts
if (scope.declared && scope.sourceScope === "healthkit") return true;
```

`FULL_SNAPSHOT_SOURCE_SCOPE`（`"apple-health-full-snapshot"`）**不在其中**，于是回退到文件名判定。后果在 `apps/api/src/server.ts:1069-1073`：

```ts
if (succeeded && isHealthKitUploadSource(source, source.inputPath)) {
  await importSources.retainImportedUpload(sourceId);   // 保留归档
} else {
  await importSources.cleanupUpload(sourceId);          // 删掉归档
}
```

声明了全量快照的归档，若文件名不含 `apple-health-healthkit`，导入成功后会被 **cleanup**。而 `docs/PARSER_DESIGN.md:§12.3` 明确把"误删后可从完好归档恢复"当作设计目标 —— **最权威的恢复源被清理，与目标相反**。

当前不可达（所以定级 🟡 而非 🔴）：
- iOS 客户端硬编码 `"sourceScope": "healthkit"`（`apps/ios/RAI/HealthKitExport.swift:148,173`）→ `manifest-full-snapshot` 分支**目前没有生产者**；
- 上传文件名也固定含 token（`HealthKitExport.swift:161`、`HealthKitSync.swift:843` 的 `filename="apple-health-healthkit.zip"`）→ 文件名回退分支总能命中。

但这是**未来契约陷阱**：一旦接入 Garmin/第三方导出器或允许重命名，"声明全量"反而导致恢复源被删。修法：

```ts
if (scope.declared
  && (scope.sourceScope === "healthkit" || scope.sourceScope === FULL_SNAPSHOT_SOURCE_SCOPE)) return true;
```

同一处判断也决定 `ImportSourceManager.register` 的 `sourceSha256`（`import-sources.ts:512-515`）：全量快照走文件字节 sha 而非内容哈希 → 重复上传无法去重。

### 3.3 manifest 三处独立解析，查找深度不一致

| 位置 | 查找路径 | 深度 |
|---|---|---|
| `readSyncManifestScope`（`import-sources.ts:135-168`） | `inputPath/`、`dirname(inputPath)/` | 1 层 |
| `digestHealthKitExportContent`（`import-sources.ts:248-254`） | `exportRoot/` | 本级 |
| `readSyncManifest`（`cli.ts:364-374`） | `inputRoot/` | 本级 |

而 `findExportRoot`（`import-sources.ts:524-543`）可以**下探 3 层**找 `export.xml`。归档若为 `root/a/b/c/export.xml` + `root/sync-manifest.json`：
- `readSyncManifestScope` 查 `c/` 与 `b/` → 找不到 → **静默退回文件名判据**；
- 而 `export.xml` 在 `c/` 能被发现。

即"判据"与"载荷识别"的搜索范围不匹配，与"manifest 优先于文件名"的设计意图冲突。嵌套场景的测试只覆盖了**一层**父目录（`import-sources.test.ts:540-555`）。

三处各自重复 `version !== 1` 校验与字段白名单，违反单一真相。建议抽一个 `readSyncManifest(inputPath)` 供三处共用（同时解决 §3.2 的字段口径）。

### 3.4 显式删除：LIKE → 精确匹配，未命中无信号

`database.ts:2310-2327` 把原 `metadata_json LIKE '%id%'` 换成 4 个 `json_each(...) WHERE value = ?`。这是**正确修复**（原实现下含 `%`/`_` 的标识符会变成通配符，子串匹配可能误删别的训练），也消除了跨字段误匹配。

链路核实完整 ✅：iOS manifest `deletedSourceIds` = HKWorkout UUID（`HealthKitExport.swift:151`）→ CLI 读同名键（`cli.ts:368-370`）→ `apple-health-parser.ts:528-529` → 精确匹配 `RAIHealthKitWorkoutUUID`，而该键正由 `HealthKitExport.swift:275` 以 `workout.uuid.uuidString` 写入。

唯一缺口：**匹配不到时没有任何信号**。若未来客户端传的 ID 形态与存储不一致，显式删除会静默失效（用户以为删了，实际没删）。建议 `removeWorkoutsBySyncIdentifiers` 返回未命中的标识符，或落一条 `import_issues`。

---

## 四、✅ 已核实正确（不必改）

**FK 级联链完整**（`packages/storage-sqlite/src/database.ts`）—— 这决定了 GC 能否删动：

- CASCADE：`training_metric_runs.model_run_id`(:666)、`workout_training_loads`(:685)、`daily_training_metrics`/`daily_zone_profiles`/`workout_zone_summaries`(:716/:827/:1070/:1094/:1160)、`ability_assessments`(:362)、`daily_ability_snapshots`(:396)、`model_checkpoints`(:1011)、`workout_features`(:312)
- NO ACTION（**必须显式处理**）：`model_runs.feature_run_id`(:343)、`recompute_jobs.model_run_id`/`feature_run_id`(:432-433)、`active_model_run.model_run_id`(:463)
- SET NULL：`model_validation_gates.base_model_run_id`(:1299)

`pruneSupersededModelRuns` 的处理与之吻合：先 `UPDATE recompute_jobs SET model_run_id/feature_run_id = NULL`（`database.ts:1954-1962`），再按 `model_runs` → `feature_runs` 顺序删（`:1965-1971`，注释已说明原因）；保留 active（无 active 时直接抛错拒绝，`:1846-1852`）；血缘双向回溯（model 链 `:1878-1884`、feature 链 `:1908-1918`，含"孤儿特征运行也保护"）。

**墓碑时机正确**：`clearEntityTombstones` 在 `seedImportGenerations` 内、扫描**前**执行（`database.ts:2133-2139`），注释点明了顺序反了会被墓碑挡住写入。`finalizeImportGeneration` 有事务包裹（`:2231` `this.begin()`）。

**守卫不可被 API 路径绕过**：`--allow-large-removal` 只暴露给 CLI，`worker.ts:778-787` 的 spawn 参数里没有它；`ImportRemovalGuardError.fromPayload` 会拒绝伪造计数（`import-guard.ts:68-82`：校验 `total === records+workouts+summaries`、`total ≤ existingEntities`、`total > allowedRemovals`）。

**去重哈希正确**：`digestHealthKitExportContent` 只纳入 `version`/`sourceScope`/`deletedSourceIds`（排序去重），**排除 `createdAt`**（`import-sources.ts:246-254`），使内容未变的重导出仍能去重，同时删除事件变化能改变哈希。

**iOS 皮肤解耦方向正确**：像素皮肤的 `WorkoutDetailView`（`NativeViews.swift:1185`）此前调用科技皮肤的 `TechRouteView` 与 `NativeHeartRateChart`，本次替换为 `PixelRouteView`/`PixelHeartRateChart` —— 这正是 memory 记录的事故 `18067cb` 同类问题。已核实无跨皮肤复用：`WorkoutDetailView` 仅被 `NativeViews.swift:436,1089` 引用，科技皮肤使用独立的 `TechWorkoutDetailView`（`TechViews.swift:1107`）。

**iOS 类型可达**：`RoutePoint`/`MetricSeries` 在 `APIModels.swift:599/705`、`HeartRateChartData` 在 `APIModels.swift:739`、`nativeNumber` 在 `NativeFormat.swift:9`，均为共享文件；`PixelCharts.swift` 的 `#if os(iOS)`（:1）与皮肤无关，不会因皮肤分支缺文件而失编。

---

## 五、🔡 清理项

| 项 | 位置 | 说明 |
|---|---|---|
| `snapshotReason` 死字段 | `worker.ts:582` 声明、`:660` 赋值 | 全仓无读取者。`deliverables/DATA_MODEL_REVIEW_2026-09-10.md:206` 已把它写成成果，属"文档描述了未完成能力" |
| `removal_guard_json` 存而无出口 | `runtime-state.ts:34/155/166/184` | 已持久化，但 `worker.ts:1959-1963` 只取 `userMessage` 文本，API 未暴露结构化计数，前端（`apps/web/src`）零消费点。要么加出口，要么按冗余删掉 |
| `pruneEntityTombstones` 的 `limit` 不约束 source tombstones | `database.ts:1569-1576` | `DELETE FROM import_source_tombstones WHERE deleted_at < ?` 无 `LIMIT`，与 entity tombstones 的 limit 语义不一致 |
| 交付物处置 | `deliverables/` | 4 个新 md 应入库（该目录既有 md 均已跟踪）；`icp-footer-live.png`（45 KB 截图）未被 gitignore，建议不入库或加 ignore |

---

## 六、验证记录

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 通过（55 s） |
| `npm test`（第 1 次） | 🔴 489 tests / 483 pass / **2 fail** / 4 skip |
| `npm test`（第 2 次） | 🔴 同样 2 项失败（#116、#131） |
| 单跑失败 #131 | ✅ ok（14.3 s） |
| 反向验证：拆墓碑拦截（`database.ts` `if (false)`） | ✅ 4 例失败 |
| 反向验证：关守卫（`import-guard.ts` `exceeded:false`） | ✅ 1 例失败 |
| 反向验证后还原 | ✅ 哈希一致，工作区回到原状（29 项 / +1348） |
| iOS `swiftc -typecheck` | ⚠️ 沙箱内宏插件受限（`sandbox_apply: Operation not permitted`），`@Observable` 级联报错，**无一条指向本次改动文件**，无法完成编译验证 |

⚠️ 附带发现：根 `test` 脚本为 `node --test ... && npm run test -w @rai/web`，node:test 失败后**短路**，`apps/web` 的 vitest **本次完全未执行**。修好 #116 后才算完整验证。

---

## 七、建议修复顺序

1. **补 `predata:prune-tombstones`**（1 行）→ 重跑确认 `npm test` 只剩 #131。
2. **处置 #131**：先降低 apps/api 的测试并发或放宽窗口，确认转绿；再决定是否值得单独排查。
3. **修 §3.2**（`isHealthKitUploadSource` 纳入 `FULL_SNAPSHOT_SOURCE_SCOPE`）—— 低成本、消除未来陷阱。
4. **抽单一 manifest 读取器**（§3.3）—— 建议与 §3.2 一并做。
5. 清理项按需处理；交付物入库前决定 png 去留。

---

## 八、待小唐决定

- D1：是否按 §七 顺序修复？（1、3 我建议直接做；2 需要他定测试并发策略）
- D2：是否需要我补做 `HEAD` 对照实验来给 #131 定性？（需要临时 stash，有污染风险）
- D3：`removal_guard_json` 是补 API 出口还是按冗余删除？
- D4：4 个新 md + 1 张 png 的入库策略。

---

# 九、复审（2026-09-11 09:55，小唐修复后）

改动量 1348 → 1367 插入（4 个文件：`package.json`、`import-sources.ts`、`cli.ts`、`worker.ts`）。

## 9.1 修复逐项核对

| 原项 | 修复内容 | 核对结果 |
|---|---|---|
| 🔴 #116 | `package.json` 增 `predata:prune-tombstones` | ✅ 全量测试中 #116 已消失 |
| 🟡 §3.2 | `isHealthKitUploadSource` 增 `\|\| scope.sourceScope === FULL_SNAPSHOT_SOURCE_SCOPE`（`import-sources.ts:210`） | ✅ 逻辑正确。`resolvePreserveAbsent` 内对 `isHealthKitUploadSource(source)` **有意不传 inputPath** 也对 —— manifest 已在上方 `scope.declared` 分支处理，避免重复 IO |
| 🟡 §3.3 | `readSyncManifestScope`（`import-sources.ts:136-152`）与 `readSyncManifest`（`cli.ts:365-382`）**都改为向上 3 层** | ✅ 两处循环逐字一致（仅命名不同），与 `findExportRoot` 下探 3 层正好对齐：`export.xml` 最深在 `root/a/b/c`，向上 3 层恰好回到 `root` |
| 🔡 | 删除 `snapshotReason` 死字段 | ✅ 字段已消失。副作用：`resolvePreserveAbsent` 的 `reason` 现在**只有测试消费**（生产只剩 `.preserveAbsent`），`SnapshotModeReason` 成为测试专用契约 —— 可接受（它锁住分支选择），但若不再需要可观测性可进一步简化 |

## 9.2 🔴 遗留：两处修复**都没有测试锁定**

| 修复点 | 现有覆盖 | 缺口 |
|---|---|---|
| `isHealthKitUploadSource` 认 full-snapshot | `import-sources.test.ts:533-540` 的 4 条断言**全部不传 inputPath**，只覆盖文件名分支 | manifest 分支（含新增的 full-snapshot → `true`）**零覆盖** |
| manifest 向上 3 层 | `:692-707`「sits above the discovered export root」只测 **1 层**父目录 | 第 2、3 层零覆盖 |
| `cli.ts` 的 `readSyncManifest` 3 层 | 无 | 端到端零覆盖（该函数未导出，只能经 CLI 测） |

代码已改、测试未跟 ⇒ 下次谁重构这段循环，退化不会被发现。

## 9.3 🟡 #131 定位完成（4 组梯度实验）

| 实验 | 规模 | #131 结果 | 耗时 |
|---|---|---|---|
| 单文件 + pattern | 1 文件 | ✅ pass | 14.3 s |
| `server-runtime` + `worker` | 2 文件 / 95 | ✅ pass | ~1 m 42 s |
| `apps/api/test/*.test.ts` 整目录 | 14 文件 / 234 | ✅ pass（0 fail） | 2 m 46 s |
| 全量 `npm test` | 489 | 🔴 fail | 20.9 ~ 22.1 s |

**机制（有代码依据，非推测）**：

1. `server.ts:509-512` — server 启动即 `recomputeWorker.schedule()` 与 `predictionModelWorker.schedule()`；
2. `hasActivePredictionModelJob`（`server.ts:382-386`）查 `status IN ('queued','running','validating')`；
3. 测试在 `:265-277` 插入一条 `status='running'` 的预测任务 ⇒ worker 接管，`predictionModelWorker.isRunning = true`；
4. `busy` 的定义**包含** `predictionModelWorker.isRunning`（`server.ts:573-579`，注意它比 `isDatabaseWriteBusy`（`:399-402`）更宽）；
5. 测试在 `:288` 把 DB 状态改回 `failed`，但**内存中的 worker 不会立即停止**；测试只用 5 s 窗口（`:291`）等 `busy` 转 false。

⇒ 只有在**全仓并发**造成 CPU 争抢、worker 收尾变慢时，5 s 才会不够。本次改动**完全未触碰** prediction worker / 调度 / runtime-status 任何代码 ⇒ **不是逻辑回归，是既有脆弱性的暴露**。改动把测试总量从 ~380 抬到 489（+29%），提高了触发概率，属"最后一根稻草"。

（未做 `HEAD` 对照的替代解释：单跑 / 双文件 / 单目录三档均通过，已排除"改动逻辑导致"；且本次未碰该路径。）

**处置建议**（择一）：
1. `server-runtime.test.ts` 这类"真实 server 子进程 + 固定等待窗口"的端到端测试隔离到独立批次（独立 npm script 或 `--test-concurrency=1`）；
2. 把 `:291` 的 5 s 空闲窗口放宽（15 s，成本几乎为零）；
3. 在 `waitForApi` 后补一个"等待启动期 job 恢复完成"的显式同步点，替代固定窗口。

推荐 1 或 2。

## 9.4 遗留清理项状态

| 项 | 状态 |
|---|---|
| `snapshotReason` | ✅ 代码已删 |
| `DATA_MODEL_REVIEW_2026-09-10.md:206` | 🔴 **仍写「job 增 `snapshotReason`」**，与代码不符，需对齐 |
| `removal_guard_json` 无 API/前端出口 | ⬜ 未动 |
| `pruneEntityTombstones` 的 `limit` 不约束 source tombstones | ⬜ 未动 |
| `deliverables/UNCOMMITTED_REVIEW_2026-09-11_副本.md`、`.DS_Store` | 🆕 建议删除或 gitignore；png 去留待定 |

## 9.5 复审验证记录

| 命令 | 结果 |
|---|---|
| `npm test`（第 3 次全量） | **489 tests / 488 pass / 1 fail（仅 #131）** ⇒ #116 已消除 |
| `node --import tsx --test apps/api/test/server-runtime.test.ts apps/api/test/worker.test.ts` | 95 / 94 pass / 0 fail |
| `node --import tsx --test apps/api/test/*.test.ts` | 234 / 231 pass / 0 fail |
| 文件字节核查（`cli.ts:26-40`） | ✅ 无脏字符（`allowLargeRemoval: boolean;` 正常） |

⚠️ 因 `&&` 短路，`apps/web` 的 vitest 在三次全量中**从未执行**；修掉 #131 或改为 `;` 才能覆盖。
