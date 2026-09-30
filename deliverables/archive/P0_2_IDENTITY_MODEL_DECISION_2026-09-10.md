# P0-2「跨源工作锻炼身份」评审与技术裁决

- 日期：2026-09-10
- 来源：`deliverables/DATA_MODEL_REVIEW_2026-09-10.md` 的 P0-2
- 方法：4 路并行只读审查者独立论证 + 主持人亲验裁决（**未改任何代码**）
- 证据等级：本文所有结论均标注「✅ 亲验」或「🟡 推断」；✅ 表示我在本机库副本 / 源码上直接验证过，附可复核命令

---

## 0. 结论先行

| 项 | 原判 | 复核后裁决 |
|---|---|---|
| **P0-2 是否真实缺陷** | P0：主键含 `sourceName` 导致跨源身份断裂 | 🔴 **不成立**。原判前提错误，实际**零用户可见错误**，未来 Garmin 场景也已被现有机制覆盖 |
| **要不要动 `workouts.id`** | 建议改造为一等实体 | ❌ **不要动**。改了不合并任何一行，只制造 271 次主键变更 + 9 张表重写 |
| **要不要加 `physical_activities`** | 建议新增 | ❌ **不要加**。`training_sessions` + `workout_groups` **已经是**该实体 |
| **真存在的残余风险** | — | 🟡 一条**惰性冗余列**（`workout_features.canonical_workout_id`）是未来踩坑点；一条**未被反向测试锁定的隐式不变量** |

**一句话**：P0-2 应从「必修的架构缺陷」降级为「记录在案的技术债 + 加一条回归测试」，**不需要任何结构性改动**。

---

## 1. 原判是什么

原审查的论证链是：

1. `workouts.id = stableId("workout", [activityType, sourceName, syncIdentifier])`（`packages/health-export-parser/src/apple-health-parser.ts:191-199` ✅ 亲验）**把 `sourceName` 掺进主键**；
2. ⇒ 同一次跑步如果来自两个源（Apple Watch + Garmin），必然得到两个不同的 `id`；
3. ⇒ 关联只能退化为时间窗启发式（`canonicalize.ts:73-124`），并建议引入 `physical_activities` 一等实体 + 影子表灰度。

**这三步里，第 2 步是错的**（见 §3.1）。

---

## 2. 亲验事实底盘

以下均在本机 `var/rai.sqlite` 只读副本上实测（2026-09-10），可逐条复核。

### 2.1 表结构

| 项 | 事实 |
|---|---|
| `workouts` 主键 | `id TEXT PRIMARY KEY`（单列文本，非复合键） |
| `workouts` 行数 | 271，`id` 全部唯一 |
| 来源分布 | connect 148 / apple_watch 46 / huawei 41 / coros 36 |

**直接外键指向 `workouts.id` 的共 6 处**（`PRAGMA foreign_key_list` ✅ 亲验）：

| 子表.列 | ON DELETE |
|---|---|
| `training_sessions.canonical_workout_id` | SET NULL |
| `workout_events.workout_id` | CASCADE |
| `workout_group_members.workout_id` | CASCADE |
| `workout_groups.canonical_workout_id` | **NO ACTION** ← 唯一阻断点 |
| `workout_routes.workout_id` | CASCADE |
| `workout_statistics.workout_id` | CASCADE |

**软引用（存 `workouts.id` 值、无 FK，迁移不会自动跟随）**：

| 位置 | 行数 | 命中率 |
|---|---|---|
| `workout_features.canonical_workout_id` | 1,608 | 1,608/1,608 ✅ |
| `import_entity_generations.entity_id`（kind='workout'） | 271 | ✅ |
| `import_entity_changes.entity_id`（kind='workout'） | 274 | ✅ |

**不存 `workout_id` 的派生表**（经 `training_session_id`/`feature_id` 间接关联）：`workout_training_loads`、`workout_zone_summaries`、`ability_assessments`。

### 2.2 身份键实测（🔴 本次最关键的一组）

| 断言 | 实测值 |
|---|---|
| `HKMetadataKeySyncIdentifier` 覆盖 | 271 / 271 |
| 该键的**唯一值个数** | **271**（无一重复） |
| 按 `(activityType, syncIdentifier)` 分组的多行组 | **0** |
| `RAIHealthKitWorkoutUUID` 在 DB 中 | **0 条**（只存在于导出 XML） |

**3 个跨源重复组的成员 sid 明细**（✅ 亲验）：

