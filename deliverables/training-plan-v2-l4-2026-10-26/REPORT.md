# 训练计划 V2 最终验收阶段一 — L4 与完整 iOS 构建

交付整理版：测试结果保持原样；原始报告见 [REPORT.source.txt](REPORT.source.txt)，来源哈希及未入库材料见 [精选清单](../training-plan-v2-final-2026-10-26/EVIDENCE_ALLOWLIST.json)。绝对路径只记录历史执行环境，不作为当前运行入口。


日期：2026-10-26（Asia/Shanghai）。模式：AUDIT + VALIDATE。原始证据目录保存在本机外部临时归档；本目录是经明确 allowlist 精选的副本，原始报告见 `REPORT.source.txt`。

## 结论

本阶段要求的本地 L4 命令、Python/Rust 门禁、完整 Simulator App 编译、generic iOS Device App 编译及 UI 测试工程编译均已通过，真实退出码均为 0。没有确认的业务测试失败。存在明确平台跳过、编译警告和未验证项，不能写作“零警告”“GitHub CI 通过”或“生产发布就绪”。

可以进入完整变更的提交审查与 GitHub CI。提交时必须包含实际依赖的未跟踪源码、测试和 Fixture；本报告不授权自动提交、推送、合并、部署、生产数据修复或 V2 生产写能力。

## 1. Git 基线与冻结

分支 `main`，相对 `origin/main` ahead 2。HEAD：`2e7c07bb66b3701c4e1b768c90f431b654584f5c`。暂存区为空。53 个 tracked 文件已修改（4,013 additions / 359 deletions）；另有 241 个未跟踪文件，其中 8 个为产品源码/测试/Fixture/工具，233 个为前阶段交付证据。

```text
2e7c07b feat(training-plan): implement v2 session and execution closed loop
1fc866a Merge pull request #1 from BlacnkCat0811/ci/fix-github-actions-2026-10-24
1b6a10b fix(ci): enforce Linux and native iOS verification
```

本轮保存了原始 status、diff、diff stat、tracked/untracked 清单以及 2,651 个现存非忽略文件 SHA-256。开始与结束的 `git diff --check` 均 exit 0。完整清单见 [冻结哈希](workspace-before-sha256.json)、Git 状态（外部原始归档，见精选清单）、原始差异（外部原始归档，见精选清单）。

此前 A-01、D-01/D-02、I-01/P-03、D-03、P1 的报告和代码均存在；P1 SHA256SUMS 所列证据全部匹配。源码确认了历史 rest lock 分类、共享距离 Fixture、Skip 资格、结构上限、执行授权/最终事实检查/reconcile-v2、不可变编辑身份和独立省略距离协商。B08 协调器、更新读合同、HTTP/定时器及 Swift Store/DTO 回归均在当前树中，本轮 Node 与 Swift 验证实际执行了对应路径。此处未用旧日志替代本轮结果。

重要 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `AGENTS.md` | `2df97360c6034d7517e5a04b45c24e71bba3d53d30f699060df531e2390af1e7` |
| `package.json` | `a774d2d94590c53e71d94cc807985b6740d8be87dbef2f3032b809412796480f` |
| `scripts/run-tests.mjs` | `9f4479bc8943a3ac4bd7455f3af008d7462d56012ab7ced41192066c1e6d8eb7` |
| `.github/workflows/ci.yml` | `d726cf371fcb9a1ffad385dfbd54720b95b3d203d56e1269be848a2582c83d73` |
| `apps/api/src/training-plan-execution-commands.ts` | `1d77f45b6dbfae645f3eb724e70269ced5f95711a90a15d9a682d354de2f13d7` |
| `apps/ios/RAI/TrainingPlanSessionEditorPolicy.swift` | `662075a793a1c063b49e0135e7d093bbac13538acda9fd45f3daf02debee6671` |
| `apps/ios/tests/fixtures/training-session-distance-v1.json` | `24667252898aa4c1a237eb3eed2434e3b72624551beadbf76f622499dfa91156` |
| `apps/ios/RAI.xcodeproj/project.pbxproj` | `9ea441c0d0b34954cefb992fa973b840424ba669684f97f5c2c36ccbd9aef112` |
| `apps/ios/Podfile.lock` | `85bf628c4624a7899a8ecafbe4a388e80a4c34c8afbb34261234fd383e606c3c` |

