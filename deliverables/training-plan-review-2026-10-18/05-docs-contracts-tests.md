# 训练计划审查 05：文档 / 契约单源 / 测试覆盖 / 门禁

- 审查员：docs-verification-reviewer（只读审查 + 验证执行）
- 审查日期：2026-10-18（Asia/Shanghai）
- 仓库：`/Users/tp/running`，分支 `main`，HEAD `09ed8d0`，工作树唯一未跟踪项为本报告的交付目录
- 环境：macOS，`node v24.21.0`（`/Users/tp/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin`），无 npm、无 Xcode Simulator 运行、无配对 Watch
- 任务：共享任务 `task-5`

> 结论摘要见 §3。**本报告的"通过"只覆盖本机实际跑过的命令**；真机、配对 Watch、Simulator 视觉验收一律未执行，未执行项不计通过。

---

## 1. 审查范围

| 范围 | 审阅对象 |
| --- | --- |
| 文档 | `AGENTS.md`、`README.md`、`docs/IOS_TRAINING_PLAN_STATE_V1.md`、`IOS_TRAINING_PLAN_IMPLEMENTATION.md`、`IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md`、`TODAY_PLAN_CARDS_REVIEW.md`、`COACH_LOOP_IMPLEMENTATION_STATUS.md`、`COACH_LOOP_OPTIMIZATION_PLAN.md`（抽查）、`ALGORITHM.md`（plan 段落与 §16.1 矩阵）、`DECISIONS.md`（D5/D6/D13/D14/D15/D16/D17）、`IOS_NATIVE_API_CONTRACT.md`、`IOS_NATIVE_RUNBOOK.md` |
| 契约单源 | `packages/api-contracts/src/index.ts`（plan 类型与 handshake 能力位）、`apps/api/src/schemas.ts`、`apps/api/src/{server,plan-publication,mobile-goals,data}.ts`、`apps/ios/RAI/{APIModels,APIClient,PlanStatePolicy,TrainingPlanStore,NativeAppModel}.swift` |
| 测试与门禁 | `apps/api/test/*plan*｜*coach*`、`apps/ios/tests/*`（Store/Model/TrainingPlanStore/presentation 回归）、`scripts/run-tests.mjs`、`scripts/run-ios.mjs`、`scripts/check-doc-line-refs.mjs`、`scripts/check-acceptance-matrix.mts`、`.githooks/pre-commit`、`.github/workflows/ci.yml` |
| 退役面 | `apps/ios` 的 WebView/WebKit/`#if os(macOS)` 残留；plan 文档中的旧 Web 承诺 |

**明确不在本次范围**：全量 `node scripts/run-tests.mjs`（由 Lead/其它 lane 负责）、API 服务启动、`smoke:api`、真机/Simulator/配对 Watch 验收、`run-visual-tests.sh`。

---

## 2. 验证结果表

命令均在上述 PATH 下、仓库根执行。`node_modules/.bin/tsc ... && tsc ...` 即 `package.json` 的 `typecheck` 脚本主体；`node scripts/run-ios.mjs gates` 即 `test:ios`。

| # | 命令 | 退出码 | 关键输出 | 耗时 |
| --- | --- | --- | --- | --- |
| V1 | `node_modules/.bin/tsc --noEmit -p tsconfig.pure.json` | 0 | 无输出（0 错误） | 1 s |
| V2 | `node_modules/.bin/tsc --noEmit -p tsconfig.json` | 0 | 无输出（0 错误） | 7 s |
| V3 | `node scripts/run-ios.mjs gates` | 0 | `iOS 门禁通过（类型检查 + 纯逻辑回归）`；`106 store regression checks passed`；`Technology presentation: 200 checks passed` | 313 s |
| V4 | `node scripts/run-ios.mjs gates`（复跑，全量日志 `/tmp/ios-gates-full.log`，1445 行） | 0 | `类型检查 94 个文件（已跳过 3 个仅依赖高德 SDK 的文件）` → `iOS 类型检查通过` → … → `iOS 门禁通过（类型检查 + 纯逻辑回归）` | 306 s |
| V5 | `node scripts/check-doc-links.mjs` | 0 | `Documentation: 74 files, 555 local links, 0 problems` | <1 s |
| V6 | `node scripts/check-npm-scripts-portable.mjs` | 0 | `18 个 package.json / 104 条 script` 通过 | <1 s |
| V7 | `node scripts/check-doc-line-refs.mjs`（默认范围） | 0 | `合计 138 处；越界 0；内容漂移 0；锚在空行 7 处（告警）` | <1 s |
| V8 | `node scripts/check-doc-line-refs.mjs docs/IOS_TRAINING_PLAN_STATE_V1.md … docs/TODAY_PLAN_CARDS_REVIEW.md … README.md`（显式传入 plan 文档） | **1** | `合计 23 处；越界/无法解析 1 处`：`❓ docs/WEB.md:12`；`🟠 锚在空行 TechViews.swift:477`；STATE_V1/IMPLEMENTATION/ARCHITECTURE_PROPOSAL/COACH_LOOP_*/API_CONTRACT/RUNBOOK/DECISIONS/README `0 处引用` | <1 s |
| V9 | `node --import tsx scripts/check-acceptance-matrix.mts` | 0 | `§16.1 矩阵：77 条；cited 77；declared-gap 0；missing 0` | <1 s |
| V10 | `node --import tsx --test`（21 个不依赖 onnxruntime 的 plan/coach 测试文件，见下） | 0 | `tests 207 / pass 207 / fail 0 / skipped 0`，`duration_ms 19258` | 19 s |
| V11 | 同一批文件**逐文件**单独运行（21 次） | 20×0，1×1 | 仅 `coach-facts-storage.test.ts` 为 1（dlopen，本机环境限制，见 V12）；其余 20 个文件各自 exit 0；最慢 `coach-acceptance-replays` 14.1 s、`coach-extra-replays` 6.9 s，其余 <1 s | 合计约 26 s |
| V12 | `node --import tsx --test apps/api/test/training-plan-state.test.ts` 等导入 `apps/api/src/data.ts` 的文件 | **1** | `Error: dlopen(.../onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node, 0x0001) … different Team IDs`，`code: 'ERR_DLOPEN_FAILED'`，在**模块加载期**崩溃，未执行任何断言 | 1–2 s/文件 |
| V13 | `node -e "require('onnxruntime-node')"`（根因探针） | 1 | 同一 dlopen 报错；`file` 显示该 `.node` 为 x86_64 adhoc 签名，与 node 进程 Team ID 不同 | <1 s |
| V14 | `node --import tsx --test --test-concurrency=2`（Lead 的 26 文件 plan 套件，原始输出 `/tmp/lead-plan-tests.log`） | 1 | 200 例：191 通过；9 个文件失败，失败原因**全部**是 V12/V13 的 dlopen | Lead 侧执行（未记录精确耗时） |

