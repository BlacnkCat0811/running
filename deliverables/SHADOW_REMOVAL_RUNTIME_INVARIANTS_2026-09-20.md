# RAI 去除影子对照 · 运行时自洽防线方案

> 决策（小唐，2026-09-20）：**不保留影子系统/影子对照；一次改到位直接上线；问题在运行中发现。**
> 本文只给方案，不含任何已执行的改动。所有"事实"均亲验到 `文件:行号`；未能核实的单独列在 §8。
> 本方案取代 `deliverables/RUST_REFACTOR_PHASE2_PLAN_2026-09-20.md` 中**依赖 shadow 的两条**（详见 §0.2）。

---

## ⚠️ 实施结果（2026-09-21）——与本文计划的偏差，读本文前先读这段

`docs/RUST_DATA_ENGINE.md` 的「运行时写路径不变量（B1–B5）」是**当前生效口径**（含 B3/B4 的两条硬约束）；
下表只记录"计划 → 实际"的偏差与原因，**本文 §3 的表格不要当作实现说明读**。

| 项 | 计划写法 | 实际实现 | 原因 |
|---|---|---|---|
| B1 | 「`native-worker.ts` 不改」 | **改了**：`NativeResult` 增 `canonicalDigest`，增 64 位 hex 校验；`NativeOptions` 增 `purpose?: "replay"` | 摘要要穿透协议层就必须改；`purpose` 用于把 B3 的重放排除在 `rai:native-engine` 指标之外，否则 `rustCalls` 凭空翻倍 |
| B1 | 结果写 `import_issues` 一行 pass | **只写失败/降级**：摘要缺失写 `invariant.b1.digest_unavailable` 警告；违规直接抛 | 每导入一次就往 issue 表灌 5 行 pass，会让 `data-summary.issues` 这个告警通道失去意义（线上该表当前 0 行）。"检查跑了没有"由 B1 的降级警告覆盖 |
| B2 | `== observed − tombstoned` | **改为单边不等式 `≤`** | 一个 id 可在载荷里出现多次（`device` 不入 id）⇒ 台账行数合法地少于 `observed − tombstoned`，等式会在真实导出上假阳性 |
| B3 | `inserted == 0 && tombstoned == 0` | **只断言 `inserted == 0`** | 🔴 `tombstoned` 是读取侧计数，两遍必然相同；断言为 0 会在"载荷重新引入已删除记录"这个合法输入上**让导入失败** |
| B3 | `apply()` 每次导入都重放一遍 | 🔴 **改为仅增量批次重放**，`--replace` 跳过 | 审查实测（探针）：`--replace` 下 `batchId` 为 undefined ⇒ 台账 `ledgerCount()` 恒 0，而 Rust `if let Some(batch)` **根本不写台账** ⇒ 台账断言是 `0 === 0`；`inserted` 又被 `this.incremental &&` **必须**关闭（replace 下 worker 重写每一行 ⇒ 第二遍必然等于全行数）。剩下 `observed`+摘要均为输入侧性质、B1 已覆盖，而重放要**重写全部行**且 `purpose:"replay"` 让该开销不上报 ⇒ 纯损失。原注释称台账增量是 "mode-independent assertion"，**该说法不成立** |
| B4 | 在 `import-dataset-analysis.ts` 重派生 `change_type`/`effective_at`/`content_hash` | **移到 `native-record-writer.ts`**，比对落盘后的 13 个内容列 + 台账行存在 | canonical 中转在 CLI 退出后即被删除，API 侧拿不到；比对列也改为"worker 实际写进候选库的列"，才能覆盖跨语言字面量失配 |
| B4 | 「抽 N≈64 条非 tombstone 行」 | **取尾部 + 按 id 去重** | 🔴 取头部会拿到被后续同 id 行覆盖的旧内容 ⇒ `<id>.device` 假分歧。取尾部时"晚于窗口起点的出现必在窗口内"⇒ `DESC` 下首次出现即全局最后写入 |
| B5 | 补 `import_entity_changes` | 另补 `route_file_fingerprints` | 在真库（325 MB / 45 表）逐一比对后确认：它是**导入产物**（GPX 路径写 `route_id`、`pruneOrphanRoutes` 维护），而其余未覆盖表属重算/模型产物、用户覆盖或批次台账 |
| B5 | 排序键改主键，理由记为"实测 **21.7 s → 3.0 s**（约 6×）提速" | 🔴 **该理由被推翻（2026-09-21 更正）**：改按主键的正当理由是**正确性**，不是提速 | 受控探针（本机 324 MB 库、预热缓存、3 轮中位数、隔离排序键单一变量）得 OLD **5,790 ms** → NEW **6,919 ms**，即**慢约 19%**。冷缓存首跑 21,708 → 11,516 ms ⇒ "21.7 s" 出自**冷首跑**，"3.0 s" 冷热都不出现，属跨条件拼接。根因：主键（有索引）打头 ⇒ SQLite 选该索引，但索引次级序与完整 `ORDER BY` 不匹配 ⇒ 计划变成「索引扫描 + 回表 + 排序」，比「全表扫描 + 排序」更贵。`route_points` **−20% 是唯一改善**；`import_entity_changes` **+82%**、`import_entity_generations` **+101%**；叠加域清单 20 → 22 ⇒ **工具整体比改动前更慢** |

