# 直接增量同步 PR5-S1+S2：事实存在性判据与软删标记（2026-10-13）

依据：[PR5 落地设计](../docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md) D4、§3 清单 1/2、§5（S1/S2）。

**范围**：`workouts.deleted_at` 软删（迁移 v36）+ 事实侧唯一存在性判据 + 全部事实侧读路径接入。
**为什么先做这两步**：它们是 **PR4-2e（放开 `deltaMode: "full"`）的硬前置** ——
没有它们，删除批次一开闸就会 ①让旧负荷继续计入当天汇总、②级联销毁已发布路线版本的内容。

---

## 1. 写侧（S2）

| 改动 | 位置 |
|---|---|
| 新迁移 **v36 `workout_soft_delete_marker`**（只 `ADD COLUMN deleted_at TEXT`，可空、无默认值）+ 冻结校验和 | `packages/storage-sqlite/src/v36-migration.ts` |
| 两处 `DELETE FROM workouts` → 软删标记（`deleted_at` + 清 `is_canonical`/`canonical_group_id`） | `database.ts` 的 `finalizeImportGeneration` 与 `removeWorkoutsBySyncIdentifiers` |
| 权威载荷**恢复**语义：`insertWorkout` 的 upsert 擦掉 `deleted_at`；`observeImportEntity` 的"存不存在"按**事实**判定 | `database.ts` |
| 删除配额的分母只数仍在的训练 | `countImportableEntities()` |
| 已删训练不再被重新分组（否则会重新长出一个 session） | `canonicalize.ts` 的 `loadRunningWorkouts` |
| 等价性比对忽略墙上时钟列（删除这件事本身由 tombstone + 账目承载） | `apps/api/src/import-equivalence.ts` |
| 直连车道的写入记账把"软删 UPDATE"识别成 `removed` | `apps/api/src/direct-sync-ingest.ts` |

## 2. 读侧（S1）

判据**只有一处实现**：`sql/fragments.ts` 的 `workoutPresentConditionSql(alias)`（事实存在性）与
`sessionFactPresentConditionSql(sessionAlias)`（会话级，**组合**前者）。

接入点：`read/workout-read-repository.ts`（计数/列表/详情/两处按 id 读）、
`read/series-read-repository.ts`（会话行 + 元数据）、`read/facts-reader.ts`（固定代次读，
保持文件头"被删除的实体在任何代次都不可见"这条 D1 边界继续成立）、
`read/trends-read-repository.ts`、`read/training-statistics-read-repository.ts`、
`apps/api/src/data.ts`（今日/周/四周/planActual/统计/趋势锚点×3/qualityDates/成绩候选/coach 事实）、
`apps/api/src/mobile-read.ts`（两处）、`apps/api/src/coach-loop-routes.ts`（锁课校验）、
`activeDurationSecondsSql`。

## 3. 实测

| 项 | 结果 |
|---|---|
| 新用例 `packages/storage-sqlite/test/workout-presence.test.ts` | **5/5**（C7 + 恢复语义 + 会话级 + 结构判据 + v36 列形状） |
| 新用例 `apps/api/test/data.test.ts` 的 **C3** | 绿：软删一条后事实侧列表 8→7、汇总距离**恰好**少 5 km、**分析侧仍是 8**（D4.3：已发布 release 不改写） |
| 回归 | storage-sqlite **154/154**、parser **146/146**、`tsc`（pure + full）EXIT=0 |

**结构判据**（写进 `workout-presence.test.ts`）：全仓**只有** `sql/fragments.ts` 允许出现
`deleted_at IS NULL` 字面量；事实侧文件里每一处 `FROM/JOIN workouts` 所在语句都必须引用那条判据。

**突变验证（3 处，全部被精确捕获）**：

| # | 突变 | 结果 |
|---|---|---|
| 1 | 存在性判据换成 `1 = 1` | **5 条转红**（含 C3） |
| 2 | 软删换回物理 `DELETE FROM workouts` | C7 转红（路线版本的点被级联删光） |
| 3 | 会话级判据换成 `1 = 1` | C3 + 会话级用例转红 |

## 4. 同轮发现并修掉的三处"软删带来的新缺口"

1. **恢复语义断了**：软删之后 `observeImportEntity` 仍按"行在不在"判定 ⇒ 权威载荷重新提到该训练时
   `shouldWrite=false`，`deleted_at` 永远擦不掉 —— "删错了还能从好档案里恢复"这条既有契约会静默失效。
2. **删除配额被自己的历史放宽**：`countImportableEntities()` 把已删行算进分母。
3. **直连车道的账本核对会拒掉每一次删除批次**：写入记账把软删 UPDATE 记成"非删除"，
   与账本里的 `removed` 对不上（提交前断言直接抛错）—— 这正是那条断言存在的意义。

## 5. 如实标注的边界

- ⚠️ `deleted_at` 是**墙上时钟**：两个独立进程做同一次删除会得到不同毫秒值，所以
  `import_equivalence` 忽略它；删除的**事实**由 tombstone 与账目承载（两者都在比对范围内）。
- ⚠️ 本步不实现 PR5 的其余部分：`currentFacts`/`publishedAnalysis` 两块视图、新鲜度合同、
  缓存五元组、详情路线走版本表、`route_points` 退役（S3–S11）**均未做**。
  因此**读侧仍然把"当前事实"和"已发布分析"混在同一个响应里**（只是已删事实不再进入事实侧）。
- ⚠️ **分析输入侧**未改判定：已删训练对应的 `training_sessions` 由既有机制（删除时清掉 workout_groups，
  下一次规范化把没有分组的会话标 `inactive`）排除，`recompute-pipeline` 里那几处 `JOIN workouts`
  因此看不到它。这是**依赖既有机制**，不是本轮新增的保证；S6（数值修正）时应补一条
  "已删训练的会话在分析输入里不可见"的断言。
- ✅ **为什么"会话必须有真实训练事实"这条收紧不会误伤生产数据**：生产里只有两条写
  `training_sessions` 的路径 —— `canonicalize.ts` 插入时总是带 `canonical_workout_id`，
  `import-worker.ts` 的恢复语句是从既有会话行复制。唯一可能为空的情形是"那条 workout 曾经被
  **物理**删掉"（老库的 `ON DELETE SET NULL`），而这种行正是必须消失的行。
- ⚠️ 手写 schema 的测试夹具需要同步跟进（本轮补了 3 处 `deleted_at` 列），且在
  "会话夹具没有 `canonical_workout_id`"时**行为会变**：那样的事实不再产出成绩候选
  （设计清单 11 的决定：事实缺失时不用 anchor 顶一个时长出来）。夹具应补上真实 workout，
  而不是把判据放宽 —— 放宽会让"已删训练"重新变成候选。这是"手写 schema / 简化夹具会漂移"
  的既有代价，不是新增风险。
- ⚠️ §14.3 P01–P06 与 §14.5 真机验收在本环境不可达。

## 6. 下一步

**PR4-2e：放开 `deltaMode: "full"`**（前置已清空）+ A01 全类型验收；
随后 PR5-S3（`versions`/`freshness` + 绑定列可读）与 S4（两块视图）。
