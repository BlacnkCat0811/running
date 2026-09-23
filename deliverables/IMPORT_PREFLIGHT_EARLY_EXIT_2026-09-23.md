# 导入早退：载荷级 pre-flight

> 日期：2026-09-23　范围：`apps/api` 导入链路（`import-worker.ts`）的 `unchanged` 早退机制
> 承接：`IOS_EXPORT_DETERMINISM_P0P1_VERIFICATION_2026-09-23.md` 里那条**自认没做完**的遗留瓶颈——
>
> > 「虽然没替换主库，但『判断有无变化』本身还是把备份、复制、解析和对比这几步给跑了一遍。
> > 如果是线上 506 MB 的大库，这一步依然有开销，后续需要进一步优化早退机制。」
>
> 结论先行：**已修。** 新增一道**载荷级 pre-flight**，位置在 `createCurrentBackup` **之前**。
> 命中时该次导入**不备份、不复制暂存副本、不解析 XML、不做全表对比**；判据只读**载荷**
> （元数据 + GPX），**开销与主库大小无关**。本机实测：载荷摘要 5.6 ms/MB，
> 而它替掉的备份 9.6 ms/MB + 复制 3.7 ms/MB 是 O(主库)。

---

## 0. 一句话结论

| # | 结论 | 分级 | 性质 |
|---|---|---|---|
| 1 | 旧 `unchanged` 只省掉了**最后一步**（换主库 + 重算）；`backup`→`stagingCopy`→`parseImport`→`changeAnalysis` 四步**照付**，判据本身也是 O(主库) | 🔴 已修 | 读代码 + 实测 |
| 2 | 新判据：**「这份载荷就是产生当前主库的那一份」**，而不是「这份载荷的数据没变」。后者不成立（见 §2.3） | 🟢 已落地 | 读代码 |
| 3 | 判据三重守卫：非删除型载荷 · 主库存在锚点 · 锚点绑定的 `dataset_version` 未被后续导入改写。任一不成立即退回完整路径 | 🟢 已落地 | 实测（3 条守卫各有反例测试） |
| 4 | 锚点写在**暂存库**、随激活进入主库 ⇒ 锚点不可能先于它所描述的数据出现；激活失败回滚时一并消失 | 🟢 已落地 | 读代码 + 实测 |
| 5 | **一处新增的主库写入**：`unchanged` 判词路径尽力刷新锚点。不刷新则契约/引擎变更会让捷径**永久**失效（判词一直是 `unchanged`，走不到激活路径，锚点再也写不回去） | 🟡 有意为之，需评审 | 读代码 |
| 6 | **语义变化**：pre-flight 命中路径不再跑 `PRAGMA quick_check`。理由：那道校验保护的是**写入**（"不要在坏库上增量导入"），而这条路径不写任何一行、也不产备份 | 🟡 有意为之，需评审 | 读代码 |
| 7 | 实测（本机暖缓存）：载荷摘要 **5.6 ms/MB**；库在线备份 **9.6 ms/MB** + 暂存复制 **3.7 ms/MB**。载荷通常远小于库 ⇒ 这笔账在线上 2C2G 上只会更划算 | 🟢 实测 | 实测 |
| 8 | `source_xml_sha256` 自身仍含 `<ExportDate>`，影响 `import_batches.xml_sha256`（审计）与 `model_runs.dataset_version`（版本标记） | 🟡 仍待排期（**本次未动**） | 读代码 |
| 9 | **锚点的失效依赖人工递增 `CONTRACT_VERSION`**：`stableId` / 内容哈希这类**派生算法**变更，载荷一个字节都不变、`dataset_version` 也不变，锚点会继续命中 ⇒ 新算法进不了库 | 🔴 已知边界，已写进模块注释 | 读代码 |

---

## 1. 旧链路到底还在付哪些钱

`ImportWorker.run()`（`apps/api/src/import-worker.ts:449` 起）原顺序：

