# RAI 全项目多智能体审查报告

> 日期：2026-07-17  
> 模式：只读审查（6 个并行探索/审查子代理，**未修改业务代码**）  
> 范围：架构与包边界、API 安全与并发、健康数据导入/解析、领域算法、Web 前端、预测/ML  
> 分域原稿：`%TEMP%\grok-Administrator\grok-project-audit-d39f4082-*.md`  
> 历史对照：`docs/PROJECT_AUDIT_2026-07-13.md`

## 1. 审查方法

| 子代理 | 焦点 | 产物 |
|--------|------|------|
| architecture | monorepo 分层、contracts、Python 隔离 | `…-architecture.md` |
| api | `apps/api` 安全、任务、SQLite 并发 | `…-api.md` |
| data | parser / incremental / canonical / 备份恢复 | `…-data.md` |
| domain | features / scoring / physiology / load / zones | `…-domain.md` |
| web | React SPA、竞态、假数据 UI、E2E | `…-web.md` |
| prediction | CatBoost/ONNX、激活门槛、CLI 一致性 | `…-prediction.md` |

产品范围以根目录 `AGENTS.md` 为准：仅 Web + 本地 API + 共享 TS 包；不把原生移动端或 &lt;1024px 重设计当作缺陷。

## 2. 总评

RAI 是成熟的本地优先跑步分析 monorepo：领域包依赖方向大体正确，导入采用 staging + 校验 + rename 发布，API 绑定 `127.0.0.1` 并有 Host/Origin 防护，预测训练与生产推理（ONNX）边界清晰。相对 2026-07-13 审查，多项高优先级问题（active 指针、中断任务恢复、Worker 重算、Windows 进程树取消等）已落地。

当前残余风险集中在三类：

1. **正确性 / 产品诚信**：Web 上部分“周环比 / 7 日变化”为硬编码占位；训练负荷 composite 与 Banister 元数据混用；会话类型 long_run 优先误标。  
2. **并发与数据边界**：重算与预测训练可同时写同一 SQLite；部分写路由不与 recompute 互斥；replace 仅等待读 lease。  
3. **架构与可维护性**：`storage-sqlite` / 生成式 `api-client` 未落地；`RaiApplicationService` 体量过大；评分主路径单测偏薄。

## 3. 各域结论摘要

### 3.1 架构与包边界

**结论**：纯领域包（features / scoring / physiology / training-load / training-zones）仅依赖 `@rai/contracts`；Web 只依赖 `@rai/api-contracts`；Python 在 workspace 外、经子进程训练。主要漂移是计划中的 `storage-sqlite` / `api-client` 未实现，SQLite 与 product schema 落在 `health-export-parser`，读（API `RaiReadStore`）写（`RaiApplicationService`）双 SQL 层并存，`@rai/contracts` 混入 HTTP Response 形态类型。

**优势**：Feature/Model Run 插入 + `active_*` 指针、配置哈希与版本常量、OpenAPI/JSON Schema 校验路径存在。

### 3.2 API 安全与运行时

**结论**：本地单用户安全基线扎实（绑定 loopback、ZIP slip/bomb、备份 basename、500 脱敏、导入锁转让、中断 job 恢复）。高信号问题是**后台重算与预测 worker 无互斥**、override / model-runs 不挡 active recompute、DB replace 不覆盖 worker 写连接、目录导入接受任意 `inputPath`。

### 3.3 数据管道

**结论**：SAX 流式 XML、generation 增量、session 稳定匹配、迁移 checksum + FK check、API rename-aside 发布是强项。高风险仍是**workout/record ID 过度哈希 payload** 导致增量 churn、整份 XML 单一大事务、HR 序列严格 `source_name` 匹配、GPX 全量内存、`INSERT OR REPLACE` 路径 UNIQUE 级联风险、多 session 歧义时铸造新 id。

### 3.4 领域算法

**结论**：HRR-TRIMP、composite load 时间线、Daniels VDOT 可逆、walk-forward 校准与 residual 封顶设计认真。核心缺陷：生产 `load = compositeLoad` 却保留 Banister 的 source/intensity/confidence；HR 覆盖用时长加总而非并集；long_run 规则压制 interval/recovery；`raceHeartRateReserveThreshold` 死配置；EWMA 冷启动；极低速度可负 VDOT；**scoring 主路径几乎无单测**。

### 3.5 Web 前端

