# RAI 全项目多智能体审查报告（第三轮 · R3）

> 日期：2026-07-17  
> 模式：只读 · 6 个并行审查子代理  
> 审查 ID：`86b12e7c`  
> 对照基线：`docs/PROJECT_AUDIT_2026-07-17_R2.md`（含 §9 同日修复声明）  
> 分域原稿：`%TEMP%\grok-Administrator\grok-project-audit-86b12e7c-*.md`  
> **未修改业务代码**

## 1. 方法

| 子代理 | 焦点 |
|--------|------|
| architecture | monorepo 分层、storage、contracts、RecomputePipeline 体量 |
| api | 安全、并发、ZIP、busy_timeout、错误脱敏 |
| data | parser、增量 ID、session rematch、route/GPX |
| domain | features / scoring / load / zones / physiology |
| web | 假指标、竞态、path 绑定、a11y |
| prediction | CatBoost/ONNX、激活门、train/serve |

产品范围以 `AGENTS.md` 为准（Web 桌面 ≥1024px + 本地 API）。

## 2. 总评

相对 R2 与 §9「同日已修复」声明：

- **领域（R2-7–10）、数据（R2-5/6/11/12）、Web 主路径（R2-2/3/4/19/20）、预测主路径（R2-1/17/18）多数仍成立。**
- **API 侧 R2 声明有明显水分**：`writerLease` 已整体拆除（R2-1 意图用短 DB 会话达成），但 **R2-15 ZIP 实际字节计量、R2-16 HTTP 写互斥并未落地**；R2-14 导入错误脱敏仍半开。
- 本轮焦点从「旧 bug 是否关掉」转为 **激活门完整性、导入/session 边角、客户端叙事诚信、并发互斥空洞**。

整体健康度仍高，但不宜再假设 R2 §9 的 API 项全部在代码中。

## 3. R2 修复核验总表

| ID | 域 | R3 结论 | 说明 |
|----|----|---------|------|
| R2-1 | api / prediction | **fixed（改设计）** | 无 `writerLease`；训练仅在 claim/complete/fail 短开库 |
| R2-2/3/20 | web | **fixed** | 证据计数、全马占位、ML 状态来自 API |
| R2-4 | web | **mostly fixed** | detail 有 path 校验；**series 无 dataPath 校验** |
| R2-5/6/11/12 | data | **fixed** | route 清理、seed 哨兵、inactive rematch、稳定 id |
| R2-7–10 | domain | **fixed** | 有残差：RPE 置信度 blend、stats-only 仍可 eligible |
| R2-13 | api | **fixed（主路径）** | `RaiDatabase` busy_timeout=5000；ad-hoc 打开仍缺 |
| R2-14 | api | **partial** | prediction fail 脱敏；**import job.error 仍原始 stderr** |
| R2-15 | api | **not fixed** | 仍只信 ZIP 声明 `uncompressedSize` |
| R2-16 | api | **not fixed** | 无共享写锁；仅 soft busy gate |
| R2-17 | prediction | **fixed（recompute 路径）** | 手动 activate ability 不清理 CatBoost |
| R2-18 | prediction | **fixed** | 全距离失败 → `inference_unavailable` |
| R2-19 | web | **fixed** | Dashboard 统计 loading/error |
| R2-21–23 | arch | **partial / open** | schema 已迁 storage；写路径 god pipeline；DTO 三份手维 |
| R2-24 | arch | **fixed** | pure packages + tsconfig.pure.json |

## 4. 优先问题清单（本轮）

### P0 — 建议优先

| # | 域 | 严重度 | 问题 |
|---|----|--------|------|
| R3-1 | api | bug | **ZIP size-lie 炸弹**：只累加声明 `uncompressedSize`，不计量实际写出字节（R2-15 未修） |
| R3-2 | prediction | bug | **`completeAndActivate` 可激活 Python 已 rejected 的模型**（缺 evaluation.status / bootstrap CI / walk-forward 强制） |
| R3-3 | web | bug | **训练详情「训练分析」编造「优秀/稳定」「心率控制良好」**；缺 HR 时仍标「良好」 |
| R3-4 | data | bug | **多匹配 session 只按 id 排序**，忽略 active 优先 → 可能让 inactive 赢过 active |

### P1 — 高价值

| # | 域 | 严重度 | 问题 |
|---|----|--------|------|
| R3-5 | api | bug | **import `job.error` 泄露 child stderr/路径**（R2-14 半开） |
| R3-6 | api | bug | **HTTP 写路径与 worker 无共享互斥**（R2-16）；override busy 不查 recompute |
| R3-7 | api | bug | **`beginReplace` 无限等待** read lease，无超时 |
| R3-8 | api | bug | **`POST /v1/imports/uploads` 整段占 mutation coordinator**（多 GB 上传阻塞其它写） |
| R3-9 | prediction | bug | **手动 `/v1/model-runs/:id/activate` 不清理 active CatBoost**（R2-17 覆盖不全） |
| R3-10 | prediction | bug | **R2-27 仍开**：激活信任 runner 路径/指标，无服务边界 ONNX 重载与 disk hash |
| R3-11 | web | bug | **`useRemote` path 切换首帧 stale**（详情闪「不存在」、列表/趋势短暂旧数据） |
| R3-12 | web | bug | **series 无 dataPath 校验**；**job 状态跨 workout id 泄漏** |
| R3-13 | data | bug | **workout 内容重写清空 route points**，强依赖后续 GPX；**path 大小写敏感 UNIQUE vs 不敏感 GPX 匹配** |
| R3-14 | data | bug | **`route_file_fingerprints` 无 FK**，route 删除后孤儿指纹 |
| R3-15 | domain | bug | **composite load 忽略 sourceConfidence / average-only 折扣**；RPE conf blend 后 0.39≠0.65 |
| R3-16 | domain | bug | **stats-only HR 仍可 full eligible + 高 CA conf**；无 HRR 的长距离仍 `long_run` |
| R3-17 | domain | bug | **速度单位硬编码 `km/hr`**，忽略 DB unit |

