# iOS 导出确定性缺陷 —— P0 + P1 实施记录（2026-09-22）

**对应方案**：`deliverables/IOS_EXPORT_DETERMINISM_FIX_PLAN_2026-09-22.md`
**本轮范围**：**P0-1 / P0-2 / P0-3**（iOS 三处确定性）+ **P1**（服务端 `stableId` 规范化 + 补守护测试）。
**未做**：P0-4（route 排序，方案要求独立提交验收）、P2（频率收敛，方案要求先看修复后实测）。

---

## 0. 结论先行

| # | 结论 | 等级 |
|---|---|---|
| 1 | P0 三条通道（字典序 / 样本查询序 / manifest 墙钟）**已全部改掉**，iOS 门禁 EXIT=0 | 🟢 完成 |
| 2 | P1 已落地，且**独立生效**：不改 iOS 也能让"行序互换 ⇒ unchanged"成立（已用回退实验证明） | 🟢 完成 |
| 3 | 方案点名缺失的那条回归**已补上**，且**能红**：移除规范化后 3 条全红 | 🟢 完成 |
| 4 | 新增结构门禁 + 6 条突变，**54 个突变 0 failed**，还原后 GREEN | 🟢 完成 |
| 5 | 🔴 **P0-2 顺带收窄了 P0-4**：route 走的是同一个 `samples()`，现在也按 startDate/endDate 排序。但 startDate+endDate 完全相同的多路线仍不稳定 ⇒ P0-4 **未关闭** | 🟡 部分 |
| 6 | 🔴 本机**此前没有 Rust 工具链**，`native-worker.test.ts` 的 8 条（含方案 §3.3 点名的跨语言等价）一直**静默 skip**。本轮装上 1.98.1 后跑通：8/8 pass | 🟢 已消除 |
| 7 | 🟡 P1 有一处**方案未列出的边界**：`activity_summary` 的 fallback id 传的是对象（下方 §5） | 🟡 已核实无害 |
| 8 | 🔴 `test:ios:mutation` 现在会原地改写 `HealthKitExport.swift`（已加入 `SOURCES`）。**并发会话跑同一棵树会被静默覆盖** | 🔴 需记住 |

---

## 1. 改动清单

### 1.1 P0 · iOS（`apps/ios/RAI/HealthKitExport.swift`）

| 项 | 位置（改后） | 改法 |
|---|---|---|
| P0-1 通道 A | `:987` `metadataXML`，循环在 `:1005` | `for (key, value) in metadata` → `for key in metadata.keys.sorted()` + `guard let value = metadata[key]`。**语义等价**：`addMetadata` / `lastMetadataValue` / `metadataBoolean` 全部按键取值，Dictionary 每键唯一 ⇒ 只改键序 |
| P0-2 通道 B | `:775` `samples()`，`sortDescriptors` 在 `:803-806` | 所有类型统一 `[StartDate, EndDate]`（endDate 仅作 tie-break），删掉 `type is HKWorkoutType ? … : nil` |
| P0-3 通道 C | `:313` manifest 字面量，`deletedSourceIds` 在 `:325` | 删除 `"createdAt": ISO8601DateFormatter().string(from: Date())`；`deletedSourceIds` 加 `.sorted()` |

**P0-3 的前置确认（方案 §2 P0-3 要求"先确认消费点"）**：
- `import-sources.ts:268-274` 的摘要只取 `{version, sourceScope, deletedSourceIds}`，且 `:272` 已 `new Set(...).sort()`
  ⇒ 客户端排序对摘要**是 no-op**，只影响 ZIP 字节（正是我们要的）。
- `health-export-parser/src/cli.ts:462-464` 只读 `version` / `deletedSourceIds`。
- 全仓 grep：**无任何**非 iOS 消费点读 manifest 的 `createdAt`。
- `<ExportDate>`（`:267`）**按方案要求没动**（服务端 `stripExportDate` 已剔除，改了零收益）。

### 1.2 P1 · 服务端哈希规范化（`packages/health-export-parser/src/utils.ts`）

- `:38` 新增 `canonicalize(value)`：**递归排序对象键，数组顺序原样保留**；只处理 plain object
  （prototype 为 `Object.prototype`/`null`），`Date`/`Map`/类实例原样透传，交给 `JSON.stringify` 自己的 `toJSON`。
- `:59` `JSON.stringify(parts)` → `JSON.stringify(canonicalize(parts))`。

