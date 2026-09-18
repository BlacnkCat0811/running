# RAI 项目架构

> 当前实施范围：浏览器 Web、localhost API、共享 TypeScript 包，以及经产品决策落地的 iOS 调试壳（`apps/ios`：WKWebView + HealthKit 只读增量同步）与配套移动端聚合 API。文中 React Native / 纯 SwiftUI 移动端产品内容仍为未来适配方向，不属于当前开发或验收范围；范围以仓库根目录 `AGENTS.md` 为准。

## 1. 架构目标

1. Web 版本先完成数据检查、模型实验和可视化。
2. 评分核心不依赖 Web、数据库或 Node，可以被移动端复用。
3. Apple 导出 XML 与 iOS HealthKit 是两个输入适配器，输出同一 canonical contract。
4. 模型升级可以重放，不修改原始数据。
5. 健康与位置数据默认只在本地。
6. 研究代码不能成为产品运行时的隐式依赖。

## 2. 关键技术决策

### 2.1 产品代码使用 TypeScript 单仓库

推荐：

- Web：React + Vite；
- 本地 API：Fastify；
- 移动端：React Native / Expo custom dev client；
- 生产评分与特征工程：纯 TypeScript packages；
- 存储：SQLite repository adapter；
- 研究：Python 只读 canonical SQLite 或脱敏 feature export。

选择 React Native 的主要原因不是 UI 复用，而是 iOS 可直接复用已经验证过的 TypeScript 特征和评分核心。HealthKit 读取通过小型原生 Swift module 完成。

> 现状注记（2026-09）：完整 RN 产品尚未立项。为验证 HealthKit 增量同步与真机体验，先行交付 `apps/ios`——生产路径是 SwiftUI 原生界面（`RAI/Skins/Technology`，2026-09-18 起为唯一视觉），HealthKit 仅只读导出 ZIP 并上传到 API；WKWebView 壳（直接加载 Web 的像素风 iOS 界面，`?raiShell=ios`）保留为开发期回退路径。TypeScript 特征/评分核心完全复用，不在设备上重复实现。

如果未来坚持使用纯 SwiftUI，则不能直接复用 TypeScript 实现。仍可复用 canonical contract、模型配置和黄金测试向量，但需要实现一个 Swift scorer。不存在同时满足“纯 SwiftUI、完全离线、零重复实现”的技术方案；这一取舍应在开始移动端前明确。

### 2.2 Python 只用于研究

Python 适合 pandas、统计检验、绘图和参数搜索，但 iOS 无法自然运行 Python。正确边界：

```text
Python research
  -> 读取 canonical SQLite / feature export
  -> 产生候选参数和实验报告
  -> 参数进入 versioned JSON
  -> TypeScript scoring 通过 golden fixtures 验证
```

不得让 Web API 在生产评分时调用 notebook 或临时 Python 脚本。

### 2.3 SQLite 是 canonical store，不是模型本身

- SQL schema 只存事实、关联、特征和版本化结果。
- 评分逻辑不写在 SQL trigger 或 view 中。
- Repository interface 隔离 Node SQLite 与未来 mobile SQLite。
- 研究层可以通过 Python `sqlite3`、DuckDB 或 pandas 只读访问。

## 3. 架构总览

