# RAI iOS ↔ 后端数据模型 · 多智能体审查报告

- 审查对象：RAI Running Ability Intelligence 的 iOS 客户端导出契约、后端导入管线、SQLite 数据模型
- 审查日期：2026-09-10
- 审查方式：四位独立审查者并行深挖 + 主持人交叉质询与亲验（只读，未改动任何代码/数据）
- 证据规范：所有结论均落到 `文件:行号`；体量数字来自对 `var/rai.sqlite` 的只读实测

**实施状态（2026-09-10 晚更新）**：P0-1、P1-1、P1-2 已实施并验证；P0-2、P0-3、P1-3、P1-4、P2-* 仍待决策。实施细节见 §五对应条目，逐项验收与回滚见该节。本报告的问题清单保留原始审查结论，**已修项就地标注**并更正被后续实测推翻的定性。

---

## 一、总体判断（结论先行）

**这个数据模型在「单数据源、可信客户端、单时区」的假设下是自洽的，工程质量高于平均水平**（外键已启用、有 `schema_migrations` checksum、有 `import_batches` 指纹、有单飞与幂等设计）。

但它有**一个结构性缺陷**：**模型正确性实际建立在三条"没写进模型"的隐式契约上**——

| # | 隐式契约 | 写在哪里 | 违反后的后果 |
|---|---|---|---|
| C1 | 上传 ZIP 的文件名必须含 `apple-health-healthkit` | 只在客户端硬编码（`HealthKitExport.swift:161`） | **静默全量删库**（含 CASCADE 到路线点）· **✅ 已修：判据改由 manifest `sourceScope` 主导，文件名不再驱动任何删除分支** |
| C2 | 一次跑步在 Apple Health 中只有一条记录 | 无任何地方声明 | 多源归并落入时间窗启发式，误合/漏合 |
| C3 | 所有数据来自同一时区 | 未持久化，重算时用请求时区兜底 | 日界错位，能力/睡眠基准被拆天 |

**三条契约都没有守卫（guard）。** 违反 C1 的破坏是"删数据"，违反 C2/C3 的破坏是"改数据"——两者都是静默的，没有告警、没有拒绝、没有审计留痕。这正是本项目最该先修的地方：**不是加约束，而是把已经存在于客户端的数据（manifest）纳入契约，让隐式契约变成显式契约。**

四方审查共收敛出 14 项问题，其中 P0 三项、P1 五项、P2 六项。

---

## 二、认知基线：数据模型的分层结构

模型是「**Apple Health XML 镜像层 + 派生计算层**」的混合体，共 44 张表（实测）。

```
┌─ 第 0 层：导入台账 ────────────────────────────────────────
│  import_manifest / import_batches / import_batch_files
│  import_entity_changes / import_entity_generations / route_file_fingerprints
├─ 第 1 层：原始镜像（Apple Health 的忠实副本）────────────────
│  health_records  160,051 行   ← 含 raw_attributes_json（48.99 MB）
│  workouts            271 行   ← canonical_group_id + is_canonical
│  workout_statistics / workout_events / activity_summaries / entity_inventory
│  workout_routes       92 行 ── route_points 204,284 行
├─ 第 2 层：规范会话（跨源归并的产物）───────────────────────
│  workout_groups / workout_group_members（is_canonical, canonical_rank）
│  training_sessions（anchor_start_at / anchor_end_at）
├─ 第 3 层：派生特征与模型（按 run 版本累积）─────────────────
│  feature_runs / workout_features              6 runs × 268
│  model_runs / ability_assessments             6 runs × 268
│  daily_ability_snapshots                      6 runs × 2,458 = 14,752
│  training_metric_runs / daily_training_metrics 6 runs × 2,458 = 14,752
│  workout_training_loads / workout_zone_summaries / daily_zone_profiles
│  prediction_model_runs / model_checkpoints / recompute_validations
└─ 第 4 层：用户写入 ────────────────────────────────────────
   profile / workout_overrides / training_zone_profile_settings
   canonical_nights / canonical_hrv_days
```

**实测来源分布（`workouts` 表）**：connect 148 / apple_watch 46 / huawei 41 / coros 36 —— **四个数据源已经并存，但模型没有任何一处显式表达"来源能力差异"**。这不再是"未来扩展"问题，是当下事实。