## 2. L4 测试发现与真实性

| 域 | 已跟踪测试文件 | 实际发现并传给 Node 的文件 |
|---|---:|---:|
| `apps/api` | 164 | 167 |
| `packages/application` | 49 | 49 |
| `packages/contracts` | 6 | 6 |
| `packages/durability` | 1 | 1 |
| `packages/dynamics` | 1 | 1 |
| `packages/features` | 5 | 5 |
| `packages/health-export-parser` | 32 | 32 |
| `packages/model-eval` | 7 | 7 |
| `packages/normalization` | 1 | 1 |
| `packages/physiology` | 3 | 3 |
| `packages/prediction-inference` | 1 | 1 |
| `packages/readiness` | 2 | 2 |
| `packages/scoring` | 9 | 9 |
| `packages/storage-sqlite` | 44 | 44 |
| `packages/training-load` | 2 | 2 |
| `packages/training-zones` | 1 | 1 |
| **合计** | **328** | **331** |

测试发现使用当前 `scripts/run-tests.mjs` 的真实导出函数，已执行 tracked ⊆ discovered 断言，遗漏为 0；非空保护保持有效。331 个明确文件路径传给真实 Node runner。未修改发现器或使用替代筛选脚本。完整文件名见 [test-discovery.json](test-discovery.json)。

三个未跟踪产品测试均被发现并纳入全量：

- `apps/api/test/training-plan-execution-cursor-errors.test.ts`
- `apps/api/test/training-plan-history-compatibility.test.ts`
- `apps/api/test/training-plan-state-audit.test.ts`

交付目录内 `before/` 历史测试副本不属于产品测试，未被重复执行。另记录 9 个产品 Fixture 文件。未跟踪的 `TrainingPlanSessionEditorRegression.swift` 已接入普通 iOS 聚合路径；普通路径 9 支脚本覆盖全部 33 个 `*Regression.swift`，无未接入回归。静态可达图另含 1 支可选 mutation 脚本，本轮没有启用。

| 套件 | 报告用例/范围 | 通过 | 失败 | 跳过/忽略 | 取消 |
|---|---:|---:|---:|---:|---:|
| Node L4 | 2,854 | 2,851 | 0 | 3 | 0 |
| Python pytest | 32 | 32 | 0 | 0 | 0 |
| Rust 单元测试 | 2 | 2 | 0 | 0 | 0 |
| rust:verify 跨语言 Node 回归 | 32 | 32 | 0 | 0 | 0 |
| iOS 纯逻辑/模型 | 33 个回归文件 + 源码门禁 | 聚合通过 | 0 个命令失败 | 三个 SDK 文件不在独立类型检查中，已由完整构建补齐 | 无中断 |

Node 实际运行 2,851 个测试体，另外 3 个按平台跳过；TAP 总数 2,854，todo 0，suite 0。不能将跳过计为通过。Rust 的 32 个 Node 用例与 L4 有重叠，不与其相加计算唯一用例总数。Swift 各脚本使用不同的 check/断言计数口径，本报告不编造统一用例总数；逐套件实际数字见 [ios-summaries.txt](ios-summaries.txt)。

## 3. 本轮命令、耗时与退出码

所有以下命令均真实执行；耗时为外部观察的墙钟秒数，原始 `/usr/bin/time -l` 输出在各日志末尾。完整 argv、cwd、环境覆盖值和资源数据见 [COMMANDS.md](COMMANDS.md) 与 [commands.json](commands.json)。

