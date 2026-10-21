# Lane 2：领域包 / 数据与持久化 / 发布模型架构审查

- **基线**：`/Users/ta/running`，`git HEAD = 9db450f`（`docs(training-plan): 2026-10-20 发布记录`），审查对象是当前工作树。
- **方法**：逐行读源码（E1）；本地实跑只读命令与探针（E2，命令见 §4）；10-13 快照（`.archify/rai-audit-20261013-160439/AUDIT-REPORT.md`，对齐 `60678af`）只作为线索，**每条结论都回 HEAD 源码复核**。
- **覆盖**：`packages/contracts`、`api-contracts`、`storage-sqlite`、`application`、`health-export-parser`、13 个算法包，`crates/rai-data-worker`，`research/`（只审与 Node 的交接架构）；为回答"单一数据源"读了 `apps/api` 的持久化与发布代码（跨 lane 事实已标注）。
- **没做**：不跑全量测试；不碰 `var/`；不评模型准确率；不审 iOS 源码质量（只核对"同一规则是否在 iOS 有第二份实现"这一点）。
- 严重度沿用仓库惯例：P0 数据丢失/安全/不可用；P1 发布阻断或硬不变量被破；P2 用户可见错误或高概率结构性风险；P3 可维护性/文档。

## 0 结论摘要

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 | 0 | 未发现可复现的数据丢失/安全/不可用路径 |
| P1 | 0 | 未发现"有强制点、但强制点已被绕过"的硬不变量；见 §3 每条末尾的"升级条件" |
| P2 | 6 | D-01 补偿控制已成死代码；D-02 文档描述的主发布链路已不存在；D-03 三库只治理了一库；D-04 双发布实现；D-05 跨语言重复语义；D-06 库文件形式未文档化 |
| P3 | 10 | 见 §3.3 合并表 |

**总体判断**：领域包这一层是本次审查看到的**最强的一块**——16 包 / 31 条实测边与 4 条禁线全部成立，纯领域层（12 包）在真实意义上无 IO，恢复度/CA-TA/预测公式都收敛到了单一来源，跨语言接口用"同一 sha256 字面量 + 双方各自复算"固定住。真正的问题集中在**持久化的下半场**：schema 治理只覆盖主库（46 迁移、冻结 checksum、双门禁），控制库/runtime/epoch 三个库各有一套无门禁的建表方式；发布语义有两套实现（storage-sqlite 的 repository + transition gate，与 application 里 35 条手写 DML 的预测模型状态机）；以及 2026-10 那次"直连车道收口"把候选库/文件换库链路从运行路径删除后，**三份现行文档与两处代码注释仍在描述旧的发布模型**。

**最该先做的三件事**：
1. 给 CLI 导入的车道补回全库校验（或在文档里承认检测缺口），因为"结构探针可替代 quick_check"的两条前提已有一条失效（D-01，前提 1）。
2. 把控制库/runtime 库/epoch 库纳入迁移治理（至少"每个库一个版本表 + 一个门禁"），现在它们连"表清单"都没有（D-03）。
3. 修正 `docs/ARCHITECTURE.md` / `docs/DATA_PIPELINE.md` 的发布模型描述（D-02）——这一条成本最低、误导性最大。

## 1 实际架构（as-built）

### 1.1 包依赖图（实测边，非声明）

`node scripts/check-package-boundaries.mjs` 输出：**16 个包 / 31 条 src 边 / 4 条禁线，通过**（§4 命令 1）。我另用独立脚本复算（只数 `src/` 下的 `@rai/*` 静态+动态+require 导入），得到同样的 31 条包边 + 10 条 `apps/api -> packages` 边 = 41 条，与 `ALLOWED_EDGES` 逐条一致，**无一条未声明边、无一条僵尸白名单**。

分层形状（`→` 表示 import 方向）：

```
contracts ← (16 个包中 14 个吃它；只有 normalization 与它无边)
  ├─ api-contracts → contracts            ← apps/api 消费（73 处）
  ├─ 纯领域壳: durability / dynamics / model-eval / physiology / readiness
  │            prediction-inference / scoring / features → normalization / training-load ← readiness
  │            training-zones → training-load
  ├─ storage-sqlite → contracts, model-eval
  ├─ health-export-parser → contracts, storage-sqlite
  └─ application → 其余 13 个包（唯一的编排层）
```