| # | 步骤 | 旧 `unchanged` 是否付 | 复杂度 |
|---|---|---|---|
| 0 | `readImportReceipt` | 付（廉价） | O(1) |
| 1 | `createCurrentBackup` → 在线备份 + `quick_check` | **付** | **O(主库)** |
| 2 | `stagingCopy` → `copyFile(备份, 暂存)` | **付** | **O(主库)** |
| 3 | `parseImport` → spawn CLI，全量解析 XML 写入暂存 | **付** | O(载荷) + O(写入) |
| 4 | `changeAnalysis` → 暂存 vs 备份全表 diff | **付** | O(主库) |
| 5 | `recompute` | 早已跳过 | — |
| 6 | `activateDatabase`（rename 换主库） | 早已跳过 | — |

即：所谓 `unchanged` 早退，只挡住了第 5、6 步。用户看到的「本地 9.3 秒」就是第 1–4 步。

**根因**：判据建立在**暂存库与备份的对比**上，而暂存库必须先由备份复制出来。
也就是说"判断有没有变化"这件事本身依赖于已经付掉的那笔 O(主库) 成本。

---

## 2. 新判据是怎么定的

### 2.1 不能复用的两个现成值

- `source_xml_sha256`：`apple-health-parser.ts:547` 对**整个 XML 文本**（含 `<ExportDate>`）做 sha256。
  iOS 每次导出都会重写 `<ExportDate>` ⇒ 数据一行没变、指纹每次都变。**拿它当"变没变"的判据就是上一轮那条通道 D。**
- `dataset_version`：`cli.ts:344` 由上面那个指纹派生 ⇒ 同样随墙钟漂移。

两者都只能证明"变了"，不能证明"没变"。**新判据必须是重导出能复现的东西**，所以复用了
`import-sources.ts:254` 的 `digestHealthKitExportContent`——它剥掉 `<ExportDate>`、
纳入 sync-manifest 语义（`version`/`sourceScope`/`deletedSourceIds`）与全部 GPX 内容，
是上传去重已经在用的稳定摘要。

### 2.2 锚点绑定什么

锚点键 `import_manifest['source_payload_anchor']`，值是
`{"sha256": <组合摘要>, "datasetVersion": <写锚点时的 dataset_version>}`。

组合摘要（`importPayloadSha256`，纯函数）折进四件事，任一变则身份变：

| 输入 | 为什么必须进摘要 |
|---|---|
| 载荷内容摘要 | 内容本身 |
| `CONTRACT_VERSION` | 解析契约变了，同一份载荷会写出不同的行 |
| 删除语义（`preserveAbsent`） | 同一份字节，删除型与非删除型的行为不同（见 §2.3） |
| 执行引擎（`typescript`/`rust`） | 换引擎就是换写入实现 |

### 2.3 「相同载荷」≠「无操作」——两个必须挡的反例

这条是设计里最关键的一步。字节相同**并不**蕴含这次导入无操作：

1. **另一来源插入过。** 两个来源可能携带**同一个** `canonical_workout_id`。A 导入后 B 导入了
   自己的版本，此时重放 A 会把实体**改回 A 的值** ⇒ 真实判词是 `incremental`，不是 `unchanged`。
2. **删除事件的回魂。** 先导入 A（载荷含实体 W），再来一次只带 `deletedSourceIds` 的删除同步
   把 W 删掉，然后 A 被原样重放。W 会被**重新插入**（`import_entity_tombstones` /
   `import_source_tombstones` 全库只在"变更检测"里被读，**从不**在插入时被读——
   `import-dataset-analysis.ts:219`、`import-equivalence.ts:13`；导入路径里 0 处引用）。

两个反例都由**同一条守卫**挡住：锚点记录的 `dataset_version` 必须与主库**当前**的相等。
任何后续导入都会改写 `dataset_version`，于是锚点失效、退回完整路径。
方向是安全的：`dataset_version` 漂移过头只会少省一次，不会多省一次。

