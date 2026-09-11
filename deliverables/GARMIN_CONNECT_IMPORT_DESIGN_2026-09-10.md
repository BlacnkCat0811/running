# Garmin Connect 数据接入设计方案

> 状态：**设计稿，未执行**（小唐 2026-09-10 要求"设计但不执行"）
> 影响面：`packages/health-export-parser` / `packages/storage-sqlite` / `packages/features` / `packages/application` / `apps/api` / 新增 `packages/garmin-import`
> 证据基准：本机 `var/rai.sqlite` 只读实测副本（2026-09-09 快照）+ 代码逐点核对

---

## 一、结论先行

**推荐：文件导入路线（Garmin 原始 FIT/TCX）→ 适配器产出"RAI 规范包"→ 复用现有 Apple Health 导入管线。新增 `garmin` 源类别。不使用 Garmin 官方 API 或第三方非官方 API 作为主链路。**

三条理由（都有实测/代码支撑）：

1. **收益最大**：佳明跑步现在**完全没有路线、没有心率序列**（实测 146 场 0 覆盖）。FIT/TCX 里这两样都有原生数据，一次导入即可补齐。
2. **成本最低**：项目已有"**适配器 → 规范导出包 → 复用管线**"的先例（iOS 端 `HealthKitExport.swift` 合成 `export.xml` + `workout-routes/*.gpx` + `sync-manifest.json` 喂给同一条管线）。沿用这条路，`atomic` / `incremental generation` / `route fingerprint` / `canonicalize` 这些踩过坑的机制全部零改动复用。
3. **风险最小**：文件导入零认证、零 ToS 风险、零账号封禁风险；Garmin 官方 Health API 个人开发者拿不到，非官方 API（garth 类）违反 ToS 且凭据要落盘。

> 🔴 **但在动手前有两个必修门禁**（详见第六节）：如果不修，导入一个 Garmin 包会**删掉你现有的全部 Apple Watch / 华为 / COROS 数据**。这不是危言耸听，是 `finalizeImportGeneration` 的现有语义，见 6.1 实证。

---

## 二、实测：佳明数据现在到底丢了什么

对本机库 `var/rai.sqlite`（只读副本）实测：

| 指标 | Garmin（`source_category='connect'`） | Apple Watch | 说明 |
|---|---|---|---|
| canonical 跑步场次 | **146** | 46 | 佳明占全部 268 场跑步的 **54.5%** |
| 有路线（route_points>0） | **0 / 146 = 0%** | 46 / 46 = 100% | 🔴 佳明跑步全部无地图、无海拔 |
| 有跑步心率统计 | **0 / 148 = 0%** | 45 / 46 = 98% | 🔴 连 avg/max 都没有 |
| `health_records` 心率序列 | **0 条** | 12,234 条 | 🔴 无 HR 序列 → 负荷算不出来 |
| 有距离统计 | 146 / 146 = 100% | 100% | 唯一可信字段 |
| 有消耗统计 | 146 / 146 = 100% | 100% | 有 0 值场次（min=0 kcal，虚）|
| `route_points` 点数 | **0** | 204,284 | 全库路线点 100% 来自 Apple Watch |

关键旁证（决定设计走向）：

- 佳明跑步的 `device` 字段**全部是 `iPhone13,4`**，`source_name='Connect'`。
- `metadata_json` 里只有 `HKIndoorWorkout` + `HKMetadataKeySyncIdentifier`（一个 `UUID` 形式的值，**不是 Garmin activityId**）。

**推论（🔴 这是全案的地基）**：这些数据是 **Garmin Connect iPhone App 把摘要中继写入 Apple Health** 的产物，不是手表直连。所以：
- App 中继拿不到 GPS → 没有 route；
- App 中继只写 workout 级摘要 → 没有 HR 序列，连 avg/max 都没写进来；
- 且 **HealthKit 侧 syncIdentifier 是 HK 自己生成的 UUID，与 Garmin 的 activityId 无关联** —— 意味着去重不能靠 id 对齐，只能靠**时间 + 距离**（见第七节）。

