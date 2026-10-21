# 项目架构

维护日期：2026-10-20。本文只描述**现行实现（as-built）**：源码与发布记录是依据，时点审查/方案文档不算规范。
产品与范围入口：[README](../README.md)、[AGENTS](../AGENTS.md)；算法语义：[ALGORITHM](ALGORITHM.md)；数据合同：[DATA_PIPELINE](DATA_PIPELINE.md)；运维：[OPERATIONS](OPERATIONS.md)。

## 1. 交付物与边界

```text
Apple Health XML/GPX/ZIP ───────────┐
iOS HealthKit 只读导出 → ZIP 上传 ───┤
                                 v
Node/Fastify API ── 导入双直连车道 ── 主库事务（事实+路线+账本+回执+分析任务）
                └─ 分析/重算 worker ── 主库派生 run + 发布指针
                                 ↓
                    API DTO → SwiftUI iOS（唯一客户端）
```

- 仓库只交付两样东西：`apps/ios` 的原生 SwiftUI App，和它直连的 Node.js API + 共享算法包。
- Web 前端（`apps/web`）与 macOS target 已于 2026-10-17 退役（[DECISIONS](DECISIONS.md) D17、[ADR-006](adr/ADR-006-retire-web-and-macos.md)）：没有 WKWebView 路径、没有浏览器静态托管、没有 `npm run build`。
- iOS 不运行 Node.js、不复制评分核心；HealthKit 只读导出的样本经 ZIP 上传进导入管线，手表排期是唯一的 WorkoutKit 写入面（详见 §7）。
- 不存在设备端 Swift scorer、独立 Watch/桌面/Android 产品。「本地优先」指部署者控制数据库，不代表手机与服务器之间不传健康数据。

## 2. 运行时拓扑

- **单 Node 进程**：不增加多 API 写者、不用 PM2 cluster；一个 Fastify 主线程负责 HTTP、控制库同步写和调度。
- **import worker 线程**：一次任务内按固定顺序执行两条直连车道（§3）；顺序是显式数据，worker 侧 fail-closed 校验。
- **recompute worker 线程**：分析/重算在 worker 里跑，跨线程写许可由 write-lease 授权（§5）。
- **prediction training 子进程**：只读打开主库，只产出工件；DB 行由父进程记录，不构成第二个写者。
- **CLI**（`packages/health-export-parser`）：离线导入、迁移、审计；候选库 + 文件换库的导入发布只在这里（备份恢复另有一套带 journal 的换库，见 §5）。
- **定时器**：训练计划协调器等 single-flight tick 在主线程内串行执行。

## 3. 导入与发布

### 3.1 API：两条直连车道 + 终态失败（没有候选库回退）

API 运行期的导入是「data-only 快通路 → direct-sync 统一接收器 → 否则显式失败」：

1. **data-only 快通路**：入口判据更严（记录白名单 + 基线合同戳）。命中时只增量保存原始记录，不需要重算或换库。
2. **direct-sync 统一接收器**：接受 Workout / 评分类型 / 显式删除 / GPX 路线，在**同一笔主库事务**里写入事实、路线、导入账本、可持久查询的回执，并由账本决定是否登记分析任务（提交权归调用方）。回执的 `analysisStatus` 是唯一判据：`queued` 表示同事务真的登记了分析，`not_required` 表示没有。
3. **否则 `ImportLaneRefusal`**：带稳定 `failureCode` 的**终态失败**，不是回退信号。不存在「退回候选库」「整库备份 → 临时库 → 文件换库」的 API 路径；旧调用链已从 API 删除，保留的方法只服务隔离退役，运行期没有路径到达。

顺序不可交换：data-only 的判据比统一接收器更严，放到后面会让它的两道闸门失去意义。变更顺序会被 worker 侧直接拒绝执行。

失败与恢复语义：`202 queued` 不等于成功，客户端要查任务终态；导入回执与事实同事务提交，因此 worker 回复丢失时从回执恢复「已提交成功」而不是报失败。内容未变的上传走 no-op 回执路径（锚点绑定 `dataset_version`，任何后续导入都会让它失效），no-op 也必须落可持久查询的回执。

### 3.2 CLI：候选库 + 文件换库（不同的离线语义）

CLI 仍保留完整链路：SQLite 在线 backup 生成私有候选库 → TS/Rust 引擎写入 → 发布闸门（对刚写完的候选库做结构探针；不再跑全库 `quick_check`）→ `publishDatabaseFile` 原子换库 → read store 替换。它服务离线导入、迁移与运维场景，与 API 运行期是**两条不同的语义**，不能互相套用。Rust 可选热循环（`RAI_IMPORT_ENGINE`）只在这里可选；API 两条车道固定 TypeScript 引擎。

### 3.3 备份责任