**突变验证已做（本文 §3.3 要求）**：B1 改分隔符 → 红（报 `rust=`/`ts=` 双摘要）；B4 改比对列 → 红（报出 `<id>.type`）；
B4 改回头部采样 → 红（报出 `<id>.device` + `<id>.raw_attributes_json`）。探针已清零，无残留。

**两处计划外缺陷**（都是"不变量自己成为故障源"，均已修 + 已加回归用例）：见 `docs/RUST_DATA_ENGINE.md`
同名章的两条 🔴 约束；B4 的回归用例在 `packages/health-export-parser/test/native-worker.test.ts`。

---

## 0. 这次决策改变了什么

### 0.1 收益是确定的

影子对照的开销分两部分，你的决策砍掉的是大头：

| 部分 | 位置 | 成本 | 处置 |
|---|---|---|---|
| **跑第二遍完整重算**（extractFeatures → replayTrainingMetrics → replayModel） | `recompute-pipeline.ts:253/257/259` | **18.3 s**（占导入总量 27%） | 🔴 删除 |
| 比对本身（7 条 SQL 哈希） | `recompute-pipeline.ts:285-333` | 零头 | 🔴 连同删除 |

顺带消失的还有：`recordCache.clear()` 的缓存失效、`allowNativeAggregates = false` 对原生聚合的**主动禁用**（`recompute-pipeline.ts:212-213`）——这项副作用一直在让 shadow 期间的爬升聚合退回 TS。

### 0.2 代价必须写明，不能含糊

**影子对照提供的信号是"跨界等价"：Rust/增量路径的结果 == 独立全量重放的结果。**
它一删，这个信号就**永久失去**，且本方案的所有替代手段都**严格弱于它**。区别在于：

- shadow 证明的是「**两条独立路径结果相同**」；
- 下面 §3 的不变量证明的是「**自己的账对得上**」。

后者挡得住"少了/多了/重复了/没写台账"，**挡不住"两边一致地算错"**。这是在"不跑第二遍"前提下的**数学下限**，不是方案没做好。我建议你把这句话当成接受本方案的前提。

---

## 1. 🔴 先分清三个都叫 "shadow" 的东西

**这是整份方案里最容易出人命的地方**，因为代码里三处共用一个词，但只有一个该删。

| 名称 | 位置 | 实际是什么 | 处置 |
|---|---|---|---|
| 影子重放 `runShadowValidation` | `recompute-pipeline.ts:239-282` | 跑第二遍完整重算，再和候选比对 | 🔴 **删** |
| 比较器 `compareRunOutputs` | `recompute-pipeline.ts:285-333` | 上述重放专用的 7 域哈希比较；全仓仅 `:261` 一处调用 | 🔴 **删** |
| **模型版本闸门** `evaluateValidationGate` | 调用点 `recompute-pipeline.ts:222-226`；实现 `evaluateValidationGate`（modelRuns） | **incumbent 存在时强制比较新旧模型版本**，失败即抛错阻断激活 | ✅ **必须保留** |

第 3 项的陷阱在于它的**错误信息恰好叫 `Shadow model gate failed`**（`recompute-pipeline.ts:224`），而且代码注释（`:219-221`）专门写了一段话警告：

> Version-to-version comparison is mandatory whenever an incumbent exists. `validationMode` only controls the additional incremental replay check above; **it must not provide a way around the gate.**

也就是说：**作者当年就预料到有人会把这两个混为一谈**。删 shadow 时若顺手删掉这个闸门，等于把"模型版本回退保护"一起拆了——那是比 shadow 重要得多的东西。**保留它，并建议在 `:219` 的注释里把 "Shadow" 字样改成 "Model-version"**，消除歧义。

**同样不能删的**：
- `recompute_validations` 表（`database.ts:1046`，属迁移 `model_checkpoints_and_shadow_validation` `:1025`）。**迁移不可改历史 `up`**（改了所有既有库永久打不开），表留着当空表零成本。
- `ImportJobPerformance.validationMode` 字段（`api-contracts/src/index.ts:377-379`）与 `schemas.ts:511` 的三值 enum —— 理由见 §2.2。

---

## 2. 阶段 A：删除影子重放（**零行为变化**）

