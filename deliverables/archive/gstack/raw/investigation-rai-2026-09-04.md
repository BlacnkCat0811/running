# RAI「工程质量 / 架构 / 数据层」只读设计审查（排障手视角）

> 审查日期：2026-09-04（Asia/Shanghai）
> 审查人：gstack-investigator（软件工坊排障手）
> 模式：**只读审查，未修改任何文件**（铁律遵守）
> 基线：`main @ 6c61a9a`（工作树含未提交的 README/docs/deploy 例行改动，审查不涉及）
> 范围：monorepo 包边界、storage-sqlite 迁移与数据层、apps/api 与存储耦合、类型/运行时安全、错误处理与可观测性、技术债信号
> 方法：静态走读 + grep 取证。未执行全量测试（团队要求只做设计层审查）。

---

## 0. 结论先行（TL;DR）

**整体判断：🟡 中高 —— 工程纪律优秀（不可变 Run、原子切换、shadow gate、ZIP 防御、纯包门禁都到位），但"架构目标 vs 实现"仍有系统性落差，风险集中在四处：**

1. **存储语义分裂成三套**（业务 `rai.sqlite` / 运行时 `runtime.sqlite` / 文件 `mobile-goals.json`），备份、恢复、删除只覆盖业务库 → 回滚后会出现"旧数据 + 新目标/新任务状态"的不一致态；
2. **HTTP 路由层仍在直接持有 SQL 与业务决策**，其中「模型激活」在路由里重复实现了 storage 仓库已有方法 → 双实现漂移是**门禁绕过级风险**；
3. **写路径仍是巨型单体**（`storage database.ts` 2067 行同时持有 18 个迁移 + 连接 + 导入写 API；`apps/api/worker.ts` 1930 行装 3 个 worker；`recompute-pipeline.ts` 2155 行），与 `ARCHITECTURE_DEBT_MIGRATION.md` 中 P0/P1/P2 未完成状态吻合；
4. **时区被硬编码为 Asia/Shanghai 137 处、跨 17 个文件**（含纯包、SQL `+8 hours`、导入睡眠 canonicalization），与 schema 中按行存 `timezone_identifier` 的设计意图相冲突，是数据层长期一致性的最大隐患。

**强项（应保持）**：迁移 ledger 带 checksum 且 fail-closed；active 指针单例 + 视图过滤 `status='succeeded'`；导入走 staging 克隆 + rename 安装 + rollback；`recompute_validations` 影子 hash 对照；读仓库已大量下沉 storage；纯领域包无 node 内置依赖（tsconfig.pure 门禁实际生效）。

---

## 1. 发现清单（按严重度排序，结论先行）

### 🔴 R1　模型激活逻辑在 HTTP 路由中重复实现 storage 仓库，双实现漂移属门禁绕过级风险
- **位置**：`apps/api/src/server.ts:953-991`（`POST /v1/model-runs/:id/activate`）vs `packages/storage-sqlite/src/model-run-repository.ts:89-125`（`activateSucceeded()`）
- **证据**：仓库方法已完整实现「仅 succeeded 可激活 + 必须有 succeeded training_metric_run + 有 failed 验证门禁则拒绝 + 单例写入 + 清空 active_prediction_model」；路由内联 SQL 又抄了一遍同语义（`EXISTS(... failed)`、`has_succeeded_training_metrics`、`INSERT ... ON CONFLICT`、`DELETE FROM active_prediction_model`）。仓库用 `ORDER BY created_at DESC LIMIT 1` 判最新门禁，路由用无排序 `EXISTS`；仓库抛 `Error`，路由返回 409——两处语义已经出现细微不一致，后续任一改动都会产生"一处允许激活、另一处拒绝"的分叉。
- **问题**：业务不变量（谁可激活）被复制到 HTTP 层；绕过 `RaiApplicationService`/仓库直接写库；安全相关门禁的判断漂移难以被单测覆盖。
- **方案**：路由只做错误→HTTP 映射，激活动作统一收敛到 `SqliteModelRunRepository.activateSucceeded()`（或 application service 封装）；删除 `server.ts` 内联激活实现；为「repository 与路由行为一致」补一条行为锁测试。