---

## 三、四方圆桌：共识、分歧与裁决

### 3.1 四方共识（高置信，可直接采信）

| 议题 | 结论 | 证据 |
|---|---|---|
| 枚举列无约束 | `source_category` / `activity_type` / `health_records.type` 均为 `TEXT NOT NULL`，无 CHECK | `database.ts:57,79,127,1218` |
| 枚举硬编码散落 | 新增数据源须同步 ≥8 处，recompute 4 处白名单不改则新源心率被忽略 | `utils.ts:5-15,134-136`、`canonicalize.ts:103-105`、`recompute-pipeline.ts:644,702,722,1562` |
| 无稳定 ID 对齐 | 跨源去重靠「±120s + 重叠 ≥85% + 距离 ≤max(0.2km,3%)」启发式 | `canonicalize.ts:73-124` |
| 规范成员双重真相 | `workouts.is_canonical` 与 `workout_group_members` 重复存储同一关系，无一致性校验 | `database.ts:90,189-191`、`canonicalize.ts:309/316/331` |
| 外键与迁移完整性良好 | `PRAGMA foreign_keys=ON`、`schema_migrations` 带 checksum | `database.ts:1318,1347,1286` |

### 3.2 分歧与主持人裁决

**分歧 1：`deletedSourceIds` 到底有没有生效？**

- 契约组（agent-1）：manifest 只有 `deletedSourceIds` 落地，其余字段是死数据。
- 完整性组（agent-3）：删除判据只看文件名 token。

**裁决：两者都对，但描述的是两条独立通道，必须分开理解。**

- **通道 A（显式删除，安全）**：`readSyncManifest`（`cli.ts:350-360`）读 `deletedSourceIds`，用于删除用户在 Health 里主动删掉的跑步。有保护——JSON 解析失败会 `throw "sync-manifest.json 无法读取，拒绝将缺失内容当作删除"`。
- **通道 B（隐式删除，高危）**：`isHealthKitUploadSource`（`import-sources.ts:99-115`）用**文件名 token** 决定 `preserveAbsent`；为假时 `finalizeImportGeneration`（`database.ts:2001-2054`）删除**所有** `generation <> 当前` 的实体，并经外键 CASCADE 波及 `workout_routes` → `route_points`。

**关键结论：manifest 里那个正确的显式声明 `sourceScope: "healthkit"`（`HealthKitExport.swift:148`），全仓只被写入、从未被读取。** 通道 B 宁愿嗅探文件名，也不看这个字段。这是纯工程疏漏，不是设计取舍。

**分歧 2：`daily_training_metrics` 的重复 `CREATE TABLE` 是否危险？**

- 完整性组（agent-3）初判为"重复定义"。
- 存储组（agent-2）核实为分属不同 migration。
- **裁决：存储组正确**。`database.ts:683`（v6）与 `:794`（v8）、`:652`（v5）与 `:1127`（v15）分属不同 migration 版本，各只执行一次，**安全**。此处不构成缺陷。

**分歧 3：migration 数量**——主持人亲验：`schema_migrations` 实为 **18** 条（v18 = `model_validation_gates`，`database.ts:1261`），非 17。

### 3.3 主持人亲验补充（四方均未捕获）

以下两项由主持人直接查询 `var/rai.sqlite` 得出，是本次审查的独立增量：

**① 派生层"只增不减"，83% 是僵尸数据**

```
model_runs = 6，全为 succeeded；active_model_run 只指向 1 个
daily_ability_snapshots  = 6 runs × ~2,458 天 = 14,752 行
daily_training_metrics   = 6 runs × ~2,458 天 = 14,752 行
workout_features         = 6 runs × 268      = 1,608 行
ability_assessments      = 6 runs × 268      = 1,608 行
日期跨度 2019-12-13 → 2026-09-09（2,463 天）
```

每次重算新建一个 run，**旧 run 的全量派生数据永不清除**，无 GC、无保留策略。当前不可达的僵尸行占 12,289 / 14,752 = **83%**。这解释了 migration v8/v15 为何要"全表重写 14,752 行"——**迁移的代价被 run 无 GC 放大了 6 倍**。增长模型是 O(N_runs × N_days)，长期必然失控。

