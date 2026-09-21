# Rust 数据引擎：下一阶段推进方案（2026-09-20）

> 多智能体讨论产物。**只给方案，不执行。**
> 参与角色：性能证据官（perf-scout）· 风险与可逆性审查官（risk-guard）· 架构边界守卫（arch-guard）· 交付与门禁负责人（delivery-owner）。
> 工作区 `HEAD = 41c2490`，工作树干净。
> **本文所有事实均由主控逐条亲验**；分发稿中被证伪的三处已在下文标注「✂️ 已纠正」。

---

## 一、结论先行

**先不要扩 Rust 覆盖面。** 当前卡点不是"哪些还没搬"，而是**测量面**与**等价性防线**两处空白：

| # | 空白 | 事实 |
|---|---|---|
| 1 | **最大的时间块是黑盒** | 真实导入总 67.1s，其中 `parseImport` **26.5s** 只有单点计时，内部阶段分布未知（`apps/api/src/import-performance.ts:26-31`） |
| 2 | **唯一的跨引擎等价工具从未跑通，且比较面选错了** | `data:benchmark` 的 `parity.checked/complete` 至今未通过（缺 `--input`）；而它依赖的 `importEquivalence` 比较面**完全不覆盖 Rust 实际改动的那些写操作** |
| 3 | **写路径没有任何自动不变量** | 线上 `RAI_IMPORT_VALIDATION_MODE=off`；而**影子对照本来就从不覆盖写路径**（见下），所以它从来不是这道防线 |

⇒ 在补上 1/2/3 之前做任何 Rust 扩容，**既无法归因，也无法验收**。

---

## 二、亲验过的现状事实（这是判断的地基）

### 2.1 Rust 到底替换掉了什么

| Rust 已接管 | 位置 |
|---|---|
| XML **分词**（SAX 事件 → spool SQLite） | `crates/rai-data-worker/src/main.rs:213` `parse_xml()` |
| Record **upsert 热循环**（写 CLI 私有候选库） | `main.rs:488` `apply_records()` |
| 单路由**爬升聚合**（多路由留给 TS） | `main.rs:440` `aggregate()` |
| GPX 点解析 | `main.rs:213`（`gpx=true`） |

🔴 **但"分词"并没有把每行 Record 的 JS 工作省掉。** 实测 `packages/health-export-parser/src/apple-health-parser.ts:481-498`：
native 分支仍然 `SELECT ... FROM xml_units ORDER BY sequence` **逐行 `JSON.parse` 并重放 `openTag`/`closeTag`**；
`nativeRecords.capture(...)` 就写在同一个 `closeTag("Record")` 处理器里（`:388`）。
⇒ **Rust 替换的是 tokenizer，不是 record 处理。** `buildRecord` / `classifySource` / `contentHash` 全留在 JS。

### 2.2 时间去哪了

| 阶段 | 实测 | 说明 |
|---|---:|---|
| `parseImport` | **26.5 s** | 含 3 次 Rust 子进程调用，其 `wallMs` 合计 **0.61 s（0.9%）** ⇒ **约 99% 在 TS 侧，且分布未知** |
| `recompute` | 31.4 s（内含 shadow 18.3 s） | 关掉 shadow 后约 13 s |
| `activation` / `backup` / `stagingCopy` | 4.3 / 1.9 / 1.8 s | |
| **合计** | **67.1 s** | |

### 2.3 🔴 影子对照从来没有覆盖过写路径（关键纠正）

`runShadowValidation()`（`packages/application/src/services/recompute-pipeline.ts:239-282`）做的是：
把**增量重算**的 candidate 与**临时跑一遍全量重放**的 reference，
比较 `features` / `ability_assessments` / `daily_ability_snapshots`（`:285-300` 的 `compareRunOutputs` 域定义）。