**业务含义**：146 场占 54.5% 的跑步历史对能力评估近乎零贡献。无心率 → 负荷（TRIMP/TRIMP-like）不可算；无路线 → 无爬升、无配速-坡度修正。补齐这 146 场，等于把有效训练样本从 122 场提到 268 场，**样本量 +120%**。

---

## 三、方案选型

| 方案 | 数据完整度 | 认证/合规 | 自动化 | 工程量 | 结论 |
|---|---|---|---|---|---|
| **A. Garmin 官方 Health API** | 高 | 🔴 需 OAuth1.0a + **合作伙伴审批**（企业主体、用例审核） | 全自动 | 大 | ❌ 个人项目拿不到，不做 |
| **B. 非官方 Connect API**（garth 类 SSO 登录） | 最高（原始 FIT） | 🔴 违反 ToS、账号封禁风险、MFA 打断、明文凭据落盘 | 全自动 | 中 | 🟡 降级为可选脚本（P3），不进主链路 |
| **C. 文件导入**（账号全量导出 / 网页 Export Original / 设备 `GARMIN/Activity/*.fit`） | 高（FIT 为原始记录） | ✅ 零认证、零 ToS 风险 | 手动/半自动 | 中 | ✅ **主链路** |

补充说明 C 的三种取数姿势（**2026-09-10 修订**：核查 Garmin 官方文档后调整了优先级）：

- **C1 账号全量数据导出**（`garmin.com/account/datamanagement/exportdata`）：提交请求后 Garmin 在数小时内邮件发送**该账号全部活动的原始 `.fit`**。零成本、零认证、一次拿到全量历史。**无法按时间筛选**，包体较大（历史越长越大）。
- **C2 单活动导出**（Connect 网页，**非 App**）：活动详情页齿轮图标 → `Export Original` 得到 zip，内含**原始 `.fit`**。若选 `Export to TCX` 则是重新生成的 TCX（同样含 GPS + 心率 + 圈）。**移动端 App 没有 `.fit` 导出入口**，必须用桌面浏览器。
- **C3 手表 USB 挂载**：插线后读 `GARMIN/Activity/*.fit`。🔴 **只能拿到"尚未同步到 Garmin Connect"的活动**——Garmin 在活动同步成功后会**从设备上清除该文件**（官方支持文档明示："If the Activity folder is empty, the activity has already synced... and been cleared from the device"）。所以它**不是历史归档**，只对"没同步上的/被中断的活动"有价值。

### 🔴 C3 在 macOS 上的实测限制（原先被我漏掉）

Garmin 官方支持文档明确写：**使用 MTP（媒体传输协议）或带音乐存储的机型，在 Mac 上不会显示为磁盘驱动器，这些型号必须用 Windows 电脑。**

- 现代 Garmin 手表（Forerunner 970 / Venu 3 等）走 **MTP**，macOS 的 Finder、`/Volumes`、`Disk Utility`、`rsync` **都看不到它**。MTP 是"对象式"协议，不会挂载成卷。
- Mac 上要看文件必须用第三方 MTP 客户端：**OpenMTP**（免费，`openmtp.ganeshrvel.com`）或 **Android File Transfer**（Garmin 官方推荐的那个）。
- 老式走 USB Mass Storage 的机型才会像 U 盘一样挂载。

三个必踩的坑（Mac 侧）：

1. 🔴 **必须先完全退出 Garmin Express**。它在后台运行会占住 MTP 会话，导致 OpenMTP 看不到设备；且 MTP **一次只能被一个程序占用**。
2. 🔴 **手表屏幕要保持解锁唤醒**。MTP 需要设备处于唤醒态，息屏会断连、传输中断。
3. 🟡 Apple Silicon Mac 还需在 `系统设置 → 隐私与安全性 → 允许配件连接` 放行；macOS 可能"允许充电但拦截数据"。

Windows 侧无障碍：插上后出现在「此电脑」下（可能是 `Primary` 盘或 `Internal Storage`，命名因机型而异）→ `Garmin` → `Activity`。