V10/V11 的文件清单（全部 exit 0）：`plan-periodization`、`plan-execution`、`mobile-plan-sync`、`weekly-plan`、`weekly-plan-preview`、`weekly-plan-migration`、`direct-sync-plan`、`coach-plan-repair`、`coach-subjective-feedback`、`coach-goal-gap`、`coach-loop`、`coach-acceptance-replays`、`coach-decision-v2`、`coach-execution-assessment`、`coach-extra-replays`、`coach-release-gate`、`coach-template-library`、`mobile-coach-snapshot-parity`、`run-coach-phase`、`session-structure`、`race-candidate`。

### 2.1 V3/V4 的边界

- V3 是本机真实执行（313 s，含 Swift 类型检查与全部纯逻辑回归），**不是**文档里的旧数字。
- V3 的原始输出经 `tail -60` 截断，未保留类型检查的完整清单；V4 复跑把全量输出写入 `/tmp/ios-gates-full.log`（1445 行），两端信息合起来才完整：V4 给出 `94 个文件` 与首段结果，V3/V4 都是 exit 0。两次运行合计约 619 s，均真实执行。
- 两者都**不包含** Simulator 视觉验收、真机安装/权限流程、配对 Watch 验收（见 §8）。

---

## 3. 结论摘要

1. **类型检查与 iOS 门禁在本机真实通过**（V1–V4）。V4 显示类型检查覆盖 `94 个文件`（另 3 个仅依赖高德 SDK 的文件按既有契约跳过），V3/V4 两次 `test:ios` 均 exit 0、合计约 619 s。文档声称的"`test:ios` 覆盖排期/Store/展示回归"成立：本机 106 项 store 回归、200 项展示检查、排期与状态机回归全部在 V3/V4 内执行并通过。
2. **不依赖 ONNX 的 21 个 plan/coach 测试文件 207 例全部通过**（V10/V11），覆盖周期化、依从性、重排、周计划 preview/confirm、迁移、教练闭环、会话结构、比赛候选。**这部分是当前可复核的绿灯**。
3. **训练计划最核心的三类契约测试本机无法执行**：快照一致性 503、发布操作幂等/过期/跨域、回执 v2 生命周期，全部集中在 `apps/api/test/training-plan-state.test.ts`，而该文件经 `apps/api/src/data.ts → @rai/application → prediction-report → @rai/prediction-inference → onnxruntime-node` 在导入期崩在原生模块 dlopen 上（V12/V13，Lead 已独立确认为本机环境限制）。**这不是产品缺陷，但也意味着这三类断言本轮"未验证"。**
4. **文档/门禁仍残留 Web 时代承诺**，并且与 D17（2026-10-17 起禁止把 `npm run build`/`test:e2e:*` 加回）直接冲突：`IOS_TRAINING_PLAN_STATE_V1.md:88` 把 `npm run build` 列为"自动入口"，`IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md:24/326` 仍在讨论冻结窄屏与 `test:e2e:web`，`TODAY_PLAN_CARDS_REVIEW.md:76` 引用已删除的 `docs/WEB.md:12`（V8 当场报出）。其中 `TODAY_PLAN_CARDS_REVIEW.md`、`IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md` 由 `README.md:67/70` 列为现行说明；`STATE_V1`/`IMPLEMENTATION` 经 `IOS_NATIVE_API_CONTRACT.md:104/106` 与 `IOS_TRAINING_PLAN_IMPLEMENTATION.md:3` 链式引用，是训练计划契约的现行解释。
5. **契约单源有一个真实缺口**：`GET /v1/mobile/plan-operations/:id` 的响应在 `packages/api-contracts` 里没有类型（服务端返回 `unknown`，iOS 自建 `PlanPublicationResult`），且 OpenAPI 描述漏了 `scopeMismatch`。这是本功能里唯一没有共享类型兜底的对外契约。
6. **验收矩阵没有 plan 快照/发布操作/回执条目**：§16.1 的 77 行里只有 G01–G05 覆盖周期化/依从性，STATE_V1 的三类新契约没有矩阵行；`check-acceptance-matrix` 只校验"被测试引用的 ID 存在"，所以**新特性可以完全没有验收行而门禁全绿**。