| 命令/检查 | 结果 | 秒 | 退出码 | 日志 |
|---|---|---:|---:|---|
| `npm run typecheck` | PASS | 26.144 | 0 | [typecheck](typecheck.log) |
| `RAI_TEST_CONCURRENCY=2 npm test` | PASS | 1346.007 | 0 | [node-l4](node-l4.log) |
| `npm run check:docs` | PASS | 1.688 | 0 | [docs](docs.log) |
| `npm run check:doc-refs` | PASS | 1.524 | 0 | [doc-refs](doc-refs.log) |
| `npm run check:acceptance-matrix` | PASS | 4.705 | 0 | [acceptance](acceptance.log) |
| `npm run check:scripts` | PASS | 1.370 | 0 | [scripts](scripts.log) |
| `npm run check:package-boundaries` | PASS | 1.182 | 0 | [boundaries](boundaries.log) |
| `npm run check:package-boundaries -- --self-test` | PASS | 0.925 | 0 | [boundaries-self](boundaries-self.log) |
| `npm run check:training-plan-single-writer` | PASS | 2.921 | 0 | [single-writer](single-writer.log) |
| `node scripts/check-blob-size.mjs` | PASS | 2.910 | 0 | [blob](blob.log) |
| `npm run review:model-boundaries` | PASS | 24.521 | 0 | [model-boundaries](model-boundaries.log) |
| `npm run smoke:api` | PASS | 3.185 | 0 | [smoke](smoke.log) |
| `npm run ml:check` | PASS | 7.914 | 0 | [ml-check](ml-check.log) |
| `npm run ml:test` | PASS | 15.881 | 0 | [ml-test](ml-test.log) |
| `npm run rust:verify` | PASS | 100.388 | 0 | [rust-verify](rust-verify.log) |
| `npm run check:ios-gates` | PASS | 3.111 | 0 | [ios-gates](ios-gates.log) |
| `npm run test:ios` | PASS | 971.324 | 0 | [ios](ios.log) |
| `xcodebuild -list -json（RAI workspace）` | PASS | 8.391 | 0 | [xcode-list](xcode-list.log) |
| `xcodebuild -showBuildSettings -json（仅保存允许字段）` | PASS | 4.068 | 0 | [xcode-settings](xcode-settings.log) |
| `xcodebuild / RAI / generic iOS Simulator / build` | PASS | 165.136 | 0 | [app-simulator](app-simulator.log) |
| `xcodebuild / RAI / generic iOS Device / build` | PASS | 167.952 | 0 | [app-device](app-device.log) |
| `xcodebuild / VisualAcceptance / build-for-testing` | PASS | 34.750 | 0 | [visual-compile](visual-compile.log) |
| `npm ci --omit=dev（隔离副本）` | PASS | 22.441 | 0 | [production-install](production-install.log) |
| `检查 typescript / vite / react / vitest 缺席` | PASS | 0.333 | 0 | [production-assert](production-assert.log) |
| `npm run smoke:api（仅生产依赖副本）` | PASS | 6.839 | 0 | [production-smoke](production-smoke.log) |
| `bash -n`，4 个 tracked deploy shell | PASS | 0.073 | 每项 0 | [结果](deploy-syntax.json) |

没有重复执行 `test:all`：其 typecheck / npm test / test:ios / ml:test 四个组成入口已各执行一次。没有运行不存在的 test:changed/test:affected。Rust verification 按 CI 既有脚本重跑 3 个跨语言文件；两个 iOS 聚合入口会重复执行部分 Python 源码门禁；两次 smoke 分别验证当前依赖与仅生产依赖，这些是明确的验证重叠。

## 4. CI 要求核实与边界

