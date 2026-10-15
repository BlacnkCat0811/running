# RAI 同步数据与数据处理链路审查报告 · 2026-10-15

> 审查对象：**同步数据链路**（iOS ↔ 服务端直连同步：协议 / 车道 / 批次预算 / 收敛重传 / 导入落库）
> ＋ **数据处理链路**（解析 → 规范化 → 落库 → 派生计算）。
> 基线 commit：`7532ff0`（工作区干净，无未提交改动）。审查方式：**全程只读，未修改任何代码**。
> 方法：4 路子智能体并行只读审查（服务端同步 / iOS 同步端 / 导入落库 / 派生计算）
> ＋ 主智能体**逐项抽样复核**（重点项读码亲验、1 项以 git worktree 定点突变实证）
> ＋ 门禁实跑。**结论以主智能体复核后的口径为准；未复核项已逐条标注。**

---

## 一、总结论

**健康度：🟡 中（无 P0；1 条 P1、8 条 P2 为实际待修项）。**

最近 5 天（10-10 ~ 10-15）连续修复了 6 个批次的历史缺口（收口后遗症、上界放宽、尾页根治），本轮审查确认**这些修复的主体实现是正确的**；新发现集中在三类"接缝"：
① 收口（`ed556a3`）删旧链路时的**遗漏与半接续**（data-only 死键、守卫假绿）；
② **跨端对齐面**（服务端 ↔ iOS 的 code/上界/注释随时间漂移）；
③ **测试可信度**（假绿 1 例已突变实证、窗口盲区 1 例、夹具差变量 1 例）。

| 维度 | 评级 | 一句话 |
|---|---|---|
| 服务端直连协议（apps/api direct-sync） | 🟡 | 无 P0/P1；边界测试存在"历史事故窗口"盲区；inspect 乐观 `ready` |
| iOS 同步端（尾页根治 P0–P2b） | 🟡 | 主实现（写前判定/先判后取/有界重导）读码正确；**门禁假绿已实证**；循环耗尽不落档 |
| 导入与落库（parser/storage/worker） | 🔴→🟡 | **data-only 准入死键（P1）**：测试绿/生产死；其余为死代码与不可达测试 |
| 派生计算（scoring ~ model-eval） | 🟡 | `recoveryIsolationHolds` 恒真（激活门判据无信息量）；其余以低风险/未复核为主 |
| 门禁与测试可信度 | 🟡 | 1 例假绿**已突变实证**、1 例窗口盲区、1 例夹具自写键；另有 1 例资源型超时（环境） |

---

## 二、质量门禁实跑（主智能体独立实跑）

| 门禁 | 结果 | 证据（日志） |
|---|---|---|
| `npm run typecheck`（双 tsconfig） | ✅ **EXIT=0** | `.workbuddy/runlogs/audit20261015-typecheck.log` |
| direct-sync 定向 7 文件（node --test） | 🟡 44 tests / 43 pass / **1 fail** | `.workbuddy/runlogs/audit20261015-directsync-batch.log`；唯一 fail = `direct-sync-handshake-capability` 的 60s 超时（**资源型**：当时 4 路子智能体并行；隔离单跑 **4/4 绿**，`.workbuddy/runlogs/audit20261015-handshake-isolated.log`） |
| `direct-sync-http-acceptance.test.ts`（单文件） | ✅ **9 tests / 9 pass / 0 fail（EXIT=0，3m58s）** | `.workbuddy/runlogs/audit20261015-http-acceptance.log` |
| `npm run test:ios` | ✅ **EXIT=0（7m57s）**：`iOS 门禁通过（类型检查 + 纯逻辑回归）`；含 `check-background-capabilities` **284/0**（⚠️ 其收敛三条判据的有效性问题见 P2-1）、export determinism 14/0、direct-sync 契约 parity 13 条、analysis reconcile 43 条 | `.workbuddy/runlogs/audit20261015-ios-gates.log` |
| `npm run check:docs`（新增文档索引验证） | ✅ **EXIT=0**（61 文件 / 433 链接 / 0 问题） | 本批两份报告已挂 README 索引 |
| check-background-capabilities.py **突变实证** | 🔴 假绿已证实（见 P2-1） | 两次实跑输出内嵌于 P2-1；证据归档 `.workbuddy/runlogs/mutation-audit-20261015.log` |

> ⚠️ 环境记录：本沙箱下并发跑重测试会被 SIGTERM 掐断（一次实测 137），且 60s 启动窗口会被资源争抢击穿。上述失败与超时均按"环境证据 + 隔离复验"处理，未计为代码缺陷。

