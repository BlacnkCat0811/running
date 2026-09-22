# iOS 导出确定性缺陷 —— 最优修复方案（2026-09-22）

**症状**：iPhone 每次打开 App 都同步，且当天 0 新数据仍报「已更新 5 次跑步」+ 重算 RAI 时间线。
**定性**：不是设计，是缺陷。**不损坏数据正确性**，但每次同步白付 30–40 s 服务端算力 + 一份 506 MiB 全库备份。

本方案由三路独立核实（iOS 导出侧 / 服务端哈希契约 / 频率与运维代价）收敛而成，逐条带 `文件:行号`。

---

## 0. 结论先行

缺陷有**三条互相独立的通道**，症状不同、修法不同、验收指标也必须分开看：

| 通道 | 机理 | 后果 | 根因位置 |
|---|---|---|---|
| **A. workout content hash 变** | 导出 XML 里 `<MetadataEntry>` **行序**每进程随机 | `updatedWorkouts=5`、重算 5 条特征、从 09-09 重放模型 | `apps/ios/RAI/HealthKitExport.swift:957` |
| **B. export.xml 字节变** | 样本查询未排序 ⇒ `<Record>` 位置抖动 | 服务端 `source_sha256` 每次不同 ⇒ `inspection` **永不返回 `unchanged`** | `HealthKitExport.swift:766-772` |
| **C. ZIP 字节变** | manifest 里 `createdAt = Date()` | `payloadHash`／幂等键每次不同 ⇒ 服务端**每次新建一份来源** | `HealthKitExport.swift:307`（+ `:305`） |

**三方合起才是"每次打开都同步 + 都重算 + 都备份"的完整解释。**

### 为什么"5"这个数字出现（且每次都是它）

窗口是**时间**维度，不是条数：anchored 同步重读 `[lastExportEnd − 48h − 14d, now]` 内**全部**跑步
（`HealthKitExport.swift:168` `routeBackfillWindow = 14d`、`:395-409` 回填合并）。
线上近 14 天恰好 5 次（09-09/09-10/09-14/09-16/09-21），`modelReplayFrom` 恒为 `2026-09-09T12:36:04Z` 即窗口起点。

> ⚠️ **不要去找"最近 N 次"的设计 —— 它不存在。** 5 是窗口与跑量的巧合。

### 根因链（通道 A，已完整走通）

```
HealthKitExport.swift:957   for (key, value) in metadata        ← Swift Dictionary，每进程随机种子
      ↓ :960                 输出 <MetadataEntry> 行序随机
apple-health-parser.ts:471   metadata 进 workout_content 的 parts
utils.ts:14-20               stableId → JSON.stringify(parts)   ← 对键序敏感
database.ts:2440-2442        previous.contentHash !== contentHash ⇒ updated
import_entity_changes        change_type='updated'
import-dataset-analysis.ts:35-45  changedWorkout 命中 ⇒ mode=incremental ⇒ 窗口内重算
```

**判别性证据**：连续 6 次上传 `export_bytes` **全部 = 12,243,292**，而 `source_sha256` **6 个全不相同**
—— 同长度、不同字节 = **纯排列**。同一 workout 的 content_hash 在连续 4 个批次里每次都不同。
旁证：record 无 `<MetadataEntry>` 子元素（`recordXML:789-804`）⇒ `import_entity_changes` 里 record 行 **0 条** ✔。
同一文件在 `:510`/`:526`/`:539` 已经**做对了三次**（`.sorted()` / `.sortedKeys`），`:957` 是唯一例外。

---

## 1. 方案对比