```mermaid
flowchart TB
    subgraph Sources["数据来源"]
        Export["Apple Health 导出\nXML + GPX\n桌面 / Web 导入"]
        HealthKit["Apple HealthKit\niOS 调试壳（现状）"]
    end

    subgraph Adapters["输入适配层"]
        ExportParser["health-export-parser\n流式 XML / GPX 解析"]
        HealthKitAdapter["iOS 调试壳 HealthKitExport\n增量导出 ZIP"]
    end

    subgraph Domain["跨平台领域层：纯 TypeScript"]
        Contracts["contracts\nCanonical Health Contract"]
        Quality["canonicalization\n稳定 ID、去重、质量标记"]
        Features["features\nWorkout Feature Vector"]
        Scoring["scoring\nCA、TA、Decay、GV、解释"]
        TrainingLoad["training-load\nTRIMP、周期统计、训练状态"]
        Assessments["Ability Assessments\n版本化结果时间线"]
    end

    subgraph LocalData["本地数据层：不上传健康或路线数据"]
        Repository["SQLite Repository\nRaw + Canonical + Feature + Assessment"]
        DatasetVersion["Dataset / Feature / Model Version\n可复现重算"]
    end

    subgraph WebNow["当前：Web 产品（桌面工作台 + iOS 壳像素界面）"]
        Worker["Import / Recompute Worker"]
        Api["Fastify Local API\n127.0.0.1"]
        Web["React + Vite Dashboard"]
    end

    subgraph MobileLater["未来：iPhone App"]
        MobileRepo["Mobile SQLite Adapter"]
        MobileApp["React Native UI\nExpo Custom Dev Client"]
    end

    subgraph Research["离线研究与模型治理"]
        Analysis["Python Research\n只读 feature export"]
        Config["Versioned Model Config\n参数 + 黄金测试向量"]
    end

    Export --> ExportParser --> Contracts
    HealthKit --> HealthKitAdapter
    HealthKitAdapter -. "导出 ZIP（复用现有 XML 导入管线）" .-> ExportParser
    Contracts --> Quality --> Repository
    Repository --> Features --> Scoring --> Assessments
    Features --> TrainingLoad --> Repository
    Assessments --> Repository
    DatasetVersion --- Repository

    Worker --> ExportParser
    Worker --> Quality
    Worker --> Features
    Worker --> Scoring
    Repository --> Api --> Web
    Assessments --> Api

    MobileRepo --> Features
    MobileApp <--> MobileRepo

    Repository -. "脱敏、只读导出" .-> Analysis
    Analysis --> Config --> Scoring

    classDef current fill:#dceeff,stroke:#2563eb,color:#102a43;
    classDef future fill:#e9f7ef,stroke:#15803d,color:#163a25;
    classDef core fill:#fff4d6,stroke:#b7791f,color:#4a3200;
    classDef privacy fill:#f5f5f5,stroke:#525252,color:#202020;
    class Export,ExportParser,Worker,Api,Web,HealthKit,HealthKitAdapter current;
    class MobileRepo,MobileApp future;
    class Contracts,Quality,Features,Scoring,Assessments,Config core;
    class Repository,DatasetVersion,Analysis privacy;
```

图中的实线表示产品运行时数据流；`HealthKitAdapter -.-> ExportParser` 的虚线表示 iOS 壳导出 ZIP 复用现有导入管线；其余虚线只允许脱敏后的研究数据离开 SQLite。`contracts`、`features`、`scoring` 和 `training-load` 不依赖 Web、Node、SQLite 或 UI，因此是 Web 与移动端共用的稳定边界。

## 4. 分层

### 4.1 Ingestion adapters

职责：

- 读取平台格式；
- 规范化日期、单位和来源；
- 产生 canonical objects；
- 保存来源 provenance；
- 不计算 RAI。

实现：

- `health-export-parser`：当前 XML/GPX（含睡眠/HRV canonicalization）；
- `apps/ios` 调试壳 `HealthKitExport`：HealthKit 只读增量导出为 ZIP，复用现有导入管线（现状）；
- 未来第三方 API 也必须作为独立 adapter；原生 React Native / SwiftUI 的 HealthKit adapter 产品仍属范围外。

### 4.2 Canonical domain

`packages/contracts` 只包含：

- canonical 类型；
- metric identifiers；
- contract version；
- 序列化 schema。

禁止依赖 React、Fastify、SQLite、HealthKit 或文件系统。

### 4.3 Canonicalization and quality

职责：

- 稳定 ID；
- 完全重复 record 去重；
- Workout group；
- canonical 选择；
- 数据覆盖率与质量标记；
- 手动 override。

质量结果是独立数据，不应直接混在评分公式里。

### 4.4 Feature engine

计划包：`packages/features`。

输入：canonical Workout、关联时间序列、跑前上下文和 feature config。  
输出：`WorkoutFeatureVector`，包含值、缺失原因、覆盖率和版本。

特征工程必须是纯函数。数据库查询由 repository 在调用前完成。

### 4.5 Scoring core

`packages/scoring`：

- 五维得分；
- CA；
- confidence；
- TA 更新；
- decay；
- GV；
- explanation codes；
- model version。

约束：

- 无 I/O；
- 不读取系统时间；
- 不访问数据库；
- 不依赖 UI；
- 输入完整显式；
- 输出确定性；
- Web 和移动端运行相同测试向量。

### 4.6 Application services

当前实现：`packages/application`。

负责用例编排：

- `ImportHealthExport`；
- `RebuildCanonicalWorkouts`；
- `ExtractWorkoutFeatures`；
- `RecomputeAbilityTimeline`；
- `GetDashboard`；
- `OverrideWorkoutEligibility`。

Application service 可以依赖 repository interface 和 scoring，但不能依赖具体 UI。

### 4.7 Infrastructure

