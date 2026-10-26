# 训练计划 V2 最终交付 — 隔离 Worktree 与本地提交

日期：2026-10-26（Asia/Shanghai）。模式：IMPLEMENT。状态：本地交付分支完成；未推送、未创建 PR、未合并、未部署。

## 任务结果

训练计划 V2 的已验收内容已整理到独立 Git worktree，并在原 `main` 工作区没有切换、暂存、清理或覆盖的前提下，形成可审查的本地提交序列。61 个冻结产品路径全部纳入 Git；新增 Node 测试、Swift policy/regression 和共享距离 Fixture 均已跟踪。原始 53 个 tracked 修改、8 个未跟踪产品文件和 233 个未跟踪证据文件均保留在原始工作区。

本轮只允许的源码改动是 `TechTrainingSessionEditor.swift` 的 Actor 隔离最小修复；只允许的文档改动是视觉验收数据库说明、独立距离省略能力、更新读请求头/Vary 语义、证据报告可移植引用及 Git 交付报告索引。没有其他业务语义变更，没有启用训练计划 V2 生产写能力。

## 1. 原始 main 工作区保护

| 项目 | 实际结果 |
|---|---|
| 原始目录 | `/Users/ta/running` |
| 原始分支 | `main` |
| 原始 HEAD | `2e7c07bb66b3701c4e1b768c90f431b654584f5c` |
| 原始工作区 | 53 个 tracked 修改、241 个未跟踪文件（8 个产品文件、233 个交付证据）、暂存区为空 |
| 原始文件指纹 | L4 冻结清单 2,651 个文件，最终复核 changed 0、missing 0 |
| 原始 iOS/Pods | 495 个额外复制文件在 L4 阶段前后逐一 SHA-256 一致 |
| 禁止操作 | 未执行 `git reset --hard`、`git clean`、`git stash`、`git push`，未切换或暂存原工作区 |

原始工作区的最终 `git status` 仍为 294 行（53 个修改 + 241 个未跟踪），HEAD 与分支不变。原始证据和原始哈希由 `FROZEN_TRACKED.patch`、`ORIGINAL_STATE.txt`、`ORIGINAL_INDEX.txt` 及 `SOURCE_FREEZE.json` 固定。

## 2. 隔离 Worktree 与本地分支

| 项目 | 实际值 |
|---|---|
| Worktree | `/Users/ta/.codex/worktrees/training-plan-v2-final-20261026/running` |
| 分支 | `codex/training-plan-v2-final-20261026` |
| 起点 | `2e7c07bb66b3701c4e1b768c90f431b654584f5c`（detached 建树后创建本地分支） |
| 原始 main | 保持 checkout，不切换、不暂存、不覆盖 |
| `.git` | 共享仓库元数据，不复制整个 `.git`；worktree 独立工作目录 |
| 敏感/大型产物 | 未复制生产 SQLite、健康 XML/GPX、构建产物、Pods 构建缓存或无关依赖目录 |

## 3. 冻结基线、转移与内容身份

冻结清单包含 53 个 tracked 修改和 8 个未跟踪产品文件，共 61 个产品路径；逐项记录 SHA-256、文件模式、LF 行尾和生成时的 Xcode Target/编译入口归属。转移后 61/61 路径存在，SHA-256 与模式和冻结清单一致，全部 LF；新增 Swift policy 已进入同步目录 Target，editor regression 已接入 iOS 测试入口。

之前交付尝试曾遗漏两份原始产品文档；本轮在转移核对时发现其工作树内容回退到 HEAD，已从原始工作区恢复冻结内容并重新比对，61/61 哈希一致后才继续。没有把该差异静默带入提交。

三个新增 Node 测试均被真实发现器纳入 331 文件集合：

- `apps/api/test/training-plan-execution-cursor-errors.test.ts`
- `apps/api/test/training-plan-history-compatibility.test.ts`
- `apps/api/test/training-plan-state-audit.test.ts`

共享距离 Fixture 为 `apps/ios/tests/fixtures/training-session-distance-v1.json`，Node 与 Swift 共用；没有历史证据测试副本进入产品测试发现范围。

## 4. 本地提交序列