| 组 | canonical | 非 canonical | 两者 sid |
|---|---|---|---|
| coros × huawei | coros `F6BADF3F-…` | huawei `37_1716553…` | **完全不同** |
| apple_watch × connect | apple_watch `D7FBD1C0-…` | connect `0F04796C-…` | **完全不同** |
| apple_watch × connect | apple_watch `BE4AE816-…` | connect `82E7E332-…` | **完全不同** |

### 2.3 复现命令（可直接跑）

```bash
cd /Users/ta/running
node --experimental-strip-types -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("var/rai.sqlite", { readOnly: true });
const a = (s) => db.prepare(s).all();
console.log(a("SELECT count(*) n, count(DISTINCT id) u FROM workouts"));
console.log(a("SELECT json_extract(metadata_json,\"$.HKMetadataKeySyncIdentifier\") sid, count(*) c FROM workouts GROUP BY 1 HAVING c>1"));
'
```

---

## 3. 三条关键更正

### 3.1 🔴 `HKMetadataKeySyncIdentifier` 是「每源」键，不是跨源键 ⇒ 原判第 2 步错误

原判假设「syncIdentifier 是 HealthKit 级的稳定活动标识，两个源写同一个值」。实测**相反**：

- 271 个值**全不重复**；
- 3 对跨源重复的 sid **两两不同**（Garmin 中继到 HealthKit 的活动拿到的是 HealthKit 自造 UUID，与 Apple Watch 自造 UUID 无关）；
- 按 `(activityType, syncIdentifier)` 分组 = 0 个多行组。

**推论（决定性）**：把 id 从 `hash(activityType, sourceName, syncIdentifier)` 改成 `hash(activityType, syncIdentifier)`：

- **不会合并任何一行**（syncIdentifier 已全局唯一）；
- 只会让 **271 个 id 全部变化**，连带重写 6 处 FK + 3 处软引用；
- 跨源去重**依然只能靠时间窗启发式**——与今天完全一样。

⇒ **方案 A 是"全表翻修 + 零语义收益"，净负。**

### 3.2 那条软引用列当前**没有有效消费者** ⇒ 零用户可见错误

`workout_features.canonical_workout_id` 的全链路（✅ 亲验）：

- **写入路径 1（新鲜）**：`buildFeatureSource` 取 `SessionRow.canonicalWorkoutId`，而 `SessionRow` 来自 `training-session-repository.ts:40,58` 对 `training_sessions.canonical_workout_id` 的 join ⇒ 实时值。写入点 `recompute-pipeline.ts:979`。
- **写入路径 2（陈旧）**：`reuseFeaturePrefix` 用 `SELECT feature.*` 把父 run 的旧值**逐字复制**（`recompute-pipeline.ts:1027-1056`，插入点在 `:1048`）⇒ 理论上可陈旧。
- **读取点（全仓唯一）**：`loadFeatureRunVectors`（`recompute-pipeline.ts:1062-1081`，`:1068`）把它读成 `WorkoutFeatureVector.canonicalWorkoutId`。
- **该读取值被谁消费？无人**：`loadFeatureRunVectors` 的返回值只流向 `buildAndPersistZoneProfiles`（`:351-356`、`:1289`），而后者遍历 `features` 时只用 `feature.trainingSessionId` + 外部 `sessions` map（`:1176-1177`、`:1314-1315`），**从不读 `feature.canonicalWorkoutId`**。

**旁证 —— 下游真正的 canonical 来源是 `training_sessions`，不是 `workout_features`**：

| 真实读取点 | 取自 |
|---|---|
| `data.ts:696-720,740`（能耗/海拔/步频/功率/踏频/触地/路线） | `row.canonicalWorkoutId` ← `workout-read-repository.ts:247,300` ← **`ts.canonical_workout_id`** |
| `data.ts:255`（当日能耗） | `JOIN workout_statistics stat ON stat.workout_id = ts.canonical_workout_id` |
| `series-read-repository.ts:52,193`（路线/海拔序列） | `ts.canonical_workout_id` |
| `prediction-data.ts:259,665` | `session.canonical_workout_id` |
| `recompute-pipeline.ts:871,884,889,897`（特征源构造） | `SessionRow` ← `training_sessions` |

⇒ 唯一消费该惰性列的地方，消费的是那个**没人用的字段**。**当前数据下 P0-2 不产生任何用户可见错误。**

### 3.3 🟢 canonical 翻转**已经**进入脏水位线 ⇒ 未来 Garmin 场景也已被覆盖

