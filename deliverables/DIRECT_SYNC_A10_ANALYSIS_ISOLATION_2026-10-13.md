# §14.2 A10「分析失败隔离」的行为级证据（2026-10-13）

依据：`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §14.2 A10、[PR4 落地设计 §6/§8.5](../docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md)。

**判据（逐字取自矩阵）**：raw 接收已成功仍保持成功；分析失败显示独立状态，重试只计算，
不要求重新导出、不重新备份或复制库。证据要求：分析故障注入、原回执不变、重试调用追踪。

**为什么现在才能测**：A10 的前提是"分析任务真的会被登记"。在这之前直连车道的
`recompute_jobs` 计数被断言为 **0**（登记属 PR4 步骤 2），连"分析失败"这个状态都产生不出来 ——
验收清单里 A10 那一行的"未覆盖"结论就是这么来的。2e（`34780e3`）之后登记是真的。

---

## 用例

`apps/api/test/analysis-failure-isolation.test.ts`（1 条，约 3 s）。

两条**独立通道**：原始接收走真实 `ImportWorker`（真实排队 + 子进程 + 事务，否则"原回执不变"
没有意义）；分析走进程内 `RaiApplicationService.runNextJob()`（与 API 消费者同一入口）。
故障注入落在**真实写点**上：

```sql
CREATE TRIGGER a10_fail_analysis BEFORE INSERT ON model_runs
  BEGIN SELECT RAISE(ABORT, 'injected analysis failure'); END
```

——失败发生在 CPU 已经算完、正要写候选的时候，不是 mock 出来的。

| 判据 | 断言（实测全绿） |
|---|---|
| ① 原回执不变 | 失败前后 `readImportReceipt(batch)` **逐字段 deep-equal**（两批都查）；`health_records`/`workouts`/`training_sessions` 计数不变；`import_batches` 计数不变 |
| ② 失败独立可见 | `recompute_jobs.status='failed'` 且 `error_json` **点名注入原因**（证明失败确实是注入的那一个）；**读侧** `RaiReadStore.jobs()`（`GET /v1/jobs` 用的就是它）报 `status='failed'`、`error={code:"task_failed", message:"任务执行失败"}`；同一次读取里前一个成功的任务仍是 `succeeded`；`active_model_run` 与 `dashboard().activeModel` 仍指向成功的那次 release |
| ③ 重试只计算 | 走 API 的真实重试入口（`POST /v1/model-runs` → `enqueueFullRecompute`）后再跑消费者：批次/事实/会话计数不变、回执仍逐字段不变、`var/` 无备份与整库候选、发布指针**移动到一个新的** release（不是复用失败的候选） |

## 突变验证（4 处，逐个跑）

| # | 突变 | 结果 |
|---|---|---|
| 1 | `fail()` 用任务行的 `model_run_id` 激活候选 | **不变红** —— 注入点（`INSERT INTO model_runs`）发生在 `setJobRunIds(..., modelRunId)` **之前**，该列还是 NULL，突变体是空操作。**如实记录：这条突变选错了靶子，不是用例没牙** |
| 2 | `fail()` 把排队中的回执改写成 `analysisStatus:"failed"`（PR4 §6 表里写明的靶子） | 转红（"分析失败不得改写原始回执"） |
| 3 | `fail()` 删掉最新批次行 + 把发布指针指向不存在的 run | 转红（批次计数 + "旧 release 必须仍然可读"） |
| 4 | `enqueueFullRecompute` 里插入一个批次行（模拟"重试重新接收"） | 转红（"重试不得产生新的批次行"） |

## 如实标注的边界

- ⚠️ 回执里的 `analysisStatus` 是**写入时刻**的事实（`queued`），消费者**不得**改写它。
  "分析失败"这个独立状态今天由 `recompute_jobs` + `/v1/jobs` 承载；读侧的**派生**投影
  （把事实版本与分析版本合成一个 `freshness`）属 **PR5 S3/S4**。本用例钉住的是
  "两者不会互相污染"—— 那正是那个投影能成立的前提。
- ⚠️ API 层的失败文案是**故意通用**的（`task_failed`），原始原因只留在 `recompute_jobs.error_json`。
  这是既有产品决定，本轮不改；PR6 会统一客户端文案。
- ⚠️ 本用例不覆盖并发面（分析进行中接收新批次），那是 A11 的范围。

## 对验收矩阵的影响

§14.2 的 `未覆盖` 从 **2 项（A10、A11）减为 1 项（A11）**。
