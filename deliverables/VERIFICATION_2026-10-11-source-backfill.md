# 验收证据：纯补史导入不再被资格漂移门禁死锁（`sourceBackfill`）

- **as-of**：2026-10-11 06:43 CST（UTC+8）
- **时区**：`Asia/Shanghai`（`packages/contracts/src/timezone.ts:28`）
- **代码**：`cebb0dc`（= `origin/main`）；服务器 `/opt/rai` HEAD 同为 `cebb0dc`
- **配置**：引擎 `rust` `0.1.0` + `--native-fallback typescript`；`RAI_RUST_BINARY=/opt/rai-native/rai-data-worker`
- **载荷**：`/var/lib/rai/var/imports/upload_dd2544dc-93c6-4a48-bf24-e1d60f3783e7/extracted`
  （`export.xml` 250,241,407 B）
- **起点库**：`rai.importing.web_import_mv2jk9a1_….attempt-1.sqlite.replaced.10c4dbd7-…`，
  `health_records = 183,556`，与线上主库逐值相同 ⇒ 确为导入前状态
- ⚠️ 本记录只含**聚合数字与命令**，不含原始健康数据、Token、路线、上传 ZIP 或 SQLite。

## 1. 结论

线上那次 `web_import_mv2jk9a1_…` 失败是**假阳性**：iOS 历史补齐把事实时间线从 `2023-10-31`
前推到 `2020-02-26`，两个假设「两侧同一份事实」的**资格**判据随之超标，而**数据健全性与分数位移
全部宽裕通过**。`cebb0dc` 新增 `sourceBackfill`（纯补史）通道，在可结构化证明「零删除 + 把全库最早
事实推得更早」时把这**两个数据驱动理由**改记为 `migrationReport`；其余硬失败照旧拦下。
阈值 `MODEL_TRANSITION_GATE_THRESHOLDS_V2` **一字未改**。

落地后线上同载荷同基线的复跑：`status = "succeeded"`。

## 2. 复现命令（服务器，均为**独立 CLI 进程**，不触碰线上主库）

起点：把「导入前副本」拷成独立目标库，解析器自身再做一次 staging 并原子安装。

```
cp <导入前副本> /var/lib/rai/var/repro/stage.sqlite && chown rai:rai $_
chmod 666 /var/lib/rai/var/repro/stage.sqlite

# ① 解析 + 应用 + 写本批账本
cd /opt/rai && sudo -u rai env RAI_RUST_BINARY=/opt/rai-native/rai-data-worker \
  /usr/bin/node --import tsx packages/health-export-parser/src/cli.ts incremental-import \
  --input /var/lib/rai/var/imports/upload_dd2544dc-…/extracted \
  --database /var/lib/rai/var/repro/stage.sqlite \
  --engine rust --native-version 0.1.0 --native-fallback typescript \
  --native-spool-root /var/lib/rai/var/repro/spool \
  --report /var/lib/rai/var/repro/audit.md --json-report /var/lib/rai/var/repro/audit.json \
  --source-database <导入前副本> --batch-id repro-0110 --preserve-absent

# ② 全量重算（🔴 不带 --dirty-from：解析器报告里的 dirtyFromAt 是 workout 级，
#    用它跑出的是「假绿」；API 实际用的是记录级最早边界）
cd /opt/rai && sudo -u rai env RAI_RUST_BINARY=/opt/rai-native/rai-data-worker \
  /usr/bin/node --import tsx packages/application/src/cli.ts recompute \
  --database /var/lib/rai/var/repro/stage.sqlite \
  --engine rust --native-version 0.1.0 --native-fallback typescript \
  --native-spool-root /var/lib/rai/var/repro/spool2 --timezone Asia/Shanghai \
  --import-batch repro-0110
```

