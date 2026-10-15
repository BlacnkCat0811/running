# 导入与落库链审查报告（新产出，非复述）

> ⚠️ 本报告是**本次新做**的审查，不是 team-lead 要求的「完整原文重新输出」—— 那份报告在我的会话中不存在（详见交付说明）。分级口径、章节结构按 team-lead 指定格式给出。

审查对象：**导入（`local-ingest` / `direct-sync-ingest` 入口）→ 落库（`RaiDatabase` 写入事务、去重、幂等、回滚）** 这一条链。

审查时间：2026-10-15。工作区：`/Users/ta/running`。

---

## 一、发现清单

### 🟡-1　data-only 车道的单测用「实现自己的摘要函数」算载荷身份，跨车道规则未对齐

**位置**
- 实现：`apps/api/src/data-only-import.ts:120`（用 `digestHealthKitRecordSnapshot` 复核）
- 生产准入：`apps/api/src/import-worker.ts:989`（`computeImportPayloadSha256` → `digestHealthKitExportContent`）
- 单测夹具：`apps/api/test/data-only-import.test.ts:65-68`
- 同链路的既有规则：`apps/api/test/direct-sync-ingest.test.ts:109-113`

**证据**
1. `data-only-import.test.ts:65` 里 `payloadSha256` 是用 `digestHealthKitRecordSnapshot(...)` 现算的 —— 也就是**被复核方自己用的那个函数**，而不是生产端 `computeImportPayloadSha256`。
2. 姊妹车道明确立过相反的规则，并写明理由（`direct-sync-ingest.test.ts:109-113` 原文）：
   > 🔴 摘要必须用**生产端同一个函数**算（worker 的 `computeImportPayloadSha256`），包括路由内容。从前这里手写的是"XML+manifest"配方，与生产不一致 —— 于是"带 GPX 的载荷"在接收器里会被判成"载荷已变更"而硬失败，而这条用例当时**看不见**那个缺陷，因为它自己也在用那份错的配方（**两边一起错 ⇒ 假绿**）。
3. 对照测试：`apps/api/test/data-only-import-queue.test.ts:132` **已经**改用生产函数 `computeImportPayloadSha256`；`data-only-import.test.ts:65` 没有。
4. 我实跑探针比对两个函数（见「二、闭环核验」第 1 条）：**无 `workout-routes/` 时两者字节相同**（`8bfe50c0…`），**一旦存在 `workout-routes/**` 就分叉**。
5. 让两者在 data-only 车道上恰好相等的，**只有** `data-only-import.ts:107` 那句「目录里除了 xml + manifest 不允许有任何其他条目」：
   ```ts
   || entries.some((name) => ![xmlName, "sync-manifest.json"].includes(name))) return null;
   ```
   这条闸门与摘要选择相距 13 行、语义上互不相干。

**影响**
今天**没有**真缺陷（闸门兜住了）。风险是耦合性：`data-only-import.ts:124` 的比较在不等时**抛错**（`throw new Error("Data-only payload changed after admission")`），不是回退 —— 与姊妹车道当初那个用户可见硬失败的形态完全一致。一旦有人放宽 `:107` 的目录形状闸门（例如为别的需求允许 `workout-routes/`），缺陷立刻复现，而现有单测因为「两边一起错」**不会红**。

**最小复核**
```bash
node --import tsx --test apps/api/test/data-only-import.test.ts
```
再把 `data-only-import.test.ts:65` 的 `digestHealthKitRecordSnapshot(...)` 换成 `await computeImportPayloadSha256(inputPath, {...})`，在夹具里补一个 `workout-routes/x.gpx`，观察是否出现 `Data-only payload changed after admission`。

**建议方向**
把 `data-only-import.test.ts:65` 对齐 `direct-sync-ingest.test.ts:114`（改用 `computeImportPayloadSha256`）。这把「准入摘要 == 复核摘要」从**依赖远处闸门的巧合**变成**被测试钉住的契约**。

**置信度**　高（代码事实与实测均为直接证据；「是否为需修缺陷」的判断为中，属稳健性/可维护性问题）

---

### 🟡-2　`payloadSha256` 的方法文档与 S3.1 收口后的实际行为直接矛盾

**位置**　`apps/api/src/import-worker.ts:980-986`（文档）vs `apps/api/src/import-worker.ts:667-671`（行为）

**证据**
- `:980-986` 的方法注释写：
  > A payload that cannot be read is *not* a pre-flight failure: the import itself will report the real problem with a proper message. **Failing here would turn an optimisation into a new way to fail an import.**
- `:667-671` 的实际代码：
  ```ts
  if (payloadSha256 === null) {
    // S3.1 收口：载荷摘要算不出来（输入不可读）⇒ 显式失败（带码），不再是回退理由。
    laneRejections.push({ ... reason: "payload_identity_unavailable" ... });
    throw new ImportLaneRefusal(["payload_identity_unavailable"]);
  }
  ```
