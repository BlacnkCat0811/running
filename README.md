# RAI Running Ability Intelligence

RAI 是一个本地优先的个人跑步能力分析项目。当前阶段先解析 Apple 健康导出、建立可复现的数据分析层，并在 Web 端验证评分模型；后续移动端复用同一 canonical contract 和 TypeScript 评分核心。

## 当前已完成

- Apple Health `export.xml` / `导出.xml` 流式解析；
- Workout、WorkoutStatistics、WorkoutEvent、ActivitySummary 解析；
- Apple Health GPX 路线和轨迹点解析；
- 稳定 ID、完全重复 record 去重、跨来源 Workout 聚类；
- canonical Workout 选择；
- 脱敏数据审计报告；
- RAI 共享评分基础函数及测试。
- 版本化 Feature Run、Model Run、训练评分和每日能力快照。
- 训练级用户覆盖与单 worker 重算任务队列。
- Fastify 本地 API，覆盖概览、训练、趋势、导入、任务与模型历史。
- API 运行时 JSON Schema 校验与 `/v1/openapi.json` 接口索引。
- React / Vite Web 界面，支持桌面与 390px 响应式布局。
- 数据资产摘要、SQLite 在线备份、备份下载与确认保护的数据删除。
- 两个不可变 Model Run 的 CA、置信度、最终 TA 与资格状态量化对照。
- 导入/canonical/Feature 数据审计页，展示来源分类、记录类型、心率覆盖和缺失原因。
- 训练详情中的心率、跑速和跑步功率时间序列，下采样后仅用于解释。
- 训练详情扩展为心率、跑速、步频、海拔、功率、步幅、垂直振幅和触地时间八类同步时序，并展示能量、爬升、跑姿指标与公里路线标记。
- 校准进度、7 日 TA 变化、CA/TA 差值、五维滚动趋势、跑量与训练负荷上下文。
- 训练列表支持模型参与、资格、环境、日期范围、来源、置信度、路线和训练类型筛选，筛选状态保存在 URL。
- 无数据库首次启动引导，以及删除数据库后的安全恢复入口。
- 脱敏诊断 JSON、任务阶段查看/取消、SQLite 备份恢复和导入任务状态落盘。
- “导入更新”在完整重建 canonical 数据时保留用户覆盖、RPE/备注和不可变模型历史。
- 独立的生理预测核心：Apple Health VO₂max 稳健集成、有效 VDOT、乳酸阈值配速/心率、5K/10K/半马预测。
- 8 周距离专项准备度、温湿度、爬升与恢复疲劳修正，并逐项保留时间影响。
- 严格 walk-forward 偏差校准和 Ridge 残差候选；只有持出验证通过才自动激活。
- `/v1/predictions` 只读接口与响应式“预测”页面，支持比赛场景交互。
- 个体化 HRR-TRIMP 训练负荷、急性/慢性 EWMA、增长率、单调度、训练应激与六级训练状态。
- 周、月、年及滚动周期运动统计，独立“统计”页面、首页摘要和训练详情负荷证据。
- 训练统计可独立于 RAI 资格排除，所有统计结果通过不可变 Training Metric Run 回放和 active 视图读取。

真实健康数据和生成的 SQLite 已由 `.gitignore` 排除。

## 环境

- Node.js 22 LTS（22.12.0 及以上、低于 23；推荐使用 `.nvmrc` 中的版本）；
- npm 11 及以上；
- Python 3.12 或 3.13（可选）；只有内置 CatBoost 训练和 Python 测试需要通过 `npm run ml:bootstrap` 安装锁定环境。基础分析、公式回退、ONNX 推理和生产 Web/API 启动只依赖 Node.js。

## 安装

```powershell
npm install
```

## 导入 Apple 健康数据

推荐通过 Web 一键更新：运行 `npm run dev`，打开“数据与模型”，直接拖入 Apple 健康导出的 ZIP。系统会在本机完成安全解压、预检、备份、增量分析和数据库切换；相同导出会直接提示数据已是最新。页面也会自动检查项目导出目录和下载目录，并保留下面的目录导入作为高级兼容方式。

