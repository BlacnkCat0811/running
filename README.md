# RAI — Running Ability Intelligence

RAI 是个人跑步数据分析应用：Apple Health XML/GPX 或 iOS HealthKit 导出的 ZIP → Node API/SQLite → 共享 TypeScript 计算 → 桌面 Web 与 SwiftUI iOS。
**iOS 不运行 Node.js、不复制评分核心**；“本地优先”指部署者控制自己的数据库，不表示手机与云端之间不传健康数据。

## 当前边界

- 桌面 Web：主要验收 1440×900，最低主动支持宽度 1024px；更窄布局仅保留兼容，不默认扩展。
- iOS：已有 SwiftUI App、HealthKit 只读导出/同步、后台恢复和 API 消费；不新增 Watch、Android、桌面原生产品。
- 计算：Fitness CA/TA、Readiness、Preparation/Durability 证据、复合负荷/分区、5K/10K/半马预测；未知/未校准必须如实呈现。
- 导入使用私有候选库和受控发布；**没有常驻 shadow 全量双跑**。ML/经验区间必须经过独立标签和发布门槛。
- 源码版本、数据库已计算版本、线上已激活版本是三件事。本机没有足够真实比赛标签，不宣称准确率已经提高。

具体开发范围以 [AGENTS.md](AGENTS.md) 为准；本轮问题与验证见 [项目审查](docs/PROJECT_REVIEW.md)。

## 快速开始

要求 Node.js 22 LTS（≥22.12，默认版本见 [.nvmrc](.nvmrc)）或 24 LTS（24.x）；两条线都已实测通过。npm workspace。Python 只用于可选训练，不是 Web/API 启动依赖。

```bash
npm ci
npm run dev
# Web http://127.0.0.1:5173；API http://127.0.0.1:8787
```

在 Web“数据与模型”导入 Apple Health ZIP。真实 XML、GPX、SQLite、上传包和备份不得提交 Git。
已有数据库若存在未应用 migration，应先按 [运维](docs/OPERATIONS.md) 备份、检查，再明确决定是否迁移；不要把启动失败当作删除数据库的理由。

```bash
npm run build
npm start
```

生产部署见 [Ubuntu 部署](deploy/README-UBUNTU.md)。只把 Nginx HTTPS 暴露到公网，API 默认回环地址；不要打开匿名健康数据读取或把 Token 写入源码。

## 检查

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e:web
npm run check:docs
npm run check:doc-refs
npm run check:acceptance-matrix
npm run check:package-boundaries
```

`test:e2e:web` 跳过390px；完整项目审查仍遵守窄屏冻结范围。
现有 iOS 用 `npm run test:ios`；Python 用 `npm run ml:test`。缺 Xcode/平台导致跳过必须报告，不能当通过。
真机 HealthKit、后台唤醒、地图与视觉验收不能由上述自动检查替代。

## 文档入口（每个主题只保留一份现行说明）

| 主题 | 文档 |
|---|---|
| 模块、数据流与依赖 | [架构](docs/ARCHITECTURE.md) |
| 算法职责、不变量与54项验收合同 | [算法](docs/ALGORITHM.md) |
| 导入、身份、恢复事实、存储与谱系 | [数据管线](docs/DATA_PIPELINE.md) |
| 开发、迁移、备份、回放、发布操作 | [运维](docs/OPERATIONS.md) |
| 长期约束与不能随意“优化”的决策 | [决策](docs/DECISIONS.md) |
| Web 页面、写命令与桌面验收 | [Web](docs/WEB.md) |
| 当前审查结果与未决问题 | [项目审查](docs/PROJECT_REVIEW.md) |
| 今日页计划类卡片的口径冲突与改法 | [计划卡口径](docs/TODAY_PLAN_CARDS_REVIEW.md) |
| iOS 构建、权限和平台入口 | [iOS](apps/ios/README.md) |
| 新版跑步教练流程与未复刻边界 | [跑步教练](docs/RUN_COACH.md) |
| iOS 训练计划现状复核与后续实施方案 | [训练计划架构方案](docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md) |
| Rust 可选数据执行器 | [Rust](docs/RUST_DATA_ENGINE.md) |
| 直接增量同步 PR2+PR3 落地设计（同库事务、版本化事实与路线） | [直接同步落地设计](docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md) |
| ML 环境与工件 | [研究目录](research/README.md) |
| 固定时点、固定数据库的机器证据 | [核验产物](deliverables/README.md) |

过期 PRD、设计草案、实施批次、重复时点审计已删除；历史从 Git 查阅，不继续复制到 archive。
新结论更新相应现行文档；生成审计报告不是产品规范，也不能把另一台机器的统计当成本机事实。
