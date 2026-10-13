# 直接增量同步 PR4-2e：放开 `deltaMode: "full"`（2026-10-13）

依据：[PR4 落地设计](../docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md) §7（三步上线顺序的第 3 步）、
§8.4（本轮实测证据）、[PR2/PR3 设计](../docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md) §6b。

**一句话**：直连车道从"只接白名单记录增量"扩到"接 Workout / 评分类型 / 显式删除 / GPX"，
并且**真的接上了**统一接收器（不再掉回"整库备份 + 换库"的旧候选链路）。
这一步的难点不是改判据，而是"判据放开 ≠ 车道接上"——所以本轮的判据全部是**端到端**的。

---

## 1. 改了什么

| 项 | 位置 | 说明 |
|---|---|---|
| 车道判据 | `apps/api/src/direct-sync-plan.ts` | `deltaMode`：`"record-only"` → `"full"`。含义是"车道**能装下**任意增量载荷"，**不是**"每批都要分析"——批次是否需要分析由账本决定 |
| 车道接线 | `apps/api/src/import-worker.ts` | record-only 快通路拒收 → 投递 `direct-sync` 任务（统一接收器）→ 两条都拒收才回退旧链路 |
| 计时账本 | `packages/api-contracts/src/index.ts` | `ImportStage` 新增 `directSyncApply`（两条子车道分开计时） |
| 载荷身份 | `apps/api/src/direct-sync-ingest.ts` | 🔴 **修掉一个真缺陷**（见 §3） |
| 输入目录 | `apps/api/src/direct-sync-ingest.ts` | `inputTreeAllowed` 收紧到与摘要/导入器**逐项对齐** |

顺序不可交换：**先 record-only（入口判据更严），再统一接收器，最后才回退旧链路**。
反过来会让 record-only 的两道闸门（类型白名单 + 基线合同戳）失去意义。

## 2. 实测

| 用例 | 结果 |
|---|---|
| `apps/api/test/import-worker-direct-sync.test.ts`（**新**，端到端） | **2/2** |
| `apps/api/test/direct-sync-prohibited-operations.test.ts`（新增 full 车道 §14.1 用例） | **7/7** |
| `apps/api/test/direct-sync-ingest.test.ts`（接收器，含 GPX 用例改用生产摘要函数） | **9/9** |
| `apps/api/test/direct-sync-plan.test.ts` + `direct-sync-analysis-registration.test.ts` | **6/6 + 6/6** |

端到端断言（真实排队 → 真实子进程 → 真实事务）：事实落库、`training_sessions` 生成、
`recompute_jobs` 恰好一条（`job_type='import'`、`status='queued'`、载荷 mode `direct_sync_analysis`、
两个代次都为 1、`dirty_json.reasons` 含 `workout_present`）、回执 `analysisStatus='queued'`
且与终态摘要逐字段一致、`import_batches.summary_json.analysisJobId` 对上、
**无备份 / 无换库 / 主库 inode 不变 / 无子进程 CLI**。

§14.1 在**更宽**的车道上同样"全 0"，且投递序列被钉死为 `["data-only", "direct-sync"]`。

## 3. 同轮发现并修掉的真缺陷（本轮最有价值的产出）

**载荷身份摘要两侧不同源**：

- worker 准入用的是 `computeImportPayloadSha256` → `digestHealthKitExportContent`（折进 `workout-routes/**` 的路由内容）；
- 接收器复核用的是 `digestHealthKitRecordSnapshot`（**只算 XML + manifest**）。

⇒ 任何**带 GPX** 的载荷都会在 `Direct sync payload changed after admission` 这句**错误结论**上
**硬失败**（不是回退，是用户可见的失败），而 GPX 正是这条车道要接的类型之一。

它不是"设想中的风险"：修复前先写测试复现（`import-worker-direct-sync.test.ts` 第二条），
突变验证（把复核退回旧配方）时该用例转红、无 GPX 的那条仍绿 —— 形态完全对得上。

⚠️ 附带教训：`direct-sync-ingest.test.ts` 的夹具原先**自己手写**了同一份摘要配方（也是"XML+manifest"），
所以两边一起错 ⇒ **假绿**。已改为直接调用生产函数 —— 于是这条用例同时守住了
"准入摘要 == 接收复核摘要"。

同轮还收紧了一处不一致：`inputTreeAllowed` 从前允许**任意位置**的 `.gpx`，而那些文件既不进摘要、
也不会被 `allGpxRelativePaths` 导入 —— 属于"被允许、但没被证明有读过"的退化形态。现在只允许
`workout-routes/**/*.gpx`。

## 4. 突变验证（3 处，全部被精确捕获）

| # | 突变 | 结果 |
|---|---|---|
| 1 | worker 不再投递 `direct-sync`（判据放开但没接上） | 两条端到端用例转红：载荷掉回旧候选链路并撞上"不得整库备份"的守卫 |
| 2 | 接收器复核退回"只算 XML+manifest" | **带 GPX** 的用例转红，无 GPX 的仍绿 |
| 3 | 回执恒写 `not_required`（假新鲜） | 两条端到端用例转红 |

## 5. 判据语义的变化（必须记下来，否则后人会照旧口径"修"回去）

**回执的 `analysisStatus` 从"车道级事实"变成"批次级事实"**：

- record-only 快通路（入口证明结构上碰不到分析）⇒ 恒 `not_required`，且 `recompute_jobs` 必须为空；
- 统一接收器 ⇒ 按账本分类取 `queued` / `not_required`，且提交前**双向断言**：
  需要分析却没有任务/绑定不符 ⇒ 抛错；声称 `not_required` 却登记了任务 ⇒ 抛错。

旧的"直连车道不得登记任何分析任务"断言已按这个口径改写，历史记录保留在 PR2/PR3 设计里不改写。

## 6. 如实标注的边界

- ⚠️ **§14.3 P01–P06 未测**：需要目标云机，本环境给不了。
- ⚠️ **首次历史分页与大包分批仍走旧链路**（§5.2 分片计划未实现，超限直接回退）⇒
  §14.1 的"全 0"**不能**推广成"整份清单已通过"。
- ⚠️ **PR5 的 S3–S11 未做**：已删事实不再进事实侧（S1/S2 已落地），但"当前事实"与"已发布分析"
  仍在同一个响应里；§9.1 要等读侧拆分才彻底消失。
- ⚠️ 真机 HealthKit 上传验收（A12 截图等）在本环境不可达。

## 7. 下一步

PR4 步骤 3（短写租约拆分，A11）与步骤 4（局部 canonical 接入）互不依赖，可并行；
PR5 S3（`versions`/`freshness` + 绑定列可读）是读侧一致性的第一块。