线上 `RAI_IMPORT_VALIDATION_MODE=off` 已生效，所以删除这段代码在**运行时是零行为变化**——它只是把"当前靠配置关掉"变成"代码里不存在"。这同时消掉一个同族隐患：**配置写了 ≠ 生效**，代码删了才是真的没了。

### 2.1 删除清单

| # | 文件 | 位置 | 动作 |
|---|---|---|---|
| A1 | `packages/application/src/services/recompute-pipeline.ts` | `:210-217` | 删 `if (validationMode === "shadow")` 调用块（含 `recordCache.clear()` / `allowNativeAggregates` 切换） |
| A2 | 同上 | `:239-282` | 删 `runShadowValidation()` 全函数 |
| A3 | 同上 | `:285-333` | 删 `compareRunOutputs()` 全函数 |
| A4 | 同上 | `:399` | `validationMode` 解析改为忽略该字段（历史 job.request 里仍有此键，勿校验） |
| A5 | 同上 | `:219-224` | 保留闸门；把注释与错误文案里的 "Shadow" 改为 "Model-version" |
| A6 | `packages/application/src/service-types.ts` | `:64`、`:72` | 删 `RecomputeRequest.validationMode` 及 options 里的同名字段 |
| A7 | `packages/application/src/recompute-helpers.ts` | `:237` | 删 `validationMode: options.validationMode ?? "off"` |
| A8 | `packages/application/src/cli.ts` | `:31` | 删 `--shadow-validate` 解析 |
| A9 | 同上 | `:51-52` | 调用不再传 `validationMode` |
| A10 | `apps/api/src/import-worker.ts` | `:124` | 删构造参数 `validationMode` |
| A11 | 同上 | `:481` | 删 `timing.validationMode = incremental ? ... : "not-run"`（默认值 `not-run` 生效） |
| A12 | 同上 | `:494` | 删 `...(this.validationMode === "shadow" ? ["--shadow-validate"] : [])` |
| A13 | 同上 | `:1489` | 白名单里删 `"shadowValidation"`（阶段 C 会用同一处，合并改） |
| A14 | `apps/api/src/import-performance.ts` | `:3`、`:6-14` | 删 `importValidationModeFromEnvironment()` 与未用的 `ImportValidationMode` 类型（`ImportPerformanceTracker` 本体保留，阶段 C 要用） |
| A15 | `deploy/rai.env.example` | `:12` | 删该行（被 `deploy-cloud.test.ts:21` **整行精确匹配**钉住） |
| A16 | `deploy/n100/rai.env.example` | `:11` | 删该行（被 `deploy-n100.test.ts:132` **正则锚定**；该测试的 read 基目录是 `deploy/n100`，见 `:126`） |

### 2.2 🔴 不要做的事：不要收窄 `validationMode` 的 enum

直觉上"删 shadow"就该把 `schemas.ts:511` 的 `enum: ["shadow","off","not-run"]` 缩成两值。**别做**，理由是硬的：

线上在 2026-09-19 之前跑的就是 `shadow`（`docs/RUST_DATA_ENGINE.md:306-310`），因此**历史 job 记录里必然存在 `validationMode: "shadow"`**。而该字段是导入任务出参 schema 的 **required 字段**（`schemas.ts:509` 的 `required: ["validationMode","totalMs","stagesMs"]`）。收窄 enum 会让带 `"shadow"` 的历史记录在出参校验时被拒——**用一次"清理"制造一批查不了的历史记录**。

正确做法：**保留三值 enum，保留字段，只删"能产生 shadow 值"的代码路径**（A1-A16）。字段语义收敛为「本字段恒为 `not-run`；保留仅为兼容既有记录」。
（已核：iOS 与 Web 对 `validationMode` **零引用**——`apps/ios` grep 无命中，`apps/web` 仅命中 CSS 的 `box-shadow`。所以保留字段没有任何客户端负担，纯粹是历史记录兼容。）

### 2.3 同批必须改的测试（否则 `npm test` 必红）

| 文件 | 行 | 现断言 |
|---|---|---|
| `apps/api/test/deploy-cloud.test.ts` | `:21` | 整行精确匹配 `RAI_IMPORT_VALIDATION_MODE=shadow` |
| `apps/api/test/deploy-n100.test.ts` | `:132` | 正则锚定 `^RAI_IMPORT_VALIDATION_MODE=shadow$` |
| `apps/api/test/native-import-worker.test.ts` | `:70` | `validationMode === "shadow"` |
| `apps/api/test/import-queue-live.test.ts` | `:53` | 同上 |
| `apps/api/test/worker.test.ts` | `:1376-1383`、`:1414`、`:1434` | 参数化 `["shadow","off"]` 两态 + `--shadow-validate` 参数断言 |
| `apps/api/test/import-performance.test.ts` | `:12-16`、`:25-36`、`:55` | env 解析 + tracker 用例 |
| `apps/api/test/health-incremental.test.ts` | `:138`、`:218` | `validationMode: "shadow"` 入参 + `recompute_validations` 查询 |
| `packages/application/test/import-replay.test.ts` | `:137`、`:175`、`:153`、`:184` | 同上 |
| `apps/api/test/schemas.test.ts` | `:82` | `required` 三字段断言（**不改**，仅确认仍绿） |