| # | 提交 | 内容 | 文件数 | 验证 |
|---|---|---|---:|---|
| 1 | `50243034` | `docs: establish RAI engineering and validation rules` — AGENTS 工程治理、`.gitignore` 构建产物/一次性脚本规则 | 2 | pre-commit hook PASS；只读治理 diff |
| 2 | `1ffe3134` | `fix(training-plan): stabilize B08 input identity and negotiated reads` — 输入身份、读取协商、更新 DTO/Store | 13 | 干净 checkout 4 文件 37/37 PASS；pre-commit hook PASS |
| 3 | `2ae30501` | `fix(training-plan): deliver validated V2 compatibility and execution closure` — A-01、D-01/D-02、I-01/P-03、D-03、P1 EXEC/EDIT/COMPAT 原子收敛 | 48 | 干净 checkout typecheck PASS、9 文件 175/175 PASS；pre-commit hook PASS（含 iOS 聚合） |
| 4 | `00414eb2` | `fix(ios): keep editor step mapping in MainActor context` — 三处 `map(EditorStep.init)` 闭包化 | 1 | 定向 editor 79 checks、`test:ios`、x86_64 Simulator/arm64 Device 完整构建 |
| 5 | `本提交（最终 HEAD）` | `docs(deliverables): record V2 delivery evidence and validation` — 文档修正、精选证据、最终报告 | 245 | 全部最终门禁与文档/证据检查 |

提交分组是按真实依赖合并的：B08 与其余 V2 命令/执行/编辑/能力变更强耦合，未为了增加提交数量而拆出无法独立编译的中间状态。完整路径清单和每个提交的验证 JSON 见 [COMMITS.json](COMMITS.json)。

### 提交级检查

每个提交在提交前执行：

- `git diff --cached --check`
- `git diff --cached --stat`
- `git diff --cached --name-only`
- 当前 `.githooks/pre-commit`（类型、文档、doc-refs、脚本、iOS gates、仓库大小与训练计划单写者）
- 与提交内容对应的 L1/L2；B08 和核心提交另在只包含该提交及祖先的干净 detached worktree 中复跑。

核心提交的干净验证命令为 9 个明确存在的测试文件，结果 175/175、0 fail/skip/cancel；B08 为 4 个文件 37/37。没有用包含后续未提交修改的工作区冒充中间提交通过。

## 5. Swift Actor 警告最小修复与完整构建

原警告位于 `TechTrainingSessionEditor.swift` 的 `warmup/cooldown/blocks` 初始化：

```swift
warmup = structure.warmup.map(EditorStep.init); cooldown = structure.cooldown.map(EditorStep.init)
blocks = structure.blocks.map { EditorBlock(iterations: $0.iterations, steps: $0.steps.map(EditorStep.init)) }
```

最小修复只在原有 `View`/MainActor 隔离初始化上下文中改成显式闭包，不改变 `EditorStep.init`、不添加 `nonisolated`、不关闭并发检查、不扩大 SwiftUI 重构：

```swift
warmup = structure.warmup.map { EditorStep($0) }
cooldown = structure.cooldown.map { EditorStep($0) }
blocks = structure.blocks.map { block in
    EditorBlock(iterations: block.iterations, steps: block.steps.map { EditorStep($0) })
}
```

| 检查 | 修复前 | 修复后 |
|---|---|---|
| 编辑器定向回归 | 79 checks（既有） | 79 checks，exit 0 |
| generic iOS Simulator | BUILD SUCCEEDED，3 个 unique Actor 警告 | `BUILD SUCCEEDED`（216.27 s），`main actor-isolated initializer` 0 条 |
| generic iOS Device | BUILD SUCCEEDED，3 个 unique Actor 警告 | `BUILD SUCCEEDED`（260.86 s），`main actor-isolated initializer` 0 条 |
| `npm run test:ios` | PASS | `PASS（103 个 Swift 源文件类型检查；iOS 聚合纯逻辑回归）` |

构建使用独立 DerivedData，`CODE_SIGNING_ALLOWED=NO`，完整 App Target 链接；没有用 Simulator UI 或独立 `swiftc` 代替 App 构建。VisualAcceptance `build-for-testing` 也编译成功（50.12 s，9 条工具链 warning），但 UI 用例未执行。构建警告证据见 `app-simulator.log`、`app-device.log`、`build-warnings-after.json`、`APP_BUILD_COVERAGE.json`。

## 6. 文档修正与链接结果