日常更新不需要手动解压 ZIP，也不需要单独执行重算命令。

已有数据库更新时，系统会先在线备份并克隆 staging 数据库，然后按实体 generation 同步 XML、按文件指纹更新 GPX，并只重建受影响的 canonical 分组。Feature 和模型从兼容 checkpoint 继续计算；局部结果会与独立完整回放做规范化 hash 对照，不一致时拒绝切换 active 数据库。导入来源和任务状态保存在 `var/runtime.sqlite`，API 重启后可以恢复任务状态；旧 JSON 状态会在首次启动时自动迁移。

命令行目录导入：

```powershell
npm run data:import -- `
  --input "D:\applerun\apple_health_export" `
  --database "D:\applerun\var\rai.sqlite" `
  --report "D:\applerun\docs\DATA_AUDIT.md" `
  --json-report "D:\applerun\var\reports\data-audit.json" `
  --replace
```

`--replace` 会显式重建目标数据库；不传该参数时，解析器拒绝覆盖已有数据库。

只重新生成审计报告：

```powershell
npm run data:audit -- `
  --database "D:\applerun\var\rai.sqlite" `
  --report "D:\applerun\docs\DATA_AUDIT.md"
```

执行完整特征提取和模型回放：

```powershell
npm run data:recompute -- `
  --database "D:\applerun\var\rai.sqlite" `
  --timezone "Asia/Shanghai"
```

生成当前生理与比赛预测报告：

```powershell
npm run data:predict -- --as-of 2026-07-11T00:00:00+08:00
```

查看当前 active CatBoost 模型的严格 walk-forward 评估产物：

```powershell
npm run data:prediction-eval -- --as-of 2026-07-11T00:00:00+08:00
```

在没有新跑步时追加当天的停跑衰减快照：

```powershell
npm run data:refresh-snapshots -- `
  --database "D:\applerun\var\rai.sqlite" `
  --timezone "Asia/Shanghai"
```

## 验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e:web
```

`test:e2e:web` 使用本机 Chrome/Edge 验证 1440 x 900 桌面流程。冻结的 390px 兼容覆盖保留在 `npm run test:e2e:responsive`，仅在明确修改响应式代码时运行；`npm run test:e2e` 会顺序运行两者。

一次执行类型检查、单元/集成测试、模型训练测试、Web 构建和桌面浏览器 E2E：

```powershell
npm run test:all
```

仓库已提供 `pre-commit` 类型检查钩子（`.githooks/`）。新克隆后执行一次以启用：

```powershell
git config core.hooksPath .githooks
```

（完整测试门禁见 CI 或推送前手动 `npm run test:all`。）

## 启动 Web

开发模式同时启动本地 API 与 Vite：

```powershell
npm run dev
```

- Web：http://127.0.0.1:5173
- API：http://127.0.0.1:8787/v1/health

生产模式先构建 Web，再由 Fastify 同一进程提供页面和 API：

```powershell
npm run build
npm start
```

`npm start` 只运行已经构建的 `apps/web/dist`，不会在生产启动时调用 Vite。部署时可先在构建环境执行 `npm run build`，随后执行 `npm ci --omit=dev` 和 `npm start`；缺少 Web 构建产物时会立即退出并给出明确提示。

生产启动不要求 Python。需要训练或验证 CatBoost 模型时，另行执行 `npm run ml:bootstrap`、`npm run ml:check` 和相应的 `ml:*` 命令。

打开 http://127.0.0.1:8787。API 固定监听本机地址，不开放局域网访问。

> **云部署（可选）**：仓库提供腾讯云 Ubuntu 部署参考（Nginx 反代 + Bearer token + systemd，API 仍只监听本机），详见 `deploy/README-UBUNTU.md`。注意：部署到云主机意味着健康数据与路线存放到你控制的服务器，请自行评估隐私与访问控制（token 保护、备份加密、`.env` 权限）。