**"不重生成主键"的依据（方案 §3.4 的核心断言，本轮逐条复核过）**：
19 处 `stableId` 调用里，只有 3 处传对象 —— `activity_summary` 的 fallback、以及两个 content hash：
- `record` / `workout` / `route` / `training_session` / `workout_group` / `canonical_night` /
  `canonical_hrv_day` / `dataset` / 4 个 job id：**全部是原始值数组**
  > `dataset` 用的是 `[{key, value}]`，键序 `key` < `value` 本就已排序 ⇒ 输出不变。
- `record_content` / `workout_content`：**设计上就该变**（它们就是被 bug 影响的那两个），一次性。
- 迁移内联副本 `storage-sqlite/src/database.ts:1454+`：输入全是原始值
  ⇒ 加了 `:1454-1463` 注释说明"为什么此处**不加**规范化"（加了是死代码，且会暗示两边形状不同）。
- **Rust 侧确认无需改动**（方案 §3.4）：`main.rs:543` 只 `SELECT content_hash FROM canonical_records`，
  哈希由 TS 算好后经 `native-record-writer.ts:11-12`（"Keep normalization and ID hashing in JS"）写进去。

### 1.3 P1 · 新增守护测试

`packages/health-export-parser/test/metadata-order-determinism.test.ts`（4 个用例）：

1. 两个独立库、同一份 XML、`<MetadataEntry>` 行序互换 ⇒ **同一个 workout id + 同一个 content hash**。
2. 同一库：全量导入后带 `incremental` 再导一次行序互换的 XML ⇒ 该批次 `import_entity_changes` **零行**；
   紧跟一条**反向对照**（真改 metadata 值 ⇒ 必须恰好一条 `workout/updated`）。
3. `analyzeDatasetChange(staging, previous, batchId).mode === "unchanged"`（对齐 `apps/api/test/worker.test.ts:1280-1296`）。
4. 用旧公式（裸 `JSON.stringify`）重算一组原始值数组的 id ⇒ 必须逐字节相同；
   并断言**交换数组两项必须改变 id**（钉死"数组不可排序"）。

### 1.4 P0 · 新增结构门禁

`apps/ios/tests/check-export-determinism.py`（14 checks），挂在 `apps/ios/tests/run-model-tests.sh:85`。

- 判据：`metadataXML` 不得直连遍历 Dictionary、必须遍历 `metadata.keys.sorted()`；
  `samples()` 不得出现 `sortDescriptors: nil` / `type is HKWorkoutType`、必须有 `HKSampleSortIdentifierStartDate`；
  代码里不得出现 `"createdAt"` 与 `ISO8601DateFormatter().string(from: Date())`；
  `deletedSourceIds` 那行必须带 `.sorted()`；**并且断言自己没成孤儿**。
- 按方案 §3.1 的两条硬要求实现：
  - 🔴 **先剥整行注释**（本文件注释里逐字写着那些被检查的形状，整段判会恒红/恒绿）；
  - 🔴 括号配平取函数体，**取不到 = 失败**（函数被改名时判据不许静默变空转）。

### 1.5 突变验证

`apps/ios/tests/check-background-mutations.py`：
- `HEALTH_EXPORT` 加入 `SOURCES`（`check-background-mutations.py:67-68` 自己警告过这条：漏加会让 `restore()` 静默跳过）；
- 新增 `EXPORT_GATE`，并把它并进 `CLEAN`；
- 新增 6 条 `[export]` 突变：三条改回真实旧写法 + `deletedSourceIds` 去排序 + 反孤儿 + **"判据非空转"**（把 `metadataXML` 改名）。

---

## 2. 验证结果（全部本机实测）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | clean（纯逻辑 + 全仓两条 tsconfig） |
| iOS 聚合 | `npm run test:ios` | **EXIT=0**；输出含 `Export determinism checks: 14 checks, 0 failed` |
| Node 全量 | `node --import tsx --test packages/*/test/*.test.ts apps/api/test/*.test.ts` | **798 / 795 pass / 0 fail / 3 skip** |
| Node 的 3 个 skip | 同上 | 全部 Windows-only 语义（`:89` `:166` `:381`）⇒ 环境性，非新增 |
| Web | `npm run test -w @rai/web` | 13 files / **86 pass** |
| Rust 单测 | `cargo test --release --locked --workspace` | 2 passed / 0 failed |
| **跨语言等价** | `RAI_REQUIRE_RUST_TESTS=1 node --import tsx --test …/native-worker.test.ts` | **8/8 pass**，含 `Rust decoded data preserves TS stable IDs, metadata, routes, updates, and tombstones` |
| 突变验证 | `npm run test:ios:mutation` | **54 mutations, 0 failed**；负向对照仍为 `COMPILE-ERROR`；`restored: exit=0 GREEN` |
| 门禁判别力（临时树探针） | 6 条定向破坏 | 6/6 红在**对应那条具体 message** 上（不是"只看到红了"） |
| **P1 独立生效** | 临时移除 `canonicalize` 后跑新测试 | **3/3 红**（且已还原，`canonicalize` 仍在） |