| 方案 | 内容 | 收益 | 残留代价 | 风险 | 结论 |
|---|---|---|---|---|---|
| **A 只修字典序** | `:957` 排序 | 症状消失：不再"已更新 N 次"、不再重算 | ⚠️ **半绿**：每次仍上传 12 MB、服务端仍解压+摘要、**仍每次写一份 506 MiB 备份**（`import-worker.ts:480` 在分析之前无条件执行） | 🟢 极小 | ❌ 不够 |
| **A+B+C（推荐 P0）** | iOS 三处确定性 | 从第 2 次同步起 `inspect` 返回 `unchanged` ⇒ **零导入、零备份、零重算** | 每次冷启动仍导出+上传 12 MB（`inspect` 在上传之后，见 `HealthKitSync.swift:788-801`） | 🟢 可控，有一次字节变化 | ✅ **采用** |
| **+ 服务端哈希规范化（P1）** | `stableId` 递归排序对象键 | 对"任何生产者的键序抖动"免疫（含未来回归、Apple 官方导出、其它写入者）；**可单独生效，不必等 iOS 发版** | 首次导入同 A+B+C；`import-equivalence` 既有 baseline 作废 | 🟡 语义面变大，必须单独提交 | ✅ 建议同批、独立提交 |
| **+ 频率收敛（P2）** | observer 前台路径也过节流 | 省掉每次冷启动的 12 MB 上行 | 真机"跑完步打开看数据"最长等一个阈值 | 🟡 改动 UX 语义 | ⏸️ 先看修复后实测再定 |

**为什么推荐 A+B+C 而不是只做 A**：只做 A 会把 `updatedWorkouts` 打到 0，
但 B/C 仍让 `inspect` 返回 `ready` ⇒ 仍走 `startImport` ⇒ 仍出现 import job 与备份。
这正是最容易被误读成"修好了"的形态 —— **验收必须把 `inserted/updated` 与 `importMode/inspection.status` 分开看**。

---

## 2. 落地改法（P0，iOS 侧）

### P0-1 🔴 根因止血：`metadataXML` 排序遍历

- 位置：`apps/ios/RAI/HealthKitExport.swift:953-963`（遍历在 `:957`）
- 改法：`for (key, value) in metadata` → 按键排序遍历（`metadata.keys.sorted()` + 取值），`skip` 判据不变。
- **语义等价**（已核实）：`utils.ts:81-109` 的 `addMetadata`/`lastMetadataValue`/`metadataBoolean` 全部**按键取值**；
  Swift Dictionary 每键唯一 ⇒ 键内顺序不受影响 ⇒ 只改键序，不改含义。
- 一次性代价：仅"排序后剩余 ≥2 键"的少数 workout 会一次性判 `updated`（与当前 5 同量级），**第二次同步起归零**。

### P0-2 🔴 修 B：所有样本查询显式排序

- 位置：`HealthKitExport.swift:766-772` —— 现在只有 `type is HKWorkoutType` 给 `NSSortDescriptor`，其余 `nil`。
- 改法：所有类型统一传 `HKSampleSortIdentifierStartDate`（必要时加 endDate 作二级 tie-break）。
- 影响面：**只改 export.xml 字节**，不产生任何 `updated`（record 的 id 与 hash 只用自身属性：`:193-202`、`:429`）。

### P0-3 🔴 修 C：manifest 去掉每次变化的墙钟

- 位置：`HealthKitExport.swift:307`（`"createdAt": ISO8601DateFormatter().string(from: Date())`）、`:305`（`deletedSourceIds` 数组序）。
- 改法：`createdAt` 删除或改为数据派生值；`deletedSourceIds` 排序。
- ⚠️ **实施前先确认消费点**：服务端内容摘要只取 `{version, sourceScope, deletedSourceIds}`（`import-sources.ts:268-274`），
  但必须再 grep 一遍解析侧/展示侧，确认无人读 `createdAt`。
- 注意：`<ExportDate>`（`:267`）**不要动** —— 服务端已主动剔除（`import-sources.ts:110`、`:231-234`），改了零收益。

### P0-4 🟠 条件触发、单独提交：route 顺序与编号

- 位置：`HealthKitExport.swift:812-846`（`for route in routes` 无排序）、`:840`（`entries.count + 1` 决定 `_1/_2.gpx`）。
- 只在"一个 workout 有多条路线"时才抖；当前 `routesUpdated=0` ⇒ 判为**未触发**。
- **爆炸半径远大于前三项**：`relativePath` 是 route 身份的一部分（`apple-health-parser.ts:248`），
  改名 ⇒ 旧 route 行删 + 新行插 + `routesUpdated` + 服务端 route 指纹变（`import-sources.ts:286-287`）
  ⇒ 可能抬高 `dirtyFromAt` 触发增量重算窗口。