已读取当前 `.github/workflows/ci.yml`：Rust 在 ubuntu-24.04 与 macos-26；iOS 在 macos-26 并固定 Xcode 26.6；verify 在 ubuntu-24.04 / Node 22，要求完整发现、Python 锁定环境、模型边界、文档/结构门禁、API smoke 和生产依赖启动。

本轮在 macOS 26.6.2 x86_64、Node 22.23.2 / npm 10.9.8、Python 3.12.14（ML）、Rust 1.98.1 下执行可用门禁。iOS 源码 Python 门禁使用系统 Python 3.9.6，满足其 ≥3.9 条件。SQLite/迁移、合同、导入发布、API runtime 和 deploy-cloud/n100/upgrade 文本/模拟命令回归均由本轮全量发现覆盖；没有运行生产迁移 CLI。部署 shell 只作语法解析及测试中的 systemctl 替身，不代表真实 Linux systemd/nginx 集成验收。

仅生产依赖验证在临时副本进行，`ONNXRUNTIME_NODE_INSTALL=skip` 与 CI 的可选 GPU 下载策略一致；确认 typescript、vite、react、vitest 不存在后运行 API smoke，exit 0。原工作区 node_modules 未重装。ML 已有锁定依赖检查通过，故没有运行可能重建现有 venv 的 ml:bootstrap。已有 Pods/Manifest.lock 与 Podfile.lock 一致，本轮直接使用锁定 SDK，没有在原工程运行 pod install。

GitHub CI：**NOT CHECKED**。本机测试不能代替 Linux job，也不能代替固定 Xcode 26.6 的 CI；当前工作区未提交内容也尚未对应任何 CI revision。actionlint 本机未安装；临时获取 v1.7.11 时网络读取超时（159.035 s），没有取得可执行文件，故该 workflow lint 为 **NOT RUN（环境/网络）**，没有计作 PASS。见 [获取结果](actionlint-install.json)。

## 5. 完整 App 编译与 AMap 覆盖

真实工程为 `apps/ios/RAI.xcworkspace`，包含 RAI.xcodeproj 与 Pods.xcodeproj；共享 Scheme 为 RAI，App Target 为 RAI，Debug bundle 为 app.rai.running.debug。最低 iOS 17.0，Swift 语言模式 5.0，默认 actor 为 MainActor，SDK 26.5。工程支持 iphoneos / iphonesimulator，无新增平台或 Target。

本机 Xcode 26.5 (17F42)、Swift 6.3.2；与 CI 固定 Xcode 26.6 的差异保留为待 CI 验证事项。CocoaPods 1.17.0，AMap3DMap 11.2.100、AMapFoundation 1.9.1；现有 framework 均有 x86_64 / arm64 slice。工程签名原设 Automatic / Apple Development，本轮均用 `CODE_SIGNING_ALLOWED=NO`，没有个人签名、证书或 provisioning 操作。

为避免 Pods resource 脚本写入原 Pods，使用临时工程副本。495 个复制文件（含工程、源码、测试与 SDK）起初与原文件逐个 SHA-256 一致；完整构建没有删除源码、添加 stub 或绕过 App Target。副本内每个 App build 的 SwiftFileList 都包含 106/106 个产品 Swift 文件，另有 1 个生成文件；两个构建均完成链接并生成 RAI.app。

| 构建 | 架构 / Mach-O 平台 | 结果 | 耗时 |
|---|---|---|---:|
| generic iOS Simulator | x86_64 / IOSSIMULATOR / minos 17.0 / SDK 26.5 | BUILD SUCCEEDED | 165.136 s |
| generic iOS Device | arm64 / IOS / minos 17.0 / SDK 26.5 | BUILD SUCCEEDED | 167.952 s |
| VisualAcceptance build-for-testing | iOS Simulator 测试 bundle 与 runner | TEST BUILD SUCCEEDED；未运行 UI | 34.750 s |