三个非平凡形状值得记下：
- **`health-export-parser → storage-sqlite`**：解析包直接写事实库。所以它不是"解析器"，而是"导入写端"。`packages/health-export-parser/src/database.ts:1-10` 是一个 10 行兼容再导出，说明这条边曾被当作过渡手段，现在已是正式依赖。
- **`training-load → readiness`** 与 **`features → normalization`** 是仅有的两条"算法包 inter-package"边；`scoring` 只有 `contracts`——[`check-package-boundaries.mjs:105-110`] 的四条禁线（scoring 不得触达 readiness/storage-sqlite/application/model-eval）因此是**结构性成立**的，不是靠自觉。
- **`apps/api` 直连 16 处 `@rai/storage-sqlite`**，绕过 `@rai/application`；同时 `apps/api` 里还有第二个持久化栈（§1.3）。这是唯一"文档里分层、代码里穿透"的地方，但方向是 API→storage（消费层到存储层），不构成反向依赖。

### 1.2 纯领域层是否真的无 IO

`tsconfig.pure.json` 枚举 12 个包（不含 application / storage-sqlite / health-export-parser / prediction-inference），`types: []`、`lib: ["ES2023"]`，由 `package.json:38` 的 `typecheck` 与主 tsconfig 串联执行。我在 12 个包的 `src/` 里扫 `node:` / `process.` / `console.` / `fetch(` / `Date.now()` / `new Date()`：

- 零 `node:` 导入、零 `process`、零 `console`、零 `fetch`——**纯层真的纯**。
- 唯一命中是 3 处默认参数取环境时钟：`features/src/index.ts:484`、`features/src/legacy-v3/index.ts:466`（`computedAt = new Date().toISOString()`）、`model-eval/src/index.ts:762`（`generatedAt`）。这不是 IO，但它是**重放确定性**的一个洞：不传 `computedAt` 的调用会写进不同的时间戳。当前调用方都显式传值，所以是 P3 而非 P2。

被排除的 4 个包恰好都是有 IO 的：`prediction-inference` 顶部 `import { createHash } from "node:crypto"` + `readFile` + `onnxruntime-node`（`prediction-inference/src/index.ts:1-5`）。**结论：纯层边界是真实成立的，但它靠"加包时手工往 include 里枚举"来维持**——漏一行的后果是"新包静默不受约束"（这一点仓库 `.workbuddy/memory/2026-09-28.md:307` 已记录）。没有任何东西自动检查"哪些包被纳入纯层"。

### 1.3 进程与存储：文档说三库，实际四库 + 三套建表方式

| 库 | 路径 | schema 来源 | 版本机制 | 门禁 |
|---|---|---|---|---|
| 主库 | `var/rai.sqlite` | `storage-sqlite/src/database.ts` 注册表，46 迁移 | `schema_migrations` + **冻结 checksum 表** | 迁移冻结测试 + 表分类清单双向一致（pre-commit 触发） |
| 控制库 | `var/rai-control.sqlite` | `apps/api/src/mobile-goals.ts:1010-1075` 基础 DDL + `training-plan-store.ts:195` | `mobile_control_schema` 表，2 步，**无 checksum** | 仅 `apps/api/test/training-plan-migration.test.ts` 覆盖"追加顺序" |
| runtime | `var/runtime.sqlite` | `apps/api/src/runtime-state.ts:288-299` | **无版本表**，`CREATE TABLE IF NOT EXISTS` | 无 |
| epoch | `var/rai.sqlite.dataset-epoch.sqlite` | `apps/api/src/dataset-epoch.ts:15-23` | 单表单行，无版本 | 无 |

主库的迁移治理是同尺寸工程里少见的严格：46 条迁移（v1–v46）、`FROZEN_MIGRATION_CHECKSUMS`（`database.ts:1740-1789`）与执行通道解耦（运行时判定走冻结表，不依赖 tsx/esbuild 的转译形状），并配 `test/migration-policy.test.ts` 的两条断言（"每条迁移都有冻结值" + "冻结值仍等于转译产物"）。v1–v22 的内联迁移正文在 `database.ts:136-1673`，v23–v46 已抽取到 `v*-migration.ts`。

第四库的存在是我在核对 `dataset-epoch.ts` 时发现的：`writeDeletedDatasetEpoch` 写 `<db>.dataset-epoch.sqlite`，理由是"独立于可删除的事实库和 runtime.sqlite 的损坏恢复"。**`docs/ARCHITECTURE.md:52` 与 `docs/DATA_PIPELINE.md` 只写了三个库**，`grep dataset-epoch docs/*.md` 零命中。

### 1.4 数据流：文档里是四级发布，代码里是"两条直连车道 + 硬失败"

`docs/ARCHITECTURE.md:11-16` 与 `docs/DATA_PIPELINE.md:13` 的主线是：**在线 backup 生成私有候选库 → TS/Rust 在候选库写 → 校验/generation/锁 → 原子文件换库 → 主库**。