### 2.4 明说的残差风险

- **主库被带外改写**（手写 SQL、只恢复了部分表）而不改 `dataset_version`：守卫看不见。
  正常的整库恢复**不在此列**——恢复会把锚点一起带回当时，两个值自洽，判据仍然成立。
- **载荷目录在导入过程中被改动**：锚点摘要算在导入**之前**。但这条路径本来就不支持——
  CLI 先读 XML、后读 GPX，中途改动会导入一份撕裂的载荷。
- **`quick_check` 频率下降**（见 §0 第 6 条）：坏库会多存活到"下一次真实导入"才被判出。
  期间 `activateDatabase` 后的那道强校验、`restore-journal`、`import-publication` 的恢复路径都还在。

---

## 3. 改动面

| 文件 | 改动 |
|---|---|
| `apps/api/src/import-payload-identity.ts` | **新增**。组合摘要（纯函数）、从导出目录算摘要、锚点读写（读含 `dataset_version`，读失败一律降级为「无锚点」） |
| `apps/api/src/import-worker.ts:505-548` | pre-flight 调用 + 命中后的终态（`importMode: "unchanged"`、`recomputeReasons: ["payload_identity_unchanged"]`、`backupName: null`） |
| `apps/api/src/import-worker.ts:620-624` | `unchanged` 判词路径：尽力刷新锚点（§0 第 5 条） |
| `apps/api/src/import-worker.ts:671-672` | 成功路径：把锚点写进**暂存库** |
| `apps/api/src/import-worker.ts:882-957` | `payloadSha256` / `detectUnchangedPayload` / `countTrainingSessions` / `recordPayloadAnchor` |
| `apps/api/test/import-payload-preflight.test.ts` | **新增** 9 条 |

`contracts` / `api-contracts` / Web **零改动**：pre-flight 的时间记在已有的 `changeAnalysis`
阶段名上（它与真正的对比互斥，同一任务只会走其中一条），摘要不回传客户端。

`import_manifest` 表、`ImportStage` 枚举、`ImportJobSummary` 契约均未扩展。

---

## 4. 验证

### 4.1 新增测试（`apps/api/test/import-payload-preflight.test.ts`，9/9 通过）

| 测试 | 钉住的东西 |
|---|---|
| 身份随四个输入变化 | 内容 / 删除语义 / 契约版本 / 引擎，且同输入可复现 |
| 内容摘要忽略导出墙钟、但能发现真数据 | 重导出（只换 `<ExportDate>`）身份不变；加一条 Record 立刻变 |
| 锚点往返 + 坏锚点读作「无」 | 含 4 种畸形值（非 JSON、缺字段、空串）× 必须降级为无锚点 |
| **首次导入写入锚点，第二次相同同步整段跳过** | `commandCount` 保持 1（未再调 CLI）；`backup`/`stagingCopy`/`parseImport` 三个阶段**不存在**；`var/backups` 目录内容逐项相同；无残留 `rai.importing.*`；`unchangedWorkouts=3` |
| 删除型载荷不早退 | 锚点按删除语义记录（摘要**会**匹配）⇒ 拒绝只可能来自守卫；再补一条同语义命中作为对照 |
| 库在锚点之后动过即失效 | 改掉 `dataset_version` 后同一载荷不再命中 |
| 身份不同仍走完整路径 | `commandCount=1` 且 `backup` 阶段存在 |
| 载荷读不到＝退回完整路径而非失败 | 无 `export.xml` 时 `detectUnchangedPayload` 返回 `null`，导入仍照常调用 CLI |
| 锚点能穿过真实激活落到主库 | 强制走激活路径后，主库锚点 = 期望组合摘要 + `dataset_version` |

### 4.2 门禁

```
npm run typecheck            → 通过（tsc -p tsconfig.pure.json && tsc -p tsconfig.json）
新测试（单跑）                → 9 tests / 9 pass / 0 fail
node 全量（含新测试）          → 809 tests / 805 pass / 0 fail / 4 skip
对照：排除新测试文件            → 800 tests / 796 pass / 0 fail / 4 skip
```