应用**不再提供备份创建/删除 API**：`POST /v1/backups` 与 `DELETE /v1/backups/:name` 返回 `410`（`backup_creation_retired` / `backup_deletion_retired`），路由仍挂载以便旧客户端区分「刻意退役」与「路径写错」。但「删除数据集」与「恢复备份」两个危险操作仍会各自写一份安全快照（`before-delete` / `before-restore`），失败路径不消耗保留槽位。日常一致性备份由运维用 SQLite backup API 或存储快照完成，活跃 WAL 库不能只 `cp` 主库文件（见 §4 与 [运维](OPERATIONS.md)）。

## 4. 四个存储与所有权

| 存储 | 内容 | 写入者 |
|---|---|---|
| 主库 `var/rai.sqlite` | 健康事实、训练、覆盖修订、不可变派生 run、已发布指针；迁移注册表是 schema 版本唯一来源 | API 请求/worker（同一时刻一个写者）；CLI 离线迁移 |
| 控制库 `var/rai-control.sqlite` | 计划状态与历史、发布结果、排期回执；schema 表 `mobile_control_schema` 当前为 **v2**：`mobile_training_state` / `_history` / `_migration_audit`，另有 legacy `mobile_goals`/`_history`、`mobile_plan_pushes`、`mobile_plan_operations`、`mobile_coach_loop_receipts` | 只有 API 主线程（同步写，无自己的跨进程发布锁） |
| 运行时 `var/runtime.sqlite` | 来源/任务状态、导入回执索引与发布 journal | API 主线程/worker |
| epoch 侧车 `var/rai.sqlite.dataset-epoch.sqlite` | dataset epoch 单行持久化；独立于可删除的事实库与运行时库的损坏恢复 | 恢复/替换数据集时写入；缺失时失败开放回落到 configured epoch |

四者都可能含敏感信息，属于同一维护/备份边界；迁移与恢复按 [运维](OPERATIONS.md) 协调，不能只复制一个活跃 `.sqlite` 文件。

## 5. 请求与一致性边界

**读路径**：全部 SQLite 读在 Fastify 主事件循环内**同步**执行，没有请求级超时预算；read store 缓存只读连接并按 inode 失效，换库时用读租约 gate 等待空闲。诚实结论：一次全库扫描会阻塞所有 HTTP、后台定时器与 watchdog 心跳，可用性兜底是进程级 watchdog，而不是「本请求超预算 → 可重试 503」。

**写路径**：写命令具备 revision/idempotency/generation 约束；反馈保存与其后分析成功是两个状态；`202 queued` 不是成功。单写者由五层叠加强制，失败方向一律 fail-closed：

1. **publication lock**：跨进程、按 DB 路径；API 进程整个生命周期持有，CLI 迁移/导入短暂持有，后启动者拒绝启动。
2. **TaskAdmissionScheduler**：进程内作业级 FIFO 准入（import/recompute/prediction/command），拿不到以 409 收场。
3. **MutationCoordinator**：进程内单 HTTP 请求级互斥（`mutation_conflict`），请求生命周期内保证释放。
4. **write-lease**：跨线程短写租约（一个租约窗口 = 一笔短事务）；授权超时是**撤回请求并抛可重试错误**，不是无保护地继续写。
5. **publication guard**：跨主库 + 控制库的发布窗口标记；读端看到 guard 变化就重试，重试用尽返回 `503` + `Retry-After`。