⇒ 它比较的是**重算结果**，**从不比较 `health_records` / `xml_units` / `apply-records` 的写入结果**。
⇒ 因此「关掉 shadow 就丢了写路径的等价保护」是**错误叙事**。真正丢掉的是两样东西：
1. 增量路径**顺带**获得的一次全量重放交叉验证；
2. 约 **27%** 的耗时。

### 2.4 唯一的等价工具：选错了比较面

`apps/api/src/import-equivalence.ts`：

- 域清单（`:9-20`）**不含** `import_entity_changes`，也**不含** `xml_units`。
- 排序键由 SELECT 列名推导（`:25-30`）⇒ **给任何域表加一列就会改变哈希基准**，历史基线作废。
- `removed` 行的 `content_hash` 存的是 **`entity_id` 而非真哈希**（`database.ts:2605`、`:2704`）
  ⇒ 对这条写入路径的**良性突变是不可观测的**。
  📌 这正是 `docs/PROJECT_AUDIT_2026-07-17_R2.md` 记过的同一反模式 —— 在台账里**今天仍然存在**。

### 2.5 写路径现有断言的真实成色

| 断言 | 位置 | 成色 |
|---|---|---|
| 候选库文件名须匹配 `.importing.<UUID>` | `main.rs:492-508` | ✅ 真实有效 |
| 库内一次性许可须匹配 | `main.rs:513-520` | ✅ 真实有效 |
| `observedRecords === count` | `native-record-writer.ts:58` | ✅ 有效（但比的是 **Rust 自报数**） |
| 协议元数据自洽（协议号/版本/行数/sha256） | `native-worker.ts:145-163` | ⚠️ 见下 |
| 🔴 **`apply-records` 的通用行数断言是空转** | `main.rs:598` 返回 `rows: 0` | ❌ **恒真** |

🔴 第 5 条是本轮最具体的发现：
`main.rs:598` 的 `apply-records` 返回 `rows: 0`，而 `native-worker.ts:161-163` 把 `rows`
与 spool 里的 `COUNT(route_aggregates)` 比对 —— 而 apply-records 的 spool **根本没写过 `route_aggregates`**
（它写的是 `--staging-database` 指定的候选库）⇒ **`0 === 0`，这条断言对真正改数据的那个 operation 恒真。**
⇒ 也就是说：**Rust 写坏候选库的行内容，除了自报的 `observedRecords` 之外，没有任何独立计数能发现。**

### 2.6 Rust 写路径漏了一项 TS 检查 —— 但今天等价（✂️ 分发稿定为 P0 是真警报）

`main.rs:526-528` 只查 `import_entity_tombstones`；
TS `observeImportEntity` 还查 `import_source_tombstones`（`database.ts:2421-2426`）。

**我实测的判定**：今天**等价**，但这是个**潜伏陷阱**：
- `record` 路径调用时**只传 6 个参数**（`apple-health-parser.ts:390-393`）⇒ `sourceIdentifiers` 取默认 `[]`（`database.ts:2417`）⇒ 该分支空转。
- 只有 **`workout`** 传了真实的 `["HKMetadataKeySyncIdentifier","RAIHealthKitWorkoutUUID"]`（`:431-437`），而 workout **仍由 TS 写**。

⇒ 现在不是 bug；**一旦有人给 record 补上 sourceIdentifiers，Rust 路径会静默复活已按来源删除的记录**。
⇒ 处置：写成**契约测试**（见 P1-2），而不是紧急修复。

### 2.7 原生路径的启用门（确认"reuse-first"恒成立）

`apple-health-parser.ts:245`：`NativeRecordWriter` 仅在 `native && options.atomic === false && stagingDatabase` 时创建。
`seedImportGenerations`（`:248`）只在 `options.incremental` 时调用 ⇒ **两者永不重合**。
📌 即 `main.rs:561-564` 对 `__seed_unknown__` 的比对是防御性的，**根因在"谁来写 → 谁就有 seed"**。
📌 推论：`import_entity_generations` 一旦成为非空 diff 域，**在原子路径（in-process）上天生会假报警**，必须限定为「增量 + 原生路径」才比较。