> **修订后的推荐：C1（账号全量导出）为主，C2（网页 Export Original）补漏，C3 仅在"活动没同步上"时使用。**
> 原方案把 C3 当主链路是错的——因为你的历史活动早就同步进 Garmin Connect 了，手表里大概率已经清空。C1 才能真正覆盖那 146 场历史。
> 三者产出的都是可落到 `garmin_export/` 目录的 `.fit`，下游适配器完全一致，**切换取数方式不影响任何设计**。

---

## 四、目标架构

```
                 ┌─────────────────── 新增（唯一的新代码） ───────────────────┐
C1 账号全量导出 ─▶│  packages/garmin-import                                   │
C2 网页 Export   │   parse-fit.ts   (FIT 二进制 → 规范化活动)                 │
C3 手表 USB      │   parse-tcx.ts   (TCX XML   → 规范化活动)                 │
   *.fit         │   emit-package.ts → RAI 规范包                            │
   *.tcx         │        ├── export.xml                （RAI 规范类型词表）  │
   *.gpx         │        ├── workout-routes/*.gpx       （路线点）           │
      ↓          │        └── sync-manifest.json         （sourceScope=garmin）│
  garmin_export/ └───────────────────────────┬──────────────────────────────┘
                                             │ 目录 / ZIP
                                             ▼
        ┌─────────────────── 现有管线（零改动复用） ───────────────────┐
        │ ImportSourceManager (upload/discover)  apps/api/import-sources │
        │        ▼                                                        │
        │ ImportWorker → 暂存库 → CLI: import / incremental-import         │
        │        ├── parseAppleHealthXml   （解析 export.xml）             │
        │        ├── importGpxRoutes       （解析 workout-routes/*.gpx）   │
        │        └── canonicalizeRunningWorkouts / canonicalizeNights      │
        │        ▼                                                        │
        │ 原子提交 + 代数(import_entity_generations) + 路线指纹            │
        └─────────────────────────────────────────────────────────────────┘
                                             ▼
                              workouts / health_records / workout_routes / route_points
                                             ▼
                                     能力评估 / 负荷 / Z 区
```

### 为什么是"合成 export.xml"而不是"直接写库"

这不是偷懒，是被现有架构的硬约束逼出来的，且恰好是正解：

1. `ImportWorker.create()` **硬性要求输入目录里有 `export.xml`**（`apps/api/src/worker.ts:624-626`）。
2. `ImportSourceManager.findExportRoot()` 也**只认 `export.xml` / `导出.xml`**（`apps/api/src/import-sources.ts:425,430-432`）。

所以"零改动复用管线"的前提就是产出 `export.xml`。反过来说，若走"新 CLI 直接写库"路线，就要把 `seedImportGenerations` / `observeImportEntity` / `finalizeImportGeneration` / 路线指纹 / 原子提交这一整套（`packages/storage-sqlite/src/database.ts:1900-2060`）重新实现一遍——那是项目里最烫手、最多历史 bug 的一段代码。**复制它就是复制风险。**

### 关于"伪造 Apple 类型名"的质疑（先自证清白）

方案里 Garmin 的心率会被写成 `type="HKQuantityTypeIdentifierHeartRate"`。这**不是伪造来源**，因为该词表（`@rai/contracts` 的 `healthTypes`）在本项目里实际是 **RAI 的规范类型词表**，只是沿用了 Apple 的命名。**语义在 `type`，来源在 `source_name`/`source_category`**。Garmin 的出处会完整落在 `source_name='Garmin'`、`source_category='garmin'`、`device`、`raw_attributes_json` 里。若强行改用 `GarminQuantityTypeIdentifier*`，会直接打穿 recompute 里所有按类型名过滤的 SQL（见 6.2），得不偿失。

---

## 五、数据映射规格

### 5.1 FIT（推荐主格式，字段最全）