**skip 数的说明**：4 条 skip 与本次改动无关——排除新测试文件单跑同样是 4 条。
（项目记忆里"3 条 skip"是旧基线，本次一并校正为 4，未追查具体条目归属；0 fail 是重点。）
本机 Rust 二进制在 `target/release/rai-data-worker`（2026-09-22 构建）存在，`native-worker.test.ts` 未走跳过分支。

### 4.3 实测成本（本机，暖缓存，VMware 虚拟机）

合成夹具（128 MB `export.xml` / 299 MB 库）：

| 项 | 实测 | 单位成本 | 外推到线上 506 MB 库 |
|---|---|---|---|
| 载荷摘要（新增成本） | 717 ms | 5.6 ms/MB | 300 MB 载荷 ≈ **1.7 s** |
| 在线备份（被替掉） | 2 880 ms | 9.6 ms/MB | ≈ 4.9 s |
| 暂存复制（被替掉） | 1 095 ms | 3.7 ms/MB | ≈ 1.9 s |
| **被替掉的合计** | **3 975 ms** | — | **≈ 6.7 s（仅这两步）** |

还另加被整段跳过的 `parseImport`（全量 XML 解析 + 写入）与 `changeAnalysis`（全表左连接 diff）——
这两项本机没有可用的真实载荷/真实库夹具，**未实测**，按代码路径只能确认它们不再被调用（§4.1 有断言）。

**方向上要诚实说明**：载荷本身很大时（例如 300 MB 的完整导出），pre-flight 要先把载荷读一遍，
这笔 1.7 s 在"确实有变化"的导入里是**净新增开销**（相对 30–90 s 的完整导入约 2–5%）。
换来的是"没有变化"时分母侧那 6.7 s + 解析 + diff 全部归零。iOS 走的是**部分窗口**载荷，
载荷/库体积比很小，这笔账更划算。

### 4.4 未验证 / 无法验证

- 线上 506 MB 库的真实耗时：本次**没有**云机通道（`lighthouse-ops` 未连接），未做线上实测。
- 真实 300 MB `export.xml` 的解析成本：本机无此夹具，未实测。
- 两个来源交替导入的端到端行为：只有单测级证据（守卫失效测试），无真实双来源夹具。

---

## 5. 验收标准

1. 同一载荷连续同步两次：第二次 `performance.stagesMs` 中**不存在** `backup`/`stagingCopy`/`parseImport`，
   且 `var/backups` 无新文件 —— §4.1 第 4 条已覆盖。
2. 任何一条守卫失效（删除型载荷 / 库在锚点之后动过 / 载荷身份不同 / 载荷读不到）必须走完整路径，
   **且不得把导入变成失败** —— §4.1 第 5–8 条已覆盖。
3. 主库锚点与 `dataset_version` 同生共死：锚点在暂存库写入、随激活落入主库 —— §4.1 第 9 条已覆盖。
4. `npm run typecheck` 与 node 全量 0 fail —— §4.2 已覆盖。

## 6. 回滚方式

改动是**纯增量**、且有单开关式的行为边界（无锚点 ⇒ 与旧行为完全一致）：

- **紧急**：删掉主库 `import_manifest` 里的 `source_payload_anchor` 行 ⇒ 下一次导入立即回到旧路径，
  **不需要改代码、不需要重启**。
- **代码**：`git revert` 本轮的三个文件即可；`import-payload-identity.ts` 是新增文件，
  删除它 + 撤销 `import-worker.ts` 的四处引用即完全还原。
- **数据**：锚点是 `import_manifest` 里的一行，不参与任何哈希（`import-equivalence.ts` 的
  `manifest` 域只取 `parser_contract_version`/`source_xml_sha256`/`source_gpx_bundle_sha256`/`dataset_version`），
  **不改变任何既有比对基线**。