**② 历史 generation 永不刷新，76,729 个真实实体悬在删除线上**

```
import_generation_8b760c...  83,322 行
full-import                  76,729 行
import_generation_67eb2b...     267 行
import_generation_eb6438...       4 行
合计 160,322 行 = health_records 160,051 + workouts 271   ← 一一对应真实实体
```

🔴 **修正一处早先的措辞**：这 76,729 行**不是孤儿墓碑**，而是**真实存在、可被读取的实体**的 generation 记录。

机制上有两条事实叠加，后果比"台账膨胀"严重得多：

1. 写入路径 `observeImportEntity`（`database.ts:1949-1957`）用 `ON CONFLICT ... DO UPDATE SET generation = excluded.generation`，即**命中的实体被重新盖章为当前 generation**。
2. 删除判据 `finalizeImportGeneration` 是 `generation <> 当前`。

两者合起来意味着：**每次非保留式导入都生成一个全新的 generation，使所有现存实体成为 stale 候选——只有本次载荷中重新出现的实体才幸免**。删除量 = 现存实体 − 本次载荷覆盖的实体。

实测 160,322 个实体的 generation 分散在 4 个值上（一一对应真实实体）：

| entity_kind | generation | 行数 |
|---|---|---|
| record | `import_generation_8b760c…` | 83,052 |
| record | `full-import` | 76,729 |
| record | `import_generation_67eb2b…` | 267 |
| record | `import_generation_eb6438…` | 3 |
| workout | `import_generation_8b760c…` | 270 |
| workout | `import_generation_eb6438…` | 1 |

其中 76,729 条记录**从未被任何增量导入刷新过**（不在增量窗口内），因此必然缺席于任何增量载荷 ⇒ 必然被删除。它们不是垃圾，删掉就是数据丢失。

（同一机制也保证了守卫不会误伤：完整快照会让每个实体重新盖章，投影删除量趋近 0。见 §五·建议 1 实施记录。）

**③ 批次台账割裂**：`import_batches` 仅 5 条且全部为 `web_import_*`（2026-09-03 → 09-04）。iOS 同步批次**不进入该表**，走的是另一条台账。同一系统存在两套批次可观测性，排障时无法形成完整链路。

---

## 四、问题清单

### P0 — 可能导致静默数据丢失或失真

| # | 问题 | 证据 | 触发条件 | 影响 |
|---|---|---|---|---|
| P0-1 | 删除判据与 manifest 脱节：`preserveAbsent` 由**文件名 token** 决定，而 `sourceScope` 写了不读 | `import-sources.ts:99-115`、`worker.ts:623`、`HealthKitExport.swift:148`、`database.ts:2001-2054` | 上传文件名不含 `apple-health-healthkit` 的 ZIP（重命名、Web 端上传、第三方导出） | 删除所有不在本批的 `workouts` / `health_records` / `activity_summaries`，CASCADE 删除 `workout_routes` 与 `route_points`。**已有实测事故** |
| P0-2 | 稳定 ID 通道闲置：`RAIHealthKitWorkoutUUID` 与 manifest `sourceIds` 写了零消费；反而 `workouts.id` 把 `sourceName` 掺进主键 | `HealthKitExport.swift:275,150`、`apple-health-parser.ts:172-179` | 同一物理跑步被多个来源记录 | 同一跑步必然产生不同 id，只能靠时间窗启发式归并；间歇训练/赛事多次起停/跨午夜易误合或漏合 |
| P0-3 | 日界时区依据不可信：`local_date` 取重算请求时区（默认 `Asia/Shanghai`），与数据自身时区无校验 | `server.ts:985`、`recompute-pipeline.ts:371,685-716` | 用户跨时区 / 客户端未上报 TZ | 同一天被拆成两天，`daily_ability_snapshots` 与 `canonical_nights` 基准错位 |