⚠️ 上面两张表（A1-A16 + 测试）分布在 3 个套餐里，属**机械改动**，但必须同批进出——`deploy-*.test.ts` 与 `rai.env.example` 是**整行匹配**，分开提交必红。

### 2.4 阶段 A 的验收

1. `npm run typecheck` 绿
2. `npm test` 绿（基线：node **737 / 733 pass / 0 fail / 4 skip**）
3. `npm run test:ios` 绿
4. `npm run rust:verify` 绿（本机执行，**不在云机跑**）
5. 本机真实导入一次：`/v1/import-jobs/:id` 的 `validationMode === "not-run"`，且 `computeStagesMs` 里**不再出现** `shadowValidation`
6. 线上 `import-jobs.json` 里的历史 job 仍可正常读取（抽 1 条 `shadow` 的历史记录验证）

### 2.5 文档同步 —— 这不是顺手的事

现状是：**代码默认 `shadow`、两个 env 模板推荐 `shadow`、文档明确论证 `shadow` 更安全**。
你的决策把这一切反转，所以文档必须显式改写，否则会留下"文档教人开一个代码里已不存在的东西"。

| 文件 | 行 | 现内容 | 处置 |
|---|---|---|---|
| `docs/RUST_DATA_ENGINE.md` | `:145-147` | 默认值示例含 `RAI_IMPORT_VALIDATION_MODE=shadow` | 删该行 |
| 同上 | `:153-158` | "必须同批写入，缺一不可"的 4 行配方含该变量 | 删该行，配方变 3 行 |
| 同上 | `:160-162` | 🔴 **"保留 `shadow` 作为推荐默认 …… 且它是更安全的姿态"** | **结论反转，必须重写** |
| 同上 | `:310-317` | "已关闭 …… 三大保护"一节 | 更新：① 该变量已不存在 ② **点名"协议级校验不覆盖 `apply-records`"**（§3.1 的 B1 修的就是这个洞，文档不能再把它列为保护之一） |
| `deploy/n100/README.md` | `:58-60` | 变量说明："默认 `shadow` 保留增量与全量重放对照 / `off` 跳过" | 删该变量说明，改为指向 §3 的不变量 |
| 同上 | `:228-230` | 🔴 **"先使用 shadow 验证一轮实际增量 …… 结果异常时切回 shadow"** | **结论反转，必须重写**：该建议已不可执行 |
| 同上 | `:56-57` | "尚未拆成逐个算法的 CPU 时间" | 阶段 C 之后更新为"已拆出 5 个细分子阶段" |

⚠️ 上表两处 🔴 **不是措辞问题，是结论反转**——它们论证的是一个已被否决的方案。
改完必须通读一遍 `docs/RUST_DATA_ENGINE.md` 与 `deploy/n100/README.md`，确认**没有残留"建议启用 shadow"的句子**。
建议在 `docs/RUST_DATA_ENGINE.md` 里留一段决策记录（日期 + 决策人 + 理由 + 替代方案编号），与 R15 那种"引用既有决策"的写法一致。

---

## 3. 阶段 B：运行时自洽不变量（替代防线）

设计原则（对应你"运行中查找问题"的诉求）：

- **不跑第二遍**——只做当事进程内的记账与数据库自对账；
- **默认只记录、不阻断**——先观察一个周期，确认无假阳性后再谈是否升级成 gate；
- **结果随 job 持久化**——这样它天然带 jobId 与时间，可回看趋势，不需要新表。

### 3.1 五条检查项

