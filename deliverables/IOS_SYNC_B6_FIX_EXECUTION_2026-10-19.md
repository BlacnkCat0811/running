# B6 修复执行记录（P0 止损，2026-10-19）

- 依据：[IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md](IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md) §5
  —— 五项“未实施”里 B6 是唯一判“需要优化”的项；本轮执行它 §5.4 的 **P0 止损**。
- 基线：工作树（`67028e1` + 未提交的 R1–R6 改动）。**未改任何产品代码**（无 Swift / TS 生产文件），
  改动全部在“门禁脚本 / 执行链 / 基线 / 测试 / 文档”。
- 边界：未部署、未真机、未跑 mutation 全量；本文的“通过”都是本机判据。

## 1. 修的是什么（三个缺陷形态叠在一起）

1. **判据在默认解释器上导入即崩**：`check-pr5-facts-analysis.py` 用 PEP 604 注解
   （`-> str | None`，:87；`body: str | None`，:106）却没有 `from __future__ import annotations`。
   本机 `python3` = `/usr/bin/python3` = **3.9.6**（本仓声明的下限）⇒ 模块导入 `TypeError`，
   **0 条判据执行**，退出码 1。
2. **基线不可复现**：`var/reports/pr5-c9-baseline-keys.json` 被 `.gitignore:4` 的 `var/` 忽略，
   **从未入库**，也没有生成脚本 ⇒ 干净树永远红（3.12 上实测 3 failed），却被当成“预存在失败”
   正常化了整整 6 天。
3. **没有执行者**：它只挂在 `npm run check:ios-gates`，而该入口既不在 `.githooks/pre-commit`、
   也不在 `.github/workflows/ci.yml`；`npm run test:ios` 的 9 支门禁链里没有它。
   ⇒ 从 `60678af`（2026-10-13）引入起，**连续 6 天一条判据都没跑过**。

三件事任意一件单独修都不够：只加 future import 仍然缺基线；只补基线仍然没人跑；
只接执行链则一接就红（因为前两件没修）。所以三件必须同批。

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `apps/ios/tests/check-pr5-facts-analysis.py` | 加 `from __future__ import annotations`；基线路径改为**入库**的 `apps/ios/tests/fixtures/pr5-c9-baseline-keys.json`；新增 `--write-baseline`（要求契约文件干净、记录来源 `commit` + `contractsSha256`）；新增 **C9 interface 覆盖判据**（基线缺一个端点即红）；新增 **`fieldsSha256` 完整性判据**（手工删基线一行即红，重建才通过） |
| `apps/ios/tests/fixtures/pr5-c9-baseline-keys.json`（新） | C9 三个响应（`WorkoutListResponse` / `TrainingPlanStateResponse` / `MobileTodayResponse`）的字段名 + 可选性快照，`commit=67028e1…` |
| `apps/ios/tests/run-model-tests.sh` | 挂上 pr5 ⇒ `npm run test:ios` 在 macOS 上真的执行它 |
| `scripts/run-ios-python-gates.mjs` | 解释器 probe 从“major == 3”改为 **≥ 3.9**（与 `run-ios-gates.sh` 的 `3.[0-8]` 拒绝口径对齐）；启动时打印解释器版本；新增 `referencedGateFiles` / `findOrphanGates` / `planGates().orphans`：**非排除门禁若不在任何 `run-*.sh` 里，整支入口直接红**（剥掉整行注释，防止“注释里提过”被当成执行者） |
| `.githooks/pre-commit` | `apps/ios`、`packages/api-contracts`、`packages/contracts` 有改动时跑 `npm run check:ios-gates`（纯文本判据、跨平台，非 macOS 也跑） |
| `.github/workflows/ci.yml` | macOS job 增加 `Run cross-platform source gates` |
| `packages/application/test/cross-platform-scripts.test.ts` | 新增 3 条：孤儿判据必须让入口变红；仓库里每个非排除门禁都挂在 `run-*.sh` 上（含 pr5 在可执行集里）；解释器下限与 `.sh` 口径一致。并在既有 pre-commit 测试里钉住 `npm run check:ios-gates` 必须挂在钩子上 |
| `docs/IOS_NATIVE_RUNBOOK.md`、`AGENTS.md` | 验证入口表补 `check:ios-gates` 行；说明 10 支结构门禁、基线位置与 `--write-baseline` 重建方式、解释器下限与缺解释器按失败处理 |
| `deliverables/README.md` | 当轮索引补两条（本记录 + 上一轮未实施项核实）——`check:docs` 的 "not reachable" 由 1 归零 |

## 3. 验证