| 原独立类型检查排除项 | Simulator | Device |
|---|---|---|
| MapPrivacy.swift | 编译输入 + MapPrivacy.o + 链接完成 | 编译输入 + MapPrivacy.o + 链接完成 |
| RAIApp.swift | 编译输入 + RAIApp.o + 链接完成 | 编译输入 + RAIApp.o + 链接完成 |
| TechRouteView.swift | 编译输入 + TechRouteView.o + 链接完成 | 编译输入 + TechRouteView.o + 链接完成 |

逐个目标文件路径、尺寸、哈希及 Mach-O 平台证据见 [Simulator coverage](app-simulator-coverage.json) 与 [Device coverage](app-device-coverage.json)。这补齐了独立 swiftc 检查排除的三个 SDK 文件，但不能证明地图运行、UI 操作、HealthKit 权限或 Watch 排程成功。

## 6. 跳过、警告及审计发现

### 平台/手工排除

1. Node：Windows path-alias semantics（路径别名）。
2. Node：Windows locked rollback（POSIX 可重命名打开的数据库，无法复现 Windows 锁定行为）。
3. Node：Windows process-tree cancellation。
4. `check-background-mutations.py`：本轮未启用；它会修改 Swift 源码做突变，超出只读范围。
5. `check-export-determinism-live.py`：本轮未进行 Simulator 探针跨进程运行。
6. Simulator UI 测试、AMap 坐标 SDK 对拍、真实 HealthKit、后台真机同步、配对 Watch 排程及生产数据副本审计均 NOT RUN。UI 工程编译成功不等于 UI 用例执行。

### P2 — 完整编译新增可见的 actor 隔离警告

已确认：`apps/ios/RAI/Skins/Technology/TechTrainingSessionEditor.swift:307:39`、`:307:91`、`:308:100` 的 `map(EditorStep.init)` 引用发出 “call to main actor-isolated initializer … in a synchronous nonisolated context”。initializer 定义在同文件 34 行。Simulator 与 Device 各发出同样 3 条（3 个唯一位置），当前 Swift 5 模式构建 exit 0；独立 warnings-as-errors 类型检查未报告这些诊断。

影响范围：编辑器初始化的 warmup/cooldown/block step 映射及编译隔离约束；本轮没有证据证明实际业务行为失败。建议单独授权最小修复，保留正确 actor 上下文，并以完整 Target 编译复验；不能仅凭纯类型检查消除此发现。未修改代码或编译警告策略。完整诊断见 [build-warnings.json](build-warnings.json)。

### P3 — 其他工具链/依赖与文档差异

UI 测试工程有 9 条工具链 warning：1 条缺少 AppIntents.framework 因而跳过 metadata extraction，8 条 Apple 已签名测试框架不执行 stripping；build-for-testing 仍完成。这些不是 UI 测试通过证据。

隔离 npm ci 报告 boolean@3.2.0 deprecated，以及 1 low / 1 moderate 共 2 个 dependency advisory；本轮未进一步评估可利用性，没有运行 npm audit fix 或升级依赖。

`ios.log` 中的 sqlite 5 schema failed 来自 StoreRegression.swift:232–260 的真实迁移锁负向 Fixture；随后的 unavailable、释放锁后重开及原账本保留断言全部通过，属于预期错误注入诊断。

文档差异：AGENTS.md / run-ios-gates.sh 的说明仍提及 run-visual-tests.sh 需要 var/rai.sqlite；当前 run-visual-tests.sh 已改用 prepare-phase5-fixture.mts 生成合成数据，并拒绝隐式复制 RAI_VISUAL_DATABASE。本轮依据源码记录现状，未运行该手工验收、未改文档，也未读取真实数据库。

## 7. 性能基线与资源限制

主机 6 vCPU、16 GiB；Node L4 固定文件并发 2，未提高并发或改变超时。全量 Node 仅执行一次，Swift 聚合仅执行一次，两个 App 使用各自全新的 DerivedData，Rust 使用新的 CARGO_TARGET_DIR。没有修改测试执行器、引入增量跳过或缓存筛选。现有工具链/包缓存状态没有被清空，不能把本轮宣传为完全冷缓存性能。

