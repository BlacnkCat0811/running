# RAI 全项目多智能体审查报告（第二轮）

> 日期：2026-07-17  
> 模式：只读 · 6 个并行审查子代理  
> 审查 ID：`692b39c7`  
> 对照基线：`docs/PROJECT_AUDIT_2026-07-17.md`（含 §10 复查）  
> 分域原稿：`%TEMP%\grok-Administrator\grok-project-audit-692b39c7-*.md`  
> **未修改业务代码**

## 1. 方法

| 子代理 | 焦点 |
|--------|------|
| architecture | monorepo 分层、storage、contracts、service 体量 |
| api | 安全、writerLease、job、ZIP、busy_timeout |
| data | parser、增量 ID、session、CLI/API 发布 |
| domain | features / scoring / load / physiology |
| web | 假指标、竞态、a11y |
| prediction | CatBoost/ONNX、激活、train/serve |

产品范围仍以 `AGENTS.md` 为准（Web 桌面 + 本地 API）。

## 2. 总评

相对第一轮审查与 §10 复查，**大量 P0/P1 已在代码中关闭**（假周环比、稳定 ID、writer 栅栏、ONNX CLI、release holdout、composite 元数据、interval/recovery 优先、跨源 HR、歧义 session、sourceId 导入等）。当前系统整体健康度明显提高。

本轮重点从「是否修好旧 bug」转为「修好后的新边角与产品诚信」：

1. **并发副作用**：prediction 训练整段占用 `writerLease`，阻塞 recompute 与 DB replace。  
2. **数据诚信（Web）**：预测页仍有客户端编造的准备度 / 全马时间 / 模型状态文案。  
3. **数据管道**：route `relative_path` 唯一冲突、首次增量 seed 假更新、inactive session 不回挂。  
4. **领域细节**：RPE 回退 confidence=0、统计-only HR 伪造全覆盖、VDOT 用 wall-clock。  
5. **ML 运营**：重算后 CatBoost 仍 active（分布漂移）、全距离回退仍报 `active`。  
6. **架构债**：storage 抽取未完成、双 SQL、大 service — 仍在但非正确性阻塞。

## 3. 与上轮残留对照

| 上轮高价值残留 | 本轮状态 |
|----------------|----------|
| #3 composite source/intensity/confidence | **已修复**（composite 覆写 + 测试） |
| #8 long_run vs interval/recovery | **interval/recovery 已优先**；long easy→long_run 为产品语义（suggestion） |
| #9 HR 并集 / offset | **生产路径已基本修复**；死代码仍丢 offset |
| #17 walk-forward ≠ 发布 ONNX | **已修复**（training_partition fit + temporal release holdout + 同 SHA） |
| #20–22 架构债 | **仍开放**（storage 部分进展；pure tsconfig 已落地） |

## 4. 优先问题清单（本轮）

### P0 — 建议优先

| # | 域 | 严重度 | 问题 |
|---|----|--------|------|
| R2-1 | api / prediction | bug | **CatBoost 训练全程持有 `writerLease`**，阻塞 recompute 与 `beginReplace`（导入激活/恢复可 10s 超时失败） |
| R2-2 | web | bug | **预测页「证据与准备度 / 综合准备度」为客户端公式**，非 API 真值 |
| R2-3 | web | bug | **全马时间**由半马 × 常数编造，与真预测同卡展示 |
| R2-4 | web | bug | **WorkoutDetail `backgroundRefresh`**：URL 已换 id，仍展示/可编辑上一训练 |
| R2-5 | data | bug | **route `relative_path` UNIQUE** + 仅按 id upsert → id 漂移时导入约束失败 |
| R2-6 | data | bug | **`seedImportGenerations` 用 id 当 content_hash** → 首次增量假全量 update + 全量重算 |
| R2-7 | domain | bug | **composite 无 HR/pace 时 confidence 强制为 0**（RPE/session 回退），负荷进 EWMA 但质量为 0 |

### P1 — 高价值

| # | 域 | 严重度 | 问题 |
|---|----|--------|------|
| R2-8 | domain | bug | 统计-only HR fallback 伪造 sampleCount=10 与全时长覆盖 → 易误标 eligible |
| R2-9 | domain / prediction | bug | 预测标签/证据用 **wall-clock 时长** 算 VDOT，暂停训练低估能力 |
| R2-10 | domain | bug | `effectiveWeights` 用 `max(availableWeight,1)` 导致部分维度权重和不归一 |
| R2-11 | data | bug | **inactive session 永不 rematch** → 再出现训练铸造新 id，覆盖孤儿 |
| R2-12 | data | bug | 无 syncId 时 workout id 仍哈希完整 payload → 第三方来源 churn |
| R2-13 | api | bug | 主库 `RaiDatabase` **无 `busy_timeout`** |
| R2-14 | api | bug | import job `error`、prediction **events** 仍可泄露内部路径/stderr |
| R2-15 | api | bug | ZIP 解压只信声明 size，**未计量实际写出字节**（size-lie 炸弹） |
| R2-16 | api | bug | HTTP 写路径 busy 预检后 **不持 writerLease**，与 worker TOCTOU |
| R2-17 | prediction | bug | 重算后 **active CatBoost 不失效/不标 stale** → train/serve 分布漂移 |
| R2-18 | prediction | bug | 全距离 ONNX 回退时 ML status 仍 `"active"` |
| R2-19 | web | bug | Dashboard 统计 **loading** 仍显示「数据积累中」 |
| R2-20 | web | bug | 模型状态面板硬编码「异常检测正常 / 近 12 周 / 高置信」 |