### P1 — 体积、成本与工程债

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1-1 | 派生层无 GC：6 个 run 各留全量派生数据，83% 不可达 · **✅ 已修** | 实测：`daily_*` 各 14,752 行、`model_runs=6`；修后回收 3 个 run / 25,437 行 | O(N_runs × N_days) 膨胀；迁移代价放大 6 倍 → 体积平台化 |
| P1-2 | **删除判据可由不可信输入（归档文件名）触发** · **✅ 已修**（原「76,729 条记录必被删」的定性已更正：台账无缺陷，缺陷在判据） | 原判据 `import-sources.ts:177-180` 的 `filename-fallback` → `preserveAbsent=false`；现改为 `untrusted-default` → 保留 | 任何无法识别的归档都会走删库分支 → 现改为默认保留 + 显式墓碑 |
| P1-3 | `raw_attributes_json` 全量保留原始 XML 属性，且被 `LIKE` 模糊匹配 | `database.ts:67,2070`；实测 48.99 MB / 310 MB ≈ 15.8%，均值 306 B/行 | 存储成本 + 查询脆弱 |
| P1-4 | 枚举无 CHECK + 硬编码 ≥8 处 | 见 3.1 共识 | 新增数据源（Garmin/COROS 已成事实）漏改即静默错算 |
| P1-5 | 规范成员双重真相，无一致性校验 | `database.ts:90,189-191` | 两处可漂移，`canonicalRank` 中 `routeCount*100` 会压过 `sourceRank`，无心率但有路线的源可能胜出 |

### P2 — 协议、并发与运维

| # | 问题 | 证据 |
|---|---|---|
| P2-1 | `syncProtocolVersion` 恒为 1，无协商、无拒绝 | `server.ts:92,544`、`HealthKitSync.swift:738` |
| P2-2 | 409 冲突不合并，仅 refetch，用户编辑被静默丢弃 | `NativeAppModel.swift:405-410`、`server.ts:711-713` |
| P2-3 | iOS 批次不入 `import_batches`，台账割裂 | 实测 + `cli.ts` |
| P2-4 | 服务发现走 http 明文 token，但 release 拒绝 http | `ServerDiscovery.swift:57`、`local-request-security.ts:81-108` |
| P2-5 | 迁移无 down、v11 为空占位 | `database.ts:938-944` |
| P2-6 | 恢复旧备份跨 schema 版本无自洽校验 | `maintenance.ts:246` |

---

## 五、优化建议（按优先级，未执行）

> 原则：**先让隐式契约显式化，再谈扩展性**。P0 三项修完之前，不建议新增任何数据源。

### 建议 1（P0-1）｜用 manifest 显式声明数据源范围，文件名降为兼容回退 ✅ 已于 2026-09-10 实施

- **改法**：`isHealthKitUploadSource` 的判据改为「先读 `sync-manifest.json` 的 `sourceScope`；读不到才回退文件名 token」。同时给 `preserveAbsent=false` 分支加**前置守卫**：删除前计算 `stale` 影响面，若 `stale.workouts > 0 && stale.records > 0` 超过阈值，拒绝执行并要求显式二次确认。
- **为什么这样改**：判据应当来自**数据内容**，而不是**传输介质的命名**。文件名是外部可任意更改的不可信输入，把它当作删库开关是典型的信任边界错误。
- **验收标准**：
  1. 将一个增量包重命名为 `test.zip` 上传 → `workouts` / `health_records` 行数**不变**（当前会大幅减少）。
  2. 上传 `sourceScope: "healthkit"` 的包 → `preserveAbsent=true`，行为与今日一致（无回归）。
  3. 上传 `sourceScope` 缺失且文件名不含 token 的包 → **拒绝并报错**，不执行删除。
  4. 新增单测覆盖三分支；用 `git stash` 验证测试确实会因旧实现失败。
- **回滚**：改动集中在 `import-sources.ts` + `worker.ts` 两处，回滚即恢复旧判据；无 schema 变更，无数据迁移。

**实施记录（2026-09-10）**

改动文件：