| 文档缺口 | 修正 |
|---|---|
| `AGENTS.md` 视觉验收仍要求个人 `var/rai.sqlite` | 改为 `prepare-phase5-fixture.mts` 生成隔离合成数据库，明确不读取个人数据库 |
| `apps/ios/tests/run-ios-gates.sh` 同类过时说明 | 已同步为专用 Simulator + 合成 Fixture |
| `IOS_NATIVE_API_CONTRACT.md` 未记录距离省略能力 | 新增 `trainingPlanSessionDistanceOmissionContractVersion` 行、请求头、依赖、缺位行为和握手 Vary/no-store 说明 |
| 更新读请求头与 Vary 语义 | 说明 `X-RAI-Training-Updates: 1` 必须与精确课程读头同时协商，三值 Vary 覆盖未请求/未知版本 |
| 证据报告可移植引用 | L4/P1 精选报告移除 `/tmp` 正文引用；`COMMANDS.md` 明确绝对路径仅记录历史环境；原始报告保留 `REPORT.source.txt` |
| Git 交付报告索引可达性 | `deliverables/README.md` 增加最终报告、L4 与各阶段报告入口 |

文档验证结果：

- `npm run check:docs`：PASS，所有本地链接存在，全部 Markdown 从根 README 可达。
- `npm run check:doc-refs`：PASS（0 越界/无法解析；8 处既有空行告警，无内容漂移基线）。
- `npm run check:acceptance-matrix`：PASS，80 cited / 0 missing。

## 7. 精选交付证据

只提交明确 allowlist 的文件，不整目录收入 `before/`、`REPORT.draft.txt`、`RedSkipRegression.swift`、临时 `model-targeted.sh`/`swift-editor.sh`、大型资源采样、构建产物、生产数据库或真实 Health XML/GPX。原始 233 个证据文件全部保留外部归档并逐个记录 SHA-256；131 个未入选文件在 `EVIDENCE_ALLOWLIST.json` 的 `excludedOriginalEvidence` 中逐项列出。

入选内容包括：

- A-01、D-01/D-02、I-01/P-03、D-03、P1、L4 报告及原始报告副本。
- 各阶段红测/绿测日志、测试文件清单、环境与统计 JSON、源码哈希。
- 四份独立补丁：`D01_D02.diff`、`stage.diff`、`D03.patch`、`P1.patch`。
- 最终 L4 的 331 文件发现、2,854/2,851/3 skip Node 终态、Python/Rust/iOS 门禁、Simulator/Device 构建和警告记录。
- 本轮 Actor 修复日志、两次完整构建、最终门禁日志、原始工作区保护与 61 文件哈希比较。

`EVIDENCE_ALLOWLIST.json` 记录每个入选文件的来源、原始 SHA-256、模式及精选版 SHA-256；报告链接均由文档门禁验证。历史红测保持红测事实，既没有改写为从未失败，也没有把早期失败算作最终失败。

## 8. 最终内容身份

`FROZEN_PRODUCT.json` 与 `PRODUCT_IDENTITY_COMPARISON.json` 逐项比较 61 个产品路径：

- 59 个路径与冻结内容完全一致（SHA-256、模式、LF）。
- 2 个路径为已授权差异：`AGENTS.md` 的视觉验收数据库说明、`TechTrainingSessionEditor.swift` 的 Actor 最小修复。
- 0 个产品路径缺失。
- 新增产品文件 8/8 已跟踪；三个 Node 测试全部被发现。
- 额外有 3 个已授权文档路径：`docs/IOS_NATIVE_API_CONTRACT.md`、`apps/ios/tests/run-ios-gates.sh`、`deliverables/README.md`；不属于产品逻辑变更。
- `.gitattributes` 另增加一条 `/deliverables/** whitespace=-trailing-space`：仅让原始日志/补丁保留历史空白，避免 `git diff --check` 因证据字节误报；源代码/现行文档仍执行默认检查。
- 未跟踪历史测试副本 0；敏感文件 0；大文件 0（全部 ≤ 1.5 MB）。

最终核对的额外说明：`docs/OPERATIONS.md` 和 `docs/TRAINING_PLAN_V2_CLOSED_LOOP_CONTRACT.md` 与原始冻结版本逐字一致，作为最终文档/证据提交的一部分纳入 Git，没有再次改写。

## 9. 最终验证与测试统计

最终验证命令在交付 worktree 执行，日志位于本目录：

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | PASS | 实际执行，记录在 `typecheck-final.log` |
| `npm run check:docs` | PASS | 所有 Markdown 可达、链接有效 |
| `npm run check:doc-refs` | PASS（8 处既有空行告警） | 0 越界/无法解析 |
| `npm run check:acceptance-matrix` | PASS | 80 cited / 0 missing |
| `npm run check:scripts` | PASS | npm script 可移植性 |
| `npm run check:package-boundaries` | PASS | 依赖边界 |
| `npm run check:training-plan-single-writer` | PASS | 结构判据，不代替运行时测试 |
| `npm run check:ios-gates` | PASS | 跨平台 iOS 源码门禁 |
| `npm run test:ios` | PASS（103 个 Swift 源文件类型检查；iOS 聚合纯逻辑回归） | Actor 提交的 pre-commit 聚合门禁 |
| Node 定向 API 回归 | PASS | 5 文件 134/134，0 fail/skip，28.05 s |
| Node L4 | INHERITED PASS，未重跑 | 331 文件、2,854 tests、2,851 pass、3 skip、0 fail；1346.007 s；并发 2 |
| Python | INHERITED PASS，未重跑 | 32/32 |
| Rust | INHERITED PASS，未重跑 | 2 unit + 32 cross-language |
| GitHub CI | NOT CHECKED | 本地分支未推送，不能声称远端通过 |

