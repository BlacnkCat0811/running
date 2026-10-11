# 导入发布模型 · 多智能体对抗式审查与优化方案

日期：2026-10-11（Asia/Shanghai）
对象：RAI（`/Users/tp/running`）「每次同步整库换文件」的发布模型
触发：用户「只要设备有新原始记录就必须整库换掉，**我觉得这个设计不对**」
方法：`multi-agent-adversarial-audit` 流程（3 个专项智能体 + 1 个红队 + 主代理逐条复核）

---

## 1. 结论先行

**用户的直觉是对的，但"不对"的地方不是"要不要换库"，而是三件事叠在一起放大了它：**
① 一次导入里**整库写 3 遍**（冗余 1 遍）；② **两次全库 `quick_check`** 合计 ≈459 s，占 77%，而两次都不能删（见 §3.3）；
③ 库里 **67% 是原始记录、20% 是只增不删的变更台账**，导致"库永远大于内存"。

**更关键的一条更正**：本次实测的 `data-only` 导入**确实带了 18 条新原始记录**（台账 `record inserted 18`），
⇒ **"提前判定后跳过发布"不是免费午餐**（跳过 = 丢数据，且客户端 cursor 已推进不会重发）。

### 按优先级排的 3 件事

| 序 | 做什么 | 为什么是它 | 代价 / 风险 |
| --- | --- | --- | --- |
| **1** | **云机内存 2 GB → 4 GB**（零代码） | 唯一能让**两道**校验都变便宜的杠杆（热态比冷态快 ~48×，仓库自测 506 MB：冷 11,993 ms → 热 260 ms）。且同时缓解"导入期间 API 变慢"——同一根因（库 > 内存） | 升配费用；回滚=降配。⚠️ **前提未实测**：4 GB 是否真能装下 2.06 GB 库 + 工作集（见 §7 U1） |
| **2** | **裁剪变更台账**（保留最近 N 批） | 台账族 **416 MB / 20%**，220 批里最近 2 批只占 ~7k 行 / 735,361 行 ⇒ 可回收 **~99%** | ⚠️ **单向门**：必须先证明无跨批依赖（见 §7 U2） |
| **3** | **去掉一次冗余整库拷贝**（3 次 → 2 次） | 纯浪费，零语义风险：每次少写 ~2 GB、少 8.6 s | 低。用 flag 切回即可 |

---

## 2. 讨论怎么进行的

- **证据底座**（先落盘，所有智能体读同一份）：`/tmp/rai-import-evidence/EVIDENCE.md`、
  `CONSTRAINTS_AND_PRIOR.md`。含三次真实导入的完整阶段耗时、`PRAGMA dbstat` 逐表字节、
  独立对照测量（备份 12.4 s / `quick_check` 203.8 s / 顺序读 306 MB/s）、管线 `文件:行号` 全图。
- **3 个专项智能体**（按风险维度切，不按目录）：**存储架构与事务**（S）、**数据口径与不变量**（D）、
  **运维成本与客户端节奏**（O）。
- **1 个红队**：拿到三份摘要后做「推翻/降级 / 矛盾 / 修了会更糟 / 单一最高杠杆 / 三人漏掉的」。
- **主代理逐条复核**（本节最重要）：红队的"最高杠杆"**被我推翻**（见 §4.1），
  `cli.ts:197-202` 的原文**证实**了红队对 D-top1 的批评（见 §3.3）。

**最有价值的产出**：一是 S 与 D 对「能不能原地追加」的**直接冲突**被红队用代码判死；
二是红队指出「四位都没算过**降次数 vs 降单次成本**的量级对比」；三是**我对红队的纠正**——它的 top1 会丢数据。

---

## 3. 我独立复核后确认成立的问题

### 🔴 3.1 一次导入写整库 3 遍（实测值 + 读码）

| # | 位置 | 实测 |
| --- | --- | --- |
| 1 | worker `backupCopy`（`apps/api/src/import-worker.ts:1030`） | 23,393 ms |
| 2 | worker `stagingCopy`（`:554`） | 8,630 ms |
| 3 | **CLI 内部再备份一次**（`packages/health-export-parser/src/cli.ts:160`，由 `:255` 调用、`:400-403` rename 回 worker 的 staging） | `computeStagesMs.prepare_staging_copy` **7,662 ms** |

