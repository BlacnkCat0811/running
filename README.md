# RAI — Running Ability Intelligence

RAI 是个人跑步数据分析应用：Apple Health XML/GPX 或 iOS HealthKit 导出的 ZIP → Node API/SQLite → 共享 TypeScript 计算 → SwiftUI iOS（唯一客户端，2026-10-17 起 Web 前端已退役）。
**iOS 不运行 Node.js、不复制评分核心**；“本地优先”指部署者控制自己的数据库，不表示手机与云端之间不传健康数据。

## 当前边界

- iOS：唯一客户端。SwiftUI App、HealthKit 只读导出/同步、后台恢复和 API 消费；不新增 Watch、Android、桌面原生产品，也不重建浏览器前端。
- 后端：iOS 直连云 API；`/v1` 路由整体保留（含此前仅 Web 使用的模型/数据运维端点），但有两组能力已由独立产品决定退役为 `410`：旧训练计划写面（2026-10-20，见 [D19](docs/DECISIONS.md)）与备份创建/删除（见 [D18](docs/DECISIONS.md)）。"仍挂载"不等于"仍可调用"。
- 计算：Fitness CA/TA、Readiness、Preparation/Durability 证据、复合负荷/分区、5K/10K/半马预测；未知/未校准必须如实呈现。
- 导入：API 只有两条直连增量车道（data-only 快通路 → direct-sync 统一接收器），同一主库事务内写事实并登记分析；两条都不合格时显式失败，不回退候选库。候选库/文件换库只保留在 CLI 离线入口。**没有常驻 shadow 全量双跑**；备份是运维责任。ML/经验区间必须经过独立标签和发布门槛。
- 源码版本、数据库已计算版本、线上已激活版本是三件事。本机没有足够真实比赛标签，不宣称准确率已经提高。

具体开发范围以 [AGENTS.md](AGENTS.md) 为准；当前状态、验证基线与未决问题见 [项目审查](docs/PROJECT_REVIEW.md)（对齐 2026-10-20）。

## 快速开始

要求 Node.js 22 LTS（≥22.12，默认版本见 [.nvmrc](.nvmrc)）或 24 LTS（24.x）；两条线都已实测通过。npm workspace。Python 只用于可选训练，不是 API 启动依赖。

```bash
npm ci
npm run dev
# API http://127.0.0.1:8787
# 真机联调：npm run dev:device（只起 API，打印局域网地址与开发 Token）
```

导入 Apple Health ZIP 走 iOS App 的「同步健康」或 CLI（`npm run data:import`）。真实 XML、GPX、SQLite、上传包和备份不得提交 Git。
已有数据库若存在未应用 migration，应先按 [运维](docs/OPERATIONS.md) 备份、检查，再明确决定是否迁移；不要把启动失败当作删除数据库的理由。

```bash
RAI_API_TOKEN=<token> npm start
```

生产部署见 [Ubuntu 部署](deploy/README-UBUNTU.md)。只把 Nginx HTTPS 暴露到公网，API 默认回环地址；Nginx 只反代 `/v1`，站点根路径 404。不要打开匿名健康数据读取或把 Token 写入源码。

## 检查

```bash
npm run typecheck
npm test
npm run check:docs
npm run check:doc-refs
npm run check:scripts
npm run check:acceptance-matrix
npm run check:package-boundaries
```

`npm test` 的默认并发 = 本机可用并行度；在多核/高负载机器上，几个重文件会互相挤占，测试里 5 s / 30 s 的墙钟预算可能被压红（假红，详见 [run-tests](scripts/run-tests.mjs) 头注释）。要一份可复现的独占结果：`RAI_TEST_CONCURRENCY=2 npm test`；**发布记录必须写明所用并发**。
`check:doc-refs` 的内容漂移判据需要 `.linerefs.json` 基线；日常提交不要求基线（缺基线时输出会写"未核对（无基线）"，不会写成"0 处漂移"），发布前的内容级核对见 [运维](docs/OPERATIONS.md)「发布检查清单」。