---

## 三、分级问题清单

### P1-1 · data-only 快通路的准入门槛引用"无写入方"的死键 —— 测试绿 / 生产死

- **位置**：`apps/api/src/data-only-import.ts:91`（`compatible()` 第 5 个条件）、`:127`（早退点）、`apps/api/src/import-worker.ts:34`（unused import 佐证）。
- **证据（主智能体已复核）**：
  - `compatible()` 要求 `import_manifest.data_only_baseline_contract === dataOnlyBaselineContract()`（`data-only-import.ts:86-93`）；不满足 ⇒ `applyDataOnlyImport` 在 `:127` 返回 `null`（快通路拒收）。
  - **全仓非测试代码中该键零写入方**：`grep -rn data_only_baseline_contract apps/api/src packages/*/src scripts/` ⇒ 仅 2 处，均为**读取**（`:83` / `:91`）。
  - 删除链：`ed556a3`（收口提交）移除了旧链路里唯一的生产写入（候选库 `INSERT OR REPLACE INTO import_manifest(key,value) VALUES ('data_only_baseline_contract',?)`，见 `git show ed556a3 -- apps/api/src/import-worker.ts`）。
  - **测试夹具自写该键**：`apps/api/test/direct-sync-prohibited-operations.test.ts:187`（`store.setManifest("data_only_baseline_contract", dataOnlyBaselineContract())`）⇒ 夹具自己让 `compatible()` 为真，测试全绿；生产库无维护者。补充复核：**测试侧写入共 11 处、分布于 8 个文件**（`setManifest` 8 处 + `UPDATE import_manifest` 2 处 + `DELETE` 1 处），另有一条**刻意**不写该键的对照（`direct-sync-ingest.test.ts:92` 注释 + `:634` 断言键不存在）。
- **影响**：对**从未写过该键的库**（新库 / 键失效库），record-only 快通路恒不合格 ⇒ 全部载荷落到统一接收器（`direct-sync` 车道）。功能等价、无数据正确性影响；代价 = 一条设计车道实质死亡 + 每次同步多一次无效的 data-only 评估 IO。
  ⚠️ **两点必要限定（防误用）**：① 对由旧链路（`ed556a3` 之前）写入过该键的库**不必然成立**——若键残留且值恰好等于当前契约值，`compatible()` 为真；此类库是否存在**无法从代码判定**（需查线上库实际键值，超出本次只读范围）。② 这不等于"data-only 是死代码"——它是"结构上不可达的**回退分支**"；判"补齐写入方"或"删除该门槛"皆可，但**不能靠测试绿推断其在生产可用**。
- **建议方向**：把该键的写入接回新链路（建议随 `direct-sync`/`data-only` 的成功提交事务内刷新，或删除该门槛并同步契约与文档）；补一条"生产形态夹具"（不预写该键）的用例，证明快通路真能走通。
- **复核状态**：✔ 主智能体已复核（零写入方 + 早退逻辑 + 夹具自写键三点亲验）；分支计数等细节由补充复核确认（见 §补录）。

### P2-1 · iOS 收敛接线门禁假绿 —— 已以定点突变实证（接线全拆，284/0 绿）

- **位置**：`apps/ios/tests/check-background-capabilities.py:1617-1626`（两条判据）；被测量对象 `apps/ios/RAI/HealthKitSync.swift:1141,1142,1302,1355`（四处接线）。
- **证据（主智能体突变实证，git worktree 内完成、`prune` 收尾）**：
  - 判据原文：`check("loadBudgetConvergence()" in sync and "saveBudgetConvergence(" in sync, "…no longer wired into the export path…")` —— 纯子串检查。
  - **突变 A（拆掉全部 4 处接线、保留函数定义）**：计数从 `3/2/2` 降到 `1/1/1`（各只剩函数定义行），门禁输出 **`284 checks, 0 failed`，EXIT=0**。
  - **反证 B（再把 3 个函数定义改名 ⇒ 子串消失）**：门禁 **`284 checks, 2 failed`，EXIT=1**，红的两条正是："the budget convergence memory is no longer wired into the export path…" 与 "nothing ever clears the convergence…"。
  - ⇒ 结论：**这两条判据测量的是"函数名是否存在于文件"，对"是否被接线"零测量力**；其失败消息声称的监测目标（wired / no-op）与实际测量目标（名字存在性）错位。该形态与脚本自己记录过的历史事故（`clearTask` 改名 ⇒ 判据恒真，见脚本头注释 `tail_after` 的由来）同族，但这两条**没有**走 `tail_after` 保护。