### 2.8 跨语言契约：三份实现，零条一致性断言

JS 语义今天有**三份手写复刻、没有第四份判据**：
1. 现行 TS：`saxes` 解析器（`apple-health-parser.ts`）+ `utils.ts` 的 `stableId`
2. **Rust**：`main.rs:64-102` 手写 `name()` / `xml_text()`，`:135-156` `number()`，`:162-182` `timestamp()`（含 `js_whitespace` 复刻）
3. 遗留：`apps/web/src/ios/native.ts`

已有测试 `packages/health-export-parser/test/native-worker.test.ts`（6 条）与
`apps/api/test/native-import-worker.test.ts`（3 条）测的是**"能跑通 / 能正确报错 / 不越权写"**，
**没有一条是"同一输入两边结果必须逐字段相等"**。⇒ 三份语义只能靠人眼保持同步。

### 2.9 `change_type` 值域（risk-guard ③ 终版，已亲验）

- 权威值域由**共享 schema CHECK** 定义：`database.ts:968` = `('inserted','updated','removed','unchanged')`；
  类型侧一致：`ImportChangeType`（`incremental.ts:7`）。⇒ 这是**双侧硬约束**，Rust 写值域外的值**当场失败**。
- **生产写入方只出现 3 值**：`inserted`/`updated`（TS `database.ts:2457` ↔ Rust `main.rs:571-572`）、
  `removed`（**TS 独有**：`database.ts:2604`、`:2703`；Rust 从不写）。
- ✅ 我自己全仓 grep（`*.ts`）确认：`'unchanged'` 在 `import_entity_changes` 上**无任何生产写入方**
  （只命中 CHECK 定义、类型定义、读侧过滤 `incremental.ts:67`）。
- ⚠️ **两个同名不同物，比值域本身更易错**：
  - `database.ts:960` 是**邻表 CHECK**（`new|changed|unchanged|removed`，**有 `new`、无 `inserted`**）；
  - `incremental.ts:29/62` 的 `"unchanged"` 是**指纹状态** `FingerprintStatus`，与 `:7` 无关。
- ⚠️ **不要配 `removed ⟹ !exists`**：台账在删除**之前**写（`:2604` 早于 `:2607`）
  ⇒ 只能断言「**最终库中不存在**」。

### 2.9b 🔴 `entity_kind` 存在两套**不相交**的词表（亲验，新增）

| 位置 | 词表 | 是否有 CHECK |
|---|---|---|
| `import_entity_generations.entity_kind` | `record` / `workout` / `activity_summary` | ✅ `database.ts:1001` |
| `import_entity_tombstones.entity_kind` | 同上 | ✅ `:1346` |
| `import_entity_changes.entity_kind` | 同上（写入方只有 `database.ts:2411` + Rust `main.rs:535`） | ❌ **无 CHECK**（该表只对 `change_type` 有 CHECK，`:968`） |
| `import_source_tombstones.entity_kind` | **只有 `workout`** | ✅ `:1366` |
| **TS 类型 `ImportEntityKind`** | `workout`/`route`/`heart_rate`/`sleep`/`resting_heart_rate`/`hrv`/`maximum_heart_rate`/`other` | — 与上面**完全不相交**（`packages/health-export-parser/src/incremental.ts:6`） |

⇒ 这是**真实的实现债**：同一个 FK 列上存在两套互不相交的词表，而**其中一套所在表没有 CHECK**。
⇒ 但它**当前不是活的 bug**：见 2.9c。

### 2.9c `planRecompute` 是**死代码**（亲验，新增）

`planRecompute()`（`incremental.ts:66`）的那个「除 `workout`/`route` 外一律判 unsafe ⇒ 回退 full」的过滤器，
看似会吞掉所有 record 变更 —— 但**它是死代码**，不影响生产：