Node 总墙钟 1346.007 s；`time -l` user 1,424.59 s、system 621.00 s、max RSS 990,396,416 bytes。外部采样的测试文件子进程合计 RSS 峰值约 1,046.44 MiB，不包含所有 server/worker 孙进程。主机既有 Simulator/App/Codex 进程在运行，load average 曾约 7.6–13.6，不能将争用全部归因于测试。静态门禁及模型边界检查与 Node 的一小段执行有重叠，Rust/Python/Swift 重编译均在 Node 结束后顺序运行。

最慢文件（外部 ps 采样，通常约 1–1.5 秒一次，最大间隔 3.947 秒；属于实测近似进程寿命，非精确 profiler timing）：

| 文件 | 最后观察到的 OS elapsed | 观察窗口秒 |
|---|---:|---:|
| `apps/api/test/phase5-training-plan.test.ts` | 06:27 | 386.442 |
| `apps/api/test/dataset-deletion-recovery.test.ts` | 05:45 | 342.588 |
| `apps/api/test/deploy-n100.test.ts` | 03:36 | 214.660 |
| `apps/api/test/server-runtime.test.ts` | 03:33 | 212.334 |
| `apps/api/test/direct-sync-http-acceptance.test.ts` | 02:28 | 147.401 |
| `packages/application/test/training-metric-domain-reuse.test.ts` | 01:36 | 94.773 |

采样看到了 214 个较长寿命测试文件进程；短文件可能落在采样间隙，不能把 214 写成实际发现/执行文件数。331 文件的执行依据为完整 argv、非空发现断言和成功 TAP 终态。原始 trace 与 文件耗时表（外部原始归档，见精选清单）均保留；没有为补齐文件计时而重跑全仓。

iOS 聚合 `time -l` max RSS 为 6,036,328,448 bytes；其中模型编译的单个 swift-frontend 采样约 5.60 GiB。App 构建通过 Xcode 服务进程执行，xcodebuild 父进程的 time RSS 不能作为全部编译器峰值：本轮采样 Swift frontend + xcodebuild 合计峰值约为 Simulator 2.57 GiB、Device 2.38 GiB，采样值也不是全部系统内存。见 编译资源采样（外部原始归档，见精选清单）。这只是本轮基线，没有实施优化。

## 8. 工作区保护与后续准入

最终 2,651/2,651 原文件 SHA-256 不变，新增/丢失的非忽略文件均为 0；原始 status 和 HEAD 不变，暂存区仍为空。原 iOS/Pods 的额外 495 文件核对也全部不变。189 个 tracked shell/Python/Swift/pbxproj 文件为 i/lf w/lf。见 [保护核对](workspace-preservation.json)。

没有执行 reset、clean、stash、add、commit、push；没有清理旧交付证据、修改源码/原测试/工程配置/AGENTS/Actions、访问生产数据库、部署或启用生产写能力。新证据、依赖副本、生成数据库与构建产物均放在临时目录；原有测试自带 mktemp Fixture 按既有生命周期创建和清理。blob gate 使用既有 git write-tree 读取当前 index 对象，不代表已验证未来暂存内容，也没有暂存工作区修改。

允许进入：完整组合变更审查、用户控制的提交、随后运行真实 GitHub CI。仍需处理/明确接受 3 个源码警告，并由 CI 完成 Xcode 26.6、Linux/Rust matrix、actionlint 等远端要求。

尚不具备整体合并/生产启用证明：生产健康/控制库的只读副本审计、历史状态冲突核查、迁移与回滚演练、Simulator UI 执行、AMap 运行对拍、真机 HealthKit 授权与前后台同步、配对 Watch/WorkoutKit 排程仍是后续阶段。本轮到此停止。