| 检查 | 结果 |
|---|---|
| `python3 apps/ios/tests/check-pr5-facts-analysis.py --write-baseline` | 写入基线 @ `67028e1`（3 个 interface） |
| `python3 apps/ios/tests/check-pr5-facts-analysis.py`（3.9.6） | **EXIT=0**，24 checks passed |
| `/Users/ta/.local/bin/python3.12 apps/ios/tests/check-pr5-facts-analysis.py` | **EXIT=0**（修前 3 failed） |
| C9 突变｜删基线一行（`WorkoutListResponse.limit`） | **EXIT=1**（`fieldsSha256` 不匹配）—— 修前该突变是绿的（实测发现并补上这条完整性判据） |
| C9 突变｜把 `total` 的可选性翻转 | **EXIT=1**（digest + `turned optional field(s)`） |
| 还原基线 | **EXIT=0**（24 checks） |
| `npm run check:ios-gates` | **EXIT=0**：`iOS 结构门禁通过（10 支跨平台判据；跳过 2 支需外部条件的）`，解释器打印 `python3 3.9.6（要求 ≥ 3.9）` |
| `RAI_PYTHON=/Users/ta/.local/bin/python3.12 npm run check:ios-gates` | **EXIT=0**（同一批判据在 3.12.14 上也绿，证明修复不是“只对 3.9 特判”） |
| 孤儿检测（合成） | `planGates({files, referenced})` ⇒ `orphans=["check-b.py"]`；`runGates` ⇒ **1**（红） |
| 孤儿检测（真实仓库） | 11 个引用 / 10 支可执行，**orphans = 0** |
| `node --import tsx --test packages/application/test/cross-platform-scripts.test.ts` | **17 tests / 17 pass / 0 fail** |
| `npm run typecheck` | **EXIT=0** |
| `npm run test:ios` | **EXIT=0**（类型检查 + 纯逻辑回归）；日志里出现 `PR5 facts/analysis checks passed (24 checks)` ⇒ 它**真的**进了聚合链，不再只是“存在” |
| `npm run check:docs` | **EXIT=0**（100 files / 664 links / 0 problems；新增本记录与 README 索引后由 1 problem 归零） |
| `npm run check:doc-refs` | **EXIT=0**（143 处引用，0 越界/无法解析） |
| `npm run check:scripts` | **EXIT=0**（18 个 package.json / 104 条 script） |
| `npm run check:acceptance-matrix` | **EXIT=0**（80 条 cited / 0 missing） |
| `git diff --check` | **EXIT=0**（无空白错误） |

## 4. 回滚

- 单批 revert 即可；**没有**产品代码、协议、持久字段、数据库迁移的改动。
- 若只回滚 `run-model-tests.sh` 那一行：`test:ios` 会退回 9 支门禁链，但 `check:ios-gates`
  仍会跑 pr5 —— 那是最小回退面（保留止损、只退“每台 macOS 都跑”）。
- 不建议回滚基线文件：那会退回“干净树必红、被当预存在失败”的状态。

## 5. 未做（P1/P2）与理由

> **状态更新（2026-10-19 第二轮）**：P1 已完成第一片（公式文本锚去格式敏感 + 与预算行为判据交叉
> 验证），且同一轮修掉了核实报告 §7 的 4 条残余风险；见
> [IOS_SYNC_DEFECT_FIX_EXECUTION_2026-10-19.md](IOS_SYNC_DEFECT_FIX_EXECUTION_2026-10-19.md)（P1 剩余批次与
> P2 仍未做）。

按 [核实报告 §5.3](IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md) 的顺序，本轮只做 P0：

- **P1 批 1（record-sync 抽 `RecordPagePlan`）**：门禁 178 处文本钉 + 生产接线，必须在
  `check-background-mutations.py` 里先补 ≥3 条突变、确认变红后再删文本断言；单批可交付，
  但需要独立一轮（含 mutation 复跑）。
- **P1 批 2（capabilities 抽 `BackgroundRunPolicy`）**：同上，前置是 61 条既有突变全绿。
- **P2（today-layout / fresh-skin 换机制、mutation 锚自动重锚）**：抽不出纯函数，要换
  “文案单源 + 模拟器视觉快照”；依赖模拟器与 `var/rai.sqlite`，属手工验收档。

## 6. 边界

- 本轮验证的都是**本机判据**：`test:ios` 是 macOS 上的类型检查 + 纯逻辑回归 + 10 支结构门禁，
  不是真机/端到端验收；CI 的 macOS job 仍不会对 gitee 远端触发（`ci.yml` 自述）。
- 未运行 `test:ios:mutation`（会逐条改坏 Swift 源码）；本轮没有改 Swift，不把它写成“已验证”。
- 全量 `npm test` 未在本批必要性内（改动只涉及门禁脚本、测试文件与文档）；已跑的 `typecheck`
  与定向测试见 §3。