### 🟠 R2　三套持久化（SQLite 业务库 / SQLite 运行时库 / JSON 文件）生命周期未协调，备份-恢复-删除语义不一致
- **位置**：`apps/api/src/maintenance.ts`（backup list 只筛 `*.sqlite` 且指向业务库 `databasePath`；`restoreBackup`/`deleteDatabase` 只处理业务库）vs `apps/api/src/runtime-state.ts:39`（`var/runtime.sqlite` 独立初始化/独立 quarantine）vs `apps/api/src/mobile-goals.ts:16,51-58`（`var/mobile-goals.json`）
- **证据**：`listBackups` 只收 `var/backups/*.sqlite`；`restoreBackup` 校验并替换的是 `databasePath` 一个文件。`mobile-goals.json` 存 raceTarget、weekPlan、lockedSession（含派生建议），`runtime.sqlite` 存 import sources/jobs——均不在备份集内。
- **问题**：(a) 恢复旧备份后，mobile 目标/锁定会话与恢复出的数据快照不对应，今日教练可能在旧 DB 上引用过期锁定建议；(b) 删除数据库不清 mobile-goals.json，用户以为已清空健康派生数据但目标文件残留（隐私语义不清）；(c) 导入幂等/增量依赖分布在业务库（generation/fingerprint）与运行时库（source sha/任务），跨库还原存在错位。
- **方案**：把「用户可写、不可从原始数据重建」的状态（mobile goals/lock）收进业务 SQLite 走同一迁移与备份，或将 runtime + goals 纳入统一备份 bundle（原子打包/解包）；至少为 tri-store 定义并文档化「恢复/删除后每份状态的语义与降级策略」（如读时校验 lock 与数据锚点一致性，失效即清除）。

### 🟠 R3　时区单一假设贯穿全部层（137 处 / 17 文件），与按行存 `timezone_identifier` 的 schema 意图冲突
- **位置**：`packages/health-export-parser/src/canonicalize-nights.ts:148`（`timezoneIdentifier = "Asia/Shanghai"` 默认）、`packages/training-load/src/index.ts:320`（纯包默认值）、`packages/storage-sqlite/src/read/trends-read-repository.ts`（SQL `date(mr.evaluated_at, '+8 hours')`）、`apps/api/src/data.ts` mobile 锚点、`apps/api/src/server.ts`、`apps/web/src/format.ts` 等
- **证据**：grep `Asia/Shanghai|+8 hours|+08:00` 在 packages/apps 共 137 处引用；`canonical_nights`/`canonical_hrv_days`/`daily_*` 都存 `timezone_identifier` 列，但消费方常以固定 +8 计算。
- **问题**：睡眠夜分组窗口（18:00–次日 14:00）、mobile "today/statistics/trends" 锚点、趋势 model-run 按天归类全部依赖上海时区；一旦用户异地/跨时区或数据含 DST 时区，日边界、周聚合、恢复基线都会系统性错位；同时 +8 被写死在 SQL 里（非参数化），无法随行级时区切换。
- **方案**：收敛为单一 App 时区策略（env `RAI_TIMEZONE`，缺省 Asia/Shanghai），在解析/服务边界显式传入；SQL 中的 `+8 hours` 改为按 `timezone_identifier` 关联或参数化偏移；为 UTC 边界、跨时区导入补黄金用例。

