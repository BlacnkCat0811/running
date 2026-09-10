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