**① 解析自报**（与线上逐值相同）：`records=512088`、`workouts=14`、
`changes = { inserted: 328598, updated: 183493 }`、`dirtyFromAt = 2026-09-09T12:36:04.000Z`、
`datasetVersion = dataset_6c33f559a29ea4262778e9a030e284b5`；staging 615 MB → 2,069,049,344 B。

## 3. A/B 对照（同一库、同一代码、同一基线，唯一差异 = `--import-batch`）

| | 对照 A | 对照 B |
|---|---|---|
| 库 / 代码 / `active_model_run` | 同一 `stage.sqlite` / `cebb0dc` / `model_run_c5eef577-…` | **完全相同** |
| `--import-batch` | 不带 | `repro-0110` |
| 结果 | **`failed`** | **`succeeded`** |
| 报错 | `Model-version gate failed: eligible_session_delta, assessment_status_change_rate` | — |

对照 A 的报错与**线上失败逐字相同**。对照 A 的评测载荷因 `recordEvaluation` 位于调用方事务内
而随失败回滚（线上同样查不到），故指标以对照 B 为准——两者起点相同，指标相同。

## 4. 门禁判定载荷（对照 B，取自真实库 `model_release_bundles.evaluation_json`）

```
status: "passed"          blocksActivation: false
failureReasons: []        notEvaluableReasons: []
transition: "cross_scale" gateVersion: "rai-model-transition-gate-v2"
baseModelRunId: model_run_c5eef577-ebb9-4059-b2e6-080fa563983a   ← 与线上基线同一条

metrics:
  eligibleSessionDelta          0.10119047619047619   (168 → 185)   阈值 0.05   🔴
  assessmentStatusChangeRate    0.37943262411347517   (107 / 282)   阈值 0.10   🔴
  matchedSessions               282
  invalidValueCount             0                    ✅
  readinessOutputCoverage       1                    ✅
  recoveryIsolationHolds        true                 ✅
  currentAbilityMeanAbsoluteDelta 4.493670443271903    阈值 8    ✅
  currentAbilityP95AbsoluteDelta  6.563169324029836    阈值 15   ✅
  finalTrueAbilityDelta           2.09863847924224     阈值 10   ✅
  recoveryNullRateDelta / recoverySaturationRate      0 / 0     ✅

migrationReport:
  source_backfill_eligible_session_delta:0.10119047619047619
  source_backfill_assessment_status_change_rate:0.37943262411347517
  （+ 该轮原本已有的 5 条同标尺报告项）

sourceBackfill:
  preservedAbsent: true
  removedRecords / removedWorkouts / removedActivitySummaries: 0 / 0 / 0
  removedEligibleSessions / removedCalibrationSessions:        0 / 0
  earliestInsertedIsNewGlobalEarliest: true
```

两个超标值**逐位等于**线上被拒的那两个（`0.10119047619047619` / `0.37943262411347517`）；
`failureReasons` 为空 + 两条 `source_backfill_*` 落进 `migrationReport`，只可能来自
`verifiedBackfill === true`（判定见 `packages/storage-sqlite/src/model-transition-gate.ts:232`）。

## 5. 突变验证（跑绿必须能变红；4 条全部按预期变红并已回退，工作区 `git diff --quiet` 通过）

| 突变 | 期望变红的用例 | 实测 |
|---|---|---|
| `verifiedBackfill` 强制 `false` | 成立即通过 | 挂 2 条 |
| 摘掉 `removedRecords === 0` | 有删除仍失败 | 挂 1 条 |
| 摘掉 `earliestInsertedIsNewGlobalEarliest` | 最早值不成立仍失败 | 挂 1 条 |
| 证据 SQL 的 `'inserted'` → `'updated'` | 库级证据测试 | 挂 1 条 |

外加双门禁分开跑：`npm run typecheck` EXIT=0；`model-transition-gate.test.ts` 18/18；
`source-backfill-evidence.test.ts` 1/1。

## 6. 未验证项 / 边界