首次启动或数据库删除后，概览、训练和趋势会显示 Apple Health 导入引导；“数据与模型”仍可提交首次导入，“设置”仍可下载已有备份。没有数据库时，重算、创建备份和删除按钮会保持禁用。

设置页可以创建、下载和显式删除本地 SQLite 备份。删除数据库必须输入完整确认文字，且系统会先创建一份 `before-delete` 在线备份；该操作不会删除 `apple_health_export/` 中的 Apple Health 原始文件。创建备份前会检查可用空间，自动备份默认保留最近 10 份且总量不超过 20 GiB，并至少保留最新一份。

备份容量策略可通过环境变量调整：`RAI_BACKUP_MAX_COUNT`、`RAI_BACKUP_MAX_TOTAL_BYTES` 和 `RAI_BACKUP_MIN_FREE_BYTES`（后两项单位为字节）。

备份可在设置页直接恢复。恢复前会执行 SQLite 完整性、必要表和外键检查；当前数据库存在时会先创建 `before-restore` 安全快照。

## 目录

```text
packages/
  api-contracts/             Web 与 API 共享的 DTO
  contracts/                 跨平台 canonical 数据契约
  health-export-parser/      Apple 导出 XML/GPX 的 Node 适配器
  storage-sqlite/            SQLite schema、迁移、repository 与发布锁
  features/                  无平台依赖的 Workout Feature Vector 提取
  physiology/                VO₂max、VDOT、乳酸阈值与公式比赛预测
  prediction-inference/      CatBoost ONNX artifact 校验与 Node 生产推理
  scoring/                   无平台依赖的纯 TypeScript 评分核心
  training-load/             训练负荷（HRR-TRIMP、EWMA 与训练状态）
  training-zones/            训练分区与时间线
  application/               SQLite 回放、任务队列、Run 与 active 指针
apps/
  api/                       Fastify 本地 API、重算 worker 与安全导入切换
  web/                       React / Vite 响应式 Web 产品
  ios/                       Xcode 调试宿主（WKWebView 显示 Web；含 HealthKit 只读同步）
deploy/                      Ubuntu 云部署参考（Nginx + Bearer token + systemd）
docs/
  ARCHITECTURE.md             Web 优先、兼容移动端的总体架构
  PARSER_DESIGN.md            解析规则和 canonical 数据说明
  MODEL_VALIDATION_PLAN.md    评分模型验证方法
  DATABASE_DESIGN.md          ER 图、表结构和迁移规则
  UI_WIREFRAMES.md            首页、详情、趋势页低保真线框
  DATA_AUDIT.md               当前导出的脱敏聚合审计
  WEB_IMPLEMENTATION.md       Web 功能、接口与运行说明
  WEB_COMPLETION_AUDIT.md     Web V1 功能、数据、测试与隐私完成度证据
  PHYSIOLOGY_OPTIMIZATION_AUDIT.md  生理预测 10 轮优化交付与验收证据
  CATBOOST_DIRECT_ACTIVATION.md     CatBoost walk-forward、ONNX 与直接激活说明
  CATBOOST_10_ROUND_OPTIMIZATION.md CatBoost 直接激活链路十轮优化审计
var/                          本地数据库和机器可读报告，不提交
apple_health_export/          Apple 原始导出，不提交
```

原生移动端产品尚未立项。仓库内 `apps/ios/` 是已授权的 Xcode 调试宿主（WKWebView 加载现有 Web，HealthKit 只读同步用于增量导入，详见 `apps/ios/README.md`）；数据、评分和 SQLite 始终在本机 Node API 上运行。

## 隐私

- 原始 XML、GPX、ECG 和 SQLite 不应提交到 Git。
- 本地数据库包含健康数据和精确路线，只能在可信设备上使用。
- `var/backups/` 中的 SQLite 备份同样包含健康数据和精确路线，应按原数据库的安全等级保管。
- `docs/DATA_AUDIT.md` 只输出聚合统计，不输出来源原名、原始健康值、精确时间或坐标。
- ECG 与医疗记录不进入 RAI 跑力评分。