| FIT 字段 | RAI 落点 | 说明 |
|---|---|---|
| `activity` / `session` (sport=1 running) | `workouts` 一行（`activity_type='HKWorkoutActivityTypeRunning'`） | **仅导跑步**，其它 sport 记为 issue 跳过 |
| `session.start_time` / `total_elapsed_time` | `start_at` / `end_at` / `duration_seconds` | UTC，统一 `toISOString()` |
| `session.total_distance` | `workout_statistics` `DistanceWalkingRunning` (km) | |
| `session.total_calories` | `workout_statistics` `ActiveEnergyBurned` (kcal) | 0 值需过滤（实测佳明有 0 kcal 场次）|
| `session.avg_heart_rate` / `max_heart_rate` | `workout_statistics` `HeartRate` avg / max | 🔴 现状为 0，这是增量 |
| `record.heart_rate` | `health_records` `HKQuantityTypeIdentifierHeartRate` | 🔴 **核心收益**：构建 HR 序列 |
| `record.position_lat/long`（半圆→度） | `route_points.latitude/longitude` + 合成 GPX | 🔴 **核心收益**：地图 + 海拔 |
| `record.altitude` / `enhanced_altitude` | `route_points.elevation_meters` | |
| `record.enhanced_speed` / `speed` | `route_points.speed_mps` | |
| `record.cadence`（步频） | `health_records` `RunningCadence` | 佳明步频质量优于 AW |
| `record.vertical_oscillation` | `HKQuantityTypeIdentifierRunningVerticalOscillation` (cm) | 跑姿动力学 |
| `record.stance_time` | `HKQuantityTypeIdentifierRunningGroundContactTime` (ms) | 同上 |
| `record.step_length` | `HKQuantityTypeIdentifierRunningStrideLength` (m) | 同上 |
| `device_info.product_name` | `workouts.device` | 例 "Forerunner 265" |
| `session.start_time`（稳定键） | `metadata.HKMetadataKeySyncIdentifier` = `garmin:<activityId>` | 🔴 幂等键，见 7.2 |

### 5.2 TCX（次选，GI 网页导出）

| TCX 节点 | RAI 落点 |
|---|---|
| `<Activity Sport="Running"><Id>` | `workouts.start_at` |
| `<Lap StartTime TotalTimeSeconds DistanceMeters Calories>` | 统计项；多圈求和/取极值 |
| `<AverageHeartRateBpm>` / `<MaximumHeartRateBpm>`（圈级） | `HeartRate` avg / max |
| `<Trackpoint><Time><Position><AltitudeMeters><HeartRateBpm><Cadence><Extensions><ns3:Speed>` | `route_points` + HR 序列。**注意：CDATA 包裹的扩展字段需兼容解析** |

### 5.3 明确不承诺的字段

- 佳明**训练效果/Training Effect、Body Battery、压力、睡眠**：本期不做（🔴 超出 RAI 的跑步能力评估范围，且缺对照基准）。睡眠若要接，走 `canonicalize-nights` 的 `sourceRank` 扩容，属于独立议题（见 6.2 备注）。
- **非跑步运动**（骑行/游泳/徒步）一律跳过并记 issue，与现有 `predicateForWorkouts(with: .running)` 范围一致。

---

## 六、必须改动的代码清单

分级：🔴 = 不改会出错/丢数据；🟡 = 不改会算错/漏统计；✅ = 无需改（已核对）

### 6.1 🔴 P0-A：「缺失即删除」会把 iOS 数据整库清空

**这是我核对代码时发现的 P0 地雷，必须先修。**

`finalizeImportGeneration`（`packages/storage-sqlite/src/database.ts:1995-2060`）的语义是：

```ts
if (options?.preserveAbsent) return { removedRecords: 0, ... };   // 安全出口
const stale = SELECT ... WHERE generation <> ?                    // 否则：
// 逐个 DELETE FROM health_records / workouts / activity_summaries
```

而 `seedImportGenerations`（同文件 `1957-1973`）会把**库里已有的每一行**都盖成 `${generation}:previous` 这个非当前代数。于是：**凡是本次导入没重新观测到的实体，全部被物理删除。**

现在 `preserveAbsent` 只有一个来源 —— 上传文件名里是否含 `apple-health-healthkit`：

- `apps/api/src/import-sources.ts:99-115`（`HEALTHKIT_UPLOAD_FILENAME_TOKEN` + `isHealthKitUploadSource`）
- `apps/api/src/worker.ts:623`（`const preserveAbsent = isHealthKitUploadSource(source ?? {})`）