| # | 不变量 | 挂载点 | 成本量级 | 能捕获 | **捕获不到** |
|---|---|---|---|---|---|
| **B1** | **输入流守恒摘要**：Rust 边读 `canonical_records` 边算 `sha256(每行「n‖id‖content_hash\n」)`（`n`=行序号，两侧均无空洞；**不用 `sequence`**，理由见 §6.3）并回传；TS 侧 `capture()`（`native-record-writer.ts:34`）同公式累计 | Rust `main.rs` `apply_records`（`:488`）+ TS **`native-record-writer.ts:58`**（与现有 `observedRecords` 断言并列，`native-worker.ts` 不改） | 一次流式 sha256，**~0.1 s** | 漏读、重复读、乱序、Rust 读到的输入 ≠ TS 写进 canonical 的输入 | 输入相同但**处理**不同（如 seed 哨兵失配） |
| **B2** | **输出端守恒恒等式**：`COUNT(import_entity_generations WHERE entity_kind='record' AND generation=g) == observedRecords − tombstonedRecords`，且 `inserted + tombstoned ≤ observed`（**必须带 `entity_kind` 才走索引 seek**，见 §6.2） | `apple-health-parser.ts:524-528`（`nativeRecords.apply()` 的计数吸收点）之后；结果用 `insertIssue()`（`database.ts:2156`）写入 `import_issues` | 一次索引 COUNT，**实测 25 ms** | 整批数量级错误、双边计数不一致 | 单行内容错误 |
| **B3** | **幂等重放（原地，不复制——🔴 已定案）**：对**同一候选库 + 同一 canonical 中转**再跑一次 `apply-records`，主断言是 **`import_entity_changes` 增量为 0**；`inserted == 0 && tombstoned == 0` 仅在**增量**模式下成立（全量模式下 `inserted` 语义为"写了多少行"，必然假报警） | `native-record-writer.ts:55-60`（`apply()` 内，store 与 canonical 路径都在手边）；**重跑前必须重写 permit** | 一次 apply-records（实测 338.8 ms）+ 一次 permit 重写，**< 1 s** | 非幂等、重复写、自增计数错、乱序写 | **语义分叉**（哨兵失配时第二次 `updated=false`，仍不报警） |
| **B4** | **抽样重派生**：抽 N≈64 条非 tombstone 行，用 TS 契约从 canonical 重新派生该行，逐列比对 `change_type` / `effective_at` / `content_hash` | `apps/api/src/import-dataset-analysis.ts`（已在做整库 `EXCEPT`，`:127-145`） | **毫秒级** | **语义静默分叉**（B1/B3 都抓不到的那类） | 覆盖率仅 N 条，系统性且一致的错仍可能漏 |
| **B5** | **修正 `importEquivalence`**（工具修复，非新增防线）：① `:25` 去掉列名 `.sort()`／改按主键排序；② `:8-20` 域清单补 `import_entity_changes` | `apps/api/src/import-equivalence.ts` | 实测 **21.7 s → 3.0 s**（约 6×） | 见下方说明 | — |

**B3 的关键设计约束**：它验的是"自己再写一次不变"，**不是**"与 TS 等价"。别把它当 parity 用。它的价值在于用 **0.4 秒**（shadow 的 1/45）覆盖"写路径是否确定性"。

**B5 说明（两个缺陷各自独立）**：
- 排序缺陷：`:24-25` 用 `PRAGMA table_info` 取列名 → 剔 volatile → `.sort()`（字母序）→ `:30` 直接把它当 `ORDER BY`。对 `health_records` 首排序列落到非唯一的 `created_at`，强制全表 temp B-tree 排序。**实测对照 21.7 s vs 3.0 s**。
- 域缺陷：清单里有 `import_entity_generations` / `import_entity_tombstones` / `import_source_tombstones`（台账的两张兄弟表），**唯独没有 `import_entity_changes`（台账本身）**，也没有 `xml_units`。
- ⚠️ 改排序 ⇒ **既有哈希基线全部作废**（这是预期行为，需在报告里标注"基线重置点"）。
- ⚠️ 定位是**离线漂移检测基线**，**不是运行时 parity**。且必须按**受影响集合**（`import_entity_changes(batch_id)` / `changedRouteIds`）取哈希，不是全库——否则在云机 113,876 条上就是几十秒量级，与 shadow 同阶，白改。

### 3.2 为什么 B4 是必须的（一句话）

B1 证明"读得对"，B3 证明"写两次一样"，**只有 B4 能回答"算得对不对"**——它是关掉 shadow 之后**唯一**能廉价抓到语义分叉的手段（例如 `SEED_CONTENT_HASH` 跨语言裸字面量失配那类：投影值相同、台账却灌进海量假 `updated`）。

### 3.3 阶段 B 的验收

1. 本机真实导入一次：job 上五项结果**全部 pass**，且 `parseImport` 耗时与改动前无显著差异（B3 只增 <1 s）
2. **突变测试（必做，否则等于没装）**：人工注入 4 种错误，每种都必须被**对应的那一项**抓到，而不是被别的项顺带抓到：
   - 改 `SEED_CONTENT_HASH` 的 Rust 字面量 → B4 报
   - 在 `apply_records` 里跳过若干行 → B1 报
   - 让 `generation` 计数与 `observed` 差 1 → B2 报
   - 让 `apply_records` 每次强制重写 → B3 报
   **突变后必须回到红，且确认不是"编译错误导致的红"**（这是本项目已踩过的坑）。
3. `npm run rust:verify` 绿

---

## 4. 阶段 C：补齐 `parseImport` 细分计时（空白①）