**结论**：`useRemote` 竞态/abort、导入恢复、对话框 a11y、懒加载与 E2E 覆盖表现优秀。**硬伤**：预测页“较上周”与数据审计“变化（7天）”为客户端编造数值；Dashboard 统计失败伪装成“数据积累中”；CA 模型激活不发 `rai:data-updated`。

### 3.6 预测 / ML

**结论**：生产推理不依赖 Python；特征 schema 哈希双端锁定；反泄漏 as-of 切分与 Windows `taskkill /T` 已实现并有测试。问题侧重方法与一致性：激活指标来自 walk-forward 中间模型而发布全量拟合 ONNX；门槛偏薄（15/3/3%）；**`data:predict` CLI 走公式同步路径，与 API ONNX 不一致**；eval CLI 评 ridge 而非 CatBoost；Node 侧 ONNX 仅 smoke 无数值 parity。

## 4. 优先问题清单（跨域合并）

严重度：`bug` = 正确性/诚信/数据完整性/并发风险；`suggestion` = 设计债/可维护性/方法风险；`nit` = 次要。

### P0 — 建议尽快处理

| # | 域 | 严重度 | 问题 | 位置（代表） |
|---|----|--------|------|----------------|
| 1 | web | bug | 预测页“较上周”硬编码假数据 | `apps/web/src/pages/PredictionsPage.tsx` |
| 2 | web | bug | 数据审计“变化（7天）”客户端公式伪造 | `apps/web/src/pages/DataAuditPage.tsx` |
| 3 | domain | bug | composite load 与 Banister source/intensity/confidence 混用 | `packages/training-load` + `service.ts` 负荷写入 |
| 4 | api | bug | recompute 与 prediction worker 可并发写同一 DB | `apps/api/src/server.ts` 启动调度 / `worker.ts` |
| 5 | api | bug | replace 只等读 lease，worker 写连接在栅栏外 | `read-store-manager.ts` / worker activate |
| 6 | data | bug | Workout/Record 稳定 ID 哈希完整 payload → 增量 delete/insert 抖动 | `apple-health-parser.ts` |
| 7 | prediction | bug | `data:predict` CLI 不用 active ONNX，与 UI/API 不一致 | `prediction-cli.ts` |

### P1 — 高价值改进

| # | 域 | 严重度 | 问题 |
|---|----|--------|------|
| 8 | domain | bug | long_run（≥75min / ≥15km）优先于 interval/recovery，扭曲 TA 证据权重 |
| 9 | domain | bug | 训练负荷 HR 覆盖用 duration 求和非并集；service 丢弃 `startOffsetSeconds` |
| 10 | domain | bug | EWMA acute/chronic 从 0 起步，门闸打开后 loadRatio 易虚高 |
| 11 | domain | bug | 极低速度 Daniels O₂ cost 可为负 → 负 VDOT |
| 12 | data | bug | HR 序列仅同 `source_name`，跨设备丢失 series |
| 13 | data | bug | 歧义多 session 匹配铸造新 id，覆盖/历史易脱钩 |
| 14 | api | bug | override / `POST /v1/model-runs` 不挡 active recompute |
| 15 | api | bug | 目录导入任意 `inputPath`（信任模型 = 任意本机客户端） |
| 16 | web | bug | Dashboard 统计失败显示为“数据积累中” |
| 17 | prediction | suggestion | 激活用 walk-forward 指标，上线模型为全量 refit ONNX |
| 18 | prediction | suggestion | 自动激活门槛偏薄（15 holdout / 3 每距离 / 3% MAE） |
| 19 | domain | suggestion | `scoreFeature` / TA 更新主路径几乎无单元测试 |

### P2 — 架构与体验债

| # | 域 | 问题 |
|---|----|------|
| 20 | arch | 抽取 `storage-sqlite`；contracts 与 api-contracts 分层；文档目录树与现状对齐 |
| 21 | arch | 双 SQL 读/写层统一 repository；`RaiApplicationService` 按用例拆分 |
| 22 | arch | 纯包 tsconfig 强制无 Node/DOM（目前靠约定） |
| 23 | api | 缺失 Origin 的 unsafe 方法放行；job 错误可能泄露绝对路径 |
| 24 | api | 大 ZIP 上传全程占 mutation 锁；`beginReplace` 无限等待 |
| 25 | data | 全 XML 单事务 vs 设计文档 5k flush；GPX 全缓冲；route `INSERT OR REPLACE` |
| 26 | domain | 死配置 `raceHeartRateReserveThreshold`；双套 HRR 区间阈值；成熟度硬编码 1.0 |
| 27 | web | CA 模型激活不广播 `rai:data-updated`；任务列表不轮询重算进度 |
| 28 | prediction | eval CLI 评 ridge 非 CatBoost；Node ONNX 无数值 golden parity |
| 29 | data/api | CLI 发布弱于 API rename-aside；迁移版本号跳过 11 |