Node L4 是继承证据：最终 TypeScript/Node 产品内容与 L4 冻结版本一致，本轮没有重新运行 `npm test`；报告和最终说明都不能把这 2,851 个通过说成本轮新执行。最终 PR HEAD 仍必须在 GitHub CI 重新执行完整 Node 测试。

## 10. Git 状态、远程与 PR/CI 准入

交付分支停在本轮最终本地 HEAD（`本提交（HEAD；最终 SHA 由 `git rev-parse HEAD` 给出）`），工作区应为 clean。`github` 远程指向 `BlacnkCat0811/running`，本地交付分支尚未推送；没有设置 upstream，没有创建 PR/CI 记录。

允许进入 GitHub PR/CI 验收的前提是：用户明确授权推送当前本地分支；推送后由 CI 在当前 PR HEAD 重新运行完整 Node、Rust、Python 和 iOS 工作流；所有四个 job 实例（verify、两个 rust-data-worker、ios）按真实结果核对。当前不能宣称任何 GitHub CI 状态。

## 11. 未完成的真实数据与设备验收

以下事项仍未完成，不能由本报告、L4 或完整 App 构建替代：

- 真实生产健康/控制库的一致副本审计、历史状态冲突裁决与迁移/回滚演练。
- Simulator UI 点击、AMap 坐标 SDK 对拍、VisualAcceptance 用例实际运行。
- 真机 HealthKit 授权、前后台同步、后台任务与 WorkoutKit/Watch 排程。
- 真实设备上的编辑器后台刷新、暂停/结束执行、Skip/Confirm/Correct/Retract 交互。
- 生产部署、生产写能力开启和任何数据修复。

训练计划 V2 生产写能力保持关闭；本分支不包含生产启用授权。

## 验证结果

| 检查项目 | 结果 | 说明 |
|---|---|---|
| 类型检查 | PASS | 最终 `npm run typecheck` |
| L1 定向测试 | PASS | B08 37/37；核心 175/175；Actor editor 79 checks |
| L2 影响测试 | PASS | 核心 clean checkout 9 文件 175/175 |
| L3 模块回归 | PASS（继承） | P1 49 文件 495/495；未重跑 |
| L4 全量测试 | PASS（继承，未重跑） | 331 文件，2,851 pass / 3 skip / 0 fail |
| iOS 验证 | PASS / 部分未执行 | test:ios、Simulator/Device 构建；UI/真机未执行 |
| GitHub CI | NOT CHECKED | 未推送 |

## 测试统计

- 本轮实际新增执行：B08 clean 37、核心 clean 175、Actor editor 79 checks；另有最终定向 API 回归 5 文件 134/134。
- 继承 L4：Node 331 文件、2,854 总 tests、2,851 pass、3 skip、0 fail、0 cancel；Python 32/32；Rust 2 unit + 32 parity。
- iOS：`test:ios` 实际聚合门禁 `PASS（103 个 Swift 源文件类型检查；iOS 聚合纯逻辑回归）`；完整 Simulator/Device App 构建各 1 次，exit 0，Actor 目标警告 0。
- 并发配置：Node 均显式 `--test-concurrency=2` 或 `RAI_TEST_CONCURRENCY=2`；未提高并发或超时。
- 未覆盖：GitHub CI、真实设备、生产副本、Simulator UI 执行和真实 HealthKit/WorkoutKit。

## 风险与剩余事项

- 本地提交已可进入人工 diff/CI 审查，但不等于生产就绪。
- Node L4 为继承证据；PR HEAD 上必须重新跑完整 Node 测试。
- Actor 修复只验证编译隔离和既有 tests；没有新增 UI 行为测试，因为修复不改变 UI 行为。
- 真实数据、设备、生产副本和生产写能力仍未验收；训练计划 V2 生产写保持关闭。
- 交付分支尚未推送；推送、PR、合并和部署均需下一步明确授权。