**跨库一致性是 detect + retry，不是分布式事务**：主库与控制库不能原子提交，正确性靠 guard/epoch/摘要的前后比对与重试，读端必须能接受「读期间事实变化，请重读」。模型发布是另一层：run/快照/指针在同库内，删除/回滚/保留策略见[算法§14](ALGORITHM.md#14-发布删除与回滚)；原始健康记录不随模型回滚重写。

**datasetEpoch**：恢复备份或替换数据集必须改变 epoch，不能继续复用旧缓存/同步游标；epoch 侧车的存在就是为了在事实库被删除/恢复后仍能读到它。

## 6. Workspace 职责与依赖边界

实测（`npm run check:package-boundaries`）：**16 个包 / 31 条 src 边 / 禁线 4 条**；纯逻辑层 12 个包（[tsconfig.pure.json](../tsconfig.pure.json)）。

| 包/目录 | 职责 |
|---|---|
| [contracts](../packages/contracts/src/index.ts) | 领域合同、schema/version、语义 JSON |
| [api-contracts](../packages/api-contracts/src/index.ts) | API/iOS 消费的 HTTP DTO |
| [health-export-parser](../packages/health-export-parser/src/index.ts) | XML/GPX、安全导入、canonical、身份/删除、恢复事实；自带 CLI 车道 |
| [features](../packages/features/src/index.ts) | 显式时点的训练特征及 V3 兼容读取 |
| [scoring](../packages/scoring/src/model.ts) | CA/TA、质量门控、基线/epoch；不读取当天恢复 |
| [readiness](../packages/readiness/src/index.ts) | 当天恢复规则唯一来源 |
| [normalization](../packages/normalization/src/index.ts) | 条件比较/归一化 trace 与责任边界 |
| [durability](../packages/durability/src/index.ts) | 专项暴露、耐久证据；未校准不罚分 |
| [dynamics](../packages/dynamics/src/index.ts) | 跑姿动态读侧（覆盖门控、可比速度分段）；只吃 contracts，不进入 CA/TA |
| [training-load](../packages/training-load/src/index.ts) / [training-zones](../packages/training-zones/src/index.ts) | 复合负荷、日状态、分区来源和刺激 |
| [physiology](../packages/physiology/src/index.ts) | VO₂max/VDOT、阈值与公式成绩预测 |
| [prediction-inference](../packages/prediction-inference/src/index.ts) | 工件校验、ONNX 残差及可解释回退 |
| [model-eval](../packages/model-eval/src/index.ts) | 回放/消融/竞争/区间与报告合同 |
| [application](../packages/application/src/index.ts) | 分析/重算/预测**服务库**：recompute pipeline、model-v2 快照与预测报告/训练/回放；不是 API 领域层，装配与发布编排都在 apps/api |
| [storage-sqlite](../packages/storage-sqlite/src/database.ts) | migrations、repositories、锁/发布/备份原语 |
| [api](../apps/api/src/server.ts) | Fastify 鉴权、上传、命令、查询与运行时协调；直接 import `@rai/storage-sqlite` |
| [ios](../apps/ios/README.md) | SwiftUI、HealthKit、缓存/续传；消费服务端结果 |

依赖约束由 [包边界检查](../scripts/check-package-boundaries.mjs) 执行，四类判据：A) `packages/*` 不得 import `apps/*`；B) 具名禁线（`scoring` 不得触达 readiness/storage-sqlite/application/model-eval）；C) package.json 声明与实际 import 双向一致；D) workspace 边白名单，新增边必须显式改脚本。**「类型检查能过」不等于边界成立**。

## 7. 客户端

- iOS 是唯一客户端：SwiftUI、HealthKit 只读导出、后台恢复、直连 API。
- 健康同步：HealthKit 只读授权 → 运行相关样本导出为 ZIP → `POST /v1/imports/uploads`（`/v1/imports/inspect` 预检）进入 §3 的导入管线；后台 delivery / BGProcessingTask / background URLSession 是已授权的机制。
- 手表排期：WorkoutKit 只写训练排期，需要 workout 类型的 HealthKit 写授权；不写健康样本。
- 本地状态：页面缓存 + 同步意图 journal + 直连回执状态，不成为第二个评分/健康事实主库；设备侧不变量（水位/ledger/写前日志/回执 journal）见 [iOS 排期协议](IOS_NATIVE_PLAN_SCHEDULING.md)。
- 训练计划 v2：统一读取 `GET /v1/mobile/training-plan-state`（`X-RAI-Training-Contract: 2`），写配置/预览/刷新走 `/v1/mobile/training-plan/commands*`。服务端宣告 v2/教练合同能力时使用统一页；v2 路径本身不回落 v1 写协议。未宣告能力的旧服务端仍渲染旧页面，这是兼容面，不新增功能。
- **已知缺口（AR-1）**：统一页仍渲染「手动课表」入口，其保存/预览/确认调用的是已退役的 `/v1/mobile/goals` 与 `/v1/mobile/workout-plan/*`，会得到 `410 legacy_surface_retired`。因此**不能**把现状描述成「iOS 已完全走 v2」；这是已记录的产品缺口，不是文档口径。

## 8. 部署与安全

- 默认回环地址监听；云部署用 Nginx HTTPS，只反代 `/v1`，站点根路径 404，Bearer 令牌鉴权，systemd 资源预算与 watchdog，见[部署说明](../deploy/README-UBUNTU.md)。
- 鉴权、ZIP 限额/路径验证、导入写许可、备份/恢复锁、移动端凭证隔离都是独立安全边界；单元测试通过不代替真实环境配置核查。
- 「本地优先」不表示无网络健康数据传输：用户选云端后，HealthKit ZIP 与查询都会传给该服务器。

## 9. 可执行不变量索引

| 约束 | 门禁 |
|---|---|
| 包分层/具名禁线/边白名单 | `npm run check:package-boundaries`（含 `-- --self-test`） |
| 训练计划唯一写者形状 | `npm run check:training-plan-single-writer` |
| 退役面必须 410 且有替代面 | `legacy-surface-retirement` 测试矩阵；见 [iOS API 合同](IOS_NATIVE_API_CONTRACT.md) |
| §16.1 验收合同覆盖 | `npm run check:acceptance-matrix` |
| 文档链接/行号引用 | `npm run check:docs`、`npm run check:doc-refs` |
| 历史迁移冻结 | `packages/storage-sqlite` 迁移冻结校验和门禁 |

口径纪律：生成审计报告不是产品规范；固定时点的机器证据进 `deliverables/`，不把另一台机器的统计当成本机事实。