- **影响**：若后续提交把导出路径的收敛叠加（`HealthKitSync.swift:1355`）或 inspect 的推进/落盘（`:1141-1142`）删除，门禁不红 —— 而这三处正是 10-14 刚修复的 P1b/P2b 语义（收敛是否 no-op、是否会永久缩档）。等于"修复的防回退网"在该点上失效。
- **建议方向**：把判据改为可区分"定义 vs 调用"的形态（例如在导出路径切片内断言 `loadBudgetConvergence()`、或断言 `"= loadBudgetConvergence()"` / `".applying("` 调用形态），并为新判据做一次"删调用点必须红"的突变验证。
- **复核状态**：✔✔ **主智能体已突变实证**（三层证据：读判据源码 / 突变 A 绿 / 反证 B 红）。

### P2-2 · P2b 重导循环耗尽时不落收敛档 —— 每轮白读一遍 HealthKit

- **位置**：`apps/ios/RAI/HealthKitSync.swift:1400-1404`。
- **证据**：`attempt += 1; guard attempt < DirectSyncBudgetConvergence.maxSteps else { throw SyncHTTPError("健康数据单批始终超过服务端上限…") }` —— 循环耗尽时**只抛错、不调用 `saveBudgetConvergence`**。下一轮同步从 `loadBudgetConvergence()`（旧档位）重新开始，重跑同一量级导出与同一耗尽循环。
- **影响**：仅当"载荷连收敛后预算都持续超"时触发（低频率）；触发后每次同步白读一遍 HealthKit（GB 级导出，流程中最贵一步），与收敛机制的存在理由（"不白读"）相悖。
- **建议方向**：throw 前把耗尽态落档（或持久化局部 `attempt` 进度），让下一轮直接进入"已耗尽"分支并向用户如实报确定性失败。
- **复核状态**：✔ 主智能体已复核（读码，行号与语义确认）。

### P2-3 · 「单条超大轨迹」静默无法同步（原报告「零进展循环」的修正版）

- **位置**：`apps/ios/RAI/HealthKitExport.swift:423-431,450-454`（先判后取 + 整条放弃）；`apps/ios/RAI/DirectSyncBatchBudget.swift:80-82`（route 闸门）。
- **证据（主智能体复核修正）**：route 段对"装不进剩余额度"的单条轨迹整体放弃、零文件、状态不动（正确设计）；但**若某单条 GPX > 满额预算**（罕见超大轨迹），该条在每批都"发现→尝试→放弃"，且未取到的 workout 会持续参与 `rediscoveryCandidates` 轮转（每轮 ≤20）——**静默地永远同步不了，且反复消耗轮转预算**。
  原报告（子智能体）描述为「单 workout/单页 > 收敛后预算 ⇒ 零进展循环」；主智能体复核：**记录段不会死循环**（单条记录 ≈ 359 B ≪ 预算；批尾停止后下批满额可前进）、**整链不会卡死**，真实缺口如上。
- **影响**：一条大轨迹的数据永久缺失（无用户可见提示）；持续的重试开销。不构成同步链卡死。
- **建议方向**：对"单条超限"与"额度暂时不足"两种放弃原因做区分：前者打终态标记（如跳过并明细上报），不再放入 rediscovery 轮转。
- **复核状态**：✔ 主智能体已复核并**修正定性**（P1→P2，措辞从"循环/卡死"修正为"静默能力缺口"）。

### P2-4 · 收口核心窗口 (2, 8] MiB 无正向测试

- **位置**：`apps/api/test/direct-sync-ingest.test.ts:329-339`、`apps/api/test/import-worker-direct-sync.test.ts:267-296`（均只测 `>8 MiB` 拒收）；`apps/api/test/direct-sync-http-acceptance.test.ts:89`（夹具自证 `<8 MiB`）。
- **证据**：全测试目录 grep（`2 * 1024 * 1024` / `8 * 1024 * 1024` / `DIRECT_SYNC_MAX_XML_BYTES` 双写法）无任何"载荷落在 (2 MiB, 8 MiB] 且被接受"的用例；该窗口恰是 10-14 真机事故（2.41 MB 批被 400 硬拒）的所在地。
- **影响**：收口后"超界=显式失败"的核心行为只在 <2 MiB 与 >8 MiB 两个端点有回归覆盖；合法窗口内的过渡行为（含边界值恰好 =8 MiB）无守卫，若将来再调上界或改比较符（`>` 变 `>=`），不会有测试拦。
- **建议方向**：补 2–3 条正向用例（~2.5 MiB xml / 边界恰好 8 MiB / route 窗口），断言 `succeeded` 且 `import_manifest` 无 `backupName`。
- **复核状态**：✔ 主智能体已复核（grep 双写法 + 读用例）。