- 且该 `ImportLaneRefusal` 在 `:764-784` 被处理为**终态失败**（`job.status = "failed"` + `failureCode`），不是回退。

**影响**
文档描述的正是收口**之前**的语义，且它把新行为明确称为「anti-pattern」。后续维护者若照文档行事会「修回」这个行为 —— 把已收口的显式失败改回静默回退，重新打开 S3.1 想关掉的缺口。`detectUnchangedPayload` 的调用点（`:613-617`）共用同一方法，改动面不止一处。

**最小复核**
`Grep "not a pre-flight failure" apps/api/src/import-worker.ts` → 命中 `:983`；`Grep "payload_identity_unavailable"` → 命中 `:669`、`:671`。

**建议方向**
改写 `:983-986` 的注释，说明 S3.1 收口后 `null` 已被调用方升级为带码终态失败，并点明这是**刻意的**语义变更（与 `:667` 的注释同源），避免两处注释互相拆台。

**置信度**　高（两侧均为原文事实；影响判断为「文档误导导致的回归风险」，非当前功能缺陷）

---

### 🔡-1　`unchangedWorkouts` 被挪用为「全表会话总数」，且在写事务内做全表 `COUNT(*)`

**位置**　`apps/api/src/direct-sync-ingest.ts:761`、`apps/api/src/data-only-import.ts:181`

**证据**
两处均为同一条语句，位置都在**已开启的写事务内**：
```ts
unchangedWorkouts: Number(db.prepare("SELECT COUNT(*) AS n FROM training_sessions").get()!.n),
```
而同一份 `summary` 里 `insertedWorkouts` / `updatedWorkouts` / `removedWorkouts` 都是本批增量（`direct-sync-ingest.ts:754-760` 的 `countWorkoutChanges`）。字面上 `unchangedWorkouts` 应是「本批未变化的会话数」，实际写的是**全库会话总数**。

**影响**
- 语义：回执字段名与取值不一致。同名键在 `:634`（早退路径）里是 `preflight.unchangedWorkouts`，而在直连路径里是总数 —— 同名字段两种口径。
- 成本：在 `beginCallerTransaction()` 之后、`commitCallerTransaction()` 之前做一次无 `WHERE` 的 `COUNT(*)`，属 O(N) 且在持有写锁期间。本环境没有 506 MB 级主库，**我无法给出实测耗时**（见「三、待复核线索」）。

**最小复核**
`Read apps/api/src/direct-sync-ingest.ts --offset 754 --limit 12`；`Read apps/api/src/data-only-import.ts --offset 176 --limit 10`。在真实尺寸主库上计时：把该语句替换为常量，比对 `performance.stagesMs.directSyncApply` 差值与 `training_sessions` 行数。

**建议方向**
若该字段确实要表达「总数」，改名或另立字段（回执消费者只有一处能分清）；若确实要表达「本批未变化数」，则现有取值是错的。无论哪种，把这条 `COUNT(*)` 移出写事务（提交后结算）以缩短持锁窗口。

**置信度**　高（语句与位置为原文事实）／成本影响**未知**（本环境无法实测，故不升级分级）

---

## 二、闭环核验（曾疑似缺陷、核查后判定「不成立」的项）

### 1. 「准入摘要与复核摘要同源」—— 实测成立，但理由不在摘要函数本身

**判定：不成立（当前无缺陷）。**

`direct-sync-ingest.ts:468-472` 用长注释记着一次真实事故：接收器曾用只算 XML+manifest 的配方复核，而 worker 准入用了折进 `workout-routes/**` 的配方，导致**带 GPX 的载荷硬失败**。该处现已改用 `digestHealthKitExportContent`（`:473`）。

我实跑探针独立验证了两个函数的等价边界（`node --import tsx`，临时脚本，已删）：

| 场景 | `digestHealthKitExportContent` | `digestHealthKitRecordSnapshot` | 相等 |
|---|---|---|---|
| 仅 `export.xml` + `sync-manifest.json` | `8bfe50c0739dd254918c5c70a14bce3dcbe732b963eb71dcc62ced3df9f624bd` | 同左 | ✅ |
| 追加 `workout-routes/r1.gpx` | 摘要**变化** | 不变 | ❌ |

即：两个函数**不是**通用等价，只是在「无路由」这一子集上重合。data-only 车道恰好只接受无路由载荷（`data-only-import.ts:107`），所以落在等价区。**这一点正是 🟡-1 的成因**。

### 2. 「无事务时 `rollbackCallerTransaction()` 会不会炸」—— 不会，是被测试钉住的契约

**判定：不成立。**