---

## 4. 发现

编号 `R-xx`；每条含位置、现象、证据、影响、建议、验证状态。P3 共 3 条（上限 5）。

### R-01（P1）训练计划最核心的三类契约测试在本机无法执行，且与 ONNX 原生依赖耦合在同一进程入口

- **位置**：两条导入路径都在加载期拉起 ONNX。
  - `apps/api/test/training-plan-state.test.ts:16`（`import { RaiReadStore } from "../src/data.js"`）→`apps/api/src/data.ts:41`（`from "@rai/application"`）→`packages/application/src/index.ts:4`（`export * from "./prediction-report.js"`）→`packages/prediction-inference/src/index.ts`（`onnxruntime-node`）
  - `apps/api/src/coach-loop-routes.ts:4`（`import { buildPredictionReportAsync } from "@rai/application"`）→同一 barrel；`apps/api/src/mobile-read.ts:4/34` 同理。
- **现象**：导入闭包触及 `@rai/application` 的测试文件在**模块加载期**抛 `ERR_DLOPEN_FAILED`，一个断言都不执行。本机 `node -e "require('onnxruntime-node')"` 即可复现（V13）。直接导入 `apps/api/src/data.ts` 的文件有 15 个（`grep -l 'src/data\.js' apps/api/test/*.test.ts`），其中计划相关的是 `training-plan-state`、`coach-loop-runtime-safety`、`coach-manual-compatibility`、`run-coach`；另有 `coach-loop-runtime`、`coach-loop-device-sync`、`coach-facts-storage`、`mobile-coach`、`mobile` 经 `coach-loop-routes.ts`/`mobile-read.ts` 间接命中。
- **证据**：V12（exit 1，dlopen 报错全文）、V13（根因探针）、V14（Lead 的 26 文件套件：200 例 / 191 通过 / 9 文件失败，失败原因单一：`coach-loop-device-sync`、`coach-loop-runtime-safety`、`coach-loop-runtime`、`coach-manual-compatibility`、`mobile-coach`、`mobile`、`run-coach`、`training-plan-state`、`weekly-capacity`）。Lead 已确认根因是 node 二进制缺少 `com.apple.security.cs.disable-library-validation` 而原生库属另一 Team ID。
- **影响**：本轮**无法**复核这三类断言——快照三次重建/`503 plan_snapshot_changed`（`training-plan-state.test.ts:90`）、发布操作同键重试与过期 410（`publication response… reject changed request, scope or expired keys`）、回执 v2 不可变历史（`receipt lifecycle preserves immutable history…`）。而它们是 STATE_V1 §读取契约/§发布操作/§回执版本 三节的唯一自动证据。文档若据此宣称"已验证"，读者无法在本机复现。
- **建议**：
  1. 短期：在 `IOS_TRAINING_PLAN_STATE_V1.md` §验证 与 `README.md` §检查 明示"`npm test` 中导入 `apps/api/src/data.ts` 的 15 个文件需要能加载 onnxruntime-node 的宿主；不满足时这 15 个文件按加载失败处理，不得算通过"。
  2. 中期：把 `@rai/application` 的预测/ONNX 依赖改为**惰性导入**（`await import()` 只在推理入口），或把 `prediction-report` 从 `packages/application/src/index.ts` 的 barrel 里拆出，使 `RaiReadStore` 的导入闭包不含 ONNX。这样计划快照/回执/操作测试不再被 ML 原生依赖绑架。
- **验证状态**：已证实（本机命令 + Lead 独立确认根因）。**不记为产品缺陷**。

### R-02（P1）三份现行文档仍把已退役的 Web 门禁写成"自动入口"，与 D17 直接冲突