现有 iOS 用 `npm run test:ios`；Python 用 `npm run ml:test`。缺 Xcode/平台导致跳过必须报告，不能当通过。
真机 HealthKit、后台唤醒、地图与视觉验收不能由上述自动检查替代。

正式开发环境为 macOS，后端生产环境为 Linux，客户端为 iOS；Windows 自 2026-10-25 起不再是正式 CI 支持平台，现有跨平台包装与通用安全测试继续保留。
**GitHub CI 已实际启用**：[仓库 Actions](https://github.com/BlacnkCat0811/running/actions) 对 PR、`main`/`master` push 和手动 dispatch 运行 [工作流](.github/workflows/ci.yml)。Linux 执行全量后端/Python/部署脚本验证，macOS 执行原生 iOS 构建与 Swift 回归，Rust 在两端核验；审计与验证边界见 [CI 审计](deliverables/ci-audit-2026-10-25/README.md)。Gitee 的 push 不会触发 GitHub，`.workflow/master-ci.yml` 仍是未启用的 Gitee Go 草案。不能把"没有 CI 红"读成"提交已验证"：
- 提交时 `.githooks/pre-commit` 会跑 typecheck、文档链接、**文档行号引用**、npm 脚本跨平台语法、**仓库体积闸门（1.5 MB/文件）**、**计划定向回归**（计划相关路径有改动时，约 5 s）、§16.1 验收矩阵、包边界；`apps/ios/` 或 `packages/storage-sqlite/` 有改动时各自再跑对应门禁（含迁移冻结与表分类清单一致性）。
- 发布前必须在能跑全量的机器上把上面这段清单逐条执行一遍（`npm test` 是分钟级，不在提交钩子里），另跑 `npm run review:model-boundaries`（R1–R3 只读对抗探针）与 `npm run check:package-boundaries -- --self-test`。
- 发布记录必须写明：提交 SHA、对应 GitHub Run ID 与关键 Job 状态、本机实跑结果、`RAI_TEST_CONCURRENCY` 取值，以及被跳过的检查。只推送 Gitee 时明确标记没有对应 GitHub 验证。
- 缺 Xcode / 缺平台导致**跳过**的检查要单独列出，不能合并进"通过"。

跨平台写法是硬规则，不是风格建议：npm script 正文只用 `&&`、纯命令、`node xxx.mjs`
（禁用 `;`、`$?`、`$VAR`、`VAR=x cmd`、`test`、`[ ]`、`uname`、依赖 shell 展开的 `*`）；
平台判定只在脚本内部（Node 用 `process.platform`，bash 用 `uname -s`）；`.sh` 只用 `bash <path>` 调用。
上面这些命令在 Windows cmd / PowerShell / macOS bash 里逐字相同，矩阵与 iOS 侧的显式跳过语义见
[iOS 运行说明](docs/IOS_NATIVE_RUNBOOK.md)。

## 文档入口（每个主题只保留一份现行说明）

| 主题 | 文档 |
|---|---|
| 开发范围、退役面与跨平台命令规则 | [AGENTS.md](AGENTS.md) |
| 实际架构：进程/线程、两条导入车道、五类持久 SQLite、单写者与读路径边界 | [架构](docs/ARCHITECTURE.md) |
| 算法职责、不变量与 §16.1 验收合同矩阵（80 条，以 `npm run check:acceptance-matrix` 输出为准） | [算法](docs/ALGORITHM.md) |
| 导入、身份、时间语义、恢复事实、存储与发布合同 | [数据管线](docs/DATA_PIPELINE.md) |
| 开发、迁移、五类存储备份/恢复、发布与排障 | [运维](docs/OPERATIONS.md) |
| 导入恢复审查问题的待实施修复方法与验收条件 | [导入恢复修复方案](docs/IMPORT_RECOVERY_REVIEW_FIX_PLAN_2026-10-23.md) |
| 长期约束与不能随意“优化”的决策（D1–D21） | [决策](docs/DECISIONS.md) |
| 当前状态、验证基线、未决问题与已收尾批次索引 | [项目审查](docs/PROJECT_REVIEW.md) |
| 新版跑步教练流程与未复刻边界 | [跑步教练](docs/RUN_COACH.md) |
| 统一排课政策 G01/G02/G03（2026-10-20 所有者方向性批准并实现，非独立临床复核） | [训练计划政策](docs/TRAINING_PLAN_POLICY_REVIEW.md) |
| iOS ↔ API 契约：handshake、统一训练 v2、410 退役矩阵 | [iOS API 契约](docs/IOS_NATIVE_API_CONTRACT.md) |
| iOS 训练计划设备侧不变量：缓存水位、回执 v2、排期日志、先撤回再下发 | [训练排期](docs/IOS_NATIVE_PLAN_SCHEDULING.md) |
| 训练计划 V2 完整闭环：B01–B08 已实现并通过本机回归，G1–G4 已签收；B09 本机故障/性能证据完成但 Linux 2C2G 门阻塞，B10 真机/Watch 门阻塞，B11 待生产授权 | [闭环实施方案](docs/TRAINING_PLAN_V2_CLOSED_LOOP_IMPLEMENTATION_PLAN.md) |
| iOS 健康同步协议：增量、后台机制、锚点与路线 | [同步协议](docs/IOS_NATIVE_SYNC_PROTOCOL.md) |
| HealthKit 记录同步 v2 合同 | [记录同步 v2](docs/HEALTHKIT_RECORD_SYNC_V2.md) |
| iOS 构建、权限、测试与真机验收 | [iOS](apps/ios/README.md) / [运行说明](docs/IOS_NATIVE_RUNBOOK.md) |
| Rust 可选数据执行器 | [Rust](docs/RUST_DATA_ENGINE.md) |
| 直接增量同步设计（已实施；仍开放条目见文首状态） | [直接同步设计](docs/SQLITE_DIRECT_SYNC_DESIGN.md) |
| 直接同步 PR2–PR5 落地设计（代码注释引用的验收映射） | [PR2+PR3](docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md) / [PR4](docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md) / [PR5](docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md) |
| 教练闭环验收合同（78 项 AC，发布门禁直接读取） | [教练闭环](docs/COACH_LOOP_OPTIMIZATION_PLAN.md) |
| iOS 同步/计算优化设计与验收映射（O01–O12） | [同步优化审查](docs/IOS_SYNC_PERFORMANCE_REVIEW.md) |
| 关键决策记录 | [ADR-004](docs/adr/ADR-004-healthkit-sync-invariants.md) / [ADR-005](docs/adr/ADR-005-temporal-training-labels.md) / [ADR-006](docs/adr/ADR-006-retire-web-and-macos.md) |
| 云端部署（Nginx/systemd/备份责任） | [Ubuntu 部署](deploy/README-UBUNTU.md) |
| ML 环境与工件 | [研究目录](research/README.md) |
| 固定时点、固定数据库的机器证据 | [核验产物](deliverables/README.md) |
| 只读的架构可视化审计（时点快照） | [架构审计](.archify/rai-audit-20261013-160439/AUDIT-REPORT.md) |

过期 PRD、已完成的实施批次、修复方案与重复时点审计已删除；历史从 Git 查阅，不继续复制到 archive。
2026-10-20 又收敛一轮：三份训练计划实施/方案文档、三份已完成的同步修复/扩展方案、教练闭环实施状态与佳明研究等，
在把仍有效的结论并入现行文档后删除；原文、收尾提交与 `git show` 取回命令见
[项目审查的已收尾批次索引](docs/PROJECT_REVIEW.md)。
新结论更新相应现行文档；生成审计报告不是产品规范，也不能把另一台机器的统计当成本机事实。
[架构审计](.archify/rai-audit-20261013-160439/AUDIT-REPORT.md) 是**对齐 `60678af` 的时点快照**：
正文里的 `文件:行号` 刻画的是当时的工作树，源码改动后**不要**回写该目录（回写等于伪造历史），
需要判断行号是否漂移时把它显式传给 `scripts/check-doc-line-refs.mjs` 自行判读。