### P2-5 · inspect 对「目录丢失 + 从未导入」来源返回 200 `ready`

- **位置**：`apps/api/src/routes/import-routes.ts:97`（`existsSync` 守卫只处理"目录在"与"目录不在"两种，不区分后者的来源状态）；`apps/api/src/import-sources.ts:597`（`status: source.lastUsedAt || previous ? "unchanged" : "ready"`）。
- **证据（主智能体已复核）**：目录缺失时跳过 preflight 直接返回 `inspection`。`lastUsedAt` 非空（已导入）⇒ `unchanged`（正确）；`lastUsedAt` 空且无同 sha 前序 ⇒ **`ready`**（乐观信号，但目录已不在）。客户端下一步 `startImport` 必然拿到 `missing_required_files`。
- **影响**：多走一步必然失败的导入 + 文案误导（"导出内容不符合直连通道要求"）；可自愈（客户端会重新导出重传）。触发条件 = 上传目录被外部清理（运维/磁盘；线上 `var/imports` 有被清空的先例）。
- **建议方向**：对"目录缺失"分流：已导入 ⇒ `unchanged`（现状）；未导入 ⇒ 404/专门 code，让客户端走"重新上传"路径而非 `startImport`。
- **复核状态**：✔ 主智能体已复核（路由 guard + status 计算两处亲验）。

### P2-6 · `recoveryIsolationHolds` 恒真 —— 模型激活门的一条判据无信息量

- **位置**：`packages/application/src/services/recompute-pipeline.ts:1135`（比较点）；`packages/features/src/v4.ts:19-21`（v4 强制把 6 个 recovery 字段置 null）；消费 `packages/storage-sqlite/src/model-transition-gate.ts:221,294-296`。
- **证据**：counterfactual 与 feature 两次调用仅在 `restingHeartRate/hrvSdnn/sleepDurationMinutes/recentLoadMinutes` 四个输入上有差异，而 `extractWorkoutFeatureVectorV4` 内部把这几个字段**强制覆盖为 null** ⇒ 两次输出逐位相同 ⇒ `semanticHash` 恒定相等 ⇒ `recoveryIsolationHolds` 恒 `true`。该值进入 gate 的一个通过条件（`=== true`）与失败分支（`!== true`）。
- **影响**：作为"模型激活的独立证据"是无信息量的（当前实现下永远通过）；作为"未来回归的防御"仍有部分检测力（若有人让恢复数据进入 v4 管线，它能察觉那四个字段的敏感性）。它容易被误读为"已经验证过恢复隔离"。
- **建议方向**：把该验证移到测试层（v4 单元测试直接断言"任意 recovery 输入下输出不变"），或保留此门但改注释与命名，明确"这是对未来改动的哨兵，不是数据证据"。
- **复核状态**：✔ 主智能体已复核（比较点 + 强制 null + 消费分支三处亲验）。原报告的重号/路径（`apps/api/...`）已纠正为实际位置 `packages/application/...`。

### P2-7 · inspect「未知 400 → `.keepTask`」——保险丝缺失（当前触发面窄）

- **位置**：`apps/ios/RAI/HealthSyncCancellation.swift:64-70`（`disposition` 默认分支）；服务端 inspect 唯一 400 出口 `apps/api/src/routes/import-routes.ts:97-109`。
- **证据（主智能体已复核）**：inspect 的 400 只有 `code === "direct_sync_payload_exceeds_bounds"` 一条被识别为 `.convergeBudget`；其余任何 400（含未来新增的确定性拒绝码、或该 code 改名）落到默认 `.keepTask` ⇒ 保留 `sourceId` ⇒ 下次 `nextStep` 恒 `.inspect` ⇒ 重撞同一 400、水位不推进。**当前服务端 inspect 400 只有 bounds 一种 code**（经 `laneRefusalFailure` 折叠），故现状无可复现触发路径——这是"提前一步的保险丝"缺口，而非现行故障。
- **影响（若未来触发）**：与 2026-09-22（404 死锁）、2026-10-14（400 死锁）**同构**的活锁第三次复发。跨端 code 字符串（`batchExceedsBoundsCode` ↔ `laneRefusalFailure`）是对齐在两个仓库内代码里的裸字符串，无契约测试钉住。
- **建议方向**：给 `disposition` 对"确定性 4xx 且非收敛类"补显式分支（abandon 或收敛），或在契约测试中钉住"服务端 inspect 400 的 code 全集 ⊆ iOS 已处置集合"。
- **复核状态**：✔ 主智能体已复核（两侧亲验 + 当前 400 出口穷举）。