| 文件 | 改动 |
|---|---|
| `apps/api/src/import-sources.ts` | 新增 `readSyncManifestScope()` / `resolvePreserveAbsent()`；`isHealthKitUploadSource()` 增可选 `inputPath`（manifest 优先） |
| `apps/api/src/worker.ts` | 判据改用 `resolvePreserveAbsent`；守卫错误以 `userMessage` 回传（其余仍脱敏） |
| `apps/api/src/server.ts` | 保留上传的判断传入 `source.inputPath` |
| `packages/health-export-parser/src/import-guard.ts` | 新建：`evaluateRemovalGuard()` + `ImportRemovalGuardError` |
| `packages/health-export-parser/src/apple-health-parser.ts` | finalize 前加守卫；选项增 `guardAbsentRemoval` |
| `packages/health-export-parser/src/cli.ts` | 新增 `--allow-large-removal` 显式出口 |
| `packages/storage-sqlite/src/database.ts` | 新增只读 `previewGenerationRemoval()` / `countImportableEntities()` |
| `docs/PARSER_DESIGN.md` | 新增 §12 快照模式与删除守卫 |

生效判定（优先级由高到低）：`sourceScope=healthkit` → 保留；`=apple-health-full-snapshot` → 全量；其他非空 / manifest 损坏 → 保留（保守）；无 manifest → 回退归档名 token。

**守卫不误伤的依据**：完整快照重导入会让每个实体重新落回当前 generation，投影删除量趋近 0——因此「全量替换」天然不触发守卫，只有*不完整*载荷才会。守卫在 staging 副本上抛错，中止即丢弃副本，线上数据零影响。

验证结果：`npm run typecheck` 通过；三包合计 294 项测试，291 通过 / 0 失败 / 3 跳过。测试有效性经反向实现确认（反转判据 → 2 例失败；关闭守卫 → 1 例失败），非空转。

### 建议 2（P0-2）｜把"物理活动"提升为一等实体

- **改法**：新增 `physical_activities` 表作为**物理事件**的唯一标识（主键由设备无关的稳定标识派生），`workouts` 降级为它的**观测记录**（`physical_activity_id` 外键 + `source_category`）。跨源归并由「时间窗启发式」升级为「稳定 ID 优先，时间窗仅作兜底」。第一批可用的稳定 ID 已经躺在数据里：iOS 侧的 `RAIHealthKitWorkoutUUID`。
- **为什么这样改**：当前是 **source-centric** 模型（以"记录"为中心），"同一次跑步被多个 App 各写一份"这件事只能靠 `workout_groups` 这个事后补丁表达。把它变成显式实体后，去重规则从散落的启发式变成模型约束，新增数据源不再需要重新调参。
- **验收标准**：
  1. 构造「同一跑步双设备记录」场景 → 归并后 `physical_activities` 恰好 1 行、`workouts` 2 行。
  2. 构造「间歇训练多次起停」场景 → 不误合（当前时间窗有误合风险）。
  3. 回填后，历史 `workout_groups` 与新的 `physical_activities` 对账一致。
- **回滚**：新表可先做影子表（并行写入、读取仍走旧路径），验证通过再切换。**这是唯一涉及 schema 的建议，务必走影子表灰度。**

### 建议 3（P0-3）｜时区作为数据属性持久化，而非计算参数

- **改法**：在导入时把数据源时区写入记录（iOS 侧可从 `export.xml` 的 `locale` 或设备 TZ 获得），重算时**校验**请求 TZ 与数据 TZ 一致，不一致则告警而非静默套用默认值。`RAI_DATASET_EPOCH` 同理——当前默认 `"default"`（`server.ts:91`），使多代际隔离实际失效，应改为启动时强制校验非空。
- **验收标准**：以两个不同 TZ 各导入一份数据 → `daily_ability_snapshots` 的 `local_date` 不串位；重算 TZ 与数据 TZ 冲突时产生明确告警。

### 建议 4（P1-1 + P1-2）｜run 保留策略与删除语义 ✅ 已实施（2026-09-10）

**P1-1 run 保留策略**