**后果推演**：一个命名为 `garmin-export.zip` 的包走 `/v1/imports/uploads` → `preserveAbsent=false` → `incremental-import` 不带 `--preserve-absent` → **删掉 12,234 条 Apple Watch 心率、46 场 Apple Watch 跑步、40 场华为、36 场 COROS，以及经 CASCADE 连带删掉 204,284 个路线点**，只留佳明。

同一个 `preserveAbsent=false` 还会触发 `importGpxRoutes` 里的 `store.pruneOrphanRoutes(allPaths)`（`packages/health-export-parser/src/gpx-parser.ts:212`），把非佳明的 GPX 指纹一并清掉。

**修法**：把"是否部分包"的判据从**文件名嗅探**换成**显式声明**。

1. `sync-manifest.json` 增加 `sourceScope` 字段（iOS 端**已经写了** `"sourceScope": "healthkit"`，见 `apps/ios/RAI/HealthKitExport.swift:150`；Garmin 适配器写 `"sourceScope": "garmin"`）。
2. `ImportSource` 增加 `sourceScope: string | null`；`buildSource()`（`import-sources.ts:381-406`）从解压根目录读 `sync-manifest.json` 填充。
3. `worker.ts:623` 改为 `preserveAbsent = source.sourceScope !== null || isHealthKitUploadSource(source)`（保留文件名判据作向后兼容兜底）。

**验收**：① 现有 HealthKit 增量同步行为逐字节不变（回归）；② 新增用例：把一个 Garmin 包导入已有 46 场 Apple Watch 的暂存库，断言导入后 Apple Watch 场次**仍为 46**。

### 6.2 🔴 P0-B：`garmin` 源类别扩容（枚举 + SQL 白名单）

数据库列 `source_category TEXT NOT NULL` **无 CHECK 约束**（`packages/storage-sqlite/src/database.ts:57,79,127`），所以**加枚举值不需要 migration**。但代码里有 8 处硬编码枚举/白名单必须同步：

| # | 文件:行 | 现状 | 改法 | 级别 |
|---|---|---|---|---|
| 1 | `packages/health-export-parser/src/utils.ts:5-12` | `SourceCategory` 联合类型 | 加 `"garmin"` | 🔴 |
| 2 | `packages/health-export-parser/src/utils.ts:132-134` | `connect` 检查在 `coros/huawei` 之后 | 加 `garmin`/`佳明` 分支，且**排在 `connect` 之前**（`"Garmin Connect"` 含 `connect`，顺序错了会串类） | 🔴 |
| 3 | `packages/health-export-parser/src/canonicalize.ts:103-115` | `apple_watch 30 / coros 20 / huawei 10 / connect 5` | 加 `garmin: 25` | 🔴 |
| 4 | `packages/features/src/index.ts:144-158` | `sourceConfidence` switch；`connect` = 0.6 | 加 `garmin: 0.85` | 🔴 |
| 5 | `packages/application/src/services/recompute-pipeline.ts:644` | 兜底 source_name 选择白名单 `IN (...,'connect','other')` | 加 `'garmin'`，并把 `CASE MAX(...)` 里加 `WHEN 'garmin' THEN 4.5` | 🔴 |
| 6 | `packages/application/src/services/recompute-pipeline.ts:702` | RHR 选择 `IN ('apple_watch','connect')` | 加 `'garmin'` | 🔴 |
| 7 | `packages/application/src/services/recompute-pipeline.ts:722` | RHR 兜底同上 | 加 `'garmin'` | 🔴 |
| 8 | `packages/application/src/services/recompute-pipeline.ts:1562` | RHR baseline 同上 | 加 `'garmin'` | 🔴 |
| 9 | `packages/application/src/services/recompute-pipeline.ts:772` | `rhrSourceCategory` 三元表达式硬编码 `apple_watch/connect` | 改为按实际选中行回填，否则标签会误报 `connect` | 🟡 |
| 10 | `packages/health-export-parser/src/audit.ts:249` | 审计白名单 `IN (...,'connect','other')` | 加 `'garmin'` | 🟡 |
| 11 | `packages/health-export-parser/src/canonicalize-nights.ts:68-73` | 睡眠 `sourceRank`，`connect` 等 = 3 | 本期**不改**（不导睡眠）；若后续接睡眠，Garmin 有分期应设 2 | 🟡 备注 |