⇒ 每次导入约 **6.2 GB 写**；第 3 次在 API 阶段名里看不出（只在 CLI 的 `computeStagesMs` 里）。
**建议**：CLI 增"原地变更指定库"模式，或 worker 与 CLI 二选一。**验收**：`stagingCopy` +
`prepare_staging_copy` → ≈0；峰值磁盘 −2 GB。**回滚**：保留旧 copy 路径，用 flag 切回。

### 🔴 3.2 变更台账只增不删，且占总库 20%（实测）

- `import_entity_changes` **735,361 行 / 133 MB**，加两个索引 **284 MB**；`import_entity_generations` 95 MB
- **保留批次总数 220**，平均 **3,343 行/批**（735,361 ÷ 220）；最近一批只有 **18 行**
- **全仓无自动裁剪代码**（grep 无 `DELETE FROM import_entity_changes`）；存在手工的
  `prune-tombstones-cli.ts`（默认 365 天，作用于 tombstone 而非台账）
- 消费方基本都带 `batch_id` 过滤（`import-dataset-analysis.ts:33-34,66-67,75-78`、`health-change-plan.ts:34-37`）

**建议**：按 batch 保留窗口裁剪（N=2 即可，只差一次早退/复算）。
**验收**：`import_entity_changes` 族 284 MB → **<20 MB**；同一 staging 库上 `analyzeDatasetChange` 的
mode 与改前逐个一致。**⚠️ 单向门**：裁剪不可逆，须先证否跨批依赖（§7 U2）。
**回滚**：停用裁剪任务（已删的行不可复原）。

### 🔴 3.3 「去掉装库后那道全库校验」= 拿掉 CLI 明确依赖的兜底（**原文证据**）

`packages/health-export-parser/src/cli.ts:197-202` 原文：

> 这里原本跑 `PRAGMA quick_check`……换成结构探针的依据见 `probeDatabaseStructure` 文档：
> ① 交付的库是本进程刚写完的，发布后再全库扫描属于重复校验；
> ② **发布闸门（`import-worker.ts` 的 `activateDatabase`）仍保留一次 quick_check 兜底 —— 页内损坏会在那里被拦下并触发回滚。**

⇒ CLI 已经把自己那道换成了**结构探针**，并**显式依赖** `import-worker.ts:1570` 那次全库校验作为唯一
页级防线。**删掉它 = 页内损坏可被发布。**
**结论：这道校验不能删**（红队对 D-top1 的批评成立，我复核后确认）。
唯一可讨论的是**它能不能变便宜**——那就回到 §1 的三件事（让库进内存 / 让库变小），而不是删闸门。

### 🟡 3.4 `healthkit_record_facts`（587 MB，全库最大表）每次导入逐行重写

`packages/health-export-parser/src/apple-health-parser.ts:470-471` 只被 `!tombstoned` 门控，
**未用 `observation.updated`**（紧邻的 `insertRecord` 在 `:468-476` 用了）；
`packages/storage-sqlite/src/database.ts:2623-2627` 是无条件 `INSERT OR REPLACE`。
**建议**：门控为 `observation.inserted || observation.updated`。
**验收**：一次"无新记录"的导入后该表 page 变化 ≈0。**回滚**：还原该条件。
⚠️ **必须同时证明**：`CONTRACT_VERSION` bump 后仍强制重写，否则"新算法永远进不了库"
（不变量 A#8）。

### 🟡 3.5 备份策略在 2.06 GB/份的现实下名存实亡

- 线上 `/etc/rai/rai.env`：`RAI_BACKUP_MAX_COUNT=14`、`RAI_BACKUP_MAX_TOTAL_BYTES=10 GiB`
  （**代码默认是 20 GiB / 10 份**，`maintenance.ts:80-84`）⇒ 实际保留 = `min(14, ⌊10 GiB ÷ 2.065 GB⌋)` = **4 份**
  （与线上 `ls var/backups` 实测 **4 个文件**一致）
- 每次导入前另写一份 ⇒ 4 小时定时备份**活不过几分钟**就被挤掉
- 写量级：96 次导入/天 × (备份 2.06 + staging 2.06 + CLI 内部 2.06) ≈ **590 GB/天**（推算，非实测）

**建议**：仅当 `mode ∉ {data-only, unchanged}` 才写 pre-import 备份；或改硬链接/快照。
**验收**：`ls var/backups | wc -l` 稳定且存在一份 >1h 的定时备份。**回滚**：恢复调用点。