`direct-sync-ingest.ts` 的 `catch` 在**任何**异常下都调 `store.rollbackCallerTransaction()`（`:842-843`），但重放早退路径（`:651-662`）的 `throw`（`:654`）发生在 `beginCallerTransaction()`（`:669`）**之前** —— 即存在「回滚一个从未开启的事务」的调用。

核查结论：这是**受支持的用法**。`packages/storage-sqlite/test/transaction-owner.test.ts:238-239` 明确断言：
```ts
assert.throws(() => caller.commitCallerTransaction(), /No caller transaction is active/);
assert.doesNotThrow(() => caller.rollbackCallerTransaction());
```
提交必须报错、回滚必须能在 `finally` 里安全调用。故 `:843` 无缺陷。

---

## 三、待复核线索（未闭环，未计入发现清单）

1. **流式摘要的 1024 字符尾缓冲边界**（低置信度，理论性）
   `import-sources.ts:237-248` 的 `hashXmlWithoutExportDate` 以固定 `EXPORT_DATE_HASH_TAIL = 1024` 保留尾部再冲刷。若某个 `ExportDate` 标签长度超过 1024 字符，其前缀会先被哈希、随后才被剥离，导致流式结果与 `stripExportDate(全文)` 不等。现实导出中标签极短，故我**未**将其列为发现。复核方式：构造 >1024 字符的 `ExportDate` 标签，断言 `digestHealthKitRecordSnapshot` 与 `digestHealthKitExportContent` 是否仍相等。

2. **`unchangedWorkouts` 的 O(N) 成本量级**（未知）
   本环境无 506 MB 级主库，无法实测（见 🔡-1）。

3. **`data-only-import.test.ts` 夹具是否覆盖真实 worker 准入路径**
   该文件直接调 `applyDataOnlyImport`（单元级），`data-only-import-queue.test.ts` 才走队列。两者的 `payloadSha256` 来源不同（前者 `digestHealthKitRecordSnapshot`、后者 `computeImportPayloadSha256`），是否有一条端到端用例能同时守住两张闸门，我未逐用例核实。

---

## 四、覆盖声明

**已实跑**
- `node --import tsx --test apps/api/test/data-only-import.test.ts apps/api/test/direct-sync-ingest.test.ts` → **43 pass / 0 fail**（duration ≈ 44.3 s）。
- 临时探针脚本比对两个摘要函数（结果见「二、闭环核验 1」，脚本已清理）。
- `apps/api/test/import-worker-direct-sync.test.ts:242-245` 的事故记录已逐字阅读并采信为「同类缺陷曾 materialized」的证据。

**已逐行读码**
`apps/api/src/direct-sync-ingest.ts`(862 行，全文)、`apps/api/src/data-only-import.ts`(248 行，全文)、`apps/api/src/import-publication.ts`(119 行，全文)、`apps/api/src/import-payload-identity.ts`(223 行，全文)、`apps/api/src/direct-sync-plan.ts`(97 行，全文)、`apps/api/src/import-sources.ts`(节选：`:230-310` 摘要函数区)、`apps/api/src/import-worker.ts`(节选：`:590-790`、`:980-1070`)、`apps/api/test/direct-sync-ingest.test.ts`(节选 `:105-130`)、`apps/api/test/data-only-import.test.ts`(节选 `:40-100`)、`apps/api/test/import-worker-direct-sync.test.ts`(节选 `:225-280`)、`packages/storage-sqlite/test/transaction-owner.test.ts`(节选)。

**明确未覆盖（本次结论不外推到这些区域）**
- 旧候选链路（整库备份 → 暂存副本 → CLI 导入 → 换库）：`import-worker.ts:744-748` 声明其运行期调用链已删除，我**未**验证该删除的完整性。
- 分析消费端：`recompute_jobs` 的消费者（`import-analysis-thread.ts` / `recompute*`）是否真正按 `directSync.analysisStatus = queued` 推进，未审。
- HTTP 层：`POST /v1/imports/inspect` 对 `preflightDirectSyncPayload` 的使用、状态码与 `bounds/actual` 透出，未审。
- 并发/多写者：单写者假设、`busy_timeout` 争用、迁移与热路径竞态，未审。
- iOS 侧：`DirectSyncBatchBudget` 与 8 MiB / 64 MiB 上界的收敛是否一致，未审。
- `packages/health-export-parser` 的解析器本体（`parseAppleHealthXml`、`importGpxRoutes`、`canonicalizeNightsForWindow`）只读了接口与断言点，未做实现级审查。
- 未运行 `npm run typecheck` 全量门禁。

**未发现 🔴**
本次审查**没有**发现「当前会导致数据错误或用户可见失败」的缺陷。最高分级为 🟡（稳健性 / 文档一致性）。这不等于「已证明无严重缺陷」—— 受上述未覆盖区域限制。