- 全仓调用方只有两处：`index.ts:44` 的 re-export、以及它自己的单测 `test/incremental.test.ts:14/24`。
- 真实的生产消费者是 **`planHealthChanges()`**（`apps/api/src/health-change-plan.ts:23`），
  它直接读台账词表 `change.entity_kind = 'record'`（`:37`）。
- 项目文档自己已记录这点：`docs/SLEEP_HRV_DESIGN.md:747` 写明 Model Run 分类走
  `apps/api/src/worker.ts` 的 `analyzeDatasetChange`，**不是** `planRecompute`。

⇒ 结论：词表分叉属**结构债**（值得登记，不紧急）；那个"unsafe 过滤器"是**第三份同名逻辑的副本**，
清理它属于 P1 的整洁性工作，**不要为它做紧急修复**。

#### 两条可执行的守卫（建议纳入 P1）

1. **死代码守卫**：在 `planRecompute` 上标一行注释 ——
   「**当前零生产调用方，改它不产生运行时效果**」，避免后人误以为改它就在优化增量。
   触发条件（未来）：任何"让 Rust 顺便产出重算计划"的接线 ⇒ `entity_kind='record'` 会**全部**命中
   `incremental.ts:69` 的 `unsafe` ⇒ 返回 `mode:"full"` ⇒ **每次增量退化成全量重算**（代价与开 shadow 同量级，且无数据损坏）。
   接线前必须先写「台账词表 → `ImportEntityKind`」的映射函数 + 单测。
2. 🔴 **Rust 硬编码 `'record'` 是**四**处，不是一处**（均在同一函数内，属台账词表）：
   `main.rs:527`（墓碑查询）/ `:530`（读上一版 `content_hash`，它决定 `updated` 判定）/
   `:532`（generations 写入）/ `:535`（changes 写入）。
   native 若扩展到 `workout`，**四处都要改**：

   | 行 | 用途 | 漏改的后果 |
   |---|---|---|
   | `:527` | tombstone 查询 | 该删的没删（静默复活已删记录） |
   | **`:530`** | **`old_hash` 查询（喂 `updated`）** | **三层递进失效，见下** |
   | `:532` | `import_entity_generations` 写入 | 覆盖正确的历史 hash |
   | `:535` | `import_entity_changes` 写入 | 台账词表污染 |

   🔴 **`:530` 的失败模式是三层的，比 `:527` 隐蔽得多**（逐层核过）：
   ① `old_hash` 查不到行 ⇒ `previous = None`（`main.rs:558`）⇒ `updated = false`（`:561-564`）；
   ② 写数据门 `:577`（`!incremental || !exists || updated`）为假 ⇒ **不写 `health_records`**；
   ③ 台账门 `:566-567`（`!exists || updated`）同样为假 ⇒ **不写 `import_entity_changes`**
   ⇒ 下游 `analyzeDatasetChange` 按台账取变更（`import-dataset-analysis.ts:34`）
   ⇒ **重算计划里没有这次变更 ⇒ 派生指标静默陈旧**。

   ⚠️ **全程没有任何现成断言会报警**：spool 的 `canonical_records` 仍含该行，
   `observedRecords` 计数仍然匹配（`native-record-writer.ts:58`）。
   ⇒ 这正是 P0-3 的 L1/L2 不变量存在的理由。

3. 📌 **`import_source_tombstones` 今天必然是空转，有**两重独立保证**：
   - **schema 层**：`entity_kind TEXT NOT NULL CHECK (entity_kind = 'workout')`（`database.ts:1366`，单值约束），
     v20 迁移的历史回填也限定了 `WHERE entity_kind = 'workout'`（`:1375`）⇒ 不存在"回填绕过 CHECK"的窗口；
   - **调用层**：唯一写入方 `recordSourceDeletion` 硬编码 `'workout'`（`:2686-2688`），
     全仓没有写 `'record'` 的地方。
   ⇒ 任何按 `kind='record'` 去查它都查不到。**这才是 §2.6 那个"潜伏陷阱"现在无害的根本原因**
   （不只是"参数没传"）。
   🔴 推论：要让 record 拥有 source-tombstone 语义，**必须放宽一个 schema CHECK = 一次数据库迁移**
   （该表由**迁移 v20** 创建，`database.ts:1361-1378`；SQLite 不能 ALTER CHECK，
   且 `PRIMARY KEY (entity_kind, source_identifier)` 也需要表重建）
   ⇒ 必须**新增一条迁移**，🔴 **绝不可改 v20 的 `up`**（改了所有既有库永久打不开）。
   ⇒ 比"多传一个实参"显眼也难误做得多。**距离出事不是差一步实参，而是差一次迁移。**