## 5. 与 2026-07-13 审查对照

| 历史主题 | 本次状态 |
|----------|----------|
| 心率区间截断 30s、Feature 等权平均 | 已由既有修复路径覆盖；本次未复现为新 bug（未做完整数值回归） |
| active 指针与 failed Run | 激活校验 succeeded + training metric；views  hardened（migration v9 叙事） |
| 重算堵主线程 | Worker Thread 路径存在 |
| 中断 job 永久 running | 启动 recover 存在 |
| Windows 预测取消进程树 | **已实现并有测试**（非开放 bug） |
| 进程级更强 DB 替换 | API import/restore rename-aside + rollback **已有**；CLI 仍较弱 |
| restore schema/FK | `quick_check` + FK + identity **存在** |
| Web 竞态覆盖新响应 | `useRemote` requestId 处理良好 |
| 仍建议：备份/校验加强、CatBoost bootstrap、间歇结构检测、图表 a11y | 部分仍开放；本次新增假 UI 数据与负荷元数据混用等 |

## 6. 各域优势（保留）

- **安全默认值**：`127.0.0.1`、Host/Origin、ZIP 路径穿越与体积上限、备份名约束、5xx 通用文案。  
- **数据不可变叙事**：新 Feature/Model Run + active 指针；shadow 校验拒绝不一致 active 切换（导入路径）。  
- **领域严谨点**：非有限值防护、权重 renorm、TA residual cap、复合负荷时间线、anti-leakage as-of 特征。  
- **Web 工程**：懒加载分 chunk、导入 job 恢复、关键对话框焦点/Esc/E2E。  
- **ML 边界**：生产不 import Python；schema hash 双端锁定；失败回退公式并标明 reason。

## 7. 建议落地顺序（仅规划，本次未实施）

1. **立刻（诚信）**：去掉或隐藏 Predictions/DataAudit 假 delta；Dashboard 统计错误显式化。  
2. **并发**：统一 writer fence（import activate / recompute / prediction complete / restore）；SQLite `busy_timeout`；写路由 busy 谓词一致。  
3. **负荷与会话类型**：composite 元数据对齐；long_run 优先级；HR 并集覆盖。  
4. **稳定 ID**：有 `syncIdentifier` 时不哈希 statistics/events；记录 ID 与 PARSER_DESIGN 对齐。  
5. **CLI/API 预测一致**：`data:predict` 走 async ONNX 或明确文档 + 开关。  
6. **测试**：scoring 黄金向量；Node ONNX golden；必要时 import ID churn 回归。  
7. **架构债**：分 PR 抽 storage、拆 service、收紧 contracts——不阻塞上述正确性项。

## 8. 未覆盖与限制

- 未在本轮执行 `npm test` / `typecheck` / E2E / 真实 `rai.sqlite` 数值回归。  
- 未对 `apple_health_export` 全量重导入压测。  
- 未审查 `var/` 运行日志中的个人健康细节内容。  
- 严重度与行号来自静态代码阅读，实施前应用测试复核。

## 9. 工件路径

| 文件 | 说明 |
|------|------|
| `docs/PROJECT_AUDIT_2026-07-17.md` | 本汇总（交付物） |
| `%TEMP%\grok-Administrator\grok-project-audit-d39f4082-architecture.md` | 架构分域 |
| `%TEMP%\grok-Administrator\grok-project-audit-d39f4082-api.md` | API 分域 |
| `%TEMP%\grok-Administrator\grok-project-audit-d39f4082-data.md` | 数据管道分域 |
| `%TEMP%\grok-Administrator\grok-project-audit-d39f4082-domain.md` | 领域算法分域 |
| `%TEMP%\grok-Administrator\grok-project-audit-d39f4082-web.md` | Web 分域 |
| `%TEMP%\grok-Administrator\grok-project-audit-d39f4082-prediction.md` | 预测/ML 分域 |

---

## 10. 复查状态（2026-07-17 二次只读核验）

对照当前仓库源码逐项核对（仍未改业务逻辑，仅增本节）。

### 图例

- **已修复**：当前代码已消除原问题核心  
- **部分修复**：主路径改善，残留相关风险  
- **仍开放**：原问题仍成立  

### P0