HEAD 的实际运行路径是（`apps/api/src/import-worker.ts:690-760`）：
1. **data-only 快通路**（`data-only-import.ts`，入口判据 = 载荷形状 + 非评分类型白名单）；
2. 拒收 ⇒ **direct-sync 统一接收器**（`direct-sync-ingest.ts`，事实+路线+账本+回执+分析任务登记**同一主库事务**）；
3. 两条都拒 ⇒ **抛 `ImportLaneRefusal`，显式失败**（稳定码），**不回退候选链路**。

原文（`import-worker.ts:751-760`）："S3.3：旧候选链路（整库备份 → 暂存副本 → CLI 导入 → 重算 → 文件换库）的**调用链已删除**。保留的方法（createCurrentBackup / activateDatabase / prepareAuditReports / …）只服务阶段 5 的隔离退役；运行期不再有任何路径到达它们。"

实测确认：`publishDatabaseFile`（文件换库原语）在 API 侧零调用，唯一调用点是 `health-export-parser/src/cli.ts:214`；`activateDatabase`（`import-worker.ts:1876`）零调用方。

**所以现在有两套导入语义并存**：API = "就地增量写主库 + 同事务登记分析"；CLI（`npm run data:import`，README:27 仍列为正式入口）= "候选库 + 文件换库"。同一条健康数据走哪条路，取决于从哪个入口进来。

### 1.5 发布与一致性：强制点清单（有强制点 vs 靠流程）

| 不变量 | 强制点 | 结论 |
|---|---|---|
| 单写者 | `publication-lock.ts` 文件锁 + PID 身份；API 全生命周期持有（`server.ts:188`），CLI 亦取同一锁 | **强制**，且"无法证明 owner 已死就不回收"（fail-closed） |
| 直连车道不得写派生/发布表 | `INGEST_TABLE_DISPOSITIONS`（`direct-sync-ingest.ts:176`）白名单 + 运行期守卫；pre-commit 跑"迁移产物↔清单"双向一致（临时库，不是 grep） | **强制**，且我实测门禁路径正确（`.githooks/pre-commit:107-126`） |
| 直连车道恒为增量（禁止快照语义） | 返回类型写死 `{preserveAbsent: true}`（`direct-sync-plan.ts:78-85`）+ 运行期字段拦截 `assertDirectSyncRequestShape` | **强制**（类型"唯一可能值"+运行期兜底） |
| 直连车道禁止 备份/整库 copy/quick_check/换库 | `contracts/src/direct-sync.ts:191-289` 的 `PROHIBITED_DIRECT_SYNC_OPERATIONS`，每条同时用 worker 方法名 / db-task op / 子命令 / stage 名 / **进程内 store 方法** / 源码标识符多通道检测，并要求显式声明"在本车道上恒为 0 的守卫"（`vacuousOnDirectLane`） | **强制**，设计质量高 |
| Rust 只许写隔离的导入库 | 64 位十六进制一次性 permit 存在导入库 `import_manifest` 里 + 目标文件名必须匹配 `.importing.<uuid>` + 源库只读打开（`crates/rai-data-worker/src/main.rs:494-530`） | **强制**，三重 |
| 主库迁移冻结 | 冻结 checksum 表 + 两条测试断言 | **强制** |
| V2 模型发布要过 transition gate | `evaluateModelTransitionGateV2`（`model-transition-gate.ts:202`），调用点在 `recompute-pipeline.ts:639`，三态 `passed/failed/not_evaluable`，"不可评估不是通过" | **强制**（V2 路径） |
| 预测模型发布要过 gate | `prediction-model-service.activate()` 自写三段判据（status=succeeded / 兼容性 / 区间校准），**没有 transition gate**，也没有 release bundle | **半强制**：判据存在，但与 V2 不是同一套，见 D-04 |
| 模型工件保留（不得被清理后"复活"指针） | `pruneSupersededModelRuns`（`database.ts:3900`）保护 active + 所有 release bundle + keepRecent=2 + 沿 lineage 上溯 | **强制**，且在无 active 时直接 throw（fail-closed） |
| ONNX 工件 ↔ 特征契约 | `PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH` 字面量在 TS 与 Python **各存一份并各自复算**；artifact load 时比对（`prediction-inference/src/index.ts:125`） | **强制**（见 §2.5） |
| datasetEpoch 变更后不得复用旧游标 | epoch 在 `import_manifest` 里，删库时落 `<db>.dataset-epoch.sqlite`；iOS 侧 scope 三要素 `serverId/athleteId/datasetEpoch` 进 schema 校验（`schemas.ts:19-21`） | **强制**（写入侧）；读侧靠 scope 比较 |
| 主库/控制库/工件同边界备份 | **无强制点** —— API 运行期的自动备份随候选链路一起消失 | **靠流程**（D-02 的连带后果） |

## 2 架构评估（按 BRIEF §2 的七个维度）