4. ⚠️ **oracle / 不变量的一切查询必须使用**全限定表名**，禁止 `LIKE '%record%'` 式取名**：
   `'record'` 这个 token 至少有 **4 种互不相干的语境** ——
   ① 台账 `entity_kind`（含 Rust 硬编码的 4 处）；② `ImportEntityKind`（**恰恰没有** `record`）；
   ③ **spool 内部表** `xml_units.kind` = `'record' | 'events'`（`main.rs:202`/`:207`）；
   ④ `import_source_tombstones`（workout-only）。
   ⇒ 用模糊匹配写断言会同时命中 spool 表，产生**假绿**。
3. 📌 **引用卫生**：`docs/SLEEP_HRV_DESIGN.md:755` 写的 `database.ts` 951 已漂移，**现为 1001**。
   这类行号引用不要当判据用（属「把文档当实测」的同族）。

### 2.10 工程流程现状（交付侧）

| 项 | 现状 | 证据 |
|---|---|---|
| `rust:build` 不支持 `--target` | 硬编码 `cargo build --release --locked --workspace` | `scripts/rust-worker.mjs:21` |
| `rust:verify` 只人工跑 | 含 cargo test + 2 个 Node 测试（`RAI_REQUIRE_RUST_TESTS=1`） | `:22-27` |
| CI 通路不存在 | `ci.yml` 是 GitHub Actions 语法，远端只有 gitee | `docs/RUST_DATA_ENGINE.md:64-66` 自认 |
| 双引擎基准未通过 | `parity.checked = Boolean(reference && successfulRust > 0)` | `apps/api/src/benchmark-import.ts:76-78` |
| ⚠️ **基准成本比纸面高 4 倍** | `--runs 3 --engine typescript,rust` 实为 `3 × 2 modes(shadow/off) × 2 engines = 12 次试验`，每次都从备份恢复一份库 | `:44-47` |
| 队列可查，但"清空"无端点 | 有 `GET /v1/import-jobs/active`（返回 active 或 null） | `apps/api/src/routes/import-routes.ts:111` |
| 部署文档 Rust 覆盖不足 | `deploy/README-CLOUD-2C2G.md` 只有 3 行概括（`:11/:33/:110-112`，无 rsproxy、无 `/opt/rai-native`、无 4 变量同批写入）；`README-UBUNTU.md` **零** rust | 实测 grep |

---

## 三、方案：四个阶段

### P0 —— 补测量面与防线（纯读 / 纯工具，零生产风险）

| # | 动作 | 交付物 | 验收标准 |
|---|---|---|---|
| **P0-1** | `parseImport` 加细粒度 sub-stage 计时：`unzip` / `xmlDecode` / **`spoolConsume`（TS 侧逐行 JSON.parse 重放）** / `gpx` / `writeCandidates` | 一张 26.5s 的构成表 | 各 sub-stage 之和与总时差 < 5% |
| **P0-2** | 把 `importEquivalence` 扩到**产物级**：① 域清单补 `xml_units`、`import_entity_changes`（带 `batch_id` 过滤）；② 排序键**显式固定**，不再从列名推导；③ `removed` 行的 `content_hash` 特判 | 新的 `importEquivalence` + 一份「域 × 是否覆盖 Rust 写路径」矩阵 | 对同一份数据，TS 引擎与 Rust 引擎产出的所有 Rust 相关域哈希相等 |
| **P0-3** | 写路径不变量（见 §四），落到导入后自动检查 | 3 层不变量 + 报警路径 | 对每条不变量**做一次突变**（人工注入错误）⇒ 必须报警 |

