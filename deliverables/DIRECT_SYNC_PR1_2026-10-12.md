# 直接增量同步：PR1 实施与验收记录

日期：2026-10-12，Asia/Shanghai。代码基线：`7a6408a`（与设计文档审查基线一致）。
设计依据：[docs/SQLITE_DIRECT_SYNC_DESIGN.md](../docs/SQLITE_DIRECT_SYNC_DESIGN.md) §13 PR1、§10.1、§14.1。

**状态：PR1 已实施并完成验收（详见下）。PR2–PR6 未开工。本批未提交。**

---

## 1. PR1 范围（文档 §13 原文对应）

| 文档要求 | 本批是否落地 | 证据 |
|---|---|---|
| 明确 raw receipt | ✅ | `packages/contracts/src/direct-sync.ts` 的 `DirectSyncReceipt` |
| 明确分析版本（状态分离） | ✅ | `IngestStatus` / `AnalysisStatus` 两个独立枚举 |
| 明确外部备份责任 | ✅ | `docs/OPERATIONS.md` 新增「外部一致性备份的责任边界」 |
| 建立验收测试骨架 | ✅ | `apps/api/test/direct-sync-prohibited-operations.test.ts`（5 条用例，含阳性对照） |
| **不**先删 backup 函数让 null 误入全量 import | ✅ 遵守（未改动 `createCurrentBackup` 及其调用点） | `git diff apps/api/src/import-worker.ts` 为空 |