- **位置**：
  - `docs/IOS_TRAINING_PLAN_STATE_V1.md:88`：`自动入口：npm run typecheck、npm test、npm run build、npm run test:ios`
  - `docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md:62`：`自动入口：…、npm run build`；`:63` `未改 Web 显示，不运行 responsive/mobile Web 测试`
  - `docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md:24`：`Web 仍以桌面为支持范围，不修改冻结的窄屏样式、导航或 390px 测试`；`:326`：`有桌面 Web 流程变化时才运行 npm run test:e2e:web。…不运行 test:e2e:responsive…`
  - 对照 `docs/DECISIONS.md:150`（D17）"不得用 `npm run build`/`test:e2e:*`/`check-web-build.mjs` 把旧门禁偷偷加回来"，与 `AGENTS.md:62-72`（Retired Surfaces）。
- **证据**：`node -e 'require("./package.json").scripts'` 无 `build`、无 `test:e2e:*`；`ls apps` 只有 `api`、`ios`；`docs/WEB.md` 不存在（`ls: docs/WEB.md: No such file or directory`）。（`TODAY_PLAN_CARDS_REVIEW.md`/`ARCHITECTURE_PROPOSAL.md` 由 `README.md:67/70` 列为现行说明；`STATE_V1`/`IMPLEMENTATION` 由 `IOS_NATIVE_API_CONTRACT.md:104/106` 与 `IMPLEMENTATION.md:3` 链式引用，读者会当作现行口径。）
- **影响**：读者按文档执行会得到 `npm run build` 不存在；更严重的是这些句子把已退役门禁重新表述为当前义务，正是 D17 明确禁止的形态（§4 的"文档承诺"复活）。对训练计划本身，这会让"验证入口"清单与真实可执行入口（`typecheck`/`test`/`test:ios`/`check:docs`/`check:doc-refs`/`check:scripts`/`check:acceptance-matrix`/`check:package-boundaries`）不一致。
- **建议**：三处改为 D17 后的入口清单；`ARCHITECTURE_PROPOSAL:24/326` 与 `IMPLEMENTATION:62-63` 加"2026-10-17 D17 后失效"的时点标注（这两份是带日期的实施记录，允许保留历史，但必须显式标注不再适用）；`STATE_V1:88` 的"自动入口"属于现状陈述，必须直接更正。
- **验证状态**：已证实。

### R-03（P2）文档行号门禁的默认范围不含任何 plan 文档，死引用因此不可见

- **位置**：`scripts/check-doc-line-refs.mjs:79-94`（`DEFAULT_DOCS` 只含 `docs/ARCHITECTURE.md`、`ALGORITHM.md`、`DATA_PIPELINE.md`、`OPERATIONS.md`、三份 `SQLITE_DIRECT_SYNC_*_DESIGN.md`、`IOS_SYNC_PERFORMANCE_REVIEW.md`）
- **现象**：V7（默认范围）全绿；把 plan 文档显式传给同一脚本（V8）立刻 exit 1，报 `docs/WEB.md:12` 无法解析（`TODAY_PLAN_CARDS_REVIEW.md:76` 那处引用指向已删除文件），另有 `TechViews.swift:477` 锚在空行。脚本注释本身写明"脚本不核对这里以外的任何文档，而'某份满是 `文件:行号` 的文档没人核对'这件事本身不报错"。
- **证据**：V7（exit 0，138 处，全在默认范围）+ V8（exit 1，23 处，1 处无法解析）。另：`.githooks/pre-commit` 与 `.github/workflows/ci.yml` 都**没有** `check:doc-refs`（grep `check:doc-refs` 只命中 `package.json:12`）。
- **影响**：`TODAY_PLAN_CARDS_REVIEW.md` 是 README 指向的现行文档（README:67），它有 23 处 `文件:行号` 却不在门禁范围内；一处已确认失效。计划上下文的"文档→代码行"承诺没有任何自动守门。
- **建议**：(a) 把 `TODAY_PLAN_CARDS_REVIEW.md`、`IOS_TRAINING_PLAN_STATE_V1.md`、`IOS_TRAINING_PLAN_IMPLEMENTATION.md` 加入 `DEFAULT_DOCS`（三者合计 23 处引用，0 处内容漂移，接入成本为零）；(b) 修掉 `docs/WEB.md:12` 这处引用（它描述的是 2026-10-11 的订正，应改为指向 D17/ADR-006）；(c) 把 `check:doc-refs` 加进 pre-commit 或 CI 的 verify job。
- **验证状态**：已证实（命令 V7/V8）。

### R-04（P2）`/v1/mobile/plan-operations/:id` 的响应没有契约单源类型，OpenAPI 描述漏一种状态