原判担心的场景是：接入 Garmin 后 `canonicalRank`（含 `routeCount*100`）压过 connect ⇒ 146 场 connect 跑步的 canonical 翻转 ⇒ 持久化的旧 `workouts.id` 引用变陈旧。

**实测这条链已被两处独立机制覆盖**：

| 位置 | 机制 |
|---|---|
| `apps/api/src/worker.ts:1197-1202` | 脏水位线 `dirtyFromAt` 的 SQL **显式包含** `current.canonical_workout_id IS NOT old.canonical_workout_id` |
| `apps/api/src/worker.ts:1018-1024` | 同一判据也计入 `updatedWorkouts`，使导入模式不落入 `unchanged` |

后果：一旦某会话的 canonical 翻转，`dirtyFromAt` 会被拉回到该会话的 `anchor_start_at`；而 `reuseFeaturePrefix` 只复用 `feature.workout_start_at < dirtyFromAt` 的行（`recompute-pipeline.ts:1032`），翻转的会话**落在水位线之后 ⇒ 不复用 ⇒ 走全量重算取实时值**。

⇒ 陈旧路径在端到端上**被中和**。这也解释了为何实测该列陈旧计数为 0。

---

## 4. 四路审查者交叉质询

| # | 审查视角 | 主张 | 亲验裁决 |
|---|---|---|---|
| 1 | 架构与契约 | 方案 C（承认 `training_sessions`/`workout_groups` 已是一等实体，消除持久化 `workouts.id` 引用）唯一正确；指出 reuse 路径是陈旧来源 | ✅ 方向正确；但**未发现脏水位线已覆盖**，故"必须修"的结论过强 |
| 2 | 存储与迁移 | **明确反对**：syncIdentifier 全局唯一 ⇒ 无合并收益，代价是 9 表 ≈3,900 行改写 + 1 处 NO ACTION | ✅ 完全采信（与 §2.2 一致）；成本估算合理 |
| 3 | 读取层与下游 | 「该列全仓**零读取点**，删列即可」；canonical 翻转后 live 路径仍正确 | 🟡 **方向对、表述过头**：确有 1 个读取点（`recompute-pipeline.ts:1068`），只是其产物无人消费（§3.2 亲验） |
| 4 | 红队 | 原判 (i) 名不副实；真缺陷是 (ii) canonical 翻转致软引用陈旧，建议在 reuse 时改取实时值 | 🟡 **机制描述正确、严重性高估**：(ii) 已被 `worker.ts:1199` 的脏水位线中和（§3.3）；且其"`data.ts:696-740` 读该列"的说法**不成立**（那些值来自 `training_sessions`） |

**收敛结论**：4 路中有 3 路独立得出「不该动主键」；两处分歧（是否有消费者、是否真会陈旧）由主持人亲验后按 §3.2 / §3.3 裁决。**原判 P0-2 的严重性被系统性高估。**

---

## 5. 方案逐条裁决

| 方案 | 内容 | 裁决 | 理由 |
|---|---|---|---|
| **A** | 一次性把 `workouts.id` 重映射为不含 `sourceName` 的键 | ❌ **否决** | 不合并任何行（§3.1）；9 表 ≈3,900 行改写 + `workout_groups.canonical_workout_id` NO ACTION 阻断；净负 |
| **B** | 新增内容派生的 `physical_activity_key` 列，派生层改读它 | ❌ **否决** | 问题不在"缺一列"，而在"持久化引用指针"；且 `training_sessions`/`workout_groups` **已经是**该实体，属重复建模 |
| **C-1** | 删除 `workout_features.canonical_workout_id`（或改为读取时 join） | 🟡 **可选，非必要** | 正确但需 migration v20；当前该列零消费者，投入产出比低 |
| **C-2** | 让 canonical 选择**单调稳定**（一旦选出永不翻转） | ❌ **否决** | 会永久锁死低质来源（connect 无路线永远赢不了 garmin），违背 `canonicalRank` 设计意图，是**有害**变更 |
| **C-3** | 让 canonical 翻转进入 dirty 范围 | ✅ **已经存在** | `worker.ts:1199` 已实现（§3.3）。**不需要新写代码，需要写一条测试把它锁住** |
| **C-0** | **什么都不改，只登记 + 加回归测试** | ✅ **推荐** | 见 §6 |

---

## 6. 推荐方案（待你拍板）

### ⭐ E1（推荐，立即做；零风险、零迁移、不动业务逻辑）

**把 P0-2 的正确性依据固化为测试**，让它从"隐式不变量"变成"被锁定的契约"：

