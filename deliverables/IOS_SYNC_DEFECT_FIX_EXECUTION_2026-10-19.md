# 同步残余缺陷修复记录（2026-10-19 第二轮）

- 依据：[IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md](IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md)
  §7「顺带核实」的 4 条残余风险 + B6 §5.3 的分批顺序；上批见
  [IOS_SYNC_B6_FIX_EXECUTION_2026-10-19.md](IOS_SYNC_B6_FIX_EXECUTION_2026-10-19.md)（B6 P0 止损）。
- 基线：工作树（`67028e1` + 未提交的 R1–R6 改动）。
- 范围：**产品代码只动 1 个文件 2 处判定**（`HealthKitExport.swift` 的 R6/A8 段计划实参 + A9 判定顺序），其余全部是
  门禁、测试与文档。未部署、未真机、未跑全量 mutation。
- 结论：上一轮列出的 4 条残余风险**全部修复/钉住**；B6 的 P1 完成第一片（格式敏感文本锚）；
  P2（视觉快照）与 P1 剩余批次仍未做（见 §6，附理由）。

## 1. 修了什么

| # | 上一轮的发现 | 修复 | 证据 |
|---|---|---|---|
| A8 | **R6 修复轮接线与注释/回归不一致 ⇒ 双重重放**：`decodedAnchor = nil`，但段计划收到 `decodedAvailable: decoded != nil`（恒 true）⇒ 计划 = `[.incremental, .historyFromScratch]`，而 `.incremental` 起点也是 nil ⇒ 同一类型历史读两遍，且增量段看不到旧锚点后的删除 | 实参改为 `decodedAnchor != nil`（修复轮 ⇒ false ⇒ 只有 `.historyFromScratch` 一段）；代码注释写清"纯判据只测了那一格、接线必须门禁钉" | `HealthKitExport.swift:2100`；门禁 `check-healthkit-record-sync.py` 新增 A8 判据；定向突变：改回 `decoded != nil` ⇒ 门禁红（已实测） |
| A9 | **R6 边缘**：修复判定排在"锚点可解码"检查之后 ⇒ 坏锚点 + 旧 floor 会以 `invalidRecordAnchor` 整批失败，永远修不好 | 修复判定前置，守卫改为 `previous == nil || decoded != nil || disabledFloorRepair else`；只有 `disabledFloorRepair` 能放宽 | `HealthKitExport.swift:2058-2066`；门禁新增 A9 判据 + 更新"坏锚点不得静默重放"判据（唯一例外必须写进判据）；定向突变：去掉 `|| disabledFloorRepair` ⇒ 门禁红（已实测） |
| A10 | R6 修复轮的删除语义代价（从 nil 看不到旧锚点后的删除）上下没有记录 | 代码注释如实写明代价与前提（`allowsHistorySkip == false` ⇒ 已提交构建从未写出 floor），**不新增逻辑** | `HealthKitExport.swift` 修复轮注释 |
| B1 | **前台触发点无门禁**：`RAIApp.swift` 被 `typecheck-ios.sh` 排除（高德依赖），`reconcileAnalysisOnEntry` 的调用点被删/写错签名不会有任何判据变红 | 新增 6 条源码判据：监听存在、入口恰好 1 次、在 `.active` 分支内、在 `Task` 内、排在 `syncIfNeeded`/`handOffUncoveredGenerations` 之后；并说明"这是类型检查之外唯一保护" | `check-direct-sync-analysis-reconcile.py` §6；定向突变：删掉调用 ⇒ 门禁红（已实测） |
| B2 | **helper 唯一性无门禁**：只钉了 `settingLateBackfill` 两处，`advancingAnchor` / `established` / `settingRecentWindowReadAt` 的唯一性无断言 | 新增 2 条：生产路径零直接构造（`HealthKitRecordCursor(` 不出现）+ 三个 helper 各恰好一次调用 | `check-healthkit-record-sync.py` B2 段；定向突变：手写一个 `HealthKitRecordCursor(...)` ⇒ 门禁红（已实测） |
| D | 计划文档回归计数与实现不符（B1 写 9 条实际 12；B2 写 6 条实际 4） | 更正为 12 / 4，并标注"2026-10-19 复核更正" | [IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md](IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md) §1.3/§1.4/摘要表 |

## 2. B6 · P1 第一片：把"格式"从契约里拿掉

上一轮把 B6 的 P1 定为"抽测试缝、逐步删文本断言"。本轮先做**不改变产品代码**的一小片：

- `check-healthkit-record-sync.py` 的 P1-4 公式判据此前要求 `min(12_000, max(4_500, xmlBytesBudget / 480))`
  **逐字**出现（换行/缩进一变就误报）。现在先把源码的**全部空白删掉**再匹配语义
  （`"".join(budget.split())`），并新增一条"握手 bounds → 字节驱动预算确实被使用"的接线判据。
- 覆盖没有丢：同一公式在 `DirectSyncBatchBudgetTests`（122 条行为判据）里也有断言。**交叉实测**：
  - 把 `480` 改成 `500` ⇒ 行为测试当场红（`maxRecords == xmlBytes/480`）+ 门禁红；
  - 把 `0.9` 改成 `0.8` ⇒ 行为测试红（`maxDeletions == 5000 × 0.9`）；
  - 只改排版（`min(` 后换行）⇒ 门禁**仍然绿**（旧写法会误报）。