- **位置**：`apps/api/src/plan-publication.ts:21-23`（`result(operationId): unknown`）、`apps/api/src/mobile-goals.ts:250-263`（实际返回 `{status:"committed"|"notFound"|"expired"|"scopeMismatch"}`）、`apps/api/src/server.ts:1330`（路由无 response schema）、`apps/api/src/schemas.ts:932`（OpenAPI 描述只写 `committed、notFound 或 expired`）、`apps/ios/RAI/PlanStatePolicy.swift:180-184`（iOS 自建 `PlanPublicationResult<Result>`）
- **现象**：四状态响应体只有 iOS 侧有一份手工声明的 Swift struct，`packages/api-contracts/src/index.ts` 里没有任何 `MobilePlanOperationQueryResponse` 类型（grep `PlanOperation` 只命中 `MobilePlanOperationScope` 与三处入参 `operationScope`）。服务端 `result()` 的返回类型是 `unknown`，路由不声明 schema，OpenAPI 文档还少一种状态，而 `IOS_TRAINING_PLAN_STATE_V1.md:44` 写的是四种。
- **证据**：`grep -n "PlanOperation" packages/api-contracts/src/index.ts`（只有 220 行 `MobilePlanOperationScope`）、`schemas.ts:932`、`plan-publication.ts:21`、`PlanStatePolicy.swift:180`。
- **影响**：这是计划发布链路里"重试语义唯一出口"的对外契约，却没有共享类型：服务端改状态名/加字段不会触发任何编译期或契约门禁失败，iOS 端 `status` 是 `String`、`result` 是可选泛型，未知状态走 `throw decoding("未知的发布操作状态，原操作不会重放")`（`NativeAppModel.swift:1354`）——即静默降级为"不重放"，用户只能看到报错。`scopeMismatch` 已在 iOS 端被当作**终局**处理（`NativeAppModel.swift:1326`），漏写进 OpenAPI 会误导后续客户端实现。
- **建议**：在 `api-contracts` 增加 `MobilePlanOperationQueryResponse`（discriminated union，四个 `status`），`PlanPublicationService.result()` 改为返回该类型，`server.ts` 路由声明 response schema，`schemas.ts:932` 的描述补齐 `scopeMismatch`；再补一条 direct-sync 风格的 `check-*-contract-parity` 断言（仓库已有 `check-direct-sync-contract-parity.py` 可仿）。
- **验证状态**：已证实（代码与文档三方差一处）。

### R-05（P2）§16.1 验收矩阵没有 plan 快照/发布操作/回执行，门禁无法发现这种缺失

- **位置**：`docs/ALGORITHM.md:349-430`（§16.1 矩阵，77 行；§16.2 从 :431 开始）、`scripts/check-acceptance-matrix.mts`
- **现象**：77 行里与计划相关的只有 `G01`–`G05`（周期化骨架、冻结义务、未知不判漏练、重排建议），**没有**任何一行描述 `planSnapshotContractVersion` 的快照一致性/503、`planPublicationContractVersion` 的操作幂等与过期、`planReceiptContractVersion=2` 的回执生命周期。对矩阵做 `grep "快照|发布操作|回执|operation|snapshot|receipt"` 在 §16.1 区间内 **0 命中**。
- **证据**：V9（`77 条；cited 77；declared-gap 0；missing 0`）与 `awk 'NR>=349 && NR<=431' docs/ALGORITHM.md | grep -cE "^\| [A-Z][0-9]+ \|"` = 77；区间内 grep 计划状态关键字 0 命中。脚本自述只检查"ID 引用/显式缺口"。
- **影响**：STATE_V1 是训练计划当前最重要的一批契约，却没有进入"持续合同"表；新增/改动这些契约时，矩阵侧不会要求任何新行，`check:acceptance-matrix` 也不会红。矩阵的 77 条与 README 承诺的验收口径因此对计划状态功能**不构成覆盖**。
- **建议**：新增三行（例如 `G06` 快照一致性、`G07` 操作幂等/过期、`G08` 回执 v2 生命周期），并把 `training-plan-state.test.ts` 的用例标题挂上对应 ID（该文件正是 R-01 里跑不起来的那份，接入后 CI 上才有意义）。
- **验证状态**：已证实。

### R-06（P3）README 写"54项验收合同"，实际矩阵 77 条

- **位置**：`README.md:62`：`| 算法职责、不变量与54项验收合同 | 算法 → docs/ALGORITHM.md |`
- **证据**：V9 输出 `§16.1 矩阵：77 条`；`docs/ALGORITHM.md` §16.1 数出 77 行；`COACH_LOOP_IMPLEMENTATION_STATUS.md:148` 也写"78项"另一套数字（教练方案的 AC ID，不冲突但并列易混）。
- **影响**：README 是唯一的总入口，读者会以 54 评估验收厚度；实际已扩到 77 且不含计划状态（R-05）。
- **建议**：改为不写死数字（"§16.1 验收合同矩阵"），或在数字旁标注生成方式/日期，避免第三次漂移。
- **验证状态**：已证实。

### R-07（P3）plan 源码改动的门禁覆盖偏窄：pre-commit 不跑任何 plan 回归，CI 在本仓远端不触发