1. 新增回归测试：构造「canonical 翻转」场景（同一物理活动先由 A 源持有 canonical，再由更优 B 源导入触发翻转），断言
   - `dirtyFromAt` 被拉回到该会话 `anchor_start_at`；
   - 翻转会话的 `workout_features.canonical_workout_id` **等于**翻转后的值（即未被 reuse 复用旧值）。
2. 在 `workout_features.canonical_workout_id` 的建表处（`database.ts:310`）加注释：**「计算时快照；reuse 路径逐字复制父 run 值；reuse 仅作用于 `workout_start_at < dirtyFromAt` 的行，故 canonical 翻转会强制重算。禁止作为权威引用消费——权威来源是 `training_sessions.canonical_workout_id`。」**
3. 更正 `deliverables/DATA_MODEL_REVIEW_2026-09-10.md` 中 P0-2 的定性与编号（降级为「技术债 / 已澄清」，附本文 §2–§3 证据）。

### 🟡 E2（可选，低风险；消除惰性列的踩坑面）

`workout_features.canonical_workout_id` 当前**零有效消费者**，可考虑：

- **E2a（轻）**：在 `loadFeatureRunVectors`（`recompute-pipeline.ts:1068`）把该字段从向量中移除（连带 `service-types.ts:21` / `WorkoutFeatureVector` 类型），使该列彻底无读取路径，剩余风险仅为"后人新写读取"。
- **E2b（重）**：migration v20 删除该列（`ALTER TABLE ... DROP COLUMN` 或重建表）。改动面更大，收益与 E2a 相近。
- **暂不推荐 E2b**：为一条零消费的列付一次 migration 不划算；等 E2a 观察一段时间后再定。

### ❌ E3（不建议）

- 不动 `workouts.id`（方案 A）。
- 不加 `physical_activities` / `physical_activity_key`（方案 B）。
- 不冻结 canonical 单调性（方案 C-2）。
- 不使用影子表灰度。

### ⚠️ 顺带发现（独立于 P0-2，供你判断是否单列）

`recompute-pipeline.ts:1032` 用 `feature.workout_start_at < dirtyFromAt` 做复用边界，而脏水位线由 `training_sessions.anchor_start_at` 计算。二者若存在**极小时间差**（同一会话的 `workout_start_at` 略早于 `anchor_start_at`），理论上存在边界行被误复用的缝隙。🟡 未观测到实例，建议在 E1 的测试里**顺带断言两者相等**，把这个假设也钉死。

---

## 7. 验收标准（若你决定落实 E1）

| # | 验收项 | 判定方式 | 反向验证（防假绿灯） |
|---|---|---|---|
| 1 | 翻转后 `dirtyFromAt` 回拉 | 断言等于被翻转会话的 `anchor_start_at` | 注释掉 `worker.ts:1199` 那一行 → 测试**必须失败** |
| 2 | 翻转会话特征不被复用 | 断言其在新 feature_run 中 `workout_features.canonical_workout_id` = 翻转后值 | 强行让 reuse 跳过该会话 → 测试**必须失败** |
| 3 | `workout_start_at` 与 `anchor_start_at` 一致 | 断言同一会话两值相等 | 无（纯断言） |
| 4 | 现有测试不回归 | `npm run typecheck` + 相关包 `node --import tsx --test` 全绿 | — |

**反向验证是硬要求**：本项目既有纪律（见 `.workbuddy/memory/`），新测试必须先用「拆掉机制 → 看它失败」证明其有效。

---

## 8. 回滚方案

- E1 只增测试与注释：`git revert` 单个 commit 即可，无数据影响。
- E2a 改类型/映射：`git revert` 即可；`workout_features` 表与数据不动。
- **不涉及任何数据库迁移 ⇒ 不需要备份恢复流程**（这正是推荐 E1 相对方案 A/B 的核心优势）。

---

## 9. 待你决定

| 编号 | 选项 | 我的建议 |
|---|---|---|
| **D1** | 是否落实 **E1**（加回归测试 + 注释 + 更正审查文档） | ✅ 建议做，成本极低、把安全性从"偶然"变成"契约" |
| **D2** | 是否落实 **E2a**（摘掉惰性列的读取路径） | 🟡 可做可不做；做了更干净，但非必要 |
| **D3** | 是否承认 **P0-2 降级**（从 P0 缺陷改为技术债） | ✅ 建议承认；证据见 §2–§3 |
| **D4** | 审查文档 P0-2 段落的更正时机 | 建议随 D1/E1 一并改，避免文档继续误导后续读者 |