**不改也正确**（已核对，记录以防误改）：

- `packages/storage-sqlite/src/read/workout-read-repository.ts:144-148`：`sourceGroup='third_party'` 的判据是 `NOT IN ('apple_watch','manual','unknown')`，`garmin` **自动归入 third_party**，语义正确。
- `apps/api/src/schemas.ts:37`：`sourceGroup` 枚举只有 `apple_watch/third_party/manual`，无需扩展。
- `canonicalRank`（`canonicalize.ts:117-124`）已含 `routeCount*100`，**有路线的 garmin 在合并时必然压过无路线的 connect**，无需额外加权。

### 6.3 新增模块

| 文件 | 职责 |
|---|---|
| `packages/garmin-import/src/parse-fit.ts` | FIT 二进制解析（建议依赖成熟库 `fit-file-parser`，不自己实现 CRC/definition message） |
| `packages/garmin-import/src/parse-tcx.ts` | TCX 解析，风格对齐现有 `gpx-parser.ts`（`saxes` 流式） |
| `packages/garmin-import/src/emit-package.ts` | 产出 `export.xml` + `workout-routes/*.gpx` + `sync-manifest.json` |
| `packages/garmin-import/src/cli.ts` | `garmin-import --input <dir> --out <pkg> [--dry-run]` |

> 🔴 **路径大小写**：GPX 文件名必须**小写**且与 `workout_routes.relative_path`（唯一约束、大小写不敏感匹配）一致。历史事故见 `faaa531`（Linux 大小写不符 → route 卡 `pending`）。适配器产出时统一 `toLowerCase()`，并复用 `normalizeRelativePath` / `normalizeRelativePathForFileSystem` 的既有区分（`utils.ts:149-159`）——**两者不可混用**。

---

## 七、风险与对策

### 7.1 🔴 双重计数（本方案第一大风险）

**问题**：库里已有 146 场 `connect` 跑步，就是同一批佳明跑步。若 Garmin 包不做对齐就插入，同一场会变成两条 workout → **训练负荷翻倍 → 能力评分虚高**。

**现有机制能接住的**：`canonicalizeRunningWorkouts`（`canonicalize.ts:73-124`）按 `UnionFind` 分组去重，判定条件：

- 起始时间差 ≤ 120s
- 时长重叠比 ≥ 85%
- 距离差 ≤ max(0.2km, 3%)（两侧都有距离时）

命中后按 `canonicalRank` 选一条当 canonical，其余挂 `canonical_group_id` 且 `is_canonical=0`。所有能力/审计读取都带 `is_canonical = 1` 过滤（`audit.ts:213,342,432`；`audit-read-repository.ts:110`），**所以非 canonical 的重复项不会污染评分**。

**仍会漏的**：佳明 app 中继的 `start_at` 与手表原始 `start_at` 是否在 120s 内、距离是否在 3% 内——**未验证**（手上还没有真实 Garmin 文件）。

**对策（三层）**：

1. **导入前预检（dry-run）**：新增 `POST /v1/imports/garmin/preview`，对每个待导入活动在库里按 `start±120s / 距离±3%` 匹配，返回 `{ 将新增 N, 将合并 M, 冲突清单[] }`。**必须先人工确认再写库。**
2. **匹配上就"增强"而不是"新增"**：匹配到的活动只补 route + HR 序列，workout 主体不产生新行。
3. **导入后回归**：跑 `audit` 比对 `running.canonicalBySourceCategory`，断言 **canonical 总场次数不增加**。

**验收标准**：146 场 connect 中，预检判为"将合并"的比例 **≥ 95%**（允许 ≤ 5%（约 7 场）因时间漂移需人工裁决）；导入后 **canonical 跑步总数 = 268 不变**；garmin route 覆盖率 = **100%**；garmin HR 覆盖率 **≥ 95%**。

### 7.2 🔴 幂等（重复扫描不能重复入库）

**问题**：`discover()` 会反复扫目录，没有稳定 id 就会每次重导。