26.5 s 是导入链路最大的一块，现在是一个只知道总数、不知道构成的数。**"运行中查找问题"要求先有这组数字**，否则后面判断"要不要 Rust 化"永远只能靠猜。

### 4.1 好消息：通道已经存在，**零契约改动**

`import-worker.ts:1488-1496` 已在消费 `rai:compute-performance` IPC 消息：

```ts
if (payload.type === "rai:compute-performance" &&
    ["features","trainingMetrics","modelReplay","shadowValidation"].includes(payload.stage ?? "") && ...)
  this.computeStagesMs[payload.stage!] = (this.computeStagesMs[payload.stage!] ?? 0) + payload.durationMs;
```

而 `computeStagesMs` 是**自由字典**（`api-contracts:380` → `Record<string, number>`；`schemas.ts:514` → `additionalProperties: {type:"number"}`），**没有白名单**。

⇒ 做法极简：
1. `packages/health-export-parser/src/cli.ts` 在 5 个子步骤外层计时，并发 `process.send({type:"rai:compute-performance", stage:"<名>", durationMs})`。子步骤点位（`cli.ts:260-351`）：`parse_health_xml` / `import_gpx_routes` / `canonicalize_workouts` / `canonicalize_nights` / `stage_audit_files`
2. `import-worker.ts:1489` 的白名单：删 `"shadowValidation"`，加上述 5 个名字（**一行改动**，与 A13 合并）
3. **不需要迁移、不需要改 schema、不需要改 `api-contracts`**

### 4.2 通道可行性已核

`command()` 的 stdio 是 `["ignore","pipe","pipe","ipc"]`（`import-worker.ts:1466`）——**IPC 通道现成**，且 CLI 已经在用 `process.send()`（`cli.ts:465-476` 发 removal-guard）。`rai:native-engine` 消息也走这条线（`import-worker.ts:1476-1485`）。

### 4.3 阶段 C 的验收

真实导入一次后，`/v1/import-jobs/:id` 的 `computeStagesMs` 里**5 个新 stage 全部有值**，且 `parse_health_xml + import_gpx_routes + canonicalize_workouts + canonicalize_nights + stage_audit_files` 之和 ≈ `stagesMs.parseImport`（允许 ±5% 的未计时间隙）。
——**"之和 ≈ 总数"这一条本身就是一个免费不变量**：它同时验证了计时点没有漏盖。

---

## 5. 上线顺序：**单批 + 观察期**

你的诉求是"改好直接上线、运行中查问题"，所以不拆五批。但 A/B/C 的风险不同，建议**两个 commit、一次发布**：

| 批次 | 内容 | 为什么可以安全同批 | 闸门（可判定） | 回滚 |
|---|---|---|---|---|
| **批 1** | 阶段 A（删影子重放）+ 阶段 C（细分计时） | A 在线上是**零行为变化**（本来就 off）；C 只加计时。两者共用 `import-worker.ts:1489` 同一行 | `typecheck` + `test`(737/733/0/4) + `test:ios` + `rust:verify` 全绿；本机导入一次，`validationMode==="not-run"`、`computeStagesMs` 五细分齐全且求和≈总数 | `git revert`（纯代码回收，无数据影响） |
| **批 2** | 阶段 B（B1-B5，**先只记录不阻断**） | 不变量只往 job / `import_issues` 写结果，不改变导入成败 | §3.3 的四项突变测试各自命中；本机导入五项全 pass | 关掉对应开关即回退（建议给 B3/B4 各留一个 env 开关）；数据侧无影响 |

**建议**：批 1 先上，跑通一次真实导入；**同一天**再上批 2。两批之间不需要等观察期——因为它们都是"加观测"，不改变行为。真正的观察期在批 2 之后。

### 5.1 上线后运行中看什么（这就是"运行中查找问题"的落点）

| 观测项 | 位置 | 正常形态 | 异常信号 → 动作 |
|---|---|---|---|
| 导入细分耗时 | `/v1/import-jobs/:id` → `computeStagesMs` | 5 项齐全，求和≈`parseImport` | 某项缺失 ⇒ 计时点没跑到；某项突然占大头 ⇒ 下一轮优化的目标（这时才有资格谈 Rust 化） |
| Rust 是否真的在跑 | 同上 → `native` | `rustCalls > 0` 且 `typescriptFallbacks == 0` | `fallbacks > 0` ⇒ **静默退化**，查 `unsupported_xml` 计数 |
| 不变量结果 | **`GET /v1/data-summary` → `issues`**（B1-B5 统一走 `import_issues`，零契约改动；**刻意不进 `job.performance`**——那里是 `additionalProperties:false` 的封闭对象，见 §6.6） | 五项全 pass（各带 `code`，如 `invariant.b1.input_digest`） | 任一项 fail ⇒ 立刻查该 job，不要等下一个 |
| 库级问题清单 | `GET /v1/data-summary` → `issues` | `[]` | 非空 ⇒ 按 `code` 分类；`import-dataset-analysis.ts:127-145` 已在做"本次 vs 上次"的 issues 差分，**本次新增的 issues 就是本次引入的问题** |
| 导入总耗时 | 同上 | 应因 A 而下降 | 若未下降 ⇒ 说明线上本来就没在跑 shadow，需确认 `RAI_IMPORT_VALIDATION_MODE` 的历史生效时间 |