### 2.1 结构与边界
依赖方向正确、无环、无反向依赖（`packages` 不 import `apps`，由检查器 A 类判据守）。分层在"包"这一级是可信的。真正的边界侵蚀在包**内部**：`@rai/application` 有 230 处 `prepare()/exec()`、18 个文件直接发 SQL（§2.2），把 storage-sqlite 的 repository 层架空成"可选风格"。

### 2.2 职责与单一数据源
**做得好的**（有证据的单一来源）：
- 恢复度：`readiness/src/index.ts:14-30` 是唯一定义处；`apps/api/src/mobile-coach.ts:208-211` 只做 `export const RECOVERY_*=READINESS_*` 的再导出，**没有第二份数字**。`application` 侧 4 个文件、`apps/api` 侧 2 个文件都从该包取值。
- 恢复规则不再进 Fitness：`scoring` 只有 `contracts` 一条边，禁线成立。
- CA/TA、剂量政策、计划状态：CA/TA 只在 `scoring`；计划状态机收敛到 `apps/api/src/training-plan-store.ts` + `plan-*.ts`（跨 lane，待 Lead 合并）。
- iOS：`grep` Swift 源码，公式级重复只有 `APIModels.swift` / `NativeFormat.swift` 两处 DTO 映射，没有第二套评分核心。

**做得不好 / 有分叉的**：
- 同一份"模型发布"语义有两套实现（D-04）：`storage-sqlite` 的 `model-run-repository` + `model-release-repository` + `model-transition-gate`（V2），与 `application/src/prediction-model-service.ts` 里 35 条手写 DML 驱动的 `prediction_model_runs` 状态机 + `active_prediction_model` 指针交换（`:758-837`）。第二套没有 release bundle、没有 transition gate。
- "变更账本 + 墓碑"语义在 TS 和 Rust 各一份（D-05）。

### 2.3 一致性与并发
读快照/指针读、写事务边界是清楚的：所有写状态机都 `BEGIN IMMEDIATE`，跨进程有独占锁，Rust 只写隔离库。失败语义整体是**失败关闭**（pending migration 拒绝打开、无 active run 拒绝 prune、通道填未知表拒绝整条车道、无法证明锁 owner 已死就拒绝回收）。**唯一依赖调用方自觉的是"增量 payload 不得被当完整快照"**，而这一点已经被类型系统钉死，属于本轮见到的最高质量的强制点。

### 2.4 故障隔离与可伸缩性
单进程 + 单写者 + 单 SQLite 文件：锁粒度是整库（`publication-lock`），所以 CLI 与 API 互斥；直连车道把"备份/整库校验/文件换库"从热路径移走，单批成本从"两次全库 quick_check（占 71.5–76.9%）"降到事务内写入——这是本轮看到的**最大规模收益**。背压依赖 `maxPending` / 队列 `attempts` / 批上界（8 MiB XML / 5000 记录 / 64 MiB 路线），超限**显式拒绝而不是分片**（`direct-sync-ingest.ts:65-78` 写明分片计划未实现）。

### 2.5 可演进性
- **契约版本化**：`contracts/src/index.ts` 有 21 个 `*_VERSION` / `*_HASH` 常量（FEATURE_SCHEMA、TRAINING_ZONE_CONFIG、READINESS_RULE_SET、MODEL_LINEAGE_SCHEMA、CATBOOST_PREDICTION_MODEL_VERSION …），策略版本集中在一个文件里，是好事；代价是这个文件 2456 行、14 个包从同一个 barrel 取值，任何形状改动都是全仓编译面。
- **迁移策略**：主库可长期维持（冻结 + 双门禁 + 抽取到 v*-migration.ts 的路径已在用）。但**新增一条迁移必须改 `database.ts` 三处**（内联/注册表/冻结表），且 v1–v22 的 1,538 行不可变正文还留在文件里 ⇒ 这个 4078 行的文件**永远无法拆分**。这是结构性的，不是风格问题。
- **跨语言版本化**：ONNX 特征契约用"双方各存一个 sha256 字面量 + 各自复算"固定。我实跑核对：Python `feature_schema_sha256()` = `462e2133…6aa7`，与 `packages/contracts/src/index.ts:1414` 字面量、`research/tests/test_contract.py:126` 断言值三者一致；TS 侧自洽性由 `application/test/prediction-feature-schema.test.ts:31-35` 用 `canonicalJson` 复算保证（我实跑该文件：2 passed）。**这是"没有共享代码也能有强制契约"的正确做法**。