- **位置**：`.githooks/pre-commit`（`npm run typecheck`、`check:docs`、`check-npm-scripts-portable`、blob size、acceptance-matrix、package-boundaries，`apps/ios/` 有改动才跑 `test:ios`；**没有** `npm test`，也没有针对 `apps/api/src/plan-*.ts`/`mobile-goals.ts` 的定向回归）；`.github/workflows/ci.yml:38` 自述"本仓库远端是 gitee，本 workflow 目前**不会**对远端触发；真正的执行入口是 `.githooks/pre-commit`"
- **证据**：读取上述两文件全文；`grep -rn "check:doc-refs" .githooks/ .github/` 无命中；`ci.yml` 的 `verify` job 确实包含 `npm test`，但只在 GitHub 侧生效。
- **影响**：修改 `plan-publication.ts`、`mobile-goals.ts`、`data.ts` 的快照/操作/回执逻辑时，pre-commit 只做类型与文档类检查；行为回归（207 例那批）完全靠人工 `npm test`。R-01 又让本机 `npm test` 不可用，于是这条路径在本机整体缺失。
- **建议**：pre-commit 对 `apps/api/src/{plan,mobile-goals,data,weekly-plan}*` 的改动增加一组定向测试（V10 那 21 个文件 19 s，已接近可接受的钩子预算）；至少在注释里写明"plan 行为回归不在钩子里"。
- **验证状态**：已证实（静态）。

### R-08（P3）验证记录节缺"对齐提交/当前否"标注，多个互不相同的 iOS 文件数并列

- **位置**：`docs/IOS_TRAINING_PLAN_STATE_V1.md:88,103`（`npm test` 1414 项 / Web 182 项；`test:ios` 87 份源码）、`docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md:85,88`（1404 项 / Web 182；84 份源码）、`docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md:332`（84 份源码）、`docs/COACH_LOOP_IMPLEMENTATION_STATUS.md:106,148,208`（1508/1518/1522 项；Web 25 文件 184 项；89/90 份源码）
- **证据**：V3/V4 本机实测 `类型检查 94 个文件`、`106 store regression checks`、`200 presentation checks`；`.githooks/pre-commit` 明确要求 `test:ios` 不得静默通过。四份文档的 84/87/89/90 都是各自时点的真实数字，但没有一处写"对齐哪个提交、是否仍代表现状"。
- **影响**：读者无法判断哪个数字是现状；在 D17 后 `npm test` 已不含 Web 套件（R-02），旧数字还会把"Web 通过"混入计划交付证据。
- **建议**：每份文档的验证节统一加一行"对齐提交 + 日期 + 该数字是否仍代表现状"；或把历史表格移入"历史记录"小节并注明"不代表当前"。
- **验证状态**：已证实（数字来自本机 V3/V4 与各文档原文）。

---

## 5. 契约单源对照表

| 契约面 | 共享单源（`packages/api-contracts/src/index.ts`） | 服务端实现/schema | iOS 解码/使用 | 一致性结论 |
| --- | --- | --- | --- | --- |
| handshake 能力位 | `HandshakeResponse:166-218`：`planSnapshotContractVersion?`、`planPublicationContractVersion?`、`planReceiptContractVersion?`、`coachLoopContractVersion?`、legacy `planReceiptMetadata?` | `server.ts:931-935`：`planReceiptMetadata:true`、snapshot=1、coachLoop=1、publication=**条件**（仅 control DB 支持时）、receipt=2 | `APIModels.swift:18-21` 全部可选；`TrainingPlanRepository.swift:39`、`TrainingPlanStore.swift:185/188`、`NativeAppModel.swift:1286/1359/1470` 按能力位降级 | **一致**。publication 条件发布 + 客户端 `guard … == 1` 是正确的降级路径 |
| 训练计划快照 | `TrainingPlanStateResponse:1202-1232`：`metadata` 12 个必填字段、`availability` 联合、`workoutPlan` 交叉窗口、`versions?`/`freshness?`/`currentFacts?`/`publishedAnalysis?` 可选 | `data.ts:516` 三次尝试、`:589/594` 503 `plan_snapshot_changed`、`:562-577` 可选字段追加到字面量**之外** | `APIModels.swift:1272-1290` 只解必填 12 字段 + 5 个顶层对象，忽略可选新字段 | **一致**。新增字段全部可选，老客户端 decode 不破。iOS 目前不消费 `versions/freshness/currentFacts/publishedAnalysis`（PR5 视图对 iOS 是冗余负载，非缺陷） |
| 发布操作查询 | **缺失**（无类型） | `plan-publication.ts:21` 返回 `unknown`；`mobile-goals.ts:250-263` 四状态；`schemas.ts:932` 描述少 `scopeMismatch` | `PlanStatePolicy.swift:180` 自建 struct；`NativeAppModel.swift:1322-1355` 按字符串比较 | **不一致** → R-04 |
| 发布操作入参（幂等键） | `operationId?`/`operationScope?` 出现在 `LockMobileSessionInput:1286-1291`、`:1657`、`:1740` | `plan-publication.ts:13-19`：`operationId` 存在时强制 `operationScope`，否则 422；跨域 409 | `NativeAppModel.swift:1286` 以 `planPublicationContractVersion == 1` 决定是否持久化原请求 | **一致** |
| 回执 v2 | `MobilePlanReceiptInput:1234-1251`：全部 v2 字段可选，靠 `contractVersion:2` 激活 | `schemas.ts:319-348` 仅 `required:["localDate","kind"]`，v2 必填由 `server.ts:1210-1244` 与 store（`mobile-goals.ts:483/504/526/628`）在运行时判定 | `APIModels.swift:1296-1343`：v2 字段全可选 + `hasRequiredVerificationFields` 在客户端自查（`contractVersion==2` 时要求 12 项齐全）；`useLegacyContract` 支持旧服务端剥离 | **一致**。双端都在运行时强制 v2 必填，契约层保持可选是刻意的兼容设计 |
| 回执/操作生命周期事件 | `lifecycleEvent?: "verified"｜"withdrawn"｜"replaced"` | 同 schema enum；`server.ts:1231` 幂等键缺省为 `workoutID:lifecycleEvent` | `APIModels.swift:1331` 白名单校验 | **一致** |
| 教练闭环 | `coach-loop.ts` 导出 `CoachLoopSettings/Command/RuntimeResponse/ReceiptContext/DeviceReceipt`（`index.ts:1872-1875` re-export） | `schemas.ts:134-140/344-357`（`coachLoopSyncedBodySchema` 在 legacy 上**追加** `coachLoop` 必填） | `APIModels.swift` 的 `CoachLoopReceiptContext` 挂在 `PlanSyncReceipt.coachLoop` 可选字段 | **一致**（回执体按路由分两个 schema，legacy 路由不会误收 `coachLoop`） |
| `/synced` 语义 | 注释 `MobilePlanReceiptInput` 上下文 + `server.ts:1244` `informationLevel: verifiedClient｜legacy` | `IOS_NATIVE_API_CONTRACT.md:107` 明确"不是物理手表收到的证明" | 同上 | **一致**，且文档与代码口径相同 |