### P2-8 · data-only 单测用「实现自己的摘要函数」算载荷身份 —— 跨层契约靠远处闸门兜着

- **位置**：实现 `apps/api/src/data-only-import.ts:120`（复核用 `digestHealthKitRecordSnapshot`）；生产准入 `apps/api/src/import-worker.ts:989`（`computeImportPayloadSha256`）；单测夹具 `apps/api/test/data-only-import.test.ts:65-68`。
- **证据（主智能体已抽查三处）**：单测的 `payloadSha256` 是用"被复核方自己的函数"现算的；姊妹车道的测试明确立过相反规则并写明教训（`direct-sync-ingest.test.ts:109-113`：「两边一起错 ⇒ 假绿」），且 `data-only-import-queue.test.ts:132` 已改用生产函数、唯独 `data-only-import.test.ts:65` 没有。两个摘要在"无 `workout-routes/`"时字节相同、一旦有路由即分叉；让它们恰好相等的**只有** `data-only-import.ts:107` 的目录形状闸门（两条约束相距 13 行、语义互不相干）。
- **影响**：今天无缺陷（闸门兜住）。风险 = 一旦有人放宽 `:107`（例如为别的需求允许 `workout-routes/`），`data-only-import.ts:124` 会**抛硬错**（"Data-only payload changed after admission"），而单测因"两边一起错"不会红。
- **建议方向**：把 `data-only-import.test.ts:65` 对齐 `direct-sync-ingest.test.ts:114`（改用 `computeImportPayloadSha256`），把"准入摘要 == 复核摘要"从巧合变成被钉住的契约。
- **复核状态**：✔ 主智能体已抽查（三个位置亲验；来源：补充独立审查 `INGEST_PERSIST_CHAIN_REVIEW_2026-10-15.md` 🟡-1）。

### P3（低成本清理）

- **P3-a** `apps/ios/RAI/DirectSyncBatchBudget.swift:8-9` 与 `packages/api-contracts/src/index.ts:652-653` 的注释仍是旧时点口径（"2 MiB / 32 MiB"、"一条直连、一条回退"）——收口/放宽后语义已变，建议标注时间口径或改写。
- **P3-b** `apps/api/src/import-worker.ts:34` unused import（`dataOnlyBaselineContract`）。
- **P3-c【已复核】** 导入链死代码现状（10-14 清单的 11 个符号）——**分为两族**：
  ①「**静态有引用、运行期不可达**」（依赖已删的 CLI 子进程 IPC / 候选链路回调）：`parseComputeStageMessage:1930`、`parseNativeEngineMessage:1920`、`nativeStats:1922/1926`、`computeProcessMaxRssKiB:1934`、`nativeFailure:1918`、`engineBlockedJobId:803`——其中 `waiting_engine`（`:809`）**全仓零读取方**，只有写入点；
  ②「**强死码**」（全仓含测试静态零调用）：`recordPayloadAnchor`（`import-worker.ts:1061`）、`writeImportPayloadAnchor` / `readDatasetVersion`（其调用点位于 `recordPayloadAnchor` 内部，传递性为零；测试仅 6 处调 `writeImportPayloadAnchor`）。
  ⚠️ 锚点机制本身**仍活**（`direct-sync-ingest.ts:800`、`data-only-import.ts:208` 事务内内联写 `source_payload_anchor`）——死的只是"带 checkpoint 的独立写盘通道"。
- **P3-d** `payloadSha256` 方法文档与 S3.1 后行为矛盾（`import-worker.ts:980-986` 文档称"not a pre-flight failure"，现行为是显式 `ImportLaneRefusal`）——文档层矛盾，低危。
- **P3-e** `direct-sync-ingest.ts:761` 的 `unchangedWorkouts` 用全表 `COUNT(*)`（写事务内、随表增长 O(N)），且语义挪用（"本次未变更数" ← 全量会话数）——信息项，修正成本未知。
- **P3-f** SA 子报告的其余 P3 项未独立复核（见 §五）。

---

## 四、主智能体对子智能体结论的复核记录（重点：纠正）

> 纪律依据：多路审查的结论必须复核（本项目曾出现 4 路 40 条建议中 6 条被实测证伪的先例）。