### 2.6 质量系统
门禁密度很高且多数真的在跑（pre-commit 里有 blob 上限、typecheck、文档链接、文档行号、npm 脚本可移植性、iOS 结构门禁、迁移冻结、表分类清单、验收矩阵、计划定向回归、唯一写者结构门禁、包边界）。包边界的 `--self-test` 我实跑 8/8 通过（含单引号/动态 import/require/.mts/跨层/声明未用六类突变）。**薄弱点在下半场**：控制库与 runtime 库的 schema 没有任何门禁；`tsconfig.pure.json` 的包清单靠手工枚举且无检查。

### 2.7 安全与运维边界
本 lane 只碰到与自己相关的部分：Rust permit 三重门、ZIP 路径校验（`health-export-parser` 侧）、`prediction-inference` 的 artifact 哈希校验。**运维侧的风险是 D-01/D-02 的连带后果**：API 运行期不再产生任何自动备份，"备份归服务器运维"成为唯一保障——这属于运维 lane，但根因在我这里（发布模型变更未同步到文档与补偿控制）。

## 3 发现详情

### D-01 ｜P2 ｜E1+E2 ｜结构探针的补偿控制已成死代码（CLI 车道）
- **位置**：`packages/storage-sqlite/src/database-structure-probe.ts:34-40`（替代 quick_check 的两条前提）、`packages/health-export-parser/src/cli.ts:230-236`（引用前提 1）、`apps/api/src/import-worker.ts:1876`（`activateDatabase`，零调用方）。
- **机制**：探针文档明确"只在**同时满足** ① 紧邻别处仍有 `quick_check` 兜底（例如 `import-worker.ts` 发布后的那一次）、② 被检查文件是本进程刚写的，才可以替代全库 `quick_check`"；它也诚实记录了检出能力降级（单页/多页内 64 字节翻转 **漏检**）。但 HEAD 上 `activateDatabase` 属于已删除的候选链路，**运行期无任何路径到达**，而探针仍在 CLI 的车道发布前使用 ⇒ **前提 1 不再成立**（功能上的全库校验没有别处兜底），只剩前提 2。
- **影响**：CLI 导入（README:27 的正式入口之一）在"页内静默篡改但页数/schema 完好"的损坏下会把损坏库安装成主库；被替换的原库留在 `<target>.replaced.<uuid>`，可人工回滚，所以不是不可恢复。概率低、影响高、检测手段已被自己声明为缺口。
- **建议**：CLI 车道的发布前恢复一次 `PRAGMA quick_check`（CLI 不是热路径，成本可接受）；或者把探针文档的前提 1 改成"当前无兜底，风险自担"并在 `docs/OPERATIONS.md` 记一条运维检查。
- **升级为 P1 的条件**：若确认 CLI 导入在生产中是日常主路径（而非一次性引导），或存在"导入后立即删除 `.replaced.*`"的清理策略。

### D-02 ｜P2 ｜E1 ｜文档描述的发布模型已不存在；API 不再有自动备份
- **位置**：`docs/ARCHITECTURE.md:11-16`（候选 SQLite + 原子发布 + 主 SQLite）、`:60`（"SQLite staging 候选必须通过完整性、数据代次与模型 gate 才可切换"）、`docs/DATA_PIPELINE.md:13`（在线 backup 生成候选库）、`:74-76`（数据库文件发布 vs 模型 bundle 发布）、`:6-7`（"2026-10-12 目标改造（设计，未上线）"）；反证：`apps/api/src/import-worker.ts:751-760`。
- **机制**：直连收口后，候选库/文件换库的调用链已从 API 删除，两条直连车道都不合格时是**硬失败**（`ImportLaneRefusal`），而不是回退。文档仍把候选库写成主发布路径，`DATA_PIPELINE.md:6` 更把已经上线的直连同步写成"设计，未上线"。
- **影响**：这是"文档承诺 ≠ 实现"的典型。按文档推理会得到两个错误结论：① 认为导入失败不会影响 incumbent（实际是"不写就失败"，没有候选兜底）；② 认为 API 运行期有备份点（实际没有）。`database-structure-probe` 与 `cli.ts:232` 的代码注释也复用了同一个失效前提（D-01）。
- **建议**：`ARCHITECTURE.md` 发布段改成"两条直连车道 + 硬失败 + CLI 仍走候选库"；`DATA_PIPELINE.md:6-7` 删掉"未上线"；§1/§7 区分 API 车道与 CLI 车道。此项无需改代码，成本最低、收益最高。