- 这是 P1 的"模板"：后续批次照同一顺序做（先确认行为判据覆盖 → 再把文本锚改成不敏感形式或删除 →
  定向突变复核）。

## 3. 定向突变（每条新判据都真的能红）

| 突变 | 期望 | 实测 |
|---|---|---|
| A8：`decodedAvailable: decodedAnchor != nil` → `decoded != nil` | 门禁红 | ✅ `FAIL: R6: ... replay the type's history twice` |
| A9：守卫去掉 `\|\| disabledFloorRepair` | 门禁红 | ✅ `FAIL: a corrupt stored anchor must not silently trigger automatic history replay — the sole exception is ...(A9)` |
| B1：删掉 `RAIApp` 里的 `reconcileAnalysisOnEntry` 调用 | 门禁红 | ✅ `出现 0 次（应为 1）` + `不在 .active 分支里` |
| B2：在 `HealthKitExport.swift` 手写一个 `HealthKitRecordCursor(...)` | 门禁红 | ✅ `FAIL: B2: HealthKitExport rebuilds a record cursor by hand` |
| 480→500 / 0.9→0.8 | 行为测试红 | ✅ `Precondition failed: ... xmlBytes/480` / `... 5000 × 0.9` |
| 只改排版（换行） | 门禁绿 | ✅ 126 checks / 0 failed |

所有突变都用"备份 → 改 → 跑 → 还原"完成，还原后判据复绿（`RESTORED_EXIT=0`）；没有留下改坏的源码。

## 4. 实跑验证

| 检查 | 结果 |
|---|---|
| `python3 apps/ios/tests/check-healthkit-record-sync.py` | **126 checks / 0 failed**（修前 121） |
| `python3 apps/ios/tests/check-direct-sync-analysis-reconcile.py` | **52 checks** 通过（修前 46） |
| `npm run check:ios-gates` | **EXIT=0**：10 支全部通过，解释器 `python3 3.9.6（要求 ≥ 3.9）` |
| `npm run test:ios` | **EXIT=0**（类型检查 + 纯逻辑回归 + 10 支结构门禁；日志含 `PR5 facts/analysis checks passed (24 checks)`） |
| `npm run typecheck` | **EXIT=0** |
| `node --import tsx --test packages/application/test/cross-platform-scripts.test.ts` | **17/17**（上批新增的孤儿/执行链判据） |
| 预算行为测试（单独编译） | **122 checks passed** |
| `npm run check:docs` | **EXIT=0**（101 files / 668 links / 0 problems） |
| `npm run check:doc-refs` | **EXIT=0**（143 处引用，0 越界/无法解析） |
| `npm run check:scripts` | **EXIT=0**（18 个 package.json / 104 条 script） |
| `npm run check:acceptance-matrix` | **EXIT=0**（验收矩阵通过） |
| `git diff --check` | **EXIT=0** |

> 说明：`npm run test:ios` 的干净重跑发生在最后一次**仅注释**的改动之前；那处改动只改注释文字，
> 之后 `check:ios-gates`（10/10）与 `typecheck` 已在终版文件上复跑。不把"未重跑全量"写成"通过"的场景
> 没有发生 —— 逻辑层面的验证都是终版文件。

## 5. 回滚

- 产品代码的改动只有两处（段计划实参 + 守卫/判定顺序），revert 即回到上一轮行为；
  但**不要**只 revert 门禁而留产品改动 —— 那会让 A8/A9 失去判据。
- 门禁新增判据都是独立 `check(...)`，单独 revert 不会影响既有判据（自计数机制按注册数核对）。

## 6. 仍未做（及为什么）

- **B6 P1 剩余批次**：`check-healthkit-record-sync.py` 的其余文本锚（顺序/计数类）、
  `check-healthkit-record-sync.py` 之外的 record-sync 邻接断言、`check-background-capabilities.py`
  的 342 条（40 处 `tail_after` / 22 处 `ordered`）。按计划需要"每批先补突变 → 确认红 →
  再删文本断言"，一批一轮，不能与本次混做。
- **B6 P2**：today-layout（90 条裸 assert）/ fresh-skin（37 处字面量）是 SwiftUI 结构与文案，
  抽不出纯函数；正确机制是"文案常量单源 + 模拟器视觉快照"，需要已启动模拟器与 `var/rai.sqlite`
  （`run-visual-tests.sh` 的既有前提），本机不可达。
- **全量 `test:ios:mutation`**：会逐条改坏 Swift 源码，耗时十几分钟；本轮对**每条新增判据**做了
  定向突变，但没有跑全量突变套件 —— 不把它写成"mutation 通过"。
- **真机 / 部署**：未做。R6 的修复轮（A8/A9）只在"游标带 floor 且跳过开关关闭"时可达；按证据
  已提交构建从未写出过这种行，所以这条修复本身没有真机现场，边界见核实报告 §1.1。

## 7. 边界

- 本轮结论均为**本机判据**：`test:ios` = macOS 类型检查 + 纯逻辑回归 + 10 支结构门禁，
  不是端到端验收。
- B1 的"冷启动/回到前台都会经过"仍是 SwiftUI `onChange` 语义推断，没有真机时序证据；
  本轮只保证**调用点存在且顺序正确**，不证明它在真机上按预期触发。
- 未改协议、未改持久字段、未改数据库迁移；磁盘契约与回滚面与上一批一致。