**已实测的坑**：佳明跑步现在的 `HKMetadataKeySyncIdentifier` 是 **`UUID` 形式**（例 `82E7E332-D16D-440F-9B33-B9B0B2237071`），**与 Garmin activityId 无任何关系**。所以**不能**用它去匹配 Garmin 侧身份。

**对策**：适配器给自己的 workout 发一个**自造但稳定**的 sync id —— `HKMetadataKeySyncIdentifier = "garmin:<activityId>"`。`buildWorkout`（`apple-health-parser.ts:178-186`）见到 syncIdentifier 就用它算 id，天然幂等。重扫同一文件 → 同 id → `observeImportEntity` 报 `inserted=false, updated=false`。

另需 **`preserveAbsent=true`**（见 6.1），因为 Garmin 目录是"全量快照"但**不能推定用户删了文件**——这与 HealthKit 增量包的语义完全一致。

### 7.3 🟡 时间对齐与时区

- `normalizeAppleDate`（`utils.ts:28-37`）只认 `"yyyy-MM-dd HH:mm:ss ±HHMM"` 格式。适配器产出的时间**必须**转成这个格式（或先转 ISO 再走 `new Date`），否则解析为 `null` → workout 被丢弃并记 `INVALID_WORKOUT`。
- FIT 的 `start_time` 是 UTC 秒数，TCX 的 `<Id>` 是带 `Z` 的 ISO。两者都要显式转 UTC，**不要用本地时区拼字符串**。
- 与 `training_sessions.anchor_start_at` 的匹配容差同样是 120s（`canonicalize.ts:141`）。

---

## 八、分期实施计划

### P0 — 地基（不动导入逻辑，可独立回归）
**内容**：6.2 全部改动 + 6.1 的 `sourceScope` 通道（先只做字段与判据，不接 Garmin 适配器）。
**验收**：
- 现有全量/增量导入结果**逐字节不变**（用同一个 Apple Health 包跑前后 compare）；
- 新增单测覆盖 `classifySource('Garmin', ...) === 'garmin'`、`'Garmin Connect'` 不落 `connect`、`sourceConfidence('garmin')`、`sourceRank('garmin')`；
- 新增回归用例：Garmin 包导入不删 Apple Watch 数据（6.1 验收②）。
**回滚**：纯增量式改动（只加枚举、只加白名单项），单独 `git revert` 不影响旧数据。

### P1 — Garmin 适配器（核心）
**内容**：`packages/garmin-import` + CLI `--dry-run`；先支持 **FIT**，再补 **TCX**。
**验收**：单个 `.fit` → 产出规范包 → 走 `/v1/imports/uploads` → 断言：`workouts` 1 行且 `source_category='garmin'`、`workout_routes` 1 行 `file_status='imported'`、`route_points` > 0、`health_records` 有 `HeartRate` 序列。
**回滚**：新包独立，删包即回滚；数据侧用导入前备份恢复。

### P2 — 自动发现 + 去重预检
**内容**：`ImportSourceManager.discover()` 增加 `garmin_export/` 与 `GARMIN/Activity/` 目录识别（`.fit/.tcx`）；`POST /v1/imports/garmin/preview`。
> ⚠️ **放 `GARMIN/Activity/` 到自动发现列表需谨慎**：① 该目录是 MTP 挂载点，在 macOS 上根本不存在（见 §三），只在 Windows 可用；② 它是「未同步活动的暂存区」而非归档，内容会被 Garmin 清空——自动发现它会导致"时有时无"的导入源，且**缺失可能被误读为删除**。**建议只把用户自己维护的 `garmin_export/` 纳入自动发现**，`GARMIN/Activity/` 仅作为手动指定路径支持。
**验收**：见 7.1 的量化标准（合并率 ≥95%、canonical 总数不变）。

### P3 — 可选：Connect API 自动化
**内容**：**独立脚本，不进主服务**；登录拿 token → 拉最近 N 天活动 → 下载原始 FIT → 落 `garmin_export/`。
🔴 **风险声明**：违反 Garmin ToS、账号封禁、MFA 打断、明文凭据落盘。**默认不做**；若做，凭据只能进 Keychain/环境变量，不入库不入 git。
**验收**：脚本可失败但不影响主服务；关了它系统照常跑。