### D-03 ｜P2 ｜E1 ｜三库（实为四库）只治理了一库
- **位置**：控制库 `apps/api/src/mobile-goals.ts:1141-1175`（`mobile_control_schema`，2 步，无 checksum）+ `training-plan-store.ts:195`（基础 DDL 在另一个文件）；runtime 库 `apps/api/src/runtime-state.ts:288-299`（`CREATE TABLE IF NOT EXISTS`，无版本表）；epoch 库 `apps/api/src/dataset-epoch.ts:15-23`。
- **机制**：主库有 46 迁移 + 冻结 checksum + pre-commit 门禁；控制库/runtime/epoch 用"当前全量 DDL + 追加式 ALTER"自管，**没有冻结、没有 fresh-vs-migrated 等价断言、不在任何迁移门禁的触发面里**（`.githooks/pre-commit:94-104` 只对 `packages/storage-sqlite/` 触发迁移冻结测试）。控制库的迁移正文（`migratePlanPushIdentity`）一旦被改写，已应用过的库保持旧形状、新库走新形状，**没有任何机制能发现两者分叉**；它保存的是"发布结果、计划历史、回执"（`:1136-1141` 自己声明）。
- **影响**：不是当前可见的 bug，而是"三库三套治理"的长期成本：加一列要判断改哪个文件、哪个库、有没有门禁；恢复备份/跨机器迁移时形状可能不同。`training-plan-migration.test.ts:222-278` 覆盖了"版本 2 追加在版本 1 之后 + 老行仍可读"，但**没有**"全新建库 = v1→v2 迁移后"的等价断言。
- **建议**：三条最小改动：① 给控制库迁移加"每个版本一个冻结 checksum"（复用主库模式），② 加一条 fresh-vs-migrated 的 schema 快照等价断言，③ 把 `apps/api/src/mobile-goals.ts`、`training-plan-store.ts`、`runtime-state.ts`、`dataset-epoch.ts` 加进迁移门禁触发面。
- **升级为 P1 的条件**：若存在"线上库从备份恢复到半迁移状态"的实际路径且未做幂等（目前每个 step 是 `IF NOT EXISTS`/`PRAGMA table_info` 守卫，看起来幂等，所以我判 P2）。

### D-04 ｜P2 ｜E1 ｜模型/预测发布有两套实现，一套有 gate，一套是手写 DML
- **位置**：V2 路径：`packages/storage-sqlite/src/model-release-repository.ts`、`model-run-repository.ts:235`（legacy gate）、`model-transition-gate.ts:202`（V2 gate）、调用点 `packages/application/src/services/recompute-pipeline.ts:578/639`。预测路径：`packages/application/src/prediction-model-service.ts:378-837`（35 条 `INSERT/UPDATE`；激活 `activate()` 在 `:805-816`，指针交换 `active_prediction_model` 在 `:830-838`）。
- **机制**：判据不在同一处——V2 走"三态 transition gate + release bundle + repository 事务"；预测模型走 `activate()` 里的三段自写判据（status / compatibility / `intervalActivationReasons`）+ `validateArtifactBoundary`。两者都在 `BEGIN IMMEDIATE` 里、都持有同一把发布锁，所以**没有发现可绕过的写入路径**；但"什么样的模型允许被激活"这条业务规则有**两份**代码，且预测那份没有可审计的 bundle（只有 `prediction_model_events`）。
- **影响**：演进成本。加一条发布不变量（例如"必须记录评估 cohort"）要改两处、想两遍；第二套没有 `not_evaluable` 这个第三态，失败语义比 V2 弱。
- **建议**：把预测模型的激活判据抽成 `storage-sqlite` 里的第二个 gate（不需要合并成同一个函数，但要在同一层、同一三态语义），DML 收进 repository。
- **升级为 P1 的条件**：若预测 DML 与 V2 的 pointer 更新能在同一事务里被混用（目前两者操作不同表、不同流程，未发现混用）。

### D-05 ｜P2 ｜E1 ｜"变更账本 + 墓碑"语义 TS/Rust 各一份，靠等价测试守
- **位置**：`crates/rai-data-worker/src/main.rs:530-560`（`import_entity_generations` / `import_entity_changes` / `health_records` upsert，注释 `:538-541` 记录了一次真实漂移："A stale Rust worker left these NULL and the TS↔Rust import-equivalence test caught it"）；TS 对应实现 `apps/api/src/mobile-goals.ts` / `packages/health-export-parser/src/native-record-writer.ts`。
- **机制**：Rust 不共享 TS 代码，重写了"before 侧 previous start/end/type"的历史语义；合同不是共享类型，而是**等价性测试**。`previous_type` 那次漂移正是这类合同最典型的失效形态（编译过、测试绿，语义错）。
- **影响**：每次改账本语义都要"改两处 + 想起跑等价测试"。测试若被跳过（无 Rust 工具链的机器），漂移就静默。
- **建议**：把等价测试的跳过语义显式化（跳过必须报"未验证"，不能当通过——仓库对 iOS 已用 `NO_IOS_SOURCE_CHECKED` + 认账闸门解决同类问题，可套用）；长期可让 Rust 只写 canonical 行、账本由 TS 回填（代价是一次额外扫描，需实测）。