---

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/direct-sync.ts`（新增） | §10.1 状态枚举、`DirectSyncReceipt`、§14.1 禁止操作清单 + `unobservableProhibitedOperations()` 自洽判据 |
| `packages/contracts/src/index.ts` | 导出上面的模块（`contracts` 是 API 与 storage 共同依赖的最小公共层） |
| `packages/api-contracts/src/index.ts` | `ImportJobResponse.summary` 新增**可选** `directSync` 字段（缺省 = 旧候选路径，老客户端不破） |
| `apps/api/src/data-only-import.ts` | 直连车道真实产出 §10.1 回执；`rawGeneration` 提为单一变量，消除"解析器 generation / 回执 rawGeneration"两处字面量分叉 |
| `apps/api/test/direct-sync-prohibited-operations.test.ts`（新增） | §14.1 守卫：结构自洽 + 行为断言 + 阳性对照 + 回执状态 + 重启恢复 |
| `docs/OPERATIONS.md` | 外部备份责任边界（WAL 一致性、同恢复边界、`datasetEpoch`、运维负责保留） |

⚠️ 未触碰：`apps/api/src/import-worker.ts`、任何迁移、`apps/ios`、冻结的窄屏 Web。

---

## 3. 验收证据（实跑，非声明）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | `EXIT=0` |
| 守卫测试 | `node --import tsx --test apps/api/test/direct-sync-prohibited-operations.test.ts` | **5/5 pass** |
| 既有直连回归（隔离单跑） | `data-only-import-queue.test.ts` | **5/5 pass** |
| 文档链接 | `npm run check:docs` | 34 文件 / 331 链接 / 0 问题 |
| 文档行号引用 | `npm run check:doc-refs` | 越界 0 / 漂移 0 / 锚空行 0 |

### 3.1 突变验证（纪律：跑绿 ≠ 断言有效）

守卫不是"看起来对"，三处突变全部被**精确捕获**：

| 突变 | 预期 | 实测 |
|---|---|---|
| 清单里把 `createCurrentBackup` 改名 | 结构用例转红 | ✅ 红：「声明的 workerMethod `createCurrentBackupRenamed` 在 ImportWorker 上不存在」 |
| 回执里 `analysisStatus` 改成 `published` | 回执用例转红 | ✅ 红：`actual 'published' - expected 'not_required'` |
| 直连车道里插一行 `await this.checkpointDatabase(...)` | 行为用例转红 | ✅ 红：「直连车道触发了 §14.1 禁止操作：**forced-wal-truncate**」（点名到条目） |

三处突变随后已全部回退，`git diff apps/api/src/import-worker.ts` 为空。

### 3.2 一次假失败（已归因）

并行 4 个测试文件 + 本机 load 13–15（6 核）时，`data-only-import-queue.test.ts` 的一条 30s 等待超时被记成失败。
隔离单跑通过。归因：**资源争用，非代码**。全量门禁必须独占跑（这与 `MEMORY.md` 的既有判据一致）。

---

## 4. 覆盖边界（必须如实标注）

`§14.1` 要求的适用场景：首次历史分页、手动同步、自动同步、后台续传、删除-only、混合评分批次、大包分批、任务重启。
**本批只守住了其中的「有界 record-only 增量」与「任务重启」**。其余场景此刻仍走旧候选链路，**必然**踩禁止操作。

这不是缺口遗漏，而是 PR1 的定位：文档 §13 明确 PR1 只"建立骨架"，真正的切路在 PR6。
`direct-sync-prohibited-operations.test.ts` 里"旧候选路径会触发守卫"被写成**通过的用例**，它记录的就是尚未迁移的那一半。

---

## 5. PR2–PR6 的真实改动面（数出来的，不是估计）

| PR | 必须重写的生产代码 | 实测体量 |
|---|---|---|
| PR2 同库事务接收全部类型 | `apple-health-parser.ts`(795) delta 路径 + `storage-sqlite/database.ts`(3270) + `apps/api` worker | 数千行 |
| PR3 版本化事实与路线 | 新增 v34+ 迁移（稀疏 history / generation / route version）+ `canonicalize-nights.ts`(315) | 跨 schema |
| PR4 分析输入与短写调度 | `packages/application/src/services/recompute-pipeline.ts` = **2431 行**（SQL/CPU 混合流程全拆）+ `TaskAdmissionScheduler` + 新 FactsReader | 2431+ |
| PR5 读侧一致性 | `packages/storage-sqlite/src/read/**`(2618) + `apps/api/src/data.ts`(1973) + `mobile-read.ts`(778) | **≈5400 行** |
| PR6 客户端状态与移除备份入口 | iOS（119 个 Swift；`SyncTaskState.swift`、`HealthKitSync.swift`）+ `deploy/upgrade.sh` + 维护/恢复入口 | 跨端 |

### 5.1 为什么 PR2 不能单独交付（关键论证）

文档 §7 要求分析输入必须是**固定版本**：`FactsReader(G)` 从当前行 + 稀疏历史恢复固定 G 的事实。
今天的旧链路之所以正确，是因为它在**冻结的暂存副本**上算分析。
一旦去掉整库副本：

- 不引入 PR3 的 generation / 稀疏 history ⇒ 分析会读到"不断变化的当前表"，即 §7 明确禁止的状态；
- 用长读事务钉住输入 ⇒ 违反 §7「不长期保持跨分钟 CPU 计算的读事务」；
- 提交 raw 后只登记分析任务而不跑分析 ⇒ 分析永远不更新，违反 §1.5「读取不能把旧分析标成最新」。

⇒ **PR2+PR3+PR4+PR5 是正确性的最小不可分单元**，PR6 才是切路。这与文档 §13 的排序一致。

### 5.2 两条环境阻塞（文档自己写死，本机做不到）

- §14.5：真机 HealthKit 自动增量、续传、有效游标保持的手动验收 —— 需要真机。
- §14.3/§14.4：P01–P06 必须在**目标云机**上实测，且文档禁止用开发机空库替代。

⇒ 「PR1–PR6 全部完成 + 完整测试通过」在当前环境下**不可达**。诚实做法是逐 PR 交付 + 明确标注未测项。

---

## 6. 建议的推进方式

1. **按 PR 逐个落地、逐个给证据**（PR2 → PR3 → PR4 → PR5 → PR6），PR3 的迁移方案先给确认再执行。
2. 每个 PR 结束跑**针对性**测试；全量门禁按小唐要求集中在最后跑一次，但需知情：这与纪律 #10「每个提交可用」有张力，代价是中间节点的坏状态要到最后一轮才暴露。
3. §14.2 的 A01–A18 矩阵**尚未**接入 `scripts/check-acceptance-matrix.mts`（它目前只解析 `docs/ALGORITHM.md` §16.1）。建议在 PR6 接入——提前接入会立刻产生 15 条"declared gap"，反而变成掩盖缺口的垃圾桶。

## 7. 建议优化项（未自动修改）

- `scripts/check-acceptance-matrix.mts` 目前只覆盖 §16.1。若要覆盖本文档 §14.2，需扩展解析目标并在 PR6 一次性转绿。
- `apps/api/src/import-worker.ts` 的 legacy 分支（`createCurrentBackup`→`copyFile`→CLI→`activateDatabase`）在 PR6 前保持原样，但它与直连车道共用 `ImportJobResponse.summary`，两套 `importMode` 语义需在 PR5 读侧改造时统一。