**兼容性小结**：handshake 四能力位 + 可选新增字段 + 回执双 schema + `useLegacyContract` 四层机制在代码里成立，iOS 侧每个能力位都有显式降级分支；唯一没有共享类型兜底的是操作查询响应（R-04）。

---

## 6. 测试覆盖缺口

| 关注点 | 现有覆盖 | 本机结果 | 结论 |
| --- | --- | --- | --- |
| 快照一致性 / `503 plan_snapshot_changed` | **仅** `training-plan-state.test.ts:90`（+ `data.ts:516` 三次重建） | **无法执行**（R-01） | 缺口：无第二证据，且本机不可验证 |
| 发布操作幂等 / 过期 410 / 跨域 409 / 重启后重试 | **仅** `training-plan-state.test.ts`（3 条用例） | **无法执行**（R-01） | 缺口：HTTP 查询路由 `GET /v1/mobile/plan-operations/:id` 只有 `server-runtime.test.ts` 冒烟级覆盖 |
| 回执 v2 生命周期（不可变历史、replaced/withdrawn、幂等） | 服务端 `training-plan-state.test.ts`（不可执行）；存储侧 `mobile-plan-sync.test.ts`（legacy/新字段共存、幂等、重开）**可执行**；iOS `StoreRegression`/`TrainingPlanStoreRegression`（V3 内 106 项） | 部分通过 | 缺口：服务端"回执 v2 历史不可改写"这一半本机不可验证 |
| 回执 v2 必填字段强制 | `mobile-plan-sync.test.ts`（`old and new receipt bodies pass public schema`）+ iOS 本地持久化断言 | 通过 | 通过 |
| 旧客户端/旧服务端兼容 | `mobile-plan-sync.test.ts`（legacy 回执不重写）、`ModelRegression.swift`（无能力位/未来版本 9 降级）、`TrainingPlanStore.swift:185`（旧服务端才 2 轮重读） | 通过 | 通过 |
| 周期化 / 依从性 / 重排（G01–G05） | `plan-periodization.test.ts` 20 例、`plan-execution.test.ts` 3 例 | 通过 | 通过 |
| 周计划 preview/confirm 幂等、过期、数据集恢复 | `weekly-plan-preview.test.ts` 6 例 | 通过 | 通过 |
| 周计划生成/校验/迁移 | `weekly-plan.test.ts`（1681 行）、`weekly-plan-migration.test.ts` 8 例 | 通过 | 通过 |
| 教练闭环（决策/修补/反馈/差距/回放/发布审计） | 9 个 `coach-*.test.ts` + `coach-release-gate.test.ts` | 通过（`coach-facts-storage` 因 dlopen 失败） | 通过（1 文件未验证） |
| iOS 状态机 / 排期 / 中断恢复 | `run-ios.mjs gates`：106 store 回归、排期与状态机回归、200 展示检查 | 通过（V3/V4） | 通过（**纯逻辑层**；不含真机） |
| 验收矩阵行 | §16.1 无 plan 状态行 | V9 绿 | 缺口 → R-05 |
| 文档行号引用 | plan 文档不在默认范围 | V8 红 | 缺口 → R-03 |

---

## 7. 文档漂移清单