| 子智能体结论 | 复核结果 | 依据 |
|---|---|---|
| （SA-1）「lane telemetry 的 `outcome:"fallback"` 无法到达发布点 / 是事后不可能赋值」 | ❌ **证伪**（核心断言不成立） | 控制流实读：`import-worker.ts:657` 设 fallback → `:764` catch 设置 `publishTerminalState` → `finally` 的 `:833-839` **无条件**把 `laneTelemetry` 写进 `job.performance.lane` ⇒ 失败批次会发布 fallback（语义=「被拒」，合理）。剩余真实问题仅为措辞/命名层（P3-a），不足以支撑原断言 |
| （SA-2）「单 workout/单页 > 预算 ⇒ 零进展循环（P1）」 | 🟡 **修正**为 P2-3 | 记录段（drain）前进性成立（单条记录 ≪ 预算；收缩到 1 条后零提交留待下批，下批满额即可前进）；真实缺口 = 单条超大 route 被"整条放弃"后仍留在 rediscovery 轮转 ⇒ 静默永久不同步。链不会卡死 |
| （SA-2）「收敛门禁假绿（P2，高置信度）」 | ✅ **升级为已实证**（突变 A 绿 / 反证 B 红） | 见 P2-1 |
| （SA-3）「data-only 门槛键无生产写入方（P1）」 | ✅ **确认并保持 P1**（正文明确"无正确性影响"） | 见 P1-1；零写入方 + 夹具自写键均亲验 |
| （SA-3'）**补充独立审查**（落盘 [`INGEST_PERSIST_CHAIN_REVIEW_2026-10-15.md`](INGEST_PERSIST_CHAIN_REVIEW_2026-10-15.md)）：单测摘要函数不对齐 / 方法文档矛盾 / `COUNT(*)` 语义挪用；并回执「死代码两族 + 零写入方证实 + B4 推断成立（含两点限定）」 | ✅ 抽查三处证据后并入（P2-8 / P3-c/d/e）；其主动披露"早前跑过 2 个测试文件（43 pass/0 fail）、落盘 1 份报告" | 三处亲验 + `git show` 旁证 |
| （SA-4）「`recoveryIsolationHolds` 恒真」 | ✅ 确认（精度补正：对"未来回归"仍有部分检测力；路径纠正 `apps/api`→`packages/application`） | 见 P2-6 |
| （SA-4）「snapshot_refresh 扩写活跃派生表但不重封 release 快照 ⇒ 分叉」 | ⏳ **部分复核**：机制存在（`recompute-pipeline.ts:455-507` 只扩活跃表；封存在 `sealDomainSnapshots` 独立入口，`model_domain_snapshots` 不可变）。**是否构成缺陷取决于读侧契约（currentFacts vs published 的消费面）**——本报告不下结论，列为待产品判定项 | 读码（:455-507/:2152-2160 + release repo 不可变语义） |
| （SA-1/SA-2/SA-4）其余 P3 级条目 | ⏳ **未独立复核**（如实标注） | — |

---

## 五、绿区（本轮读码/实跑确认无问题的部分）

- **尾页根治核心机制（1d3d37f）**：`drain` 的写前判定 + `PageDecision` 无"超预算提交"case + `shrinkLimit ≥ 1` + 锚点仅在 accept 后推进（`HealthKitRecordCursor.swift:80-114` 读码确认）；route"先判后取 + 状态/文件同进同退"（`HealthKitExport.swift:423-470` 读码确认）。
- **服务端拒因映射**：`laneRefusalFailure` 单一映射表 + `ImportLaneRefusal` 终态失败语义（`import-worker.ts:115-152,764-784` 读码确认）。
- **inspect 修复（e5cf8fc）**：目录缺失跳过 preflight + `preflightDirectSyncPayload` 入口 `existsSync` 守卫 + 删 apply 入口死 readdir（`import-routes.ts:97`、`direct-sync-ingest.ts:403-406` 读码确认）。
- **P3a 遥测键改名（2d22b61）**：`maxManifestBytes` 在 `:424/:430/:437` 三处 manifest 站点，`maxXmlBytes` 只出现在 xml 站点（读码确认）。
- **门禁实跑**：typecheck 绿；direct-sync 定向 43/44（1 例资源型超时，隔离复验绿）；http-acceptance 9/9；`npm run test:ios` EXIT=0（7m57s）；`check:docs` EXIT=0。全部日志见 `.workbuddy/runlogs/audit20261015-*.log`。

---

## 六、行动建议（按建议修复顺序）