### P4 — UI/UX
**内容**：Web「数据导入」页加"Garmin 数据包"入口 + 预检报告卡片（展示"将合并 M / 将新增 N"）；iOS 设置页可选加"从文件导入 Garmin"（走 Files 选择器，**不碰 HealthKit 权限**，符合 `AGENTS.md` 边界）。
**注意**：不触碰 <1024px 冻结区（`AGENTS.md`）。

---

## 九、回滚方案

| 层 | 手段 |
|---|---|
| **数据** | 导入前 `POST /v1/backups` 全量备份；异常时 `POST /v1/backups/:name/restore`，**请求体必须是 `{"confirmation":"恢复此备份"}`**（`apps/api/src/server.ts:1203-1220`，实现于 `maintenance.restoreBackup`，`apps/api/src/maintenance.ts:227`；自带 `before-restore` 安全备份 + rollback 文件）|
| **数据（定向）** | 目前**没有**"按来源删除"的维护命令 🟡。若需要，建议补一条 `DELETE /v1/maintenance/sources/:category`，但**本期先不做**——用备份恢复更稳，符合项目"破坏性操作先备份"的惯例 |
| **代码 P0** | 枚举/SQL 白名单改动是**纯增量**，revert 不影响历史数据 |
| **代码 P1-P2** | `packages/garmin-import` 独立包 + `sourceScope` 判据可单独回退；回退后 Garmin 包会被当作普通包（此时**必须**同时回退 6.1，否则回到"删库"语义）— 🔴 **6.1 与 P1 的先后顺序不可倒置** |
| **线上** | API 改动 `systemctl restart rai-api`；web 改动需重新 `build` + Nginx 读 `apps/web/dist` |

---

## 十、待确认（需要你定夺）

1. **取数姿势**：已修订为 **C1 账号全量导出为主**（`garmin.com/account/datamanagement/exportdata` → 邮件收全部 `.fit`）、C2 网页 `Export Original` 补漏、C3 USB 仅在未同步时用。⚠️ 仍待你确认：**C1 申请全量导出这一步是否接受**（会收到一封含全部历史活动的邮件/大包）？若你想先小范围验证，可先用 C2 导 1–2 场做端到端打通，再决定是否全量。
2. **是否接受"仅跑步"**：非跑步运动（骑行/徒步）本期一律丢弃，确认无异议？
3. **历史回溯范围**：146 场全导，还是只导近 N 个月（先生效、控风险）？
4. **P3 非官方 API 是否要做**：我的建议是**不做**（ToS + 封号风险 vs 省一次插线，不划算）。
5. **是否需要"按来源删除"维护命令**：我建议本期不做，用备份恢复兜底。

---

## 附：本次核对的关键证据索引

| 证据 | 位置 |
|---|---|
| 佳明跑步 0 路线 / 0 心率（实测） | 本机 `var/rai.sqlite` 只读副本，见第二节表 |
| 「缺失即删除」语义 | `packages/storage-sqlite/src/database.ts:1995-2060`、`1957-1973` |
| `preserveAbsent` 由文件名决定 | `apps/api/src/import-sources.ts:99-115`、`apps/api/src/worker.ts:623` |
| 导入必须存在 `export.xml` | `apps/api/src/worker.ts:624-626`、`apps/api/src/import-sources.ts:425,430-432` |
| 源类别分类与类型词表 | `packages/health-export-parser/src/utils.ts:5-12,121-140` |
| 去重与 canonical 选取 | `packages/health-export-parser/src/canonicalize.ts:73-124,233-260` |
| `sourceRank` / `sourceConfidence` | `packages/health-export-parser/src/canonicalize.ts:103-115`、`packages/features/src/index.ts:144-158` |
| recompute 硬编码来源白名单 | `packages/application/src/services/recompute-pipeline.ts:644,702,722,772,1562` |
| iOS 已用 `sync-manifest.json` 声明 sourceScope | `apps/ios/RAI/HealthKitExport.swift:145-157` |
| 路线路径大小写事故 | 提交 `faaa531`；`packages/health-export-parser/src/gpx-parser.ts:51-59`、`utils.ts:142-159` |