| 文档:行 | 现状文字 | 实际 | 处置 |
| --- | --- | --- | --- |
| `docs/IOS_TRAINING_PLAN_STATE_V1.md:88` | `自动入口：… npm run build …` | `package.json` 无 `build`（D17 退役） | 直接更正（R-02） |
| `docs/IOS_TRAINING_PLAN_STATE_V1.md:101,102,114` | `npm test` 含 "Web 25 文件 / 182 项"、`npm run build` 通过 | 已属历史；当前 `npm test` 不含 Web | 标注时点（R-08/R-02） |
| `docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md:62-63,87` | `npm run build`、responsive/Web 测试 | 同上 | 标注时点（R-02） |
| `docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md:24,326` | `Web 仍以桌面为支持范围`、`npm run test:e2e:web` | Web 已退役 | 标注失效（R-02） |
| `docs/TODAY_PLAN_CARDS_REVIEW.md:76-83` | 引用 `docs/WEB.md:12`、`apps/web/src/ios/`、`apps/web/src` 引用计数 | `docs/WEB.md` 与 `apps/web` 均不存在 | 改指 D17/ADR-006；该文档需进门禁（R-03） |
| `docs/TODAY_PLAN_CARDS_REVIEW.md:116-119,148` | 验收仍写 `npm run test:ios`（正确）+ `check-today-layout.py` | 与当前门禁一致 | 无需改 |
| `docs/COACH_LOOP_IMPLEMENTATION_STATUS.md:106,111,148,208,215` | Web 25/184 通过、`npm run build` 通过 | 历史记录，已不可复跑 | 标注时点（R-08） |
| `README.md:62` | `54项验收合同` | 77 条 | 更正（R-06） |
| `docs/IOS_NATIVE_API_CONTRACT.md:104` | 三个新能力独立协商 | 与 `server.ts:932-935` 一致 | 一致，无需改 |
| `docs/IOS_NATIVE_RUNBOOK.md:245-262` | 配对真机/手表验收为人工、不可由模拟器替代 | 与 `AGENTS.md:53-55` 一致 | 一致，无需改（证据边界表述正确） |
| `docs/DECISIONS.md:146-154`（D17）、`:87-116`（D13/D14）、`:130-138`（D16） | 计划口径与退役口径 | 与代码一致（`plan-periodization.ts` 单源、`weekly-capacity.ts` 推导、回执不重写旧历史） | 一致，无需改 |

**"已实现/已验证"表述核查结论**：STATE_V1 与 IMPLEMENTATION 的**功能**表述与代码一致（快照三次重建↔`data.ts:516`、四状态↔`mobile-goals.ts:250`、v2 必填↔`server.ts:1210`、新旧兼容↔`useLegacyContract`）；漂移集中在**验证入口与 Web 遗留**，不在功能描述。`COACH_LOOP_IMPLEMENTATION_STATUS.md` 的证据边界（§9 明确物理设备/视觉未签收、release 审计 `blocked`）表述诚实，未发现把未执行项说成通过。

---

## 8. 未覆盖项

**本机可自动验证但本轮未做**：全量 `npm test`（Lead 负责）、`smoke:api`、`check:package-boundaries`、`data:coach-replay`/`test:coach:mutation`/`check:coach-release`（属教练 lane）、`apps/ios/tests/run-visual-tests.sh`。

**需要真机/模拟器/配对 Watch，本机不可验证**（文档已如实声明，不计通过）：
- Simulator 视觉验收（`run-visual-tests.sh` 需要已启动 Simulator + `var/rai.sqlite`）：STATE_V1:109、IMPLEMENTATION:93、COACH_LOOP_STATUS §9.4 均标"未执行/不计通过"。
- 配对 iPhone + Apple Watch：UUID/时刻稳定性、表端可见、读回延迟、授权各状态、部分成功、定向/全部撤回、每个副作用后强杀重启、跨午夜与新旧服务组合（`IOS_NATIVE_RUNBOOK.md:251-260`、STATE_V1:90、IMPLEMENTATION:93）。**本报告未执行任何一项。**
- 真机 HealthKit 权限、后台唤醒、地图与响应式（`README.md:49`）。
- 本机 iOS 门禁是"类型检查 + 纯逻辑回归"，**不等价于**上述任何一项。

**因 R-01 本轮未验证**：`training-plan-state.test.ts` 全部 9 例（快照一致性、发布操作、回执生命周期），以及 V14 中失败的全部 9 个文件（另含 `coach-loop-device-sync`、`coach-loop-runtime`、`coach-loop-runtime-safety`、`coach-manual-compatibility`、`coach-facts-storage`、`mobile-coach`、`mobile`、`run-coach`、`weekly-capacity`）。这些文件的断言一条都未执行，**不得计入通过**。

**待确认（本轮未取得证据）**：服务端在**没有 control DB**（`supportsPublicationOperations=false`）时仍广播 `planReceiptContractVersion: 2`，此时 v2 回执的"operationId 幂等去重"依赖的是哪个存储路径（`server.ts:1229` 之后走 file-based store 还是控制库），未经测试确认；若走文件路径，需确认同一 operationId 重放不会产生第二条历史。