**关于 798 vs 方案记录的 777**：方案自己就把这个数标成不确定（"⚠️ 本沙箱 skip 数可能是 4 而非 3"）。
本轮以**本次实测的完整数字**为准：798/795/0 fail/3 skip，且 3 个 skip 逐条列出了原因。
决定性事实是 **fail=0**，而不是总数。

**关于"跨语言等价一直没跑"**：
`native-worker.test.ts` 的 8 条用 `{ skip: !available }` 挂在 `target/release/rai-data-worker` 上。
本机原无 Rust 工具链（`cargo not found`），所以这 8 条**一直静默跳过** ——
直到本轮装上 1.98.1 才第一次真正执行。CI 侧是有的（`.github/workflows/ci.yml` 的 `rust-data-worker` job
跑 `npm run rust:verify`，该脚本会带 `RAI_REQUIRE_RUST_TESTS=1`，缺二进制时**抛错而非跳过**）。
⇒ 本机此前的 skip 属环境限制，不是项目缺陷；但对"P1 改了哈希"这类改动，本机必须**先把 Rust 编译出来**再宣称验证过。

---

## 3. 与方案的偏差 / 需要修正方案的地方

1. **P0-2 的爆炸半径比方案写的大一点**：方案写"影响面：只改 export.xml 字节"。
   实际上 route 也走 `samples()`，所以 route 的**顺序**也变了 ⇒ `workout-routes/<id>_1.gpx` 的编号归属可能改变。
   当前 `routesUpdated=0`（无多路线 workout）⇒ **未触发**，但这条要写进 P0-4 的前置说明。
2. **P1 的"首次一次性 updated"范围比方案描述更窄**：方案说"首次导入同 A+B+C"。
   实际只影响 `record_content` / `workout_content` 两类哈希；所有**主键**不变（§1.2 逐条复核 + 测试 4 钉死）。
3. **`dataset_version`（`cli.ts:344`）不受影响**，方案未提但值得记：它的入参键序本就已排序。

---

## 4. 未做项（有意不做，附理由）

| 项 | 为什么不做 |
|---|---|
| **P0-4** route 排序 | 方案自己要求"拆成独立一次改动、独立验收"：`relativePath` 是 route 身份（`apple-health-parser.ts:248`），改名 = 删旧行插新行 + `routesUpdated` 变 + route 指纹变 ⇒ 可能抬高 `dirtyFromAt`。当前 `routesUpdated=0`（未触发）。门禁里对应的那条判据也**留空未开**（方案 §3.1 第 3 条要求 P0-4 落地后再开） |
| **P2** 频率收敛 | 方案要求先看修复后的 nginx 实测频率；且冷启动那轮上传本来就省不掉 |
| `appleDate` / `format` / `escape` / `workoutEvents` / `DateFormatter.timeZone` | 方案 §2 明确列为"不许顺手改"（全量 updated 或改语义） |
| 真机验收 | 需要重新 Build + 装手机，且要 ≥3 次冷启动间隔 <15 min。**这是唯一终审，未做** —— 见 §6 |

---

## 5. 🔴 P1 方案未列出的一处边界（本轮核实并记录）

`apple-health-parser.ts:406`：
```ts
attributes.dateComponents ?? stableId("activity_summary", [attributes])   // ← 传的是对象
```
方案说"19 处调用全部真实主键的 parts 都是原始值数组"，**这一处是例外**。

**为什么判定无害（三条实证）**：
1. 它是 `??` 的**右侧**：只有 `<ActivitySummary>` 缺 `dateComponents` 属性时才走到。
   Apple 导出与全部仓内 fixture（`parser.test.ts:48`、`native-worker.test.ts:37`、`cli-atomic.test.ts:44`、`raw-incremental.test.ts:359`）
   都带 `dateComponents`，且它是该元素的第一个属性。