`packages/storage-sqlite` 是 SQLite 唯一入口：schema / migrations、`RaiDatabase` 打开与导入写入、
publication lock、数据库文件发布、model-run / recompute-job / training-session repository，
以及 dashboard / workouts / recovery facts / mobile 聚合 / zones / series / trends / audit 等只读 repository 与共享 SQL 片段。
`packages/health-export-parser` 负责 XML/GPX 解析与 canonicalization（含睡眠/HRV，`RaiDatabase` 仍 re-export 兼容）。
`apps/api` 直接依赖 `@rai/storage-sqlite`；`RaiReadStore` 对 dashboard、workouts、zones、training statistics、
series、trends、recovery facts、mobile 聚合、audit/summary、model-run、job 均走 storage 读 repository，API 层只做缓存与 HTTP DTO 组装。

移动端周目标、周计划和锁课由 `apps/api/src/mobile-goals.ts` 使用独立控制库
`RAI_CONTROL_DATABASE`（默认 `RAI_RUNTIME_ROOT/var/rai-control.sqlite`）持久化；
`mobile_goals` 保存当前 revision，`mobile_goals_history` 保存变更历史。旧
`mobile-goals.json` 只用于一次性迁移，不是默认生产写入路径。当前业务库备份仍不等于业务库、控制库和模型 artifact 的完整备份 bundle。


- migrations（唯一源：`storage-sqlite`）；
- Node SQLite repository；
- Web import job state；
- 原子重算结果切换；
- 备份和恢复。

纯领域包不得依赖 Node SQLite API。详见 `docs/ARCHITECTURE_DEBT_MIGRATION.md`。

### 4.8 Presentation

- `apps/api`：本机 Fastify API，默认只监听 `127.0.0.1`；
- `apps/web`：React / Vite，只依赖 `packages/api-contracts` 中的 HTTP DTO；
- 页面不自己计算分数。

当前产品范围包含浏览器 Web、本地 API、其共享包，以及经授权的 `apps/ios` 调试壳与移动端聚合 API。原生 React Native / SwiftUI 移动端产品和原生桌面端仍不属于本仓库当前范围（详见 §7 与根 `AGENTS.md`）。

## 5. 当前目录与演进目标

```text
apps/
  api/
    src/                           Fastify、读取模型、移动端聚合、后台 worker
  web/
    src/                           React 页面（桌面 + iOS 壳像素 UI）、组件与 HTTP client
  ios/                             Xcode 调试壳（WKWebView + HealthKit 只读增量同步）

packages/
  contracts/                      领域 contract
  api-contracts/                  HTTP DTO
  health-export-parser/           Apple Health 解析、canonical、incremental plan
  storage-sqlite/                 schema、migrations、repos、publication lock/publish
  features/                       纯 Feature Vector 提取
  physiology/                     生理与比赛预测公式
  scoring/                        CA / TA 评分
  training-load/                  训练负荷
  training-zones/                 训练分区与时间线
  prediction-inference/           Node ONNX 推理
  application/                    用例门面 + RecomputePipeline

research/
  rai_ml/                         CatBoost 训练与 ONNX 导出
  scripts/                        python-env bootstrap / pytest / train 入口
  tests/

docs/
  现状与设计：ARCHITECTURE / WEB_IMPLEMENTATION / DATABASE_DESIGN /
              SLEEP_HRV_DESIGN 等（完整清单见根 README「文档」小节）
  历史审计与设计稿：PROJECT_AUDIT_* / PROJECT_HEALTH_AUDIT_2026-09-04 /
              CATBOOST_* / PHYSIOLOGY_* / UI_WIREFRAMES / FIGMA_HIFI_SPEC 等

deploy/                           Nginx / systemd / env 模板与 Ubuntu 部署说明
design/                           UI 设计资产与图标
var/                              本地生成，不提交
  rai.sqlite
  reports/
```

Application 侧：`RaiApplicationService` 为门面（enqueue / override / zone settings / runNextJob）；
重算流水线在 `services/recompute-pipeline.ts`。读路径可继续把剩余 SQL 下沉到 storage repository。

## 6. Web 版本

### 6.1 进程

```text
Browser (React)
  -> localhost API (Fastify)
     -> import/recompute worker
     -> SQLite
     -> feature/scoring packages
```

首次 XML 导入约 91 秒，不能在普通 HTTP 请求内等待。API 应：

1. 创建 import job；
2. worker 执行解析；
3. 每个阶段写进度；
4. Web 轮询或通过 SSE 获取进度；
5. 完成后原子切换当前 dataset version。

### 6.2 API 边界

代表接口（完整清单以 `/v1/openapi.json` 与 `docs/WEB_IMPLEMENTATION.md` 为准）：