> ⚠️ P0-2 的排序键改动会让**历史基线哈希全部作废**。这是可接受的，但**必须在文档里明写**，否则下次部署会把"哈希变了"误读成数据变了。

### P1 —— 低成本硬化（改代码，但不碰生产数据）

| # | 动作 | 位置 | 验收标准 |
|---|---|---|---|
| **P1-1** | 把 `apply-records` 的空转断言补成真断言：在候选库里独立数一次 `COUNT(health_records)` 增量 / `COUNT(import_entity_generations WHERE generation=<本次>)`，与 Rust 自报数比对 | `native-worker.ts:161-163` / `native-record-writer.ts:58` | 突变「让 Rust 少写 1 行」⇒ 必须报警 |
| **P1-2** | **跨语言契约测试（conformance）**：同一份合成 XML/GPX，TS 参考实现与 Rust 必须给出相同的 `(rows, sha256, record.id, content_hash, category)`。同时把 §2.6 的 source-tombstone 语义写成断言 | 新测试文件，挂进 `rust:verify` | 突变 Rust 的 `number()`/`timestamp()`/`name()` 任一处 ⇒ 必须红 |
| **P1-3** | `rust:build` 支持 `--target` 透传 | `scripts/rust-worker.mjs:21` | `--target x86_64-unknown-linux-musl` 能产出产物 |
| **P1-4** | 修 `import_entity_generations` diff 域的**假报警**：限定为「增量 + 原生路径」才比较 | P0-2 的域定义 | 原子路径导入不再报警 |
| **P1-5** | **死代码标注 + 词表守卫**：给 `planRecompute` 标「零生产调用方」，并加一条断言禁止 oracle 用模糊匹配取名 `record`（见 §2.9c 守卫 1、4） | `incremental.ts:66` / 新断言 | 引入 `LIKE '%record%'` 式查询 ⇒ 必须红 |

> 🔴 **P1-3 只在有明确目标时才做**。走 musl 需要本机装 `x86_64-linux-musl-gcc`，而 2026-09-19 实测**沙箱拦住了 `brew install`**（Exit 137）。若仍走云机就地编译，P1-3 无收益 ⇒ **默认不做**。

### P2 —— 拿数字后再决定扩容（**当前一律不做**）

每个候选必须先同时满足**四条门槛**，缺一即否决：

| 门槛 | 阈值 |
|---|---|
| ① 占比 | P0-1 显示该环节 ≥ 全流程 **15%** 且 ≥ **3 s** |
| ② 纯度 | 该环节是**纯计算**，无需复刻 JS 对象键顺序 / 浮点 / 时区行为 |
| ③ 可证 | P1-2 的 conformance 测试能证明等价 |
| ④ 内存 | 在 2C2G 上峰值内存增加 **≤ 100 MiB**（当前 cgroup 峰值已贴 `MemoryHigh=1100M`） |

候选池（**排序仅为假设，等 P0-1 的数字来证伪**）：