### 🟠 R4　写路径仍是巨型单体，ImportWriter/子服务拆分（债务方案 P0/P1/P4）未落地
- **位置**：`packages/storage-sqlite/src/database.ts`（2067 行：line 37–1296 为 18 个迁移、1298+ 为 `RaiDatabase`、1550+ 为导入写 API 与 generation seed）、`apps/api/src/worker.ts`（1930 行：`RecomputeWorker`/`ExternalPredictionModelTrainer`/`PredictionModelWorker`/`ImportWorker` + 内联 SQL）、`packages/application/src/services/recompute-pipeline.ts`（2155 行）
- **证据**：`service.ts` 已瘦身为 217 行门面，但 `ARCHITECTURE_DEBT_MIGRATION.md` P0a（migrations→storage）只完成一半（parser 已 re-export，但 schema+连接+写 API 仍挤在一个文件）；P1 ImportWriter、P4 子服务未执行；worker.ts 三个 worker 类共享一个文件。
- **问题**：单一文件同时承载 schema 唯一源、连接 PRAGMA 策略、批量导入写、generation 种子，任何导入写语义改动都会触碰迁移代码的上下文；worker 与 pipeline 的大函数难以独立单测与审阅。
- **方案**：按债务方案推进 `SqliteImportWriter` 抽取（parser 只留解析/canonical）；`RecomputePipeline` 拆为 feature/metric/ability 三段 service；`worker.ts` 按类拆文件；每步保持行为锁。

### 🟡 R5　移动端读路径 SQL 未下沉 storage（与 ARCHITECTURE 声明不符），且含被 canonical 取代的死亡代码
- **位置**：`apps/api/src/data.ts` `mobileToday/mobileStatistics/mobileTrends`（约 216–530 行内联 SQL）；`apps/api/src/mobile-read.ts`（280/335/431/480 行直接对 `DatabaseSync` 查询）；`apps/api/src/mobile-read.ts:424-497` `loadSleepWindow`/`loadMetricWindow`/`metricValues`
- **证据**：`ARCHITECTURE.md` §4.7 称 mobile 聚合"均走 storage 读 repository，API 层只做缓存与 DTO 组装"，但 `packages/storage-sqlite/src/read/` 下并无 mobile 读仓库，SQL 实际在 data.ts/mobile-read.ts 内联；且 `loadSleepWindow`/`loadMetricWindow` 全仓零调用（死亡代码），其算法直接读 `health_records` 原始 sleepAnalysis 自算"夜"（`start_at+6h`），与活路径 `SqliteRecoveryFactsReadRepository` + `canonical_nights`（v17 canonical 唯一事实源，见 `DATABASE_DESIGN.md` §3）是**两套睡眠口径**。
- **问题**：移动端聚合口径（睡眠、基线、窗口）存在原始记录直算与 canonical 派生两套实现；死亡代码若被误恢复会引入与 canonical 不一致的口径；SQL 三处散落（data.ts/mobile-read.ts/storage）增加修 bug 要改多处。
- **方案**：删除 `loadSleepWindow/loadMetricWindow/metricValues` 死代码；把移动聚合查询统一收进 `SqliteMobileReadRepository`（storage），API 只做 DTO 组装；在文档/架构图中同步修正"移动聚合已下沉"的表述。

### 🟡 R6　同一词汇在多处重复定义（session kind/race distance/stimulus/performance protocol），运行时 JSON Schema 与编译期 TS 无双向一致性保障
- **位置**：`packages/api-contracts/src/index.ts:451-458`（`MobileSessionKind`/`MobileRaceDistance`）、`apps/api/src/schemas.ts:88,98-106`（JSON schema enum）、`apps/api/src/mobile-goals.ts:17-25`（`SESSION_KINDS`/`RACE_DISTANCES`）、`apps/api/src/mobile-coach.ts:25-28`（quality/easy 集合）、`packages/contracts` 领域类型、DB `CHECK` 约束
- **证据**：同一会话类型集合至少存在于 5 处；`schema.enum` 与 TS union 各写各的，无推导关系，也没有断言测试比较二者。
- **问题**：请求入口以 JSON Schema（Ajv）为准、代码以 TS union 为准，二者漂移时要么合法值被误拒、要么 TS 自认为安全的枚举在运行时出现非法值；coach/持久化各自再 clamp 一次（mobile-goals.ts 的 `SESSION_KINDS.has`），形成多层冗余防线但无单一事实。
- **方案**：在 `packages/contracts`（或 api-contracts）定义 `as const` 数组作为唯一词表，TS union 由数组推导，`schemas.ts` 的 enum 由数组生成；补一条测试断言 `schema.enum` 与 TS 值集完全一致。