⚠️ **不给具体阈值数字**（如"某项 > 5 s 就优化"）。阈值只能当参数，不能当验收标准；判据是"哪一项占了大头"这个形态，不是某个拍定的秒数。

---

## 6. 我不确定的地方

> **本节已于 2026-09-20 21:xx 全部核实**（小唐要求"确定问题真实再实施"）。核实结果直接写在各条下方，结论有变化的标准 **🔴 已定案**；行号有漂移的标 **📌 已校正**。

1. 🔴 **已定案：B3 采用「原地重跑」，不复制候选库。**
   **实测依据**：候选库 = CLI 的 `--database stagingDatabase`，由主库 online backup 产生 ⇒ 体积 ≈ 主库（本机 `var/rai.sqlite` = **310 MB**）。复制它是纯浪费，且线上磁盘余量未测（可能踩 R13）。
   **"二次写脏"为什么不是理由**：B3 检测到非幂等的**唯一场景**就是"这批数据不可信、必须丢弃"——而候选库本来就要被丢弃（`import-worker.ts:593` 的 `removeDatabaseFiles(stagingDatabase)`）。所以二次写脏**不产生任何额外损失**。
   **技术前提已核实成立**：`native-record-writer.ts:42-43` 在 apply 前 `COMMIT` + `close` 了 canonical 库，但**文件不删**（清理发生在 `cli.ts:390` 的 finally，且只清 staging 库；canonical 的清理在 `import-worker.ts:599` 的 `rm(nativeSpoolRoot)`）；`:52-54` 每次调用都重新 `randomBytes(32)` 写 permit ⇒ **原地重跑不需要新机制**。
   🔴 **但必须加三条约束**（否则 B3 自己会成为假报警源）：
   - **①只在增量模式断言 `inserted === 0 && tombstoned === 0`**。全量模式（`incremental=false`）下 `inserted` 的语义是"**写了多少行**"而非"新插入多少行"（`main.rs:582-584`：`if !incremental || !exists { inserted += 1 }`）⇒ 第二次重跑 `inserted == observed`，**必然假报警**。
   - **②重跑前必须重新写 permit**。第一次跑完 Rust 已在事务内 `DELETE`（`main.rs:594-597`），不重写会以 `invalid staging permit` 失败（`main.rs:497-503`）。
   - **③主断言应该是 `import_entity_changes` 增量为 0**，而不是 `inserted`。第二次 `exists=true`、`previous=hash` ⇒ `updated=false` ⇒ 台账不写（`main.rs:566-567`）。这条比 `inserted` 更本质——它直接决定下游重算计划（`import-dataset-analysis.ts:34`）。
2. 🔴 **已实测：B2 的 `COUNT` 成本可忽略，且必须写成复合条件才走索引。**
   本机 310 MB 库实测：`WHERE generation=?` → `SCAN ... USING COVERING INDEX`，**49 ms**；`WHERE entity_kind='record' AND generation=?` → `SEARCH ... (entity_kind=? AND generation=?)`，**25 ms**。
   （⚠️ 索引 `idx_import_entity_generations_generation` 的**前导列是 `entity_kind`**，所以只按 `generation` 过滤用不上 seek。）
   ⇒ 原稿"预计远低于此"成立；**B2 定稿用复合条件形态**。原 3.1 s 那个数字绝大部分是 `sqlite3` CLI 的进程启动 + 打开 310 MB 库的开销，不是查询成本。
3. 🔴 **已定稿：B1 的摘要公式不需要改 Rust 的 SELECT。**
   公式：`digest = sha256( 每行 "(n)|id|content_hash\n" )`，`n` 为**行序号从 1 递增**。
   为什么用行序号而非 `canonical_records.sequence`：Rust 的 query **没有 SELECT `sequence`**（`main.rs:544-546`），加列要动 SELECT；而两侧都用"第 n 行"等价且更省事——TS 侧 `capture()` 的 `this.count++`（`native-record-writer.ts:34`）从 1 开始且**无空洞**（每次调用必 insert），Rust 侧 `observed += 1`（`main.rs:545`）覆盖全部行且也**无空洞**（`observed` 在 tombstone 判定之前自增）。
   📌 **挂载点校正**：TS 侧的**比对点**不在 `native-worker.ts:154-163`，而在 **`native-record-writer.ts:58`**——那里已有 `observedRecords !== this.count` 这一行，把 digest 比对并排放下即可（`native-worker.ts` 无需改，其 `worker_metadata` 自洽检查 `:157-159` 对新增字段天然通过）。
   ⚠️ 最后一条自检：**两侧任一出现跳过，公式立刻失去意义**。实现时必须在这个断言失败时把两边的 n 一并打出来（否则只会得到"摘要不等"这一个信息量极低的消息）。
