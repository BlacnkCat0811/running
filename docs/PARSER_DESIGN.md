# Apple 健康导出解析器设计

## 1. 目标

解析器负责把 Apple 健康导出转换为稳定、可查询、可重算的 canonical 数据，不直接计算 RAI 分数。

核心目标：

1. 处理数百 MB XML 时保持常量级内存。
2. 保留数据来源和原始字段，便于追溯。
3. 对日期、时长、数值和路线形成统一结构。
4. 识别完全重复 record 和跨来源重复 Workout。
5. 不删除原始 Workout，只指定 canonical 代表。
6. 为未来 HealthKit 实时适配器提供同一个输出 contract。

## 2. 当前导出包

| 文件 | 数量 | 用途 |
|---|---:|---|
| 主 Apple Health XML | 1 | Record、Workout、ActivitySummary、用户特征 |
| `export_cda.xml` | 1 | 医疗 CDA，RAI V1 不解析 |
| GPX | 43 | Workout 路线和轨迹点 |
| ECG CSV | 8 | 心电图，RAI V1 不解析 |

主 XML 约 212 MB，不能使用 DOM 全量载入。

## 3. 实际数据特征

- 解析到 488,218 条 `Record`，稳定 ID 去重后为 487,766 条；存在 452 条完全相同副本。
- 279 条 `Workout`，其中 255 条 Running。
- 369 条 `ActivitySummary`。
- 43 条 GPX 全部解析成功，共 88,066 个轨迹点。
- Running 来源包括 Apple Watch、Connect、COROS 和华为。
- 38 次 Apple Watch 跑步拥有路线和跑步动态统计。
- 只有 Apple Watch Workout 直接包含丰富的 Heart Rate、Running Power、Running Speed、Stride Length、Vertical Oscillation、Ground Contact Time 等 WorkoutStatistics。
- 第三方心率多为独立低频 Record，必须按来源和时间窗口关联，不能要求 Apple Watch 级别的采样频率。

完整聚合结果见 [DATA_AUDIT.md](./DATA_AUDIT.md)。

## 4. 解析流程

```text
Apple export XML
  -> SAX 流式事件
  -> 对象草稿（Record / Workout / ActivitySummary）
  -> 日期、时长、数值归一化
  -> 稳定 ID
  -> SQLite raw-canonical tables

WorkoutRoute/FileReference
  -> 安全解析相对路径
  -> GPX SAX 流式事件
  -> route_points

workouts + statistics + routes
  -> 重复候选匹配
  -> workout_groups
  -> canonical workout
```

### 4.1 XML 策略

- 使用 `saxes` 事件解析，不构建完整 DOM。
- 每个 `Record` 或 `Workout` 闭合后立即写入 SQLite。
- 每 5,000 个对象提交一次事务。
- SQLite 使用 WAL 和 `synchronous=NORMAL`。
- 导入中断不会产生部分提交的单个 Workout 子树。

### 4.2 日期

Apple 日期格式：

```text
YYYY-MM-DD HH:mm:ss +0800
```

canonical 存储统一为 UTC ISO 8601：

```text
YYYY-MM-DDTHH:mm:ss.sssZ
```

原始时区信息仍保存在 Workout metadata 中。展示层应根据 Workout 时区或用户时区转换，模型计算使用绝对时间。

### 4.3 Metadata

Apple 导出中同一个 key 可能重复出现，因此 metadata 使用：

```ts
type MetadataMap = Record<string, string[]>;
```

不得简单转换成 `Record<string, string>`，否则会静默覆盖重复值。

### 4.4 稳定 ID

Apple 导出 XML 不总是提供 HealthKit UUID。解析器使用 SHA-256 派生稳定 ID：

- Record：同步标识、类型、来源、开始/结束、值、单位和设备；
- Workout：同步标识、运动类型、来源、开始/结束、时长和设备；
- Route：Workout ID、相对路径和路线时间；
- Workout Group：排序后的成员 Workout ID。

哈希只用于本地确定性标识，不用于安全认证。

## 5. SQLite 分层

### 5.1 原始 canonical 层

