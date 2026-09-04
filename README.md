# RAI Running Ability Intelligence

RAI 是一个本地优先的个人跑步能力分析项目：解析 Apple 健康导出（XML/GPX/HealthKit ZIP），
建立可复现的数据分析层，在 Web 端验证评分模型，并通过 iOS 调试壳（WKWebView + HealthKit
只读同步）在 iPhone 上使用同一套 TypeScript 评分核心与像素风界面。桌面 Web、本地 API、
共享 TypeScript 包与 `apps/ios` 调试壳构成当前交付范围（边界见 `AGENTS.md`）。

## 当前已完成

- Apple Health `export.xml` / `导出.xml` 流式解析；
- Workout、WorkoutStatistics、WorkoutEvent、ActivitySummary 解析；
- Apple Health GPX 路线和轨迹点解析；
- 稳定 ID、完全重复 record 去重、跨来源 Workout 聚类；
- canonical Workout 选择；
- 脱敏数据审计报告；
- RAI 共享评分基础函数及测试；
- 版本化 Feature Run、Model Run、训练评分和每日能力快照；
- 训练级用户覆盖与单 worker 重算任务队列；
- 增量导入：按 entity generation 同步 XML、按文件指纹更新 GPX、兼容 checkpoint 增量回放、
  局部结果与独立完整回放 hash 对照，失败不回切 active 数据库；
- Fastify 本地 API，覆盖概览、训练、趋势、统计、分区、导入、任务、模型与预测历史；
- API 运行时 JSON Schema 校验与 `/v1/openapi.json` 接口索引；
- React / Vite Web 界面，支持桌面与冻结的 390px 兼容布局；
- 数据资产摘要、SQLite 在线备份、备份下载与确认保护的数据删除；
- 两个不可变 Model Run 的 CA、置信度、最终 TA 与资格状态量化对照；
- 导入/canonical/Feature 数据审计页，展示来源分类、记录类型、心率覆盖和缺失原因；
- 训练详情八类同步时序（心率、跑速、步频、海拔、功率、步幅、垂直振幅、触地时间）与能量/
  爬升/跑姿指标、公里路线标记；
- 训练列表多条件筛选（模型参与、资格、环境、日期、来源、置信度、路线、类型），状态存 URL；
- 无数据库首次启动引导、安全恢复入口、任务阶段查看/取消与状态落盘；
- 独立生理预测核心：VO₂max 稳健集成、有效 VDOT、乳酸阈值配速/心率、5K/10K/半马预测，
  温度/湿度/爬升/恢复修正与严格 walk-forward CatBoost 残差候选；
- `/v1/predictions` 只读接口 + “成绩预测”页面，预测模型（`prediction_model_runs`）可训练/
  激活/取消；
- 个体化 HRR-TRIMP 训练负荷、急/慢性 EWMA、增长率、单调度、训练应激与六级训练状态
  （含 `PhysState` 生理状态门限）；
- 训练分区（心率/配速区间）设置、每日分区与训练级分区摘要；
- 睡眠/HRV 恢复管线（schema v17+）：`canonical_nights` / `canonical_hrv_days` 唯一事实源、
  导入时 canonicalization、workout 前已完成数据约束、个人基线（28 天中位数，不足回退 60 天）、
  恢复权重 睡眠 35 / RHR 25 / HRV 25 / 负荷 15，`/v1/recovery-trends` 与移动端恢复卡/今日教练；
- 模型激活 shadow gate `rai-shadow-gate-v1`（`model_validation_gates`）：空值率、CA 均值/P95、
  最终 TA、状态变化率、恢复饱和率等验收阈值，失败保持 incumbent 不变；
- iOS 调试壳（`apps/ios`，Xcode/WKWebView）：HealthKit 只读增量导出 ZIP → 上传 →
  服务端导入，配合清新像素风界面与 `/v1/mobile/today|statistics|trends|goals|lock`
  移动端聚合 API（窗口按数据最新日期锚定）；
- 公网生产部署（Nginx 托管静态 + `/v1` 透传 Bearer + systemd 定时一致性备份）。

真实健康数据和生成的 SQLite 已由 `.gitignore` 排除。

## 环境