2. 真走到时也没有可观测后果：`insertActivitySummary`（`storage-sqlite/src/database.ts:2126-2128`）
   第一行就是 `if (!dateComponents) return;` ⇒ 该路径**不落任何行**。
3. 该属性在 Apple 的导出里是**字母序**写的（fixture 与线上样本一致），`canonicalize` 对已排序的键是恒等变换。

⇒ 结论：即使触发，最坏结果是 `import_entity_changes` 里多一条针对"从未落库的实体"的账本行，**不产生用户可见变化**。
若将来有人把 `dateComponents` 从 `<ActivitySummary>` 拿掉，这里会先坏在别处。

---

## 6. 验收标准（下一轮要做的，本轮未完成）

### 6.1 真机（唯一终审；iOS 改源码 ≠ 真机生效）

1. Xcode **重新 Build + 装回手机**（`git pull` 对已装 App 是 no-op）。
2. 控制台过滤 `[RAI]`，**强杀冷启动 ≥3 次**，每次间隔 < 15 min。
3. **期望**：状态文案恒为「Apple 健康数据已是最新」（判据源 `HealthKitSync.swift:932-950`：
   `inserted==0 && updated==0`），**不出现**「已更新 N 次跑步」。
4. 手动同步按钮（`TechViews.swift:2594`）再验一次。
5. ⚠️ 首次同步会**多报一次更新**（行序排序导致 content hash 一次性变动，方案 §7 R1）—— 属预期。

### 6.2 线上（三条一起看，缺一条会误判）

| 证据 | 修前 | 期望 | 取证 |
|---|---|---|---|
| `import_jobs` | 每次打开 +1 行，`updatedWorkouts=4~5` | **不再新增行** | 方案 §6 命令 1 |
| `import_sources.source_sha256` | 连续 6 次全不同 | **连续 ≥2 次相同** | 方案 §6 命令 2 |
| `/var/lib/rai/var/backups` | 每次打开 +1 份 | 只剩 `rai-backup.timer` 每 40 min 一份 | 方案 §6 命令 3 |

🔴 `importCompletedAt` 是快照：判据必须是"**新增**行 / 时间戳**晚于**修复时刻"。

### 6.3 部署注意

这是**服务端 + iOS 两侧**的改动，且服务端那半（P1）**可单独生效、不必等 iOS 发版**：

- 若只部署服务端：P0-1/A 通道的症状（`updatedWorkouts`）会消失，但 B/C 仍让 `inspect` 返回 `ready`
  ⇒ 仍走 `startImport` + 全库备份（方案 §1 的"半绿"形态）。**必须两侧都上**才算完整。
- 服务端部署前先 `git rev-parse --short HEAD` 记下当前 HEAD（别假想 `HEAD~N`）。

---

## 7. 回滚

| 层 | 步骤 |
|---|---|
| iOS | `git revert <本批 iOS 提交>` → Xcode **重新 Build + 装回手机**；服务器不用动 |
| 服务端 | `cd /opt/rai && git reset --hard <修复前 HEAD> && systemctl restart rai-api` |
| 数据层 | **本次不碰任何持久化结构**（无 schema、无迁移、无主键改名）⇒ 不需要回滚数据 |

🔴🔴 **备份回滚窗口约 46 分钟**（线上 `RAI_BACKUP_MAX_COUNT=14`，当前节奏下任何一份备份约 46 min 后被挤掉）。
改数据前先记下要用的备份完整文件名，改完立刻回查它还在不在。

---

## 8. 本轮新增的"操作纪律"（给下一次跑同一条路的人）

1. 🔴 **`test:ios:mutation` 会原地改写 13 个源文件再还原**（`var/mutation-backup/` 是固定路径）。
   本轮把 `HealthKitExport.swift` 加进了 `SOURCES` ⇒ **跑它之前确认没有其它会话/编辑器在同一棵树上写这些文件**，
   否则 `restore()` 会静默覆盖对方刚写的改动。本机一次完整跑约 4.5 分钟。
2. 🔴 **本机的 node 测试默认不验哈希**：跨语言等价那 8 条要 `npm run rust:verify`
   （或先 `cargo build --release` 再带 `RAI_REQUIRE_RUST_TESTS=1`）。改任何 hash 输入前先确认它**不是** skip。
3. 🟡 新增结构门禁的**判据取不到锚点 = 失败**，不要改成"找不到就跳过"。