- ⇒ **拆成独立一次改动、独立验收**，不要混进 P0-1/2/3。

### ⛔ 明确不许顺手改的三处

| 位置 | 为什么 |
|---|---|
| `appleDate`（`:1074-1078`）、`format`（`:1080-1082`）、`escape`（`:1088-1098`） | 每一条 record 与 workout 都经过 ⇒ 改动 = **全量 268+ 条一次 updated** |
| `workoutEvents` 顺序（`:545-557`） | 事件是**时序序列**，重排改语义 |
| `DateFormatter` 补 `timeZone`（`:1067-1072`） | 收益仅跨时区稳定，代价是一次**全量** updated |

---

## 3. 门禁与回归（P1）

### 3.1 新增结构门禁（因为源文件不可执行）

**已核实**：`HealthKitExport.swift` 被 `typecheck-ios.sh:79` 的 glob **覆盖**（类型检查跑得到），
但**不在** `run-model-tests.sh` 的显式文件清单里，且整文件被 `#if os(iOS)` + `import HealthKit` 锁死、
关键 helper 全是 `private static` ⇒ **本机/CI 无法执行它**，"跑两遍断言字节相同"这条路走不通。

⇒ 采用本仓成熟范式（`check-background-capabilities.py` 就是为同类问题建的）：新增
`apps/ios/tests/check-export-determinism.py`，挂到 `run-model-tests.sh` 末尾，判据钉源码事实：

1. `metadataXML` 体内**不得**出现 `for (...) in metadata`，**必须**出现按键排序的遍历（正反两条都要）；
2. **不得**出现 `sortDescriptors: nil` 与 `sortDescriptors: type is HKWorkoutType`；
3. `routeEntries` 的循环必须基于已排序序列（P0-4 落地后再开这条）；
4. manifest 不得再用 `Date()` 打 `createdAt`（P0-3 落地后再开）；
5. 门禁自己不许成孤儿：断言 `run-model-tests.sh` 里确实调用了它。

🔴 写法必须**先剥掉整行注释**（本仓注释里逐字提到了这些符号，整段文本判会恒绿）——
`check-background-capabilities.py:71-79` 有现成范式。
🔴 要配突变验证（照 `check-background-mutations.py` 的形态）：把 `:957` 改回无序遍历，
断言输出里出现那条**具体** message（只看到"红了"不算，要排除恒红与编译错）。

### 3.2 补齐缺失的守护测试（这是本 bug 潜伏至今的结构性原因）

**当前没有任何测试断言"同一份 XML、仅 `MetadataEntry` 行序不同 ⇒ 第二次导入必须判 `unchanged`"。**

新增（解析侧，可执行，所以放在 `packages/health-export-parser/test/`）：
构造两份语义相同、行序互逆的 workout XML（≥2 个键才体现顺序）→ 第一次全量、第二次带 `incremental`
→ 断言该批次**没有** `change_type='updated'` 的 workout 行，且 `analyzeDatasetChange(...).mode === "unchanged"`
（对齐既有判据 `apps/api/test/worker.test.ts:1280-1296`）。

该测试对 P1（服务端规范化）**在不改 iOS 的情况下也应通过** —— 这是 P1 独立生效的证明。

### 3.3 必须一并回归的既有测试

`native-worker.test.ts:65-84`（**TS vs Rust 逐行比对 `content_hash`**，跨语言等价的核心守门）、
`raw-incremental.test.ts:53-180`/`:528-578`、`apps/api/test/worker.test.ts:1280-1328`/`:1877-1895`、
`import-sources.test.ts:599-652`（"digest ignores ExportDate ⇒ unchanged"）。

**好消息**：全仓**未发现**任何硬编码 hash 字面量的断言 ⇒ 哈希输入规范化**不会**让测试大面积变红。

### 3.4 服务端规范化的安全边界（P1 的可行性依据）

- `stableId` 共 19 处调用，**全部真实主键**（record/workout/route/training_session/canonical_night/workout_group/4 个 job id）
  的 `parts` 都是**原始值数组** ⇒ 只排序**对象键**不会改变它们的输出，**不存在全库 id 重生成风险**。