| # | 项 | 验收标准 | 回滚 |
|---|---|---|---|
| 1 | **P1-1** data-only 死键 | 生产路径存在写入方（或门槛删除+契约同步）；补"不预写该键"的用例并实跑绿；`import-worker.ts:34` unused import 清理 | 单提交 revert；无数据面变更 |
| 2 | **P2-1** 门禁判据改造 | 改后对"删调用点"的定点突变**必须红**（沿用本次突变脚本即可） | 判据文件单文件回滚 |
| 3 | **P2-2** 耗尽落档 | 构造 maxSteps 耗尽场景的单测：断言耗尽后档位被持久化、下一轮直接报确定性失败 | iOS 单文件 revert |
| 4 | **P2-4** 窗口测试 | 新增 (2,8] 窗口正向用例 + 边界值，`npm test` 相关文件绿 | 测试文件 revert |
| 5 | **P2-5** inspect 分流 | 未导入+目录缺失 ⇒ 非 200-ready；补路由级用例 | 路由单文件 revert |
| 6 | **P2-7** inspect 400 保险丝 | iOS 侧显式分支或契约测试钉住 code 集合 | 各自单文件 revert |
| 7 | **P2-3 / P2-6 / P3-a/b** | 见各条"建议方向"；均为低风险改动 | — |

> 所有修复均**未在本轮实施**（审查任务只读）。需部署的项（服务端）须走迁移/重启闸门；iOS 侧改动需重新构建装机（当前 10-14 的 8 个 iOS 文件改动**尚未装机**——服务器部署对 iOS 无效，真机四条验收仍待跑）。

---

## 七、未覆盖范围声明

- **真机行为**：iOS 真机构建/装机验收未做（尾页根治 P0/P1b/P2b 的实机四验仍待）；HealthKit 实机边界（零样本类型 anchor 等）不在本轮。
- **线上环境**：未触碰线上库/服务；本轮结论全部基于工作区源码 + 本地实跑。
- **未复核项（如实标注）**：SA 子报告的 P3 级条目、SA-4 的 `snapshot_refresh` 分叉判定（需读侧契约/产品判定）；死代码现行清单**已复核**（P3-c）。
- **门禁口径**：`npm run test:e2e:web` / 响应式 / ML 套件不在范围；`npm test` 全量未跑（定向替代 + typecheck；全量含已知环境阻塞项 `deploy-n100`）。
- **§补录**：① http-acceptance 单文件补跑 **9/9 EXIT=0（3m58s）**；② `npm run test:ios` **EXIT=0**（7m57s）；③ SA-3 补充复核回执与任务 A/B 结论已并入 §三（P2-8 / P3-c/d/e）与 §四；④ 本批全部测试日志与突变证据归档于 `.workbuddy/runlogs/audit20261015-*.log`。

---

## 八、修复落地（2026-10-15 同日 · 多智能体计划 → 实施）

> §六行动建议的落地记录。分组提交（G1 服务端数据面 / G2 iOS / G3 门禁测试 / G4 死代码清理）；用户拍板：P2-3 = 可见化、P3-c = 全面清理。**P2-3A 可见化**：不静默修，把"单条超大轨迹被放弃"写进同步页 warnings（`HealthKitExport.swift` `RouteFetch.oversized` → "有一条跑步轨迹超过单批上限，暂未同步…已保留其同步状态"）。