### D-06 ｜P2 ｜E1 ｜第四个库文件完全未文档化
- **位置**：`apps/api/src/dataset-epoch.ts:16`（`${databasePath}.dataset-epoch.sqlite`）、`:25-35`（读回退链）。
- **机制/影响**：运维按 `docs/DATA_PIPELINE.md:76`「SQLite backup、runtime/control 数据库和工件需按同一维护边界备份」执行时会**漏掉这个文件**；漏掉后的行为是"删库/恢复后 epoch 退回 configuredEpoch"（`:25-35`），即缓存/游标可能复用旧数据集的 epoch——正是该文件存在的目的被绕过。因为 `readDeletedDatasetEpoch` 在文件缺失时**静默返回 configuredEpoch**，这是失败开放的一处（有意的，为了损坏恢复能启动）。
- **建议**：文档补第四个文件；或在 backup/restore 脚本里显式包含 `*.dataset-epoch.sqlite`（属于运维 lane，待 Lead 合并）。

### 3.3 P3 合并表

| # | 位置 | 机制 | 影响 |
|---|---|---|---|
| P3-01 | `packages/application/src/services/recompute-pipeline.ts`（4405 行、约 104 个方法） | 装配/读库/特征/评分/负荷/分区/预测/发布/prune 全在一个类里 | 改动成本高、无法按域拆分；建议先抽 3 个"读"段（`loadSessions`/`loadRecordSeries`/`loadPersonalRecovery`） |
| P3-02 | `packages/storage-sqlite/src/database.ts:136-1673` | v1–v22 内联迁移正文占文件 38%（1,538 行），不可变 | 该文件永远无法拆分；新迁移仍需改同一文件三处 |
| P3-03 | `packages/health-export-parser/src/database.ts:1-10` | 10 行兼容再导出，保留旧导入路径 | 两个 import 路径做同一件事；建议删或标 deprecated |
| P3-04 | `apps/api/src/direct-sync-plan.ts:14` | 注释称 `dataOnlyFastPath=false` 会"退回旧候选链路"，实际 `:50` 只是拒收快通路 | 注释与代码语义不一致（D-02 的局部复发） |
| P3-05 | `apps/api/src/runtime-state.ts:288-299` | runtime 表无版本表 | 与 D-03 同源，单列便于定位 |
| P3-06 | `packages/features/src/index.ts:484`、`features/legacy-v3/index.ts:466`、`model-eval/src/index.ts:762` | 纯层里唯一的时钟默认值 | 重放确定性依赖调用方显式传参 |
| P3-07 | `packages/application/test/prediction-feature-schema.test.ts:19-27` | 测试内重实现 `canonicalJson`，生产有 `semanticHash` | 两套规范化实现，非 ASCII/转义规则需同步 |
| P3-08 | `packages/application/src/prediction-report.ts:653-656`、`prediction-inference/src/index.ts:125` | 工件哈希不符 ⇒ `inference_unavailable` 并回退公式预测 | 失败开放但显式标注（`machineLearning.status`），属可接受设计；建议在 `/v1/diagnostics` 单列计数 |
| P3-09 | `packages/contracts/src/index.ts`（2456 行 / 201 导出） | 单 barrel，14 个包 + apps/api 全量取值 | 形状改动波及全仓；api-contracts 已用"再导出+重命名"隔离（27 个本地类型与 contracts **零重名**，这点是对的） |
| P3-10 | `research/rai_ml/contract.py:12-50` vs `contracts/src/index.ts:1376-1403` | 特征名单两份，靠 hash 字面量钉死 | 当前一致（E2 已验证）；新增特征必须同时改两处，无生成器 |

## 4 量化指标