### 🟡 R7　HTTP 契约无响应 schema、openapi 手写三份，响应契约只受编译期保护
- **位置**：`apps/api/src/schemas.ts:400+`（手写 `openapiDocument`）、`apps/api/src/server.ts`（全部路由仅注册 `params/querystring/body` schema，无 `response` schema）、`packages/api-contracts/src/index.ts`
- **证据**：grep `response:` 无一处 Fastify response schema；`api-contracts` 中大量字段被放宽（`JobStatus = ... | string`、`HealthResponse.status = "ok" | string`、`ModelRunSummary.status: string`），使编译期保护弱化。
- **问题**：路由实际响应是否匹配声明 DTO 无任何运行时验证；openapi.json 与路由注册、DTO 三份手维（即 R2-23 已知债）会随路由增删漂移，web 端错误只能靠 E2E/人工发现。
- **方案**：从同一 schema 源生成 openapi 与请求/响应校验（响应至少对关键端点启用 `schema.response`）；收紧 `| string` 放宽；为响应 DTO 提供"黄金快照"测试。

### 🟡 R8　SQLite 行边界普遍 `as unknown as` 强制类型（159 处），类型安全在写路径最薄
- **位置**：`packages/application/src/services/recompute-pipeline.ts`（34 处）、`packages/storage-sqlite/src/database.ts`（20）、`prediction-model-service.ts`（13）、`recompute-job-repository.ts`（12）、`prediction-data.ts`（11）等，全仓 159 处
- **证据**：`database.prepare(...).get() as unknown as {...}` 模式在写/重算路径高密度出现；读仓库中 `JSON.parse(String(row.xxx)) as T` 亦无 schema 校验。
- **问题**：列更名/语义变化时这些强转静默返回 undefined/NaN，错误延迟到业务逻辑；`recovery-facts-read-repository.ts:52-55` 甚至将多行 SQL 聚合压成一行（可读性差且无法加注释）。
- **方案**：引入带列名校验的 `mapRow<T>` 助手（白名单键 + 类型化 getter），SQL 行→领域对象集中到 mapper 层；对 `as any`/`as unknown as` 设 eslint 门禁；保持"JSON 只在 contract 边界解析"。

### 🟡 R9　迁移 checksum 基于 `up.toString()`，任何对已应用迁移的编辑/格式化都会 fail-closed
- **位置**：`packages/storage-sqlite/src/database.ts:1282-1296`（`migrationChecksum` 对 `up.toString()` 做 sha256）与 `migrate()`（1414-1426 校验）
- **证据**：函数体源码参与 hash，重排空格、注释、提取常量都会改变 hash；v1 有 legacy 兼容路径（`legacyMigrationChecksum`），v11 以空迁移占位维持编号连续（939-945）。
- **问题**：安全取向正确（已应用迁移不可篡改），但缺"合法修订已发布迁移"的流程：开发者改一个 typo/注释即触发全线 DB 拒绝打开，只能靠手工改 ledger——对单用户本地优先产品是可用性摩擦；占位版本模式依赖"编号连续"，未来易被误用。
- **方案**：文档化"已发布迁移不可变，只能新增 vN+1"策略；把 hash 基准改为稳定化的 body 摘要（去空白/注释或对编译产物哈希）；提供 dry-run 迁移检查 CLI；避免再引入空占位版本。