- **改法**：新增 `RaiDatabase.pruneSupersededModelRuns({ keepRecent })`。重算激活成功后，保留 active run + 其血缘祖先链 + 最近 `keepRecent=2` 个被取代的 run，其余连同派生数据一并回收。调用点在 `RecomputePipeline.activateModelRunAndCompleteJob`，**在激活事务提交之后**执行，失败只记 stderr 不抛出。
- **外键处理**（此前未识别的阻断点）：`recompute_jobs.model_run_id` 是 `NO ACTION`，删除前先置 NULL（job 台账保留，只释放指向已回收 run 的引用）；删除顺序必须 `model_runs` → `feature_runs`。
- **实测**（库副本 309.9 MB / 6 个 run）：回收 **3 个 run / 25,437 行派生数据**；active run 的 268 条评估、2,463 条快照、37 个 checkpoint **零变化**；`PRAGMA foreign_key_check` 为空；重复执行幂等（0 删除）。
- **验收标准**：连续重算 3 次后 `daily_ability_snapshots` 稳定在 `≤ 3 × 天数`。✅ 结构上已成立（保留 1 active + 2）。

**P1-2 删除语义修正**（原「generation 清理」方案已按 P0-1 之后的实际情形重设计）

- 🔴 **更正原判断**：`generation` 台账**没有缺陷**，不需要清理。`seedImportGenerations` 的 `INSERT OR IGNORE` + `SEED_CONTENT_HASH` 是刻意设计（避免全量导入后被误报为大批 `updated`），且 `full-import` 值如实表示"由非增量全量导入盖章、此后从未被增量窗口观测到"。原报告把它写成"墓碑残留/待清理"是误判，已更正。
- **真正的缺陷是删除判据本身**，已改为：
  1. **默认一律保留**：`resolvePreserveAbsent` 的文件名回退分支改为 `preserveAbsent = true`（`untrusted-default`）。文件名字段不再驱动任何删除分支 —— 不可识别 ≠ 完整快照。CLI `incremental-import` 同样反转为默认保留，需显式 `--replace-absent` 才按缺失删除。
  2. **删除持久化**（migration v19 `import_entity_tombstones`）：显式删除事件与按缺失删除都落墓碑；`observeImportEntity` 命中墓碑即跳过写入，**已删数据不会被旧包复活**。唯一例外是显式声明的完整快照，它在扫描**之前**清空墓碑（顺序关键）。
  3. 解析结果新增 `tombstonedCount` 用于观测。
- **验收标准**：① 一个显式删除的训练，在随后包含它的完整载荷中不再出现；② 重命名/未知归档上传后 `workouts` / `health_records` 行数不变；③ 显式全量快照可恢复被墓碑挡住的实体。✅ 三条均有测试覆盖。

### 建议 5（P1-4）｜枚举单一来源化

- **改法**：`source_category` / `activity_type` 的取值集合定义在 `packages/contracts`，schema 层加 CHECK（或 lookup 表），代码层从契约导入常量；`classifySource` 的新源分支必须排在 `connect` 之前（`"Garmin Connect"` 含 `connect`，顺序错会串类）。
- **验收标准**：全仓除 `packages/contracts` 外，不再出现裸字符串枚举；新增一个数据源只需改契约一处。

### 建议 6（P1-3、P2-1~P2-6）｜分批处理

冷热分离 `raw_attributes_json`（用确定性字段匹配替代 `LIKE`）；握手阶段强制校验 `syncProtocolVersion`；409 冲突明确"以服务端为准"并在 UI 提示；iOS 批次写入统一的 `import_batches` 台账；服务发现补 TLS 或显式标注 debug-only；迁移补 down 与回滚文档；恢复后跑一致性检查。

---

## 六、给决策者的三句话

1. **最该立刻修的是 P0-1**——它是唯一一个"用户什么都没做错，数据就没了"的路径，且修法已存在于客户端（manifest），成本最低、收益最高。**✅ 已修**。
2. **最有价值的是 P0-2**——它把项目从"每接一个数据源就要重新调一遍去重参数"里解放出来，是真正的架构升级。
3. **P1-1 / P1-2 是同一条洞的两半，收益不是省空间而是消除静默删库**——P1-1 让库体积从 O(全部 run × 天数) 变为平台化，P1-2 让"缺失"彻底不再等于"删除"。**✅ 均已修**。剩下真正需要决策的是 P0-2（架构）与 P2 组（协议/一致性）。

---

*本报告的每一条结论均可复核：`file:line` 指向当前工作区代码，体量数字来自 `var/rai.sqlite` 只读查询。审查过程未修改任何代码或数据。*