### 🟢 3.6 导入期间没有任何实时阶段可见性

`job.progressPhase/Current/Total` 全仓**只被读、从未被赋值**（`data.ts:1940-1957` 读），
`performance` 只在 `finally` 落库（`import-worker.ts:777`）⇒ 导入中只能看到 `phase` + `message`。
**建议**：在每个 `measureStage` 边界把 `{stage, elapsedMs, rssKiB}` 写进 job。
**验收**：导入中 `curl /v1/runtime-status` 能看到当前 stage 与递增的 elapsedMs。

---

## 4. 红队推翻/降级的，以及**我对红队的纠正**

### 4.1 🔴 红队的"单一最高杠杆"（提前判定后跳过发布）**被我推翻**

红队主张：*把 `data-only`/`unchanged` 判定前移到备份之前*，理由是"那 595 s 的一次系统花了 459 s 才知道
分析层无变化"。**这个前提是错的**，我用实测把它推翻了：

```
本批台账行数 18
  record inserted 18        ← 这次导入确实插入了 18 条新原始记录
```

⇒ `data-only` **不等于"什么都没变"**，它表示"只有原始记录变了、分析产物没变"。
这 18 条记录**必须落库**；跳过发布就是**丢数据**——而且客户端 cursor 已经推进，**不会重发**。
⇒ 红队那条 top1 若照做，会静默丢健康数据。**这是本轮最危险的一条建议，已废弃。**

### 4.2 红队判对的（我复核确认）

| 红队判定 | 我的复核 |
| --- | --- |
| S(b)「iOS 载荷恒 `preserveAbsent:true` ⇒ 纯 upsert、无删除」**被推翻** | ✅ 成立。`apps/ios/RAI/HealthKitExport.swift:419-420` 确实写 `deletedSourceIds` / `deletedRecords`；服务端 `sync-manifest.ts:25-38` 照读 ⇒ 导入 = **upsert + delete**。"原地追加"不能以这条理由成立 |
| S(d)「CLI 取同名锁会撞」应降级 | ✅ 成立。锁名 = `${target}.import.lock`（`publication-lock.ts:164-165`），CLI 锁的是 **staging**，今天并不撞；只有"改成原地写主库"才会撞 |
| D(b) facts 逐行重写成立、但**排序被高估** | ✅ 成立。其成本被 `parseImport` 64.6 s 封顶（整轮 ~11%），不该排进 top2 |
| O(b)「保留 4 份」算术成立、但**前提未证** | ✅ 成立且已补证：线上 env 确实是 10 GiB（我此前读过 `/etc/rai/rai.env`），`ls` 实测 4 个文件 |
| O(c)「加内存 ⇒ 两次都快」只有第一道有依据 | ✅ 成立。仓库那个 260 ms 是 **506 MB 库在顺序全读之后**测的；第二道打在**刚 install 的新库**上 ⇒ 必须实测（§7 U1） |
| O(d)「17 类记录」与代码不符 | ✅ 成立。`HealthKitExport.swift:456-501` 是 15 固定 + 3 可选 = ≤18 |
| O(e) 进度不可观测 | ✅ 成立（见 §3.6） |

### 4.3 红队自己漏掉的一条（我补上）

红队强调"裁台账是单向门"，但**没给出定量依据**。我实测补上：**220 批 / 735,361 行 / 均 3,343 行每批**
⇒ 保留最近 2 批约 6.7k 行 ⇒ 可回收约 **99%** 的台账族（416 MB → ~4 MB）。
**这才是"该不该做"的判断依据**：收益极大、但必须先把跨批依赖证否。

---

## 5. 门禁实跑结果（本次讨论期间的真实执行）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 干净（P0-a 插桩改动后复跑） |
| `node --import tsx --test apps/api/test/worker.test.ts` | ✅ **94 项 / 93 通过 / 0 失败 / 1 跳过**（跳过项是平台条件式） |
| Node 全量套件 | ✅ **1550 项 / 1545 通过 / 1 失败 / 4 跳过**；那 1 个失败已修（`import-payload-preflight.test.ts` 9/9） |
| `npm test` 的 Web 段 | ✅ 25 文件 / 184 项 |
| pre-commit（`check-blob-size` / `typecheck` / `check:docs` / §16.1 矩阵 / 包边界） | ✅ 全过（提交 `4c09d20`、`8990526`） |