### 🟡 R10　两个后台管线（live-DB 重算 vs staging 克隆 + rename 换库）无显式互锁，存在文件代际竞态窗口
- **位置**：`apps/api/src/worker.ts`（`RecomputeWorker.drain` 在 `databasePath` 直接 `RaiDatabase.open` + worker_thread 跑 job；`ImportWorker.run` 先备份→拷贝 staging→子进程导入/重算→`activateDatabase` rename 换库，1613-1700）
- **证据**：recompute 与 import 各自独立 `isRunning`/schedule；import 从 staging 克隆时点之后、swap 之前，recompute worker 仍可能在 live DB 上完成/入队 job；`preserveHistoricalState`（1435+）从 previous DB 拷贝 `recompute_jobs` 到 staging，说明两者状态需合并却无跨 worker 等待/锁。
- **问题**：swap 窗口内 live DB 上产生的新 model run/job 会随文件替换"消失"（staging 快照不含它们），而 runtime.sqlite 的 import source 已更新——需要明确"该窗口内的重算结果是否允许被导入结果覆盖"，否则存在 derived-run 指针悬挂或静默丢 job 风险。
- **方案**：给 import 的 activate 阶段加"recompute 静默"互锁（与 recomputeWorker/predictionWorker 串行化，或 import 开始即挂起其他 worker 直至 swap 完成）；对"swap 期间并发 job"补集成测试并文档化优先级（建议导入为准）。

### 🟡 R11　HTTP 路由与启动引导仍直接内联 SQL/存储决策，绕过 application/storage 边界
- **位置**：`apps/api/src/server.ts:298-304`（就绪 SQL）、`427-448`（diagnostics 内联 SQL）、`597`（session 存在检查）、`953-991`（激活，见 R1）、`440-460`（`checkTrainingZoneBackfill` 用内联 SQL 判算法版本并 enqueue）
- **证据**：`checkTrainingZoneBackfill` 在 API 进程内做"active feature schema vs metric algorithm 版本"兼容判断并自动排 full recompute/snapshot——这是一段业务治理规则，却写在 HTTP server 启动路径。
- **问题**：zone/backfill 兼容规则在 server 与 pipeline 双处维护；路由直接读写 DB 使"路由薄、服务厚、SQL 在 storage"的分层目标（ARCHITECTURE_DEBT_MIGRATION P2/P3）打了折扣，也最难单测。
- **方案**：将启动引导治理收敛为 application 的 `ensureZoneBackfillCompatibility()`（可注入 repo），server 只负责在空闲时调用；路由层只保留错误映射与 DTO 组装。

### 🟡 R12　高风险写编排缺少直接单测入口
- **位置**：`packages/application/src/services/recompute-pipeline.ts`（2155 行）vs 测试目录 `packages/application/test/`
- **证据**：grep `RecomputePipeline` 在全部 `*.test.ts` 中 0 命中；`service.test.ts`/`import-replay.test.ts` 通过门面间接覆盖了大部分主路径（含激活回滚、snapshot refresh 取消），但影子 hash 对照、checkpoint 前缀复用、并发 swap 等边界分支无直接、聚焦的测试文件。
- **问题**：最大、最贵、最易引入回归的模块只能靠间接覆盖，分支组合（shadow+incremental、snapshot 取消后半写状态）出现回归时定位成本高。
- **方案**：为 RecomputePipeline 建立直接单测（内存/临时 DB fixture），优先覆盖：shadow 校验 mismatch 拒绝、checkpoint 复用边界、swap 期间并发、快照半写取消。

### 🟢 R13　占位/哨兵类技术债（信号弱但值得记录）
- **位置**：`packages/storage-sqlite/src/database.ts:29-30` `SEED_CONTENT_HASH = "__seed_unknown__"`、`:939-945` v11 空迁移、`database.ts:1932-1936` seed 占位逻辑
- **问题**：哨兵字符串散落且依赖"首个真实 content hash 不等于哨兵"的隐含约定；v11 占位无 SQL 但占用了 ledger。
- **方案**：给 seed 迁移写入真实空状态指纹或用 `NULL` + 显式状态列取代哨兵；占位模式文档化并避免继续使用。