| 项 | 落地 | 证据 |
|---|---|---|
| **P1-1** | 按 §六方案 B：**删门槛**（`compatible()` 第 5 条件 + SELECT 列，`data-only-import.ts`）；`dataOnlyBaselineContract()` 本体随 G4 退役 | 9000 条 ≈2.6 MiB 窗口用例（data-only 拒 / direct-sync 收）+ 8 MiB 精确边界（`direct-sync-ingest.test.ts` 新增 2 例）；9 文件 fixture 死键清理 |
| **P2-1** | 门禁判据改**逐接线形态断言**（4 条，复用 `perform_body` 切片，`check-background-capabilities.py`） | worktree 双突变：拆 4 接线 → 红；改名 → 红；还原 → 绿（288 checks 0 failed） |
| **P2-2** | P2b 耗尽时落收敛档：throw 带 `exhaustedErrorCode` + catch 落 `DirectSyncBudgetConvergence(steps: maxSteps)`；`isExhausted` 分支补终态（保留任务行） | `HealthKitSync.swift`；resume 回归新增 `inputNotAllowedAbandonsTask` + 突变闭环 |
| **P2-3A** | 超大轨迹 warnings 可见化（见上）；轨迹状态保留、下批继续 | `RouteFetch.oversized` 判据进门禁 §P2-3A 两条 |
| **P2-4** | (2,8] MiB 窗口 + 8 MiB 边界正向用例（随 P1-1 批） | `direct-sync-ingest.test.ts`；`Buffer.byteLength` padding 精确到边界 |
| **P2-5** | inspect 对「目录丢失 + 从未导入」改 **404**「暂存上传已不存在，请重新上传」（`import-routes.ts`） | HTTP 级用例（upload → removeTree → inspect 404） |
| **P2-6** | 判据修正：V3 冻结提取器**不消费 recovery**（反事实实证），属性测试转红条件 = recovery 进 payload 输出 | `v4.test.ts` 参数化属性测试 15 变体 + 突变 2（注入 `recoveryRaw`）4 红；`recompute-pipeline.ts:1131` 哨兵口径注释 |
| **P2-7** | inspect 400 `direct_sync_input_not_allowed`（preflight 输入族，当前可达）→ iOS disposition **`.abandonTask`**（防 `.keepTask` 活锁）；裸 400 保持 keepTask（既有回归钉住） | 常量 `inputNotAllowedCode` + parity 门禁 3b 节（两端钉 code，15 checks） |
| **P2-8** | 单测摘要函数对齐：改用 `computeImportPayloadSha256`（生产口径），17 处 `input()` async 化 | `data-only-import.test.ts` 全绿 |
| **P3-a** | `DirectSyncBatchBudget.swift` 头注释更新为 8/64 MiB 现行口径 | — |
| **P3-b/d** | unused import 清理（随 G1）；`payloadSha256` doc 重写为 S3.1 语义订正；`docs/HEALTHKIT_RECORD_SYNC_V2.md` 加 2026-10-15 订正注记 | — |
| **P3-c** | **全面清理**：`command()`（唯一 spawn）为根整族退役 —— parser 双函数（约 3.9k chars）、`recordPayloadAnchor`、`terminateProcessTree`/`activeChild`/`engineArgs`/`nativeStats`/`computeProcessMaxRssKiB`/`nativeFailure`/`engineBlockedJobId`；`import-payload-identity.ts` 尾段（`readDatasetVersion`/`writeImportPayloadAnchor`）；契约 `ImportJobPerformance` 两键 + 响应 schema 同步；diagnostics 测试改写（删 4 条 CommandSurface 用例，保留 2 条真实 worker 用例）；preflight 测试 6 处锚点预置改内联 SQL；删 `import-worker-compute-stage` / `import-worker-native-engine-metric` 两个死 parser 测试文件 | **17 符号残留断言全零**；typecheck EXIT=0；`ImportJobPerformance` 存活键（`computeStagesMs` `:948` 活跃）不动 |
| **P3-e** | `unchangedWorkouts` 注释标注"字段=会话总数历史口径"（语义挪用修正成本未知，本轮只留口径注记） | `direct-sync-ingest.ts:761` / `data-only-import.ts` |

**验收账本**：`typecheck` EXIT=0（G4 后 4 次确认）；G1 批 http-acceptance **10/10**（含新 P2-5 用例）+ 轻量批 50/50；`test:ios` **EXIT=0**（7m34s，288 checks 0 failed 含新判据）；parity 15 checks；v4 属性测试 5/5 + 双突变闭环；G4 定向批 9 文件 156 tests 批跑 145 pass —— 其中 **1 处 G4 真回归**（`worker.test.ts` 漏网 CommandSurface 用例调已删 `command()`，已删用例+接口成员+孤立 import）+ 9 处**并发批跑资源型失败**；涉事 4 文件 **串行复验 EXIT=0（107/106 pass/0 fail/1 skip）**；`check:doc-refs` EXIT=0（越界 0 / 漂移 0）；`check:docs` EXIT=0；`check:ios-gates` 9/10 支绿（`check-pr5-facts-analysis.py` 为 README 记录的既有红：缺 `var/reports/pr5-c9-baseline-keys.json`，与本批无关）。日志：`.workbuddy/runlogs/g4-*.log`。

**未随本批落地**：iOS 真机装机与实机四验（G2 改动需重新构建）；服务端部署走 `rai-deploy` 闸门（迁移无关、纯代码滚动）；`P3-e` 的 O(N) 成本修正（需体量测量后再动）。

---

*报告生成：2026-10-15 · 小满（多智能体协作审查：sa-server-sync / sa-ios-sync / sa-ingest / sa-compute + 主智能体复核）*