| 候选 | 位置 | 先验判断 |
|---|---|---|
| TS 侧 spool **逐行 JSON.parse + SAX 重放** | `apple-health-parser.ts:481-498` | 🟡 **最可疑**：它就在 26.5s 里，且是纯计算 ⇒ 若 P0-1 显示它占大头，这是首选（把 record 装配整段下沉，而不是只下沉 tokenizer） |
| 多路由爬升聚合 | `main.rs:440`（现仅单路由） | 🟡 取决于多路由 workout 占比，需先数 |
| `canonicalize.ts` 的 O(n²) 两两重复判定 | `canonicalize.ts:277` | 🟡 算法问题多于语言问题 ⇒ **先在 TS 里修**，不该作为 Rust 化的理由 |
| `gpx-parser.ts:62` 剩余部分 | | 🟡 `route_points` 已是 Rust 解析、TS 落库 |
| `recompute-pipeline` 特征/负荷热循环 | `recompute-pipeline.ts:963/1323/1801` | ⚪ 关掉 shadow 后只剩约 13 s ⇒ 占比大概率不达门槛 |
| `audit.ts` 扫描 | `audit.ts`（739 行） | ⚪ 非导入热路径 |
| 睡眠/HRV 规范化 | `canonicalize-nights.ts` | ⚪ 体量小 |

### P3 —— 明确否决

| 否决项 | 理由 |
|---|---|
| 把 `stableId` / `JSON.stringify` / 日期规范化搬进 Rust | `docs/RUST_DATA_ENGINE.md:19-23` 已把它定为**刻意的兼容边界**；搬过去等于制造第二套 ID 生成器 |
| 评分内核 / API 层 Rust 化 | 无性能证据；且 API 层是 I/O 密集，收益近零、风险极高 |
| 「把影子对照开回来」当等价防线 | 它**从不覆盖写路径**（§2.3），且贵 27% ⇒ 花钱买了个不相关的保证 |
| 用 `data:benchmark` 的 `parity` 单独替代 P0-2/P0-3 | `parity` 严格弱于产物级比较；且**绝不能用 `--runs` 在 2C2G 上跑**（实在要跑用 `--runs 1`，12 次 → 4 次） |
| 拆分 755 行的 `main.rs` 为多 crate | 单文件、单一职责、无共享状态；拆分只增加构建时间与 ABI 面 |
| 现在扩覆盖面 | §一 的 1/2/3 空白未补，扩容无法归因也无法验收 |

---

## 四、写路径自动不变量（P0-3 的具体内容）

因为**影子对照从不覆盖写路径**，需要一个**廉价、可自动、能报警**的替代。分三层，成本从 O(1) 递增：

### L0 已有（保留）
- 候选库文件名 + 一次性许可（`main.rs:492-520`）
- `observedRecords === count`（`native-record-writer.ts:58`）
- 协议元数据自洽（`native-worker.ts:145-163`）

### L1 写入侧守恒（**建议新增，O(1)，纯计数**）
在候选库发布前断言：
1. `insertedRecords + tombstonedRecords + skippedUnchanged === observedRecords`
2. `ΔCOUNT(health_records) === insertedRecords`（tombstone 只计数不删行）
3. `COUNT(import_entity_generations WHERE generation = <本次>) === observedRecords − tombstonedRecords`
4. `本次 batch 的 imported+updated 计数 === summary.insertedRecords + summary.updatedRecords`

⚠️ 断言 3 必须**限定为增量 + 原生路径**才启用（§2.7 的假报警）。
⚠️ **不要**断言「`content_hash` 是 64 位 hex」（`removed` 行存的是 `entity_id`，§2.9）。
⚠️ **不要**配 `removed ⟹ !exists`（台账在删除前写）。

### L2 导出侧交叉恒等式（**建议新增，O(n) 但已是现成查询**）
- `entity_inventory` 按 `type` 分组计数 vs `health_records` 分组计数必须自洽
- 与上一次成功导入的 `GET /v1/data-summary` 做差：**任何计数下降都要报警**（"缺失≠删除"，见 `NOTES-data.md`）
- `issues: []` 从"附加核对"**正式升为闸门**（这一条线上已在用，但只是靠人扫一眼）

### L3 抽样对照（**可选，"shadow 的抽样替身"**）
从候选库随机抽 **N = 200** 条 record，用 TS 参考实现重算 `content_hash` 与来源分类，逐条比对。
成本 O(200) 而非全量；**能抓到系统性错误，抓不到低频错误** —— 这个局限必须写进文档，不能吹成等价保证。

---