4. **线上 `import-jobs.json` 里 `validationMode: "shadow"` 的历史记录条数**：📌 **未能核实——沙箱内 `ssh root@tpandmr.xyz` 22 端口超时**（`ConnectTimeout=8` 后 `Operation timed out`）。**结论不受影响**：§2.2 保留三值 enum 的依据是"2026-09-19 之前线上跑的就是 `shadow`"（`docs/RUST_DATA_ENGINE.md:306-310` 是实测记录），只要**曾**有一条就足以让收窄 enum 成为破坏性改动。实施时无需先拿到这个数字。
5. **`import_issues` 的生命周期**：✅ **已核实，与描述一致**——`database.ts:2473` 的 `DELETE FROM import_issues` 位于 `seedImportGenerations` 内，而后者只在 `incremental` 时调用（`apple-health-parser.ts:248-253`）⇒ 每次**增量**导入重置问题清单，`--replace` 全量不会。它反映"最近一次增量导入"而非历史日志；长期趋势必须看 job 记录（§5.1 已按此设计）。
6. **`ImportStage` 是否要同步扩展**：✅ **已核实——不必扩展，但发现一个原稿漏标的约束**。
   细分走 `computeStagesMs`（自由字典，`api-contracts:380` + `schemas.ts:514` 的 `additionalProperties: {type:"number"}`）**零契约改动**这个判断成立。
   📌 **但 B 阶段（不是 C 阶段）若要新增字段进 `job.performance`，会撞 `schemas.ts:508` 的 `additionalProperties: false`**（`performance` 对象是封闭的，`import-performance.ts:35-41` 的 `snapshot()` 结构被 `:509-511` 的 `required` 钉住）。
   ⇒ 🔴 **决定：B1-B5 的结果不走 `performance`，统一走 `import_issues`（`insertIssue()`，`database.ts:2156`）**。这样 B 阶段也是**零契约改动**，且 `import-dataset-analysis.ts:127-145` 的"本次 vs 上次"EXCEPT 差分直接可用（新增的 issues 即本次引入的问题）。原 §5.1 表格里"不变量结果 → 同上 → 新增字段"已按此更正为"→ `data-summary.issues`"。
7. ~~`--shadow-validate` 是否被文档或部署脚本引用未全量 grep~~ → **已核实**：该参数仅出现在 `import-worker.ts:494`、`application/src/cli.ts:31`、`worker.test.ts:1414` 三处，**无文档、无部署脚本引用**，可安全清除。
   同一轮 grep 暴露了原清单的两处遗漏，均已在文中补齐：`deploy/n100/rai.env.example:11`（第二个 env 模板 ⇒ 新增 **A16**）、以及 **§2.5 的文档同步表**（7 处，其中 2 处是结论反转）。
8. 🔴 **新发现（原稿完全没提）：删掉 A1 后 `allowNativeAggregates` 会变成"恒真字段"。**
   它有三个触点：定义 `recompute-pipeline.ts:148`、**唯一的两处切换** `:213`（置 false）/`:216`（置回 true）、以及 `:859` 的消费判断 `if (this.allowNativeAggregates && this.nativeElevationGains?.has(workoutId))`。
   A1 删掉 `:213/:216` 之后，该字段恒为 `true`，`:859` 退化成 `if (this.nativeElevationGains?.has(workoutId))`。
   **实施决定：保留字段与 `:859` 的判断不动**（属最小改动原则——删它要连带改 `:148` 与 `:859`，而它现在是"永远为真"，无行为影响）。但**必须在 A1 的改动注释里写明**，否则下一个人会以为这个开关还活着。这是与 §1「三个 shadow」同类的"名字还在、语义已死"陷阱。
9. 📌 **§2.5 两处行号微调**（核实后的精确值，原文偏 1 行）：`deploy/n100/README.md` 的"尚未拆成逐个算法"实际在 **`:55-56`**（原写 `:56-57`）；"先使用 shadow 验证一轮"整句在 **`:227-229`**（原写 `:228-230`）。`docs/RUST_DATA_ENGINE.md` 的 `:145-147` / `:153-158` / `:160-162` / `:310-317` 与 `deploy/n100/README.md:58-60` **均准确**。