| 表 | 内容 |
|---|---|
| `health_records` | 归一化后的 Health Record，保留原始 attributes JSON |
| `workouts` | Workout 主信息、来源、时长、indoor 状态 |
| `workout_statistics` | sum / average / minimum / maximum |
| `workout_events` | segment、pause 等事件 |
| `workout_routes` | 路线引用、文件状态和点数 |
| `route_points` | GPX 时间、坐标、海拔、速度和精度 |
| `activity_summaries` | 每日 Activity Summary |
| `profile` | Health 导出中的个人特征，仅本地保存 |

### 5.2 追溯层

| 表 | 内容 |
|---|---|
| `import_manifest` | 导入时间、文件大小、对象数量和 contract 版本 |
| `entity_inventory` | Record / Workout 类型、时间范围、单位和来源类别 |
| `import_issues` | 被跳过或不完整对象的原因 |
| `schema_migrations` | 数据库 schema 版本 |

### 5.3 canonical Workout 层

| 表 | 内容 |
|---|---|
| `workout_groups` | 同一次真实训练形成的来源组 |
| `workout_group_members` | 全部副本、canonical rank 和选择结果 |

原始 `workouts` 不删除。`is_canonical=1` 只表示当前算法选择的代表记录。

## 6. Workout 去重

两条同类型 Workout 满足以下条件时进入同组：

1. 开始时间差不超过 120 秒；
2. 重叠时间占较短 Workout 至少 85%；
3. 两者都有距离时，距离差不超过 `max(200m, 3%)`；
4. 缺少距离时，时长差不超过 `max(120s, 5%)`。

使用并查集合并传递关联。

canonical rank 依据：

- 有路线；
- 有 Workout 心率统计；
- 有跑步功率、速度和跑姿统计；
- 有设备信息；
- 原始设备来源优先于聚合来源。

当前数据识别到 3 个明确重复组，255 条 Running 形成 252 个 canonical 跑步组。规则有意保守，宁可留下待审记录，也不错误合并两次真实训练。

## 7. GPX

解析字段：

- latitude / longitude；
- timestamp；
- elevation；
- speed；
- course；
- horizontal accuracy；
- vertical accuracy。

文件路径只能在用户指定的导出根目录内解析，拒绝 `..` 路径穿越。精确坐标只写入本地数据库，不写入审计报告或普通日志。

### 7.1 路径身份与文件系统解析（两者不可混用）

导出包内的相对路径有两个用途，归一化规则不同，混用会静默丢数据：

| 用途 | 函数 | 规则 |
|---|---|---|
| 落库与匹配（`workout_routes.relative_path`、`route_file_fingerprints.relative_path`） | `normalizeRelativePath` | 分隔符归一 + 去前导 `/` + **转小写** |
| 访问磁盘（`gpx-parser.ts` 的 `safelyResolve`） | `normalizeRelativePathForFileSystem` | 分隔符归一 + 去前导 `/`，**保留大小写** |

归档条目名是大小写敏感的：iOS 侧路线文件以 `HKWorkout.uuidString`（大写）命名，而落库的路径身份是小写。用身份键去拼磁盘路径，在大小写不敏感的宿主机（macOS 开发机）上会"碰巧成功"，在大小写敏感的宿主机（Linux 生产 API）上必然 `existsSync = false`。

增量归档走 `preserveAbsent`：归档未包含的路线允许缺席。但**归档自己列出、却解析不到的文件属于异常**，必须记 `UNRESOLVED_GPX_PATH` 警告并计入 `summary_json.gpx.unresolvedRouteCount`，不得静默 `continue`——否则 `workout_routes` 会永久停在 `pending`，该次跑步既无海拔也无地图（两者同源于 `route_points`）。

## 8. 独立 Record 与 Workout 的关联

导出 XML 不提供与实时 HealthKit 查询相同的对象关联能力。V1 导出适配器只能使用：

- Record 与 Workout 时间重叠；
- 原始 source name 相同；
- 类型与运动场景匹配。

心率可用证据：