- Node.js 22 LTS（22.12.0 及以上、低于 23；推荐使用 `.nvmrc` 中的版本）；
- npm 11 及以上；
- Python 3.12 或 3.13（可选）：只有 CatBoost 训练与 Python 测试需要
  `npm run ml:bootstrap` 锁定环境。基础分析、公式回退、ONNX 推理与生产 Web/API 启动只依赖 Node.js。

## 安装

```powershell
npm install
```

国内服务器安装本仓库时，`onnxruntime-node` 的 postinstall 会直连 Nuget 下载构建清单并常被
网络拦截，请带环境变量跳过（napi-v6 Linux 二进制随包内置）：

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci
```

## 导入 Apple 健康数据

推荐通过 Web 一键更新：运行 `npm run dev`，打开“数据与模型”，直接拖入 Apple 健康导出的
ZIP（或 iOS 壳“同步健康”自动上传）。系统会在本机完成安全解压、预检、备份、增量分析和数据库
切换，并对睡眠/HRV 执行 canonicalization；相同导出会直接提示数据已是最新。页面也会自动检查
项目导出目录和下载目录，并保留目录导入作为高级兼容方式。

日常更新不需要手动解压 ZIP，也不需要单独执行重算命令。

已有数据库更新时，系统会先在线备份并克隆 staging 数据库，然后按实体 generation 同步 XML、
按文件指纹更新 GPX，只重建受影响的 canonical 分组。Feature、训练指标（含恢复子信号）和模型
从兼容 checkpoint 继续计算；局部结果会与独立完整回放做规范化 hash 对照，不一致时拒绝切换
active 数据库。候选 Model Run 激活前必须通过 `rai-shadow-gate-v1`。导入来源和任务状态保存在
`var/runtime.sqlite`，API 重启后可恢复任务状态；旧 JSON 状态会在首次启动时自动迁移。

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

`test:e2e:web` 使用本机 Chrome/Edge 验证 1440 x 900 桌面流程。冻结的 390px 兼容覆盖保留在
`npm run test:e2e:responsive`，仅在明确修改响应式代码时运行；`npm run test:e2e` 会顺序运行
两者。移动端聚合端点可用真实库冒烟：`bash scripts/mobile-smoke.sh`。

一次执行类型检查、单元/集成测试、模型训练测试、Web 构建和桌面浏览器 E2E：

```powershell
npm run test:all
```

## 启动 Web / iOS 壳

开发模式同时启动本地 API 与 Vite：

```powershell
npm run dev
```

- Web：http://127.0.0.1:5173
- API：http://127.0.0.1:8787/v1/health

真机调试 iOS 壳（局域网）：

```powershell
npm run dev:device     # 打印手机可访问地址，如 http://192.168.x.x:5173
npm run open:ios       # 打开 apps/ios/RAI.xcodeproj（运行步骤见 apps/ios/README.md）
```

生产模式先构建 Web，再由 Fastify 同一进程提供页面和 API：

```powershell
npm run build
npm start
```

`npm start` 只运行已经构建的 `apps/web/dist`，不会在生产启动时调用 Vite。部署时可先在构建
环境执行 `npm run build`，随后执行 `ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev` 和
`npm start`；缺少 Web 构建产物时会立即退出并给出明确提示。

生产启动不要求 Python。需要训练或验证 CatBoost 模型时，另行执行 `npm run ml:bootstrap`、
`npm run ml:check` 和相应的 `ml:*` 命令。

打开 http://127.0.0.1:8787。API 默认固定监听本机地址（`RAI_API_HOST` / `RAI_API_PORT`
可覆盖），不开放局域网访问。公网部署由 Nginx 托管静态并反代 `/v1/`（Bearer 校验），
见 `deploy/README-UBUNTU.md` 与 `deploy/nginx-rai.conf`；iOS 壳真机把服务器地址填为
部署后的 HTTPS 地址（本地开发填 `npm run dev:device` 打印的局域网地址）。

首次启动或数据库删除后，概览、训练和趋势会显示 Apple Health 导入引导；“数据与模型”仍可
提交首次导入，“设置”仍可下载已有备份。没有数据库时，重算、创建备份和删除按钮会保持禁用。

设置页可以创建、下载和显式删除本地 SQLite 备份。删除数据库必须输入完整确认文字，且系统会
先创建一份 `before-delete` 在线备份；该操作不会删除 `apple_health_export/` 中的 Apple
Health 原始文件。创建备份前会检查可用空间；备份默认保留最近 10 份且总量不超过 20 GiB、
最少剩余 512 MiB，并至少保留最新一份。

备份容量策略可通过环境变量调整：`RAI_BACKUP_MAX_COUNT`、`RAI_BACKUP_MAX_TOTAL_BYTES`
和 `RAI_BACKUP_MIN_FREE_BYTES`（后两项单位为字节；生产 `deploy/rai.env.example` 预置
14 份 / 10 GiB / 1 GiB，另见生产环境 systemd 定时备份说明）。

备份可在设置页直接恢复。恢复前会执行 SQLite 完整性、必要表和外键检查；当前数据库存在时
会先创建 `before-restore` 安全快照。

## 目录

```text
packages/
  api-contracts/             Web、API 与移动端共享的 HTTP DTO / OpenAPI 契约
  contracts/                 跨平台 canonical 数据契约（canonical-health-v2 等版本常量）
  health-export-parser/      Apple 导出 XML/GPX 解析、canonical、睡眠/HRV canonicalization
  scoring/                   无平台依赖的纯 TypeScript 评分核心（rai-model-config-v3）
  physiology/                VO₂max、VDOT、乳酸阈值与公式比赛预测
  prediction-inference/      CatBoost ONNX artifact 校验与 Node 生产推理
  features/                  纯 Workout Feature Vector 提取（feature-config-v8）
  training-load/             训练负荷、训练状态与生理状态分类（training-load-config-v4）
  training-zones/            训练分区与时间线
  application/               SQLite 回放、任务队列、Run 与 active 指针、预测/分析 CLI
  storage-sqlite/            schema/migrations（v1–v18）、repository、恢复事实、发布与备份