1. **真实 iOS 端同步已在 2026-10-11 07:52–08:06 实测通过**（作业
   `web_import_mv31uur8_dc36d920-dcfb-4e68-ac36-bd437ffb45bd`）：`succeeded` /
   `"导入与模型重算完成"` / `importMode:"full"` / `featuresRecomputed:282`，耗时 781 s。
   主库 `health_records` **183,556 → 512,180**，`min(start_at)` = `2020-02-26T11:43:38.000Z`，
   `active_model_run` 切至 `model_run_24957b49-…`（激活时刻 08:02:07），`rai.sqlite` = 2,165,141,504 B。
   修复要经 API 生效必须**重启 API** —— `new ImportWorker(...)` 位于 `apps/api/src/server.ts:463`
   （进程内），而拼接 `--import-batch` 的代码在 `apps/api/src/import-worker.ts:653`。
   已于 2026-10-11 06:43 重启。
   ⚠️ **App 侧会显示「更新尚未完成」——那是感知失配，不是失败**：App 的轮询在 08:00:48 挂起、
   08:06:01 才回前台（恰在完成那一刻），没有看到终态，于是 `TechSyncStatus.swift` 走
   `phase != "succeeded" || hasPendingTask` 分支显示「更新尚未完成，可在设置查看状态。」。
   iOS 轮询上限是 30 分钟（`apps/ios/RAI/HealthKitSync.swift:1694`），本次只用 13 分钟，不是超时。
   收尾动作：在 App 内点「继续同步」（jobId 已落盘，服务端会回 `succeeded`，pending 任务即清）。
2. **「零删除」证人尚未被生产数据触发过**：线上历史账本只有 `inserted` / `updated`，
   `import_entity_changes(change_type='removed')` 与 `import_entity_tombstones` **全库为 0**。
   即：今天真正起判别作用的是 `earliestInsertedIsNewGlobalEarliest` 这一条成员判定；
   删除证人由代码结构保证（删除路径必写 `removed` 行 + 墓碑），但**未经真实删除事件演练**。
3. **`baselineReferenceStartAt` 恒为 `undefined`**（`defaultRaiModelConfig`），故既有 rebase 通道
   仍不可达；本通道不依赖它。
4. **报告缺陷（本轮附带发现，未修）**：解析器自报的 `dirtyFromAt` 是 **workout 级**，
   而 API `analyze` 实际使用的是**记录级**最早边界。报告里的脏边界 ≠ 重算实际用的边界。
5. 服务器遗留复跑现场 `/var/lib/rai/var/repro/`（2.6 GB，含 2.07 GB staging 与 615 MB 副本），
   以及 `var/` 下 5 份 `.replaced.<uuid>`（各 615 MB，失败不回收）。可清理，未擅自删除。
6. **全量 `npm test` 有 1 条失败，判定为预存在的负载型假失败，非本批引入**：
   `apps/api/test/server-runtime.test.ts` 的
   `runtime status includes persisted prediction work and restore recovers recompute jobs`，
   断言 `notEqual(restoredStatus,'queued')`，受 **10 秒硬窗口**（`deadline = Date.now()+10_000`）
   保护。归因三件套：① 隔离单跑 **30/30 pass**（该用例为 `ok 6`）；
   ② `/tmp/rai-test-baseline.log`（2026-10-10 17:03，早于 `cebb0dc` 提交）已是 `not ok 502`，
   `/tmp/rai-npmtest.log`（2026-10-10 22:07）亦 `not ok 509` ⇒ 改动前即间歇失败；
   ③ `git grep importBatchId` 全仓只有 `packages/application/src/services/recompute-pipeline.ts:311`
   一处真正读取，`sourceBackfillEvidence` 只做只读 `SELECT`，`cebb0dc` 未触碰任何 `recompute_jobs`
   或恢复相关文件。
   同轮 node 段 1544 ok / 1 not ok，web vitest 段全过。