```text
POST   /v1/imports/uploads|inspect     ZIP 上传与预检
POST   /v1/import-jobs / GET /v1/import-jobs/:id
GET    /v1/workouts
GET    /v1/workouts/:id
PATCH  /v1/workouts/:id/override
GET    /v1/trends
GET    /v1/recovery-trends
GET    /v1/predictions
GET/POST /v1/model-runs        POST /v1/model-runs/:id/activate
GET    /v1/mobile/today|statistics|trends    GET/PUT /v1/mobile/goals
```

API schema 由 OpenAPI 描述，HTTP DTO 统一定义在 `packages/api-contracts`；Web 不手写第二套响应类型。
若未来引入生成式 client，应从现有 OpenAPI 生成并替换当前轻量请求封装，而不是并行维护两套 contract。

### 6.3 Web 不负责

- 不直接解析 212 MB XML；
- 不直接读 SQLite；
- 不包含评分公式；
- 不维护自己的日期/单位转换；
- 不将原始路线发往第三方地图服务。

## 7. 原生客户端范围

当前产品范围（以仓库根目录 `AGENTS.md` 为准）为浏览器 Web、本地 API 及所需共享包。例外：`apps/ios/` 是经产品决策授权的本地 Xcode 宿主——生产路径为 SwiftUI 原生界面（`RAI/Skins/Technology`，2026-09-18 起为唯一视觉），HealthKit 仅做**只读**同步（增量导出 ZIP）并上传到本地 API，不在设备上重写评分核心、不做 HealthKit 写入与后台 delivery；此前的 WKWebView 壳（加载现有 Web 的像素风 iOS 界面，`?raiShell=ios`）保留为开发期回退路径。配套的 `/v1/mobile/*` 聚合端点与周目标（`GET/PUT /v1/mobile/goals`）随 Web 产品一同交付。原生 React Native / 纯 SwiftUI 移动端产品与原生桌面端仍属范围外，需单独产品决策后方可立项。

## 8. 模型和数据版本

每个 `AbilityAssessment` 必须记录：

```text
dataset_version
canonical_contract_version
feature_schema_version
feature_config_hash
model_version
model_config_hash
calculated_at
```

参数变化产生新的 model run。不能覆盖旧 run 后继续沿用旧 TA 时间线。

## 9. 重算设计

### 完整重算

适用于：

- parser/canonical 规则变化；
- feature schema 变化；
- 基准策略变化；
- model major/minor 变化。

### 局部重算

适用于：

- 单条 Workout override；
- 延迟心率/路线到达；
- HealthKit 对象修改或删除。

从最早受影响 Workout 开始重放后续 TA。结果写入新 run，完成后切换 active run ID。

## 10. 安全与隐私

- API 默认只监听 localhost，不开放局域网；公网部署由 Nginx 反代 `/v1/`（带 Bearer Token 校验），后端进程仍只监听本机地址。
- 原始数据、SQLite、feature export 和研究输出全部 gitignored。
- 日志只使用 object ID，不记录 source name、心率值或坐标。
- Web 地图优先本地渲染；不得把原始 GPX 上传到第三方。
- 诊断导出默认移除路线和原始健康序列。
- 未来若增加云同步，必须作为独立项目决策，不得由前端库隐式引入。

## 11. 测试层级

| 层级 | 内容 |
|---|---|
| Parser fixtures | XML/GPX、重复 metadata、无效日期、路径安全 |
| Canonical fixtures | 跨来源重复、canonical rank、手动 override |
| Feature fixtures | 暂停、缺失心率、间歇、坡度、睡眠边界 |
| Scoring unit | 权重重分配、confidence、TA、decay、GV |
| Golden replay | 完整输入到历史 TA 时间线 |
| API contract | OpenAPI 与 client 一致 |
| Web E2E | 导入、筛选、详情、模型切换 |
| Future mobile integration | 未来独立立项后验证真机 HealthKit 增量和删除；不属于当前 Web 验收 |

## 12. 近期实施顺序

1. 在当前 SQLite 上实现 `packages/features`。
2. 生成 36 次 Gold 的脱敏 feature table 和质量报告。
3. 建立 baseline scorer 与完整历史回放。
4. 固化 model run / assessment schema。
5. 创建 Fastify API。
6. 创建 React Web 的数据审计和跑步详情页。
7. 完善模型并冻结 beta contract。
8. 再创建 React Native iOS 工程与 HealthKit adapter。

> 状态注记（2026-09）：第 1–7 项已完成；第 8 项的先行版本为 `apps/ios` Xcode 调试壳（WKWebView + HealthKit 只读同步，配合 `/v1/mobile/*` 聚合 API），React Native / 纯 SwiftUI 独立产品仍需单独产品决策。

该顺序保留 Web 快速迭代优势，同时避免移动端过早绑定仍在变化的数据语义。
