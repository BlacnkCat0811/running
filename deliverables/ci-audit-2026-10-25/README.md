# GitHub CI 审计与修复（2026-10-25）

## 1. 范围与结论

范围仅 CI、测试基础设施及相关文档。未修改业务源码、数据库结构、同步协议、算法输出或训练计划行为；未打开生产数据库、未部署、未推送。

开始时工作区干净，分支 `ci/fix-github-actions-2026-10-24`，HEAD 为 `ce787baa8b9b3c89f5c1f2332f01ae9fe2453b93`。`origin` 是 Gitee，另有 `github` 远端；README 中“GitHub CI 尚未启用”的说法已失实。

通过公开 GitHub REST API 获取最近全部 6 次运行，通过 GitHub 连接器逐项读取 Job/步骤和失败日志。不是仅从 commit message 推测。元数据、失败片段与分类保存在 [github-baseline.json](github-baseline.json)。本机没有 `gh`，使用 API 完成读取，没有使用生产服务。
本轮命令、退出状态、摘要与修改文件 SHA256 保存在 [local-validation.json](local-validation.json)；源文件清单不包含该清单自身，避免自引用。

- 6 次运行共 30 个 Job 实例：15 success、9 failure、6 cancelled。历史失败不是当前仍有 9 个 Job 失败。
- 历史 9 个 failure 实例已由开始前的基线修复消除（不是本轮新增修复）；本轮没有额外的产品缺陷修复。新修订的 4 个正式 Job 仍未运行，不能将未运行写成 0 失败。
- 最新基线 [40130489750](https://github.com/BlacnkCat0811/running/actions/runs/40130489750) 对应 `ce787ba`，5/5 Job 成功；本轮开始时当前 SHA 的失败数为 **0**。
- 之前的失败已由基线中的历史修复处理；本轮收敛支持平台并补齐覆盖和可靠性缺口。
- **本轮修改尚未推送，修改后的 GitHub Actions 未验证，不能宣布远端修复验收完成。** 本机通过不能替代新 SHA 的远端结果。

## 2. 真实失败基线

所有行的 Workflow 均为 `CI`。表中 Job 链接直接指向日志，运行号链接指向该次完整运行。Windows 表示当时 `windows-latest`（日志镜像 windows-2025-vs2026），Linux 为 ubuntu-24.04，Mac 为 macos-26，首轮 iOS/Rust Mac 为 macos-14。每个失败/取消实例均保留，未将 cancelled 合并成测试失败。

| Run / commit | Job / Runner | 实际失败步骤与日志 | 分类、修复与复现边界 |
|---|---|---|---|
| [40100650964](https://github.com/BlacnkCat0811/running/actions/runs/40100650964) / `04ca32f` | [verify](https://github.com/BlacnkCat0811/running/actions/runs/40100650964/job/120891926950) / Linux | Install dependencies：`Failed to find runtimes/win-x64/native/libonnxruntime_providers_cuda.so in NuGet package` | 依赖安装错误；保留已有 `ONNXRUNTIME_NODE_INSTALL=skip`，CPU 库随 npm 包分发。Linux 原始错误本机 macOS 不可等价复现，后续远端安装与推理测试通过。 |
| 同上 | [rust-data-worker](https://github.com/BlacnkCat0811/running/actions/runs/40100650964/job/120891927023) / Linux | Install Node dependencies：同一 NuGet 路径错误 | 与上一行同因；不是 Rust 产品缺陷。 |
| 同上 | [ios](https://github.com/BlacnkCat0811/running/actions/runs/40100650964/job/120891926729) / macos-14 | Run iOS gates：`error: unknown argument: '-default-isolation'` | 工具链错误；历史修复已换 macos-26。本轮固定成功基线的 Xcode 26.6，不删除 actor 隔离检查。本机 Xcode 26.5，无法重现旧编译器缺参。 |
| 同上 | [rust-data-worker](https://github.com/BlacnkCat0811/running/actions/runs/40100650964/job/120891927000) / macos-14 | Rust verify：`The operation was canceled` | cancelled；Linux 同矩阵安装先失败，按当时默认 fail-fast 推断是联动取消。本轮 `fail-fast: false` 保留两端独立诊断。不是已证实 Rust 失败。 |
| 同上 | [windows-runtime](https://github.com/BlacnkCat0811/running/actions/runs/40100650964/job/120891926931) / Windows | Windows tests：`The operation was canceled`，取消前已有 POSIX 断言失败 | 日志只明确取消；结合当时 12 分钟预算和运行时长判断超时，不能把它报告为外部服务故障。Windows 不再正式支持，本轮删除该 Job，保留测试。 |
| [40105141027](https://github.com/BlacnkCat0811/running/actions/runs/40105141027) / `93cc7d2` | [verify](https://github.com/BlacnkCat0811/running/actions/runs/40105141027/job/120905164565) / Linux | Documentation：`not reachable from README.md` | 文档基础设施；绝对机器路径使链接/孤儿检查失败。历史提交 `2259c52` 改为仓库相对路径，未降级文档门禁。本机可执行同一文档检查。 |
| 同上 | [ios](https://github.com/BlacnkCat0811/running/actions/runs/40105141027/job/120905164566) / macos-26 | Gates：`FAIL: late success cannot publish after probe cancellation`、`late success after cancellation cannot trigger reload` | 不稳定测试；历史提交 `25b413b` 先观察请求开始/响应交付，再取消并释放主 actor，替代定时器抢窗口。断言保留；本机同脚本可跑，但旧竞态不保证每次复现。 |
| 同上 | [rust-data-worker](https://github.com/BlacnkCat0811/running/actions/runs/40105141027/job/120905164776) / macos-26 | Rust verify：2 个 native-import-worker 断言超时，实际状态 `recovery_required`、主库缺失 | 夹具前置错误；`824d867` 初始化隔离主库后再验证引擎拒绝，未更改恢复协议。本机可跑同一夹具。 |
| 同上 | [rust-data-worker](https://github.com/BlacnkCat0811/running/actions/runs/40105141027/job/120905164610) / Linux | 同一两个断言失败，Job 最终 cancelled | 先有同因测试错误，随后矩阵联动取消；不能只写成“取消，无缺陷”。本轮关闭 fail-fast。 |
| 同上 | [windows-runtime](https://github.com/BlacnkCat0811/running/actions/runs/40105141027/job/120905164444) / Windows | Windows tests：取消；之前已出现信号/文件系统错误 | 取消/预算与 OS 差异；本机不跑 Windows，按新支持范围移除 Job，测试保留。 |
| [40109692198](https://github.com/BlacnkCat0811/running/actions/runs/40109692198) / `25b413b` | [verify](https://github.com/BlacnkCat0811/running/actions/runs/40109692198/job/120918626477) / Linux | Tests：`同路径换了文件必须被看见`，`false !== true`；2626 tests、1 fail | OS/夹具错误；`unlink+copy` 可复用刚释放的 inode。`0ad5696` 用曾同时存在的 replacement 经 rename 替换，保证不同文件身份。本机可验证 rename，但 APFS 不保证复现 ext4 分配行为。 |
| 同上 | [windows-runtime](https://github.com/BlacnkCat0811/running/actions/runs/40109692198/job/120918626250) / Windows | Windows tests：取消，旧预算仍 12 分钟 | 预算/OS 差异；不改 POSIX 判据。 |
| [40110796362](https://github.com/BlacnkCat0811/running/actions/runs/40110796362) / `0ad5696` | [windows-runtime](https://github.com/BlacnkCat0811/running/actions/runs/40110796362/job/120921905222) / Windows | Windows tests：`exit=1 signal=null`，`null !== 'SIGKILL'`，随后取消 | Windows 无 POSIX signalCode；12 分钟预算也不足。`80c93cd` 曾加至 40 分钟；这没有修复 OS 语义。本轮删除 Windows Job。 |
| [40111905608](https://github.com/BlacnkCat0811/running/actions/runs/40111905608) / `80c93cd` | [windows-runtime](https://github.com/BlacnkCat0811/running/actions/runs/40111905608/job/120925194692) / Windows | Windows tests：2539 pass / 52 fail / 1 cancelled / 34 skipped | 信号、systemctl 替身/PATH、open-file rename/unlink/chmod 等 OS 差异。`ce787ba` 已为 POSIX 用例明确 Windows skip；本轮未增加任何 skip，也未移除这些测试。 |
| 同上 | [ios](https://github.com/BlacnkCat0811/running/actions/runs/40111905608/job/120925194874) / macos-26 | 重复 Model regression：`Precondition failed: a new workouts request cancels the old URLSession request, not merely discards its result`，exit 133 | 不稳定测试；`7bd3a28` 等旧 URLProtocol 请求实际开始，再切过滤器并等取消事实。本轮去除重复整套回归，聚合入口仍执行它。 |

没有从这些日志确认新的产品代码缺陷、算法缺陷、真实 SQLite 协议缺陷或外部服务故障。本轮未扩大到这类修改。

## 3. 本轮修复与覆盖

| 文件 | 修改与理由 | 验证 |
|---|---|---|
| [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | 移除 Windows 专属 Job；Linux 固定 ubuntu-24.04、全量 `npm test` 并发 2、Job 预算 40 分钟。保留 Node 22、Python 3.12、锁文件与 CPU ONNX 安装口径。 | actionlint 1.7.11 与入口回归；新远端结果待授权推送。 |
| 同上 | 接入遗漏的训练计划 single-writer 与 Linux iOS source gates；增加所有已跟踪 deploy Shell 的 `bash -n`。不启动真实服务。 | 结构门禁、部署文本/替身行为测试。 |
| 同上 | 加入固定版本、SHA256 校验的 actionlint；同分支旧运行取消，Rust 矩阵不再联动中断。 | 本机 actionlint；不缓存数据库/凭证，权限仍 contents:read。 |
| 同上 | iOS 固定已成功运行的 Xcode 26.6；预检 iOS SDK；保留默认本地 skip 语义，CI 检出未检查源码哨兵或缺少完成标记则失败。Actions 显式 bash 使用 `-eo pipefail`，tee 不吞退出码。 | 完整 Swift gates、模拟器无签名构建与失败传播探针。 |
| 同上 | `pod install --deployment` 锁定 Pods；缓存只含 CocoaPods 下载，键含架构/锁文件；DerivedData 使用 runner 临时目录。删除重复 `run-model-tests.sh`，聚合入口仍完整运行一次。 | Pod 锁一致性、iOS build、UI build-for-testing；UI 不冒充已运行。 |
| [scripts/rust-worker.mjs](../../scripts/rust-worker.mjs) | Rust verify 补跑 HealthKit record sync v2 UUID/删除契约测试。原 Linux 全量因缺二进制跳过它，原 Rust Job 也未包含它，是实际覆盖缺口。 | `rust:verify` 先锁定构建，再以 `RAI_REQUIRE_RUST_TESTS=1` 运行原两个文件及新增文件。 |
| [cross-platform-scripts.test.ts](../../packages/application/test/cross-platform-scripts.test.ts)、[test-runner.test.ts](../../packages/application/test/test-runner.test.ts) | 将已退役 Windows Job 配置断言改为正式 Linux/iOS 门禁完整性断言；原跨平台行为、发现、异常退出等测试继续保留。 | 23/23 定向回归；全量结果见下。 |
| [AGENTS](../../AGENTS.md)、[README](../../README.md)、[OPERATIONS](../../docs/OPERATIONS.md)、[iOS runbook](../../docs/IOS_NATIVE_RUNBOOK.md)、[项目优化方案](../../docs/PROJECT_OPTIMIZATION_PLAN.md)、[项目审查](../../docs/PROJECT_REVIEW.md)、[Gitee 草案注释](../../.workflow/master-ci.yml)、[产物索引](../README.md)、本目录 | 更新正式平台、实际 GitHub 执行渠道与证据边界，保留历史事实，接入报告链接；Gitee 草案未启用，未修改其行为。 | 文档链接/可达性、引用、脚本与 blob 门禁。 |

数据库相关验证均来自测试创建的隔离临时库。全量测试包含 migration 冻结、WAL、事务提交/回滚、文件身份/锁、发布指针、双车道导入、回执与事实/分析状态分离、幂等/增量、Worker 重启与 POSIX 强杀恢复；没有用 mock 替代原有这些关键用例。SIGKILL 断言验证杀死后的恢复，未要求 SIGKILL 清理回调。

## 4. 测试结果

本机：macOS 26.6.2 / Intel，Node 22.23.2、npm 10.9.8，Xcode 26.5 (17F42)，仓库本地工具链 Rust 1.98.1、Python venv 3.12.14、CocoaPods 1.17.0。本机工具链与 GitHub arm64 / Xcode 26.6 不完全相同，必须分别验收。Swift/Xcode 编译以较低进程优先级运行，Xcode 并行编译限制为 2；Node 文件并发始终为 2，未调整测试超时或断言。

仓库未配置 ESLint 或 Swift Package，也没有原生 XCTest 单元测试 Target；RAI 工程只有 iOS App Target 与 RAI Scheme。执行的是现有 `run-model-tests.sh` 聚合的 Swift 可执行回归，另编译独立的 VisualAcceptance UI 测试工程；不把空 `xcodebuild test` 或新造无关测试作为验收。HealthKit 权限说明、后台 capability 与 iOS-only destination 仍保留。

下列结果来自本轮真实执行；本机可执行的必要检查均已结束，通过与跳过分别记账。新提交的远端结果仍未验证。

| 检查 | 状态 | 结果/边界 |
|---|---|---|
| GitHub 基线 `ce787ba` | PASS（历史基线） | Linux 2613 pass / 0 fail / 13 skipped；Python 32；iOS build、Swift gates、UI 编译和两个 Rust Job 均成功。 |
| 本轮 `npm ci` | PASS | 使用 ONNXRUNTIME_NODE_INSTALL=skip；依赖主版本/锁文件未改。 |
| actionlint 1.7.11 | PASS | 下载包 SHA256 核对；工作流语法/表达式通过。 |
| 测试入口定向回归 | PASS | 23 pass / 0 fail / 0 skipped。 |
| iOS CI 失败传播探针 | PASS | 正常完成 exit 0；跳过 exit 1；静默 exit 0 被闸门拒绝为 exit 1；编译失败 exit 17 原样传播。直接提取实际 workflow step，在临时 PATH 注入 npm 替身执行。 |
| actionlint 有效性探针 / Rust 工具链选择 | PASS | 有效 workflow exit 0，注入无效 Job 字段 exit 1；空 Rustup home 会按仓库文件请求 1.98.1，探针刻意将下载端点置为不可达，没有另装工具链。 |
| Python `npm run ml:test` | PASS | 32 passed。 |
| 本轮 typecheck | PASS | 最终修改的两套严格 TS 配置均通过；定向入口回归再次 23/23。 |
| 本轮 `RAI_TEST_CONCURRENCY=2 npm test` | PASS | 2626 tests：2623 pass / 0 fail / 0 cancelled / 3 skipped，1247.66 s；总数与基线相同，未删除测试。3 skip 全为 Windows 专属行为，Rust 二进制本机已具备，10 项 Rust 测试也在全量中执行。 |
| iOS App 无签名构建 | PASS | Xcode 26.5、generic iOS Simulator、隔离 DerivedData、jobs=2，BUILD SUCCEEDED；地图 Key 以空值覆盖，仅验证编译。 |
| UI build-for-testing | PASS | 独立 VisualAcceptance 工程 TEST BUILD SUCCEEDED；未启动或运行 UI 测试。 |
| `npm run test:ios` | PASS | 99 文件类型检查 + 全部纯逻辑聚合回归完成，最终完整门禁标记已确认；真实输出还通过新 CI 完成检查。AMap 依赖的 3 个文件由完整 Xcode build 覆盖。包含训练计划/v2/DTO、会话取消、导出、记录同步 126 项结构判据与 SQLite store 127 项回归。 |
| `npm run rust:verify` | PASS | Rust release locked 构建、2 个 Rust 单元测试、32 个 Node 合同测试全部通过，0 skipped；新增 record-sync v2 用例实际为 `ok 23`。 |
| `npm run review:model-boundaries` / `smoke:api` | PASS | R1–R3 violationCount=0；临时运行目录的 API 启动/健康状态/SIGTERM 退出通过。 |
| 独立副本 production-only install | PASS | `npm ci --omit=dev` 后 TypeScript 编译器、React/Vite/Vitest 均不存在，API smoke 通过；未移除开发工作区依赖。 |
| 部署脚本语法 / 结构门禁 | PASS | 4 支 deploy Shell 的 bash -n；11 支 iOS source gates；single-writer、包边界及自测、脚本语法、验收矩阵、文档门禁均通过。 |
| 新修订 GitHub CI | BLOCKED | 用户明确要求本地报告后等待推送授权，未推送/未触发新运行。 |
| Simulator UI 执行 / AMap SDK 对拍 | NOT RUN | 只编译 UI；不使用私人健康数据库。 |
| HealthKit 真机授权/读取、系统后台唤醒、WorkoutKit 实际排期 | NOT RUN | 普通 CI 与 mock 不能证明这些设备行为。 |
| 真实 systemd / nginx / 2C2G 容量验收 | NOT RUN | 本机非 Linux；部署契约与 bash 静态语法不等于服务集成/容量通过。 |

历史 Linux 的 13 skip 是 3 项 Windows 专属行为及 10 项缺 Rust 二进制的用例。本轮 Rust Job 已补齐原来遗漏的 record-sync v2 文件，其余 Rust 用例原本就在 Rust Job。Windows 专属测试文件保留，不代表现在对 Windows 提供支持。`check:ios-gates` 另有 2 个已设计为人工入口的检查（突变验证、Simulator 跨进程导出），不计为 11 项结构门禁通过的一部分。

一次本机验证启动顺序错误：`npm ci` 尚未完成时启动 typecheck，得到 `tsc: command not found`。等待安装结束后重跑成功，最终修改后又复核成功；这不是远端 CI 根因，也未为此修改依赖或编译配置。

## 5. GitHub Actions 与提交验收

| 基线 Run `40130489750` / SHA `ce787baa8b9b3c89f5c1f2332f01ae9fe2453b93` | 状态 |
|---|---|
| [verify (22.x)](https://github.com/BlacnkCat0811/running/actions/runs/40130489750/job/120980964982) | success |
| [ios](https://github.com/BlacnkCat0811/running/actions/runs/40130489750/job/120980964870) | success |
| [Rust Linux](https://github.com/BlacnkCat0811/running/actions/runs/40130489750/job/120980964948) | success |
| [Rust macOS](https://github.com/BlacnkCat0811/running/actions/runs/40130489750/job/120980964679) | success |
| [Windows（历史配置）](https://github.com/BlacnkCat0811/running/actions/runs/40130489750/job/120980964999) | success；本轮移除 |

本轮已完成本地修复与验证；提交号在提交完成后由最终交付消息列出，本报告随该提交一起保存，避免自引用 SHA。新 SHA 的 Run ID：**无（未推送）**。

待授权推送后，必须核对新 SHA 的 Linux、iOS、Rust Linux、Rust macOS 四个 Job 的实际成功状态及步骤计数，再宣布远端验收通过。不得复用旧 SHA 的绿灯，也不得把本机结果当作云端 Linux 运行结果。

## 6. 剩余风险

- 新工作流/固定 Xcode 路径/`pod --deployment` 的 GitHub 验证仍待推送。工具链将来从 runner 移除时会显式失败，需按实际运行证据更新固定版本。
- Actions v4/v5 使用的内部 Node 20 已出现 runner 自动转 Node 24 的警告；历史基线实际成功。本轮没有顺手升级 Actions 主版本，后续可独立核验固定 SHA 升级。
- 本机 `npm ci` 提示 2 项依赖审计发现（low/moderate）；未执行改变锁文件的 `npm audit fix`，本任务不将依赖安全升级混入 CI 修复。
- Gitee 与 GitHub 是独立远端；只推 Gitee 不会产生 GitHub 结果。仓库保护规则是否要求四个正式 Job 属远端治理，本轮未修改；Rust Linux 的检查名称由 `rust-data-worker (ubuntu-latest)` 变为 `rust-data-worker (ubuntu-24.04)`，需核对 required checks 是否使用旧名称。
- 本轮验证不证明生产服务状态、真实健康数据同步正确性或阶段 6 的 2C2G 容量达标；设备和 systemd 人工验收继续保留。

配置依据：[GitHub runner 镜像的 Xcode 清单](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)、[GitHub 显式 bash 的失败处理](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell)、[rustup 工具链文件规则](https://rust-lang.github.io/rustup/overrides.html)、[actionlint 官方安装说明](https://github.com/rhysd/actionlint/blob/main/docs/install.md)。实际版本以本报告记录的运行日志为准。
