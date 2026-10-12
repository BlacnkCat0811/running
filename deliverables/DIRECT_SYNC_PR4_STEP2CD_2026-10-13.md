# 直接增量同步 PR4 步骤 2c/2d：统一接收器 + 同事务登记分析任务（2026-10-13）

依据：[PR4 落地设计](../docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md) §2、§7（含 §7.1 修订、§7.2 新增前置）、
[PR5 落地设计](../docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md)。

**范围**：`apps/api/src/direct-sync-ingest.ts` —— 直连车道的统一原始接收器
（2c：写守卫按表分类 + Workout/删除/GPX 接收；2d：同事务登记分析任务 + 代次写入方 + 回执 `queued`）。
**不在本轮**：放开 `deltaMode: "full"`（2e）—— 它多了一个前置，见 §4。

---

## 1. 一个事务里做完的事

`RaiDatabase.open({ transactionOwner: "caller" })` → `PRAGMA synchronous=FULL` →
`beginCallerTransaction()` → 解析（`callerOwnedTransaction: true`，批次边界是 SAVEPOINT）→
GPX 路线（`importGpxRoutes`）→ 训练会话**局部**规范化 → 代次递增 → **登记分析任务** →
批次/清单/持久回执 → 回读断言 → `commitCallerTransaction()`。任何一步失败：整体回滚。

## 2. 写守卫：按**表**分类，且 fail-closed

`INGEST_TABLE_DISPOSITIONS` 给生产 DDL 的**每一张表**表态（`ingest` / `analysis`）。
`analysis` 类表（`model_runs` / `feature_runs` / `active_model_run` / `ability_assessments` …）
装 TEMP 触发器一律 `RAISE(ABORT)`；**出现未表态的新表时守卫拒绝安装**（不是默认放行）。
另有"事实写入全程记账 + 提交前逐条核对账本"的断言。

## 3. 登记与回执一致（不是"回执这么写而已"）

- `analysis-required` ⇒ 同事务 `enqueue("import", …, { mode: "direct_sync_analysis" }, bindings)`
  + `dependency_generation` 递增 + 回执 `analysisStatus: "queued"`；提交前断言任务存在、状态 queued、
  绑定代次等于刚递增的值。
- `record-only` ⇒ 不登记 + `not_required`；**若声称 not_required 却登记了任务，直接抛错**。
- `dependencyGeneration` 现在有真实写入方（`import_generations`），所以回执填 `String(n)`；
  `publishedReleaseId` 仍为 `null`（分析还没跑，说 published 是假话）。

## 4. 🔴 2e 的新增前置（本轮实测确认，非推断）

1. **删除会级联销毁已发布路线的版本内容**：
   `workouts --CASCADE--> workout_routes --CASCADE--> route_versions --CASCADE--> route_version_points`。
   实测：删一个 workout 后四张表全部归零（`published_route_version_id` 的 `NO ACTION` 拦不住级联）。
   这违反 §7「不让 raw FK 级联删掉不可变 release 所需的证据和路线」。
2. **删除之后旧负荷仍计入当天汇总**：那几条 SQL 不 JOIN `workouts`（PR5 设计 §1.2 清单 7）。

⇒ 2e 的前置是 PR5 的 **S1（事实侧排除已删）+ S2（`workouts.deleted_at` 软删标记）**，
两者必须在 2e 之前各自跑绿。已写入 PR4 设计 §7.2。

## 5. 实测

| 项 | 结果 |
|---|---|
| 新用例 `apps/api/test/direct-sync-ingest.test.ts` | **9/9** |
| 回归：parser 包 / API+storage | **146/146** / **80/80** |
| `tsc --noEmit`（pure + full） | EXIT=0 |
| 突变 3+1 处 | 全部被精确捕获（含一次**假绿**的发现与修补） |

新用例覆盖：record-only 无任务 / Workout 登记**并由真消费者跑完**（闭环）/ 删除-only /
GPX 路线（版本表 + 指针）/ 超限与杂物载荷不合格且零写入 / 写守卫逐条拒绝 + 事实表阳性对照 /
未表态表 fail-closed / **回执写入点故障注入 ⇒ 事实、批次、任务、账目、代次、回执整批回滚**
（清掉注入后还能重收同一载荷）/ §4.3 无资格 stamp 也可走直连。

**同轮修掉的两个"组件擅自开事务/提交"**（都是实测撞出来的）：
`PRAGMA synchronous=FULL` 必须在 `BEGIN` 之前（否则报 `Safety level may not be changed inside a
transaction`，**每一批**都失败）；`importGpxRoutes` / `native-record-writer` 直接调 `store.flush()`
在 caller 模式下抛错。新增公开的 `flushIfOwned()` / `rollbackIfOwned()`（按所有权提交），
并给两个规范化器加了 `{ callerOwnedTransaction: true }`。

## 6. 如实标注的边界

- ⚠️ 本模块**今天还没有生产调用方**：`planDirectSyncLane` 仍只给 `record-only`，生产走 data-only 快通路。
  放开是 2e，而它被 §4 的两条前置挡着。
- ⚠️ 分片（§5.2 大包）未实现：超限载荷**不合格回退旧链路**，不是"先收一半"。
- ⚠️ 路线上界（200 文件 / 32 MiB）是**临时值**，不是实测结论（P05 需目标云机）。
- ⚠️ §14.3 P01–P06 与 §14.5 真机验收在本环境不可达。

## 7. 下一步

PR5-S1+S2（事实侧排除已删 + 软删标记）→ PR4-2e（放开 `deltaMode: "full"` + A01 全类型验收）。