### P2 — 架构与体验债

| # | 域 | 问题 |
|---|----|------|
| R2-21 | arch | storage-sqlite 仅 lock/publisher/model-run；schema 仍在 parser → **已迁入 storage-sqlite**（parser re-export 兼容） |
| R2-22 | arch | `RaiReadStore` vs `RaiApplicationService` 双 SQL；service ~2400 行 → **主干关闭**：共享 fragments/repos + `RecomputePipeline` 拆分；data.ts 部分聚合 SQL 仍可继续下沉 |
| R2-23 | arch | contracts 仍含 `*Response`；OpenAPI/JSON Schema/DTO 手维三份 |
| R2-24 | arch | pure packages 已有 `tsconfig.pure.json`（上轮开放项基本关闭） |
| R2-25 | data | CLI `atomic: false`；审计 HR 仍同 source（与 recompute 跨源不一致） |
| R2-26 | web | 无 ErrorBoundary；任务状态 poll 失败静默 |
| R2-27 | prediction | completeAndActivate 信任 runner 指标/路径、不在服务边界重载 ONNX |
| R2-28 | prediction | 训练天气特征 vs 服务 null 默认 skew |
| R2-29 | domain | 双套 HRR 区间；TRIMP 常量双份；long easy → long_run 证据偏重 |

## 5. 各域摘要

### 5.1 架构

分层与依赖 DAG 健康；`tsconfig.pure.json` 已纳入 typecheck；`storage-sqlite` 有真实调用点但仍是薄抽取。主债：parser 兼 product DB、双 SQL、god service、DTO/OpenAPI 三份手维。

### 5.2 API

本地安全基线优秀（loopback、Origin/marker、sourceId、upload 不占 mutation 锁、replace 超时）。新主风险：`writerLease` 持有时长过长、busy_timeout 缺口、错误泄露、ZIP 实际字节、HTTP↔worker 非原子互斥。

### 5.3 数据管道

syncId、发布 rename-aside、GPX 分批、歧义 session 保留 id 等已扎实。新主风险：route 路径唯一、generation seed、inactive rematch、无 syncId payload 哈希。

### 5.4 领域算法

上轮 composite/EWMA/VDOT/maturity/interval 优先已关闭。新主风险：RPE 回退 confidence=0、统计 HR 伪造覆盖、wall-clock VDOT、effectiveWeights 归一。

### 5.5 Web

上轮假周环比与激活/轮询已关闭。新主风险：预测页假准备度/假全马/假模型芯片、详情页 backgroundRefresh 错 id、统计 loading 语义。

### 5.6 预测 / ML

训练/发布一致性与 Node golden 已加强；CLI/API ONNX 一致。新主风险：训练占写锁、重算后模型 stale、active 状态与真实推理脱节。

## 6. 建议落地顺序（仅规划）

1. **R2-1**：训练移出 `writerLease`，仅 claim/complete/fail 持锁。  
2. **R2-2–R2-4、R2-19–R2-20**：预测页与详情页产品诚信 + 路由数据一致性。  
3. **R2-5–R2-6、R2-11–R2-12**：导入 ID/route/session 稳定性。  
4. **R2-7–R2-10**：负荷 confidence、HR 覆盖、VDOT 时长、权重 renorm。  
5. **R2-13–R2-16**：busy_timeout、错误脱敏、ZIP 计量、HTTP writerLease。  
6. **R2-17–R2-18**：ML stale 与 status 语义。  
7. 架构债（R2-21–R2-23）分 PR，不阻塞正确性。

## 7. 限制

- 未跑 `npm test` / typecheck / E2E / 全量重导入。  
- 行号为静态阅读估计，修前需对照最新文件。  
- 严重度来自静态分析，非线上复现。

## 8. 工件

| 路径 | 说明 |
|------|------|
| `docs/PROJECT_AUDIT_2026-07-17_R2.md` | 本汇总 |
| `%TEMP%\grok-Administrator\grok-project-audit-692b39c7-architecture.md` | 架构 |
| `…-api.md` | API |
| `…-data.md` | 数据 |
| `…-domain.md` | 领域 |
| `…-web.md` | Web |
| `…-prediction.md` | 预测 |

---

## 9. 修复落地（同日实施）

已在代码中修复本轮 P0/P1 与可落地 P2（架构大拆分 #R2-21–23 仍作债务保留）：

| ID | 处理 |
|----|------|
| R2-1 | 预测训练仅在 claim/complete/fail 持 `writerLease` |
| R2-2/3/20 | 预测页证据改计数、全马占位、模型状态接 API |
| R2-4 | 训练详情关闭 backgroundRefresh + dataPath 校验 |
| R2-5/6/11/12 | route 路径冲突清理、seed 哨兵哈希、inactive rematch、无 syncId 稳定字段 |
| R2-7 | composite RPE/session 回退置信度 |
| R2-8 | 统计-only HR 不伪造全覆盖；仍可 eligible 并标 soft reason |
| R2-9 | 预测证据优先 active duration |
| R2-10 | effectiveWeights 按 availableWeight 归一 |
| R2-13–16 | busy_timeout、错误脱敏、ZIP 实际字节、override writerLease |
| R2-17/18 | 重算后清除 active CatBoost；全回退 → `inference_unavailable` |
| R2-19 | Dashboard 统计 loading 态 |
| 其它 | ErrorBoundary、long easy 不再强制 long_run、审计跨源 HR |

验证：`npm run typecheck` 通过；`npm test` **276/276** 通过。

---

*审查 ID：`692b39c7` · 修复已落地*