1. 优先使用 WorkoutStatistics 心率；
2. 否则要求至少 10 个心率点；
3. 首末点跨度覆盖 Workout 时长至少 70%；
4. 平均每分钟至少 0.5 个点。

这是一条导出适配器规则。未来 iOS HealthKit 适配器应优先使用 `HKQuery.predicateForObjects(from:)` 等直接关联，不复用时间猜测。

## 9. 数据质量边界

以下记录保留但不默认进入模型：

- 完全重复或属于非 canonical 副本；
- 距离小于 1 km；
- 时长小于 8 分钟；
- 室内跑或室内/户外未知；
- 心率证据不足；
- 原始平均配速低于 2.5 min/km 或高于 15 min/km；
- 用户手动排除。

配速阈值只用于异常候选，不应阻止未来山地越野模型采用独立规则。

## 10. 版本管理

以下版本必须独立：

- database schema version；
- canonical contract version；
- parser version；
- feature schema version；
- scoring model version。

解析器变化不应自动改变历史分数。必须先重建 canonical 数据，再以明确的 feature/model 版本重算。

## 11. 性能结果

当前机器的首次完整导入：

- 212 MB 主 XML；
- 488,218 Record；
- 279 Workout；
- 43 GPX；
- 约 91 秒完成 XML、GPX、canonical 分组和报告；
- SQLite 约 555 MB，包含索引和 88,066 个轨迹点。

后续 Web 产品应把首次导入放入后台 worker，并通过任务进度 API 展示，不在 HTTP 请求生命周期中同步等待。

## 12. 导入快照模式与删除守卫

增量导入必须区分两种语义完全不同的载荷：

- **同步包（增量）**：只覆盖自上次锚点以来的窗口。载荷里没出现的实体**不代表被删除**。
- **完整快照（全量）**：覆盖全部历史。载荷里没出现的实体**视为已删除**。

解析器用 `preserveAbsent` 表达这一区分：为真时不按缺失删除，但仍处理显式删除事件。

### 12.1 判定依据（`apps/api/src/import-sources.ts`）

| 优先级 | 依据 | 结果 |
|---|---|---|
| 1 | `sync-manifest.json` 的 `sourceScope === "healthkit"` | `preserveAbsent = true`（客户端同步包） |
| 2 | `sourceScope === "apple-health-full-snapshot"` | `preserveAbsent = false`（显式声明全量） |
| 3 | 其他非空 `sourceScope` | `preserveAbsent = true`（未知来源范围，保守不删） |
| 4 | manifest 存在但无法解析 / `sourceScope` 为空 | `preserveAbsent = true`（保守不删） |
| 5 | manifest 不存在，归档名含 `apple-health-healthkit` | `preserveAbsent = true`（向后兼容） |
| 6 | manifest 不存在，归档名不含该标记 | `preserveAbsent = true`（`untrusted-default`：来源未知） |

🔴 **删除必须由载荷显式声明，不能由缺失推断**：默认一律保留。只有 `sourceScope === "apple-health-full-snapshot"` 这一条**显式声明完整**的路径才允许按缺失删除，且仍受守卫约束。归档文件名由调用方提供且可随意重命名，因此它**不再**是任何删除分支的判据 —— 一个无法识别的归档只是"未知"，而未知不能驱动破坏性操作。

CLI 的 `incremental-import` 同样默认保留：需显式传入 `--replace-absent` 才启用按缺失删除。`--preserve-absent` 保留为兼容用的空操作（它现在就是默认行为）。

### 12.2 删除守卫（`packages/health-export-parser/src/import-guard.ts`）

`preserveAbsent = false` 时的删除量若超过 `max(50, 现有实体数 × 5%)`，解析器抛出 `ImportRemovalGuardError` 并中止导入。守卫运行在 staging 副本上，中止即丢弃副本，线上数据不受影响。

该阈值不会误伤合法的全量替换：完整快照会让每个实体重新落回当前 generation，投影删除量趋近于 0，只有**不完整的载荷**才会产生大额投影。

