# RAI — Running Ability Intelligence

RAI 是个人跑步数据分析应用：Apple Health XML/GPX 或 iOS HealthKit 导出的 ZIP → Node API/SQLite → 共享 TypeScript 计算 → SwiftUI iOS（唯一客户端，2026-10-17 起 Web 前端已退役）。
**iOS 不运行 Node.js、不复制评分核心**；“本地优先”指部署者控制自己的数据库，不表示手机与云端之间不传健康数据。

## 当前边界

- iOS：唯一客户端。SwiftUI App、HealthKit 只读导出/同步、后台恢复和 API 消费；不新增 Watch、Android、桌面原生产品，也不重建浏览器前端。
- 后端：iOS 直连云 API；全部 `/v1` 端点保留（含此前仅 Web 使用的备份/模型/数据运维端点，裁剪属独立决策）。
- 计算：Fitness CA/TA、Readiness、Preparation/Durability 证据、复合负荷/分区、5K/10K/半马预测；未知/未校准必须如实呈现。
- 导入使用私有候选库和受控发布；**没有常驻 shadow 全量双跑**。ML/经验区间必须经过独立标签和发布门槛。
- 源码版本、数据库已计算版本、线上已激活版本是三件事。本机没有足够真实比赛标签，不宣称准确率已经提高。

具体开发范围以 [AGENTS.md](AGENTS.md) 为准；本轮问题与验证见 [项目审查](docs/PROJECT_REVIEW.md)。

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

**本仓库的远端是 gitee，GitHub Actions 不会被 gitee 的提交触发**（`.github/workflows/ci.yml` 只为将来镜像到 GitHub 准备，镜像后可手动 dispatch；`.workflow/master-ci.yml` 是未启用的 Gitee Go 草案）。所以不要把"没有 CI 红"读成"提交已验证"：
- 提交时 `.githooks/pre-commit` 会跑 typecheck、文档链接、**文档行号引用**、npm 脚本跨平台语法、**仓库体积闸门（1.5 MB/文件）**、**计划定向回归**（计划相关路径有改动时，约 5 s）、§16.1 验收矩阵、包边界；`apps/ios/` 或 `packages/storage-sqlite/` 有改动时各自再跑对应门禁（含迁移冻结与表分类清单一致性）。
- 发布前必须在能跑全量的机器上把上面这段清单逐条执行一遍（`npm test` 是分钟级，不在提交钩子里），另跑 `npm run review:model-boundaries`（R1–R3 只读对抗探针）与 `npm run check:package-boundaries -- --self-test`。
- 发布记录必须写明：**gitee 侧 CI 未启用、判据来自本机实跑**、`RAI_TEST_CONCURRENCY` 取值，以及被跳过的检查。
- 缺 Xcode / 缺平台导致**跳过**的检查要单独列出，不能合并进"通过"。

跨平台写法是硬规则，不是风格建议：npm script 正文只用 `&&`、纯命令、`node xxx.mjs`
（禁用 `;`、`$?`、`$VAR`、`VAR=x cmd`、`test`、`[ ]`、`uname`、依赖 shell 展开的 `*`）；
平台判定只在脚本内部（Node 用 `process.platform`，bash 用 `uname -s`）；`.sh` 只用 `bash <path>` 调用。
上面这些命令在 Windows cmd / PowerShell / macOS bash 里逐字相同，矩阵与 iOS 侧的显式跳过语义见
[iOS 运行说明](docs/IOS_NATIVE_RUNBOOK.md)。

## 文档入口（每个主题只保留一份现行说明）

| 主题 | 文档 |
|---|---|
| 模块、数据流与依赖 | [架构](docs/ARCHITECTURE.md) |
| 算法职责、不变量与 §16.1 验收合同矩阵（80 条，以 `npm run check:acceptance-matrix` 输出为准） | [算法](docs/ALGORITHM.md) |
| 导入、身份、恢复事实、存储与谱系 | [数据管线](docs/DATA_PIPELINE.md) |
| 开发、迁移、备份、回放、发布操作 | [运维](docs/OPERATIONS.md) |
| 长期约束与不能随意“优化”的决策 | [决策](docs/DECISIONS.md) |
| 当前审查结果与未决问题 | [项目审查](docs/PROJECT_REVIEW.md) |
| 今日页计划类卡片的口径冲突与改法 | [计划卡口径](docs/TODAY_PLAN_CARDS_REVIEW.md) |
| iOS 构建、权限和平台入口 | [iOS](apps/ios/README.md) |
| 新版跑步教练流程与未复刻边界 | [跑步教练](docs/RUN_COACH.md) |
| 统一训练排课三项政策门槛（G01 赛前剂量 / G02 无历史重启 / G03 受控追加；工程提案，未批准） | [训练计划政策评审](docs/TRAINING_PLAN_POLICY_REVIEW.md) |
| iOS 训练计划现状复核与后续实施方案 | [训练计划架构方案](docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md) |
| iOS 增量同步、解析入库与模型计算审查及具体优化方法 | [同步与计算优化方案](docs/IOS_SYNC_PERFORMANCE_REVIEW.md) |
| 同步优化后七项问题的修复步骤、回归及验收 | [优化后修复实施方案](docs/IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md) |
| 第二轮复查五项残留问题的修复步骤、回归及验收 | [第二轮复查修复方案](docs/IOS_SYNC_RECHECK_FIX_PLAN_2026-10-17.md) |
| 第三轮七项扩展性优化与「禁止全量同步」边界收紧 | [扩展性优化实施记录](docs/SYNC_COMPUTE_SCALING_PLAN_2026-10-17.md) |
| Rust 可选数据执行器 | [Rust](docs/RUST_DATA_ENGINE.md) |
| 直接增量同步 PR2+PR3 落地设计（同库事务、版本化事实与路线） | [直接同步落地设计](docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md) |
| 直接增量同步 PR4 落地设计（全部类型接收、分析任务登记、短写调度） | [PR4 落地设计](docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md) |
| 直接增量同步 PR5 落地设计（分析指针与全部读侧一致性） | [PR5 落地设计](docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md) |
| ML 环境与工件 | [研究目录](research/README.md) |
| 固定时点、固定数据库的机器证据 | [核验产物](deliverables/README.md) |
| 只读的架构可视化审计（6 张交互图 + 规格 + 独立核验） | [架构审计](.archify/rai-audit-20261013-160439/AUDIT-REPORT.md) |

过期 PRD、设计草案、实施批次、重复时点审计已删除；历史从 Git 查阅，不继续复制到 archive。
新结论更新相应现行文档；生成审计报告不是产品规范，也不能把另一台机器的统计当成本机事实。
[架构审计](.archify/rai-audit-20261013-160439/AUDIT-REPORT.md) 是**对齐 `60678af` 的时点快照**：
正文里的 `文件:行号` 刻画的是当时的工作树，源码改动后**不要**回写该目录（回写等于伪造历史），
需要判断行号是否漂移时把它显式传给 `scripts/check-doc-line-refs.mjs` 自行判读。