| # | 状态 | 证据摘要 |
|---|------|----------|
| 1 预测假「较上周」 | **已修复** | 页内无硬编码 delta；E2E 断言无「较上周」文案 |
| 2 审计假「7天变化」 | **已修复** | `DataAuditPage` 已改为真实占比/数据集列 |
| 3 composite/Banister 混用 | **部分修复** | 有 `loadBreakdown` 时 confidence 来自 HR/pace 分量；`source`/`intensity` 仍走 Banister 路径 |
| 4 recompute∥prediction 写库 | **已修复** | 两者均经 `readStores.writerLease` 串行 |
| 5 replace 只等读 lease | **已修复** | `beginReplace` 等 `writerActive`+读 lease，默认 10s 超时 |
| 6 Workout/Record ID 过哈希 | **已修复** | 有 `syncIdentifier` 时用 type/source/syncId；内容哈希单独存 |
| 7 CLI 不用 ONNX | **已修复** | `prediction-cli` → `buildPredictionReportAsync` |

### P1

| # | 状态 | 证据摘要 |
|---|------|----------|
| 8 long_run 优先 | **部分修复** | interval 结构检测已在 long_run 之前；recovery/easy 仍在 long_run 之后，长轻松跑仍会标 long_run |
| 9 HR 覆盖并集 / offset | **部分修复** | zones composite 有时间线；Banister 路径仍 duration 求和；service 映射 load 时仍可丢 offset |
| 10 EWMA 冷启动 | **已修复** | 首观测日 seed acute/chronic，非从 0 |
| 11 负 VDOT | **已修复** | `oxygenCost <= 0` 抛错 |
| 12 HR 仅同 source_name | **已修复** | 同源为空时按可穿戴优先级跨源回退 |
| 13 歧义 session 新 id | **已修复** | 多匹配保留稳定历史 id 并标 `ambiguous` |
| 14 override 不挡 recompute | **已修复** | override / model-runs 检查 worker + active job |
| 15 任意 inputPath | **已修复** | `POST /v1/import-jobs` 仅 `sourceId` |
| 16 Dashboard 统计失败伪装 | **已修复** | `statistics.error` → `ErrorBlock` |
| 17 walk-forward ≠ 发布 ONNX | **已修复** | temporal/event release holdout；仅 fit(T) 一次，H 直接验收同一 artifact SHA；Node 对 H 全量复算 |
| 18 激活门槛偏薄 | **已修复** | holdout 24/每距离 6、MAE 改善 5%、标签 50 等已提高 |
| 19 scoring 主路径无测 | **已修复** | `scoreFeature` 等主路径已有单测 |

### P2（摘要）

| # | 状态 | 备注 |
|---|------|------|
| 20 storage-sqlite | **部分** | 包存在，目前 mainly publication-lock，schema 仍在 parser |
| 21 双 SQL / 大 service | **仍开放** | 架构债 |
| 22 纯包 tsconfig | **仍开放** | 约定未强制 |
| 23 Origin / 路径泄露 | **部分** | 无 Origin 需 `localRequestMarker`；job 错误脱敏未全面确认 |
| 24 上传锁 / replace 超时 | **部分** | replace 超时已有；大 ZIP 占 mutation 锁待确认 |
| 25 XML 大事务 / GPX / route REPLACE | **部分** | route 已 `ON CONFLICT`；全 XML 原子事务仍在 |
| 26 死配置 race 阈值 / 成熟度 1.0 | **已修复** | `raceHeartRateReserve*` 已移除；maturity 按 eligible 计数 |
| 27 激活事件 / 任务轮询 | **已修复** | `notifyDataUpdated` + jobs interval poll |
| 28 eval ridge / Node golden | **已修复** | eval 读 CatBoost evaluation；`onnx-golden.json` 数值 parity |
| 29 CLI 发布 / migration 11 | **部分** | CLI 有 displaced+rollback；migration v11 已存在；仍非 rename-aside |

### 复查结论

- **P0：7 项中 6 已修、1 部分（#3）** — 无未动手的 P0。  
- **P1：12 项中 9 已修、2 部分（#8/#9）、#19 已修**。  
- **P2：以架构债与方法论为主；体验/ML 工程项多数已收口。**  

**尚未清零的高价值残留：**

1. composite 生产路径下 `source`/`intensity` 仍可能与 Banister 不一致（#3）  
2. long_run 仍压制 recovery 型长距离（#8）  
3. 激活指标与全量 refit ONNX 不对齐（#17）  
4. 架构抽取与 service 拆分（#20–#22）  

---

*审查 ID：`d39f4082` · 初审只读 · 复查只读*