| 指标 | 值 | 命令/来源 |
|---|---|---|
| 包数量 / 包间 src 边 / 禁线 | 16 / 31 / 4，通过 | `node scripts/check-package-boundaries.mjs` |
| 边界检查突变自测 | 8/8 通过 | `node scripts/check-package-boundaries.mjs --self-test` |
| 独立复算的 import 边 | 41（31 包内 + 10 `apps/api→packages`） | 自写脚本扫 `src/**` 的 `@rai/*`（静态/动态/require） |
| 纯领域层包数 | 12（排除 application/storage-sqlite/health-export-parser/prediction-inference） | `tsconfig.pure.json:7-20` |
| 纯层 IO 命中 | 0 个 `node:`/`process`/`console`/`fetch`；3 处时钟默认值 | grep 12 个包 `src/` |
| `packages/*` LOC | 88,176（16 包，含测试）；`application` 26,181、`storage-sqlite` 24,736、`health-export-parser` 13,485 | `git ls-files packages \| xargs wc -l` |
| 最大文件 | `recompute-pipeline.ts` 4,405 / `database.ts` 4,078 / `contracts/index.ts` 2,456 / `recompute-job-repository.ts` 1,657 | 同上 |
| god file 形状 | `RaiDatabase` 1 类 60 方法 + 8 个预编译语句字段；`RecomputePipeline` 约 104 方法 | grep |
| migration | 46 条（v1–v22 内联，v23–v46 抽取）+ 46 条冻结 checksum | `database.ts:136-1697`、`:1740-1789` |
| 建表语句总数 | 75 处 `CREATE TABLE`（跨迁移与三个非主库） | grep |
| application 层 SQL | 18 文件 / 230 处 `prepare()/exec()` / 35 条 DML | grep |
| storage-sqlite SQL | 417 处 `prepare()`（其中 `database.ts` 149） | grep |
| 版本/哈希常量 | `contracts` 21 个 `*_VERSION`/`*_HASH` | grep |
| 测试文件 | `packages/*/test` 162 + `apps/api/test` 122 | `git ls-files` |
| Rust 执行器 | 单文件 794 行 | `wc -l crates/rai-data-worker/src/main.rs` |
| 仓库规模 | 1,115 个已跟踪文件 | `git ls-files \| wc -l` |

## 5 建议与优先级

**第一批（本周，零风险，只改文档/注释）**
1. D-02：改写 `ARCHITECTURE.md` 发布段 + `DATA_PIPELINE.md:6-7/§1/§7`，明确"API = 两条直连车道 + 硬失败；CLI = 候选库 + 文件换库"。
2. D-06：补第四个库文件到 `DATA_PIPELINE.md:76` 的维护边界。
3. P3-04：修正 `direct-sync-plan.ts:14` 的失效注释。

**第二批（结构，需要设计决定）**
4. D-01：CLI 车道恢复一次 `quick_check`（或显式认账）。风险：单次 +12 s（冷态 506 MB 实测），只影响 CLI，不影响 API 热路径。
5. D-03：控制库/runtime/epoch 纳入迁移治理。先做成本最低的两件：迁移门禁触发面加这 4 个文件；控制库加冻结 checksum。不变量：新建库与迁移后库必须形状等价。
6. D-04：预测模型激活判据下沉到 storage-sqlite 的第二个 gate，DML 收进 repository。不变量：两条模型发布路径的"允许激活"判据必须在同一层、同一三态语义。
7. D-05：Rust 等价测试的跳过语义显式化（照 `NO_IOS_SOURCE_CHECKED` 的认账闸门做）。

**第三批（演进成本，需排期）**
8. P3-01/P3-02：`recompute-pipeline.ts` 先按"读 / 算 / 写发布"切三段；`database.ts` 把冻结表与注册表搬出（迁移正文留在原处以免动 checksum）——**注意**：运行时判定走 `FROZEN_MIGRATION_CHECKSUMS[version]`，搬表本身不改值，但必须重跑 `migration-policy.test.ts` 确认冻结值仍等于转译产物。
9. 加一条自动检查："`tsconfig.pure.json` 的 include 集合 == 预期纯包集合"，防止新增包漏纳。

**不建议做的**：不要把 12 个纯包合并、不要为统一发布路径把 V2 与预测模型强行合并成一个状态机（两者的三态语义与工件形态不同，合并会放大而非缩小复杂度）。

## 6 未验证边界

- **未跑全量测试**（BRIEF 要求由 Lead 统一跑）。本 lane 只实跑了：包边界检查、包边界突变自测、`application/test/prediction-feature-schema.test.ts`（2 passed）、Python `feature_schema_sha256()` 复算。
- **未在真实库上验证**：所有持久化结论来自源码与公开测试，没有对 `var/` 下真实库做任何读写；"46 迁移与线上库一致"这一点无本机证据。
- **控制库迁移的幂等性**是读代码推断（`IF NOT EXISTS` + `PRAGMA table_info` 守卫），未用合成库实跑"半迁移后重启"。
- **iOS 侧**只做了关键词级核对（未读 Swift 实现细节），"iOS 无第二套评分核心"的结论强度是 E1-weak；iOS 的一致性属于另一个 lane。
- **Rust 与 TS 的等价性**只读了代码与注释，没有跑 `native-worker` 测试（需要 Rust 工具链与 `cargo`，本机未验证其可用性）。
- **`research/` 只审了交接面**（`contract.py` 的特征契约 + hash 字面量 + artifact manifest 字段），未审训练/评估流程正确性，也未审模型准确率。
- **跨 lane 待合并**：D-01/D-06 的运维后果（备份边界、CLI 导入的使用频率）、D-04 的发布闸门完整性（属算法/发布 lane）、`apps/api` 直连 16 处 `storage-sqlite` 是否绕过了 application 的编排语义（属 API 编排 lane）。