运维侧如需强制替换，显式传入 CLI 参数 `--allow-large-removal`。守卫拒绝导入时，CLI 通过 IPC 传递结构化计数；API 验证计数后生成 `userMessage`，并持久化这些计数，使重启后仍可返回说明。其他错误继续返回通用失败提示。

### 12.3 删除墓碑（migration v19，`import_entity_tombstones`）

删除是**显式且持久**的，不是"最新载荷里没有"的函数。因此每次删除都会落一条墓碑：

| 删除来源 | 落墓碑的位置 |
|---|---|
| 客户端显式删除事件（`deletedSourceIds`） | `removeWorkoutsBySyncIdentifiers` |
| 显式全量快照按缺失删除 | `finalizeImportGeneration` |

`observeImportEntity` 在写入前先查墓碑：命中则返回 `tombstoned: true`，解析器跳过该实体的写入。这防止**已删数据被旧包复活**（重传归档、客户端锚点重置）。解析结果新增 `tombstonedCount` 字段用于观测。

migration v20 增加 `import_source_tombstones`：即使删除事件尚未匹配本地训练，也保存源标识。后续导入检查 `HKMetadataKeySyncIdentifier` 和 `RAIHealthKitWorkoutUUID`。上传内容哈希包含 manifest 的删除标识；仅墓碑发生变化时也发布 staging 数据库，但不重算模型，避免去重或空变更分支丢弃删除事件。

**唯一例外**：显式声明的完整快照是权威基线，`seedImportGenerations` 在扫描**之前**清空全部墓碑 —— 顺序很关键，墓碑若在扫描之后才清，被它挡住的实体已经错过本次写入。这保证了"误删后可从完好归档恢复"。

### 12.4 CLI 参数现状

| 参数 | 作用 |
|---|---|
| `--batch-id <id>` | 指定批次台账 id |
| `--replace-absent` | 显式启用按缺失删除（替代了旧的默认行为） |
| `--allow-large-removal` | 绕过删除守卫，用于刻意全量替换 |
| `--preserve-absent` | 兼容用空操作（默认行为即保留） |

## 13. 派生层 run 保留策略

每次重算都会新建 `model_runs` / `feature_runs` / `training_metric_runs`，并把**完整的派生结果重新物化一份**。若不回收，库体积按 O(runs × 天数) 增长，且每个重写派生表的 migration 都要付这个倍数。

`RaiDatabase.pruneSupersededModelRuns({ keepRecent })` 回收被取代的 run：

- **保留**：active run、其血缘祖先链、以及最近 `keepRecent` 个被取代的 run（`SUPERSEDED_RUN_RETENTION = 2`）。
- **拒绝执行**：库里没有 active run 时直接抛错 —— 没有已知的存活 run 就没有"被取代"的安全定义，猜错就是删活数据。
- **外键处理**：`recompute_jobs.model_run_id` 是 `NO ACTION`，删除前先置 NULL（job 台账保留，只释放指向已回收 run 的引用）；删除顺序必须是 `model_runs` → `feature_runs`，因为 `model_runs.feature_run_id` 也是 `NO ACTION`。
- **血缘保护**：`parent_model_run_id` / `parent_feature_run_id` 为自引用 `NO ACTION`。两条父链独立遍历：特征复用可能成功而模型回放未复用；所有存活特征（包括未关联模型的特征运行）的祖先都必须保留。

调用点在 `RecomputePipeline.activateModelRunAndCompleteJob`：**在激活事务提交之后**执行，且失败只记 stderr、不抛出 —— 清运是内务，不能回滚一次已经成功的重算。

实测（2026-09-10，库副本 309.9 MB / 6 个 run）：保留 active + 最近 2 个后回收 **3 个 run / 25,437 行派生数据**，active run 的 268 条评估与 2,463 条快照零变化，`PRAGMA foreign_key_check` 为空，重复执行为幂等空操作。

> 注：SQLite 删除后空间进入 freelist 而非立即归还文件，需 `VACUUM` 才收缩文件。空闲页会被下一次重算复用；祖先链仍受保护，因此实际保留量也取决于血缘长度，不能仅由 `keepRecent` 推导体积上限。