apps/
  api/                       Fastify 本地 API、移动端聚合、重算 worker 与安全导入切换
  web/                       React / Vite Web（桌面工作台 + iOS 壳像素界面）
  ios/                       Xcode 调试壳：WKWebView + HealthKit 只读增量同步
scripts/                     版本/构建检查、局域网调试（dev-device）、移动端冒烟等
research/                    CatBoost 训练与 ONNX 导出（Python，仅研究用）
deploy/                      Nginx / systemd / env 模板与 Ubuntu 部署说明
docs/
  现状与设计：ARCHITECTURE / WEB_IMPLEMENTATION / DATABASE_DESIGN / DATA_AUDIT /
             SLEEP_HRV_DESIGN / SLEEP_HRV_IMPL_STATUS / PR3_PRODUCTION_READINESS …
  历史审计与设计稿：PROJECT_AUDIT_2026-07-* / PROJECT_HEALTH_AUDIT_2026-09-04 /
             WEB_COMPLETION_AUDIT / CATBOOST_* / PHYSIOLOGY_* / MODEL_* /
             TRAINING_LOAD_* / UI_WIREFRAMES / FIGMA_HIFI_SPEC / PARSER_DESIGN …
             （按文件名中的日期可判断时效，属当时点位的审计/验收记录）
var/                          本地数据库、运行时状态与机器可读报告，不提交
apple_health_export/          Apple 原始导出，不提交
```

iOS 调试壳说明与设计稿→API 映射见 `apps/ios/README.md` 与
`apps/ios/design/ios-app-design.html`。

## 隐私

- 原始 XML、GPX、ECG 和 SQLite 不应提交到 Git。
- 本地数据库包含健康数据和精确路线，只能在可信设备上使用；公网部署请确认 Nginx/云安全组
  仅暴露 80/443 且 `/v1/*` 带 Bearer Token。
- `var/backups/` 中的 SQLite 备份同样包含健康数据和精确路线，应按原数据库的安全等级保管。
- `docs/DATA_AUDIT.md` 只输出聚合统计，不输出来源原名、原始健康值、精确时间或坐标。
- ECG 与医疗记录不进入 RAI 跑力评分。