⚠️ 提醒：`run-tests.mjs:21` 明确「两个 suite 无论前面失败与否都会跑完」⇒ 只看 `npm test` 的 `tail`
**不能**推断 Node 段通过，必须单独跑并抓 `# pass / # fail`。

---

## 6. 需要**用户先做决定**的事（产品/授权，不是代码问题）

1. **新鲜度 vs 频率**：客户端 15 分钟投递（`HealthKitSync.swift:105`、`BackgroundSyncPolicy.swift:61`）
   是产品特性。降到 60 分钟能把占空比 67% → ~17%，但**这是产品取舍**，我不替你决定。
   ⚠️ 且实测依据不足：投递由 `HKObserverQuery` 回调驱动（`HealthKitSync.swift:415-419`），
   `enableBackgroundDelivery(.hourly)` 只是下限 ⇒ **改常量未必真降频**，需要 iOS 侧投递间隔日志才能证明。
2. **是否升配**（2 GB → 4 GB）：涉及费用。
3. **`data-only` 是否要改成"原地追加"**：见 §7 U3 —— 现有证据**不足以**支持，需要先出分库/原地写 POC。

---

## 7. 明确不建议动的 + 我没查的

### 不建议动
- **`import-worker.ts:1570` 的全库校验**：`cli.ts:197-202` 明写它是唯一页级兜底（§3.3）。
- **`data-only` 原地追加**（当前证据下）：载荷带显式删除（§4.2）+ WAL 跨库不原子 +
  `installDatabase` 是裸 `rename`（一次只能原子发布一个文件）+ tombstone 回魂风险 ⇒ 需要完整 POC 才能谈。
- **`payloadHash` 每次变**：ADR-004 明确是**有意设计**。

### 我没查的 / 证据不足（宁可留白）
- **U1**：4 GB 内存下**第二道** `quick_check` 到底多快。可证伪实验：`drop_caches` 后对 2.06 GB 库
  **连跑两次** `quick_check`，看第二次是否 ≈ 第一次的 1/10。（**这是第 1 步的前提，未做**）
- **U2**：台账裁剪会不会破坏「纯补史导入」的跨批依赖（`recompute-pipeline.ts:400-428`
  的 `sourceBackfillEvidence`；近期提交 `cebb0dc` 正是"纯补史导入解死锁"）。
  ⇒ 必须先在 `/tmp` 副本上跑一遍"裁掉旧批 → 再走补史导入"，看是否变红。
- **U3**：真实线上载荷里 `deletedRecords` 非空的**频率**（决定"删除是常态还是边角"）。
  可取 `/var/lib/rai/var/imports/*/extracted/sync-manifest.json` 或历史来源统计。
- **U4**：分库后**全部读路径**是否都是单库只读（代码里分析层用 ATTACH `previous` 做跨库只读比对，
  `import-dataset-analysis.ts:25`，但我没有穷举所有读路径）。
- **U5**：备份写量 590 GB/天的算式是**推算**（频率实测、每份字节实测，但"3 次写"里第 3 次的
  实际落盘量未用 `iostat` 实测过）。

---

## 8. 证据文件清单

- `/tmp/rai-import-evidence/EVIDENCE.md` —— 实测数字底座（硬件 / 三次导入阶段耗时 / dbstat 逐表字节 /
  独立对照测量 / 管线 `文件:行号` 全图 / 触发链）
- `/tmp/rai-import-evidence/CONSTRAINTS_AND_PRIOR.md` —— 12 条不变量 + 已查清事项（防重复）
- 本文档 §3/§4 中每条论断均可从上述文件 + 下列代码位置复算：
  `import-worker.ts:551,554,688,693,1019-1044,1538-1600`、
  `import-dataset-analysis.ts:232-237`、`cli.ts:160,197-210,255`、
  `apple-health-parser.ts:468-476`、`database.ts:2597-2606,2623-2627,2742-2749,2787-2792`、
  `HealthKitExport.swift:419-420`、`HealthKitSync.swift:105,415-419`、`publication-lock.ts:164-165`
- 关联：`deliverables/API_HANG_TRIAGE_2026-10-11.md`（本次事件的完整处置与取证档案，§1–§14）