### 🟢 R14　`api-contracts` 整体 re-export `@rai/contracts`，HTTP/领域类型名义分层实为同构
- **位置**：`packages/api-contracts/src/index.ts` 顶部大段 `export type {...} from "@rai/contracts"`
- **证据**：api-contracts 把自己标记为"HTTP DTO/OpenAPI 契约"，却把 contracts 领域类型全部转出；web 仅依赖 api-contracts，因此可轻易拿到领域 canonical 类型而非 HTTP DTO。
- **问题**：分层防护只存在于约定而非结构；未来 web 直接消费领域类型会绕过 DTO 稳定面。
- **方案**：api-contracts 只导出 HTTP DTO 与少量共享枚举，领域类型由 web 按需经 api-contracts 白名单 re-export（或禁用 `export *`，用显式清单）。

### 🟢 R15　工程强项（勿在重构中丢失）
- 纯领域包零 Node 依赖且 `tsconfig.pure.json` 实际守门；
- 迁移 ledger checksum + fail-closed、恢复前完整性/外键检查 + before-restore 快照；
- 不可变 Run + 单例 active 指针 + active 视图 `status='succeeded'` 双保险；
- 导入 staging 克隆 + rename 安装 + 失败回滚 + `recompute_validations` 影子 hash 对照；
- `PRAGMA data_version` 读缓存失效、备份保留策略/空间预检、错误对象 ID 化、token 模式 + Host/Origin 防护。

---

## 2. 各审查重点小结

| 审查重点 | 结论 |
|---|---|
| 仓库/模块边界 | 🟢 依赖方向基本正确（web→api-contracts；纯包无 node）；残留：api-contracts 整体 re-export contracts（R14）、application 公共签名引用 parser 的 `RecomputePlan`、api 直依赖 parser/storage |
| 数据层设计 | 🟡 迁移/视图/active 指针设计稳健；主要缺口为 tri-store 生命周期（R2）、时区硬编码（R3）、写路径单文件（R4）、checksum 流程（R9） |
| API 与存储耦合 | 🔴 路由层仍内联 SQL/业务决策且与仓库双实现（R1/R11）；移动聚合 SQL 未下沉 + 死亡代码（R5） |
| 类型与运行时安全 | 🟡 词汇多处重复（R6）、无响应 schema/openapi 三份（R7）、159 处 `as unknown as`（R8） |
| 错误处理/可观测性 | 🟢 总体良好（错误对象化、导入失败不回切、worker 连续失败退避、任务状态落盘可恢复）；无重大设计缺口 |
| 技术债信号 | 🟡 巨型写文件、重复激活实现、死亡睡眠直算函数、占位 v11/哨兵、高风险模块无直接单测（R12） |

---

## 3. 建议处理顺序

1. **R1（激活双实现）**：收敛到仓库单实现 —— 安全相关，改动小；
2. **R2（tri-store 备份/恢复）**：先文档化语义 + 移动端 lock/goals 读时自愈，再考虑入库/打包 —— 数据一致性最高风险；
3. **R3（时区）**：建立单一时区配置与 SQL 参数化 + 边界测试 —— 越晚修越贵；
4. **R4/R11（写路径拆分与路由瘦身）**：按既有 ARCHITECTURE_DEBT_MIGRATION 继续 P0/P1/P2；
5. **R5/R6/R7/R8（移动 SQL 下沉、词表单源、响应 schema、行映射助手）**：类型与契约稳健性；
6. **R9/R10/R12/R13/R14**：流程与工程债，可排入常规迭代。

---

*本报告为只读审查；未修改任何文件。证据行号基于审查时工作树（`main @ 6c61a9a`）。*