- 🔴 **反例（唯一高危）**：若规范化顺手把**数组也排序**，全部主键会重生成。必须写测试钉死"数组顺序是语义"。
- 公式有 **4 份副本**（正本 `utils.ts:14-19`；迁移内联 `database.ts:1453-1460`；测试内联；另有两处已排序的手工 sha256
  可作范本 `apple-health-parser.ts:398-403`、`database.ts:2500-2501`）⇒ 改实现必须确认每份的输入形状。
- **Rust 侧无需改动**：`crates/rai-data-worker/src/main.rs:543,558` 只**消费** JS 算好的 hash，不重算。

---

## 4. 验收标准

### 4.1 真机（唯一终审，iOS 改源码 ≠ 真机生效，必须重新 Build + 安装）

文案判据来源 `HealthKitSync.swift:932-950`：`inserted==0 && updated==0` ⇒「Apple 健康数据已是最新」。

1. 真机 Run，控制台过滤 `[RAI]`，**强杀冷启动 ≥3 次**，每次间隔 < 15 min。
2. **期望**：每次状态文案恒为「Apple 健康数据已是最新」，**不出现**「已更新 N 次跑步」。
3. 手动同步按钮（`TechViews.swift:2594`）再验一次，确认消息一致。

### 4.2 线上（三条一起看，缺一条可能误判）

| 证据 | 修前 | 修后期望 | 取证命令（只读） |
|---|---|---|---|
| `import_jobs` | 每次打开 +1 行，`updatedWorkouts=4~5`、`modelReplayFrom` 恒定 | **不再新增行** | 见 §6 命令 1 |
| `import_sources.source_sha256` | 连续 6 次全不同 | **连续 ≥2 次相同** | 见 §6 命令 2 |
| `/var/lib/rai/var/backups` | 每次打开 +1 份 | 只剩 `rai-backup.timer` 每 40 min 一份 | 见 §6 命令 3 |

⚠️ `importCompletedAt` 是快照：判据必须是"**新增**行 / 时间戳**晚于**修复时刻"，别拿旧时间戳当结论。

### 4.3 门禁

- `npm run test:ios` **EXIT=0**（含新增结构门禁）；突变验证全红在**正确那条**断言上。
- node 侧测试基线不退化（**777 / 773 pass / 0 fail**；⚠️ 本沙箱 skip 数可能是 4 而非 3，先查已知原因）。
- Web 侧必须**单跑**（合并脚本 `npm test` 的 forks worker 在本机资源饥饿，属既有问题）。

---

## 5. 回滚方案（分层，互不牵连）

| 层 | 步骤 |
|---|---|
| iOS（本轮主改动） | `git revert <本批 iOS 提交>` → Xcode **重新 Build + 装回手机**；服务器不用动 |
| 服务端（仅当做了 P1） | `cd /opt/rai && git reset --hard <修复前 HEAD> && systemctl restart rai-api`（先 `git rev-parse --short HEAD` 复核，别假想 HEAD~N） |
| 数据层 | **本次不碰任何持久化结构**，理论上不需要回滚数据 |

🔴🔴 **操作纪律：备份回滚窗口现在只有约 45–60 分钟。**
线上 `RAI_BACKUP_MAX_COUNT=14`（`/etc/rai/rai.env` 实测），当前导入节奏 ~17 次/h + timer 1.5 次/h
⇒ 任何一份备份**约 46 分钟后被挤掉**（14 × 506 MiB = 7.0 G 就是稳态，7.0 G ÷ 14 ≈ 506 MiB = 主库大小）。
**动手前先记下要用的那份备份的完整文件名**，改完立刻回查它还在不在。

---

## 6. 交付前要跑的命令（只读）