### P2 — 架构与体验债

| # | 域 | 问题 |
|---|----|------|
| R3-18 | arch | RecomputePipeline ~1880 LOC / ~90 prepares；ImportWriter 未拆；parser 仍写库 |
| R3-19 | arch | contracts `*Response` + api-contracts + hand OpenAPI 三份（R2-23） |
| R3-20 | arch | 只读打开绕过 `RaiDatabase` PRAGMA 策略 |
| R3-21 | prediction | 天气 train/serve skew；partial-distance 仍 `active`；历史 CatBoost 可 re-activate |
| R3-22 | domain | TRIMP 常量双份；仅 male 1.92；RPE 双公式 |
| R3-23 | web | GlobalTaskStatus poll 失败静默；假 prediction tabs；Settings `window.confirm` |
| R3-24 | api | ad-hoc `DatabaseSync` 无 busy_timeout；prediction `artifactPath` 暴露主机路径 |

## 5. 各域摘要

### 5.1 架构

依赖 DAG 健康：`packages/*` 不依赖 `apps/*`；Web 仅 `api-contracts`；pure packages 无 Node/SQLite。  
读路径双 SQL 大体关闭；写/重算仍是 god pipeline + application 内 prediction SQL。R2-21 partial、R2-22 partial、R2-23 open、R2-24 fixed。

### 5.2 API

本地安全基线仍优秀（loopback、Origin/Host、sourceId、ZIP 路径遍历/symlink）。  
R2 §9 API 声明需修正：**15/16 未修**；14 半修。新主风险：size-lie ZIP、mutation 锁占上传、beginReplace hang、HTTP↔worker 并发写。

### 5.3 数据管道

R2-5/6/11/12 代码仍在。新主风险：session 多匹配排序、route 清空/大小写、fingerprint 孤儿、无 syncId 含 duration 的 lineage 分叉。

### 5.4 领域算法

R2-7–10 成立。新主风险：load confidence 语义、RPE 双公式、stats-only eligible、无 HR long_run、速度 unit。

### 5.5 Web

预测页诚信与 Dashboard loading 保持。新主风险：详情分析假结论、useRemote stale 首帧、series path、job 跨 id。

### 5.6 预测 / ML

训练不占长写锁；recompute 清 CatBoost；全回退 status 正确。新主风险：**激活门弱于 Python reject**、ability activate 不失效 ML、服务边界不重载 ONNX。

## 6. 建议落地顺序（仅规划）

1. **R3-1 / R3-5 / R3-7 / R3-8**：ZIP 计量、import 错误脱敏、replace 超时、upload 解锁。  
2. **R3-2 / R3-9 / R3-10**：激活门对齐 Python accept + ability 切换清 CatBoost + ONNX 边界校验。  
3. **R3-3 / R3-11 / R3-12**：Web 产品诚信与 path/job 一致性。  
4. **R3-4 / R3-13 / R3-14**：session rematch 与 route/fingerprint 完整性。  
5. **R3-15–R3-17**：负荷置信度、eligible、速度 unit。  
6. 架构债 R3-18–20 分 PR，不阻塞正确性。

## 7. 限制

- 未跑 `npm test` / typecheck / E2E / 全量重导入 / 真 ZIP bomb。  
- 行号为静态阅读估计，修前需对照最新文件。  
- 严重度来自静态分析，非线上复现。  
- R2 §9 部分 API「已修复」与当前代码不符，以本轮核验为准。

## 8. 工件

| 路径 | 说明 |
|------|------|
| `docs/PROJECT_AUDIT_2026-07-17_R3.md` | 本汇总 |
| `%TEMP%\grok-Administrator\grok-project-audit-86b12e7c-architecture.md` | 架构 |
| `…-api.md` | API |
| `…-data.md` | 数据 |
| `…-domain.md` | 领域 |
| `…-web.md` | Web |
| `…-prediction.md` | 预测 |

---

---

## 9. 修复落地（同日实施 · 多智能体协作）

6 个修复子代理并行落地 R3 问题（审查 ID `86b12e7c`）：

| 批次 | 域 | 覆盖 |
|------|----|------|
| API | apps/api | R3-1,5,6,7,8,24 |
| Prediction | application + contracts | R3-2,9,10,21 |
| Web | apps/web | R3-3,11,12,23 |
| Data | parser + storage | R3-4,13,14 + 相关 |
| Domain | features/load/zones | R3-15,16,17,22 |
| Arch | storage openReadonly + 文档 | R3-20；R3-18/19 仍为债 |

### 验证

- `npm run typecheck` 通过  
- `npm test`：**285/285** 通过（含 `@rai/web`）

### 仍作债务保留

| ID | 说明 |
|----|------|
| R3-18 | RecomputePipeline god pipeline / ImportWriter 大拆分 |
| R3-19 | contracts / api-contracts / OpenAPI 三份手维（生成管线） |
| R3-21 部分 | 天气 train/serve 双采样、历史 CatBoost 与 ability fingerprint 硬绑定 |
| R3-22 部分 | 女性 TRIMP 系数待 profile sex 字段 |

*审查 ID：`86b12e7c` · 修复已落地（架构大拆分除外）*