## 五、staged 发布顺序（每批独立可判定）

| 批次 | 内容 | 闸门（可判定） | 回滚 |
|---|---|---|---|
| **B1** | P0-1 + P0-2 + P0-3（**纯工具/纯读**） | ① 新增 sub-stage 之和与总时差 < 5%；② 新等价工具对同一份数据、两引擎哈希相等；③ 每条不变量突变到红 | 无生产影响，代码回退即可 |
| **B2** | P1-1 + P1-2 + P1-4（**纯断言**） | `npm test` + `npm run rust:verify` 全绿；且**每条新断言突变一次必须红** | 断言红了说明真有问题，不是回滚对象 |
| **B3** | 用 P0-2/P0-3 的产物在**本机**对同一份备份跑一次双引擎对照 | 所有 Rust 相关域哈希相等；产出**首个可信的双引擎数字** | 无 |
| **B4** | 依据 B3 数字开一次决策会，**只选满足四条门槛的项** | 四条门槛逐条打勾 | 每项都受 `RAI_IMPORT_ENGINE=typescript` + restart 一行回滚 |
| **B5**（可选，低峰期） | 若要做多月份一次性全量导入：**先临时开回 shadow 跑一轮** | `issues: []` 且投影一致 | 关回 `off` |

🔴 **B1 / B2 不涉及任何线上变更**，可以立刻做。
🔴 **B3 之后才允许谈 B4**。在 B3 之前谈扩容就是"没有仪表盘就调发动机"。
🔴 如需在 2C2G 上跑基准：**先把 `--runs` 从 3 降到 1**（12 次 → 4 次），并停在下游任务之后。

---

## 六、交付侧必须补的三件事（与 P0 并行）

| # | 缺什么 | 动作 |
|---|---|---|
| 1 | **二进制升级协议是纸面话** | 现状只有 `GET /v1/import-jobs/active` 可查在飞任务，**没有"排空/清空队列"的端点或命令**。要么补一个受控端点，要么把"手工确认 active 为 null 后才换二进制"写成 `rai-deploy` skill 的**硬步骤** |
| 2 | **部署文档 Rust 通道空白** | `deploy/README-CLOUD-2C2G.md` 只有 3 行概括；`README-UBUNTU.md` 零。需把 `docs/RUST_DATA_ENGINE.md`「云服务器就地构建实录」的精简版并入（rsproxy 双镜像 / `/opt/rai-native` 仓库外 / 4 变量同批写入 / 停服编译） |
| 3 | **无 CI ⇒ `rust:verify` 无入口** | 远端是 gitee，GitHub Actions 不触发。最省事的方案不是重写 CI，而是：**把 `rust:verify` 挂进 `rai-deploy` skill 的发布前 checklist**，并在 `docs/RUST_DATA_ENGINE.md:64-66` 保留现有的"CI 从不运行"警示 |

---

## 七、我不确定的地方（未核实，不得当结论用）

1. `parseImport` 26.5s 内部的真实分布 —— **这就是 P0-1 要回答的**，现在任何"先搬 X"的判断都是猜。
2. 多路由 workout 的实际占比 ⇒ 决定 `aggregate` 扩容收益。
3. `data:benchmark` 在 2C2G 上一次试验的真实墙钟（未跑过）。
4. `import_entity_changes` 的 `unchanged` 值是否存在**非 TS 写入方**（如手工运维脚本）—— 我只全仓 grep 了 `*.ts`。
5. Rust 侧 `peakRssKiB` 是全进程峰值，**不能当服务峰值**；L1/L2 不变量对内存的额外开销未实测。

---

## 八、一句话总结

**这一阶段的目标不是"多写 Rust"，而是"让每一次 Rust 改动都能被证明是对的"。**
先拿到 26.5s 的构成表（P0-1）、把等价比较面扩到真正被改的写路径（P0-2）、
给写路径装上会响的报警（P0-3）；然后才谈扩容 —— 且必须先过四条门槛。