```sh
# 1) 最近 10 次导入（判据：不再新增行 / updatedWorkouts 归零）
node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/var/lib/rai/var/runtime.sqlite",{readOnly:true});console.log(JSON.stringify(d.prepare("SELECT completed_at,status,summary_json FROM import_jobs ORDER BY sequence_number DESC LIMIT 10").all(),null,1))'

# 2) 最近 6 次来源指纹（判据：连续相同）
node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/var/lib/rai/var/runtime.sqlite",{readOnly:true});console.log(JSON.stringify(d.prepare("SELECT created_at,source_sha256 FROM import_sources ORDER BY created_at DESC LIMIT 6").all(),null,1))'

# 3) 备份份数与占用（判据：只剩 timer 的产出）
du -sh /var/lib/rai/var/backups && ls -1 /var/lib/rai/var/backups | wc -l

# 4) 本机匿名只读对账
curl -sS https://tpandmr.xyz/v1/data-summary   # counts / issues / importCompletedAt
```
（云机用 `mcp__lighthouse-ops__execute_command`，Region 必须 `ap-guangzhou`、InstanceId `lhins-3gatdqed`；
命令形状要极简：外单引号 + 内双引号，避开 `substr`/`GROUP BY`/`LIKE`。）

---

## 7. 风险清单

| # | 风险 | 等级 | 处置 |
|---|---|---|---|
| R1 | 任何新增/删除/重排 `<MetadataEntry>` 都是一次性 updated —— **`HealthKitExport.swift:490-496` 的注释自己警告过这条耦合** | 🔴 已知 | 发布说明写明"首次同步会多报一次更新" |
| R2 | 只修 A 会"半绿"（症状消失、备份/上传照旧） | 🟠 | 验收分开看两组指标（§4.2） |
| R3 | route 排序爆炸半径大（`relativePath` 是 route 身份） | 🟠 | 拆成独立改动（P0-4） |
| R4 | 误改 `appleDate`/`format`/`escape` ⇒ 全量 updated | 🔴 | 写进代码评审清单 |
| R5 | `serializeMetadata` 的 `String(describing:)` 兜底（`:989`）若被触发，会写出**堆地址**，该 workout 永不收敛 | 🟡 **未核实是否触发** | 与 P0-1 同批改为"返回 nil / 稳定占位"（属 R1 类一次性变化） |
| R6 | 门禁是"钉形状"不是"钉行为"；若把排序抽成新函数，旧锚点会变绿而行为可能变 | 🟡 | 门禁与代码**同一次**改动更新，并过突变验证 |
| R7 | 备份窗口 46 min，改数据前没记文件名 ⇒ 失去回滚素材 | 🔴 | 见 §5 操作纪律 |

---

## 8. 未核实项（不得当结论用）

1. **"排序后剩余 ≥2 键的 workout 恰好 ≈5 条"** —— 由链条与"0/1 键退化"推出，**未在线上 `workouts.metadata_json` 计数**。实施前可只读统计一次。
2. **Apple `HKObserverQuery` "注册即投递"** —— 无真机 `[RAI]` 日志；8 s/20 s/31 s 的极短上传间隔的确切归因未定（冷启动投递？反复切前后台？）。
3. `HKWorkout.workoutEvents`/`workoutActivities` 的顺序是否由 HealthKit 保证。
4. `HKWorkoutRouteQuery` 是否保证按时间升序返回。
5. `serializeMetadata` 兜底路径与"华氏被当摄氏"（`:973-981`）在真实数据上是否触发。
6. 是否存在本仓之外的 `metadata_json` 字符串消费者。

---

## 9. 执行顺序（建议）

1. **P0-1/2/3** 一次提交（iOS 导出确定性）→ `npm run test:ios` + 新增结构门禁 → **真机 Build 安装** → 按 §4 验收。
2. **P1** 服务端 `stableId` 规范化 + 解析侧新增守护测试 → 独立提交 → 跑跨语言等价 → 部署（`rai-deploy` 闸门）。
3. **P0-4** route 确定性（仅当出现多路线 workout）→ 独立提交。
4. **P2** 频率收敛：先看步骤 1 之后的 nginx `uploads` 实测频率，再决定是否动节流语义。

> 产品面待议（P3，非本轮）：`inspect` 发生在上传**之后** ⇒ 即使一切稳定，每次冷启动仍要上行 12 MB。
> 若要连这份流量一起省掉，需要"先送内容指纹、命中则不上传"的新协议面 —— 属新功能，不在本缺陷修复范围内。
