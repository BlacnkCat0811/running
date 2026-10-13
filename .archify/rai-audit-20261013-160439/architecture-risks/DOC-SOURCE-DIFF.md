# DOC-SOURCE-DIFF — 文档声明 vs 源码实况

审计对象：`D:\running` @ `60678af97e4710cfd8444b3952df9fff09c2bff3`（`git status --short` 仅有未跟踪的 `.archify/`，被引用的文件均为已提交字节）。
产出者：risk-author（共享任务 `task-3`，Deliverable B）。这是**书面记录**，不是图。

## 0. 方法与证据等级

- 冲突时以源码为准。文档是**声明**，不是事实。
- 每一行都给 `文档 path:line` 与 `源码 path:line`。只引用本次实际打开过的行（read 工具或 grep 输出中直接看到的行内容）。
- 证据等级沿用 TEAM-BRIEF：**A = 已确认**（读到了实现该行为的代码）；**B = 推断**（源码强烈暗示但没有任何一行直接断言）；**C = 未知**（无法确认）。
- 判词用词限定为：`matches` / `outdated` / `overstated` / `absent from source` / `cannot confirm`。
- 本次审计的六条边界主线是：重复执行/幂等、SQLite 并发写、候选与正式派生数据一致性、原子发布/切换、失败恢复/重试/续跑、增量同步。相关行优先。

## 1. 主对照表

| # | 文档声明（文档 path:line） | 源码实况（源码 path:line） | 判词 | 等级 |
|---|---|---|---|---|
| 1 | README.md:18 「要求 Node.js 22 LTS（≥22.12…）或 24 LTS（24.x）」 | package.json:126 `"node": ">=22.12.0 <23 || >=24.0.0 <25"`（另有 package.json:11 `check:node` 前置钩子） | matches | A |
| 2 | README.md:34 / docs/ARCHITECTURE.md:66 「API 默认回环地址」 | apps/api/src/server.ts:130 `const host = process.env.RAI_API_HOST ?? "127.0.0.1"`；端口默认 8787（server.ts:129） | matches | A（Nginx/systemd 那一半见 §4） |
| 3 | README.md:11「导入使用私有候选库和受控发布；**没有常驻 shadow 全量双跑**」 | 候选链路：apps/api/src/import-worker.ts:624-644（backup → staging copy）与 :1678-1729（activate 换库）；导入 CLI 实参列表 apps/api/src/import-worker.ts:654-682 里没有 shadow 开关 | matches | A |
| 4 | docs/DECISIONS.md:8「2026-09-20 已取消导入时独立完整 shadow 重放和对应开关」；docs/DECISIONS.md:10「名称仍带 shadow 的历史表/兼容方法也不等于后台仍双跑」 | 导入参数表无 shadow（apps/api/src/import-worker.ts:654-682）；但 shadow 命名的结构仍在：packages/storage-sqlite/src/model-run-repository.ts:229 `const gateVersion = "rai-shadow-gate-v1";`，packages/storage-sqlite/src/database.ts:1062 迁移名 `model_checkpoints_and_shadow_validation`、:1088 `mode TEXT NOT NULL CHECK (mode = 'shadow')` | matches（就「导入重放已取消」这一断言） | A |
| 5 | docs/ARCHITECTURE.md:59「写命令具备 **revision/idempotency/generation** 约束」 | 幂等 ✓ apps/api/src/command-queue.ts:108-113（幂等键 sha256、指纹比对、`CommandConflictError`）；revision ✓ apps/api/src/command-queue.ts:42-44（`workout_override_revision_conflict`、`training_zone_profile_revision_conflict`）；generation ✗ 队列表只有 `sequence/id/scope/status/payload`（apps/api/src/command-queue.ts:71-74），队列本身没有任何 generation 列或判据 | **overstated**（generation 不属于 CommandQueue） | A |
| 6 | docs/ARCHITECTURE.md:61「SQLite staging 候选必须通过**完整性、数据代次与模型 gate**才可切换」 | 文件换库的实际门槛只有三步：checkpoint（apps/api/src/import-worker.ts:1719）→ rename 主库到 rollback（:1721）→ 安装候选 + `isReadableDatabase(..., "activation_verify")`（:1726-1729）。「数据代次」绑定只出现在直连车道的分析任务登记（apps/api/src/direct-sync-ingest.ts:518-524）；「模型 gate」`evaluateModelTransitionGateV2` 只在重算发布里调用（packages/application/src/services/recompute-pipeline.ts:314） | **overstated**（两项 gate 都不作用于数据库文件切换） | A |
| 7 | docs/ARCHITECTURE.md:61「候选失败不改变 incumbent」 | apps/api/src/import-worker.ts:1736-1748（失败即 `restoreImportDatabase`，未移开主库时清理新库）、:1787-1824（回滚且回读校验）、:1759-1764（只有回滚被证明完成才清 journal 意图） | matches | A |
| 8 | docs/ARCHITECTURE.md:60「恢复备份或替换数据集必须改变 datasetEpoch」 | 恢复：apps/api/src/server.ts:1969-1975（`randomUUID()` → 写回主库 → `changeDatasetEpoch`）；删除：apps/api/src/server.ts:1994-2002；epoch 读取与损坏降级 apps/api/src/dataset-epoch.ts:44-61 | matches | A |
| 9 | docs/ARCHITECTURE.md:53「`runtime.sqlite` 保存来源/任务状态；`rai-control.sqlite` 保存训练目标…控制状态」 | apps/api/src/command-queue.ts:70 `this.path = new RuntimeStateStore(runtimeRoot).path`（命令队列落 runtime 库）；apps/api/src/server.ts:127 `RAI_CONTROL_DATABASE ?? var/rai-control.sqlite` | matches | A |
| 10 | docs/ARCHITECTURE.md:68「鉴权、ZIP 限额/路径验证、导入写许可、备份/恢复锁…均是独立安全边界」 | 鉴权 apps/api/src/local-request-security.ts:141-172；ZIP 限额 apps/api/src/import-sources.ts:98-106；路径/符号链接/条目数 apps/api/src/import-sources.ts:653-662、:604-613；导入写许可 apps/api/src/task-admission.ts:9-59；发布锁 packages/storage-sqlite/src/publication-lock.ts:160-186 | matches | A（「移动端凭证隔离」见 §4） |
| 11 | docs/ARCHITECTURE.md:13「可选 Rust Record 热循环（受限写许可）」 | 默认引擎 packages/health-export-parser/src/native-worker.ts:69 `importEngine(value = process.env.RAI_IMPORT_ENGINE ?? "typescript")`；直连车道显式拒绝非 typescript：apps/api/src/direct-sync-plan.ts:51 `if (input.engine.name !== "typescript") return reject(...)` | matches（Rust 是可选能力，且不在直连车道上） | A |
| 12 | docs/ARCHITECTURE.md:51「不增加多 API 写者 / PM2 cluster」 | 进程级发布锁在 API 启动即取：apps/api/src/server.ts:170-177；同库第二个进程会被拒绝而不是排队：packages/storage-sqlite/src/publication-lock.ts:195-197、:253（`throw new Error("Another … process is using …")`） | matches（跨进程互斥真实存在） | A（PM2/systemd 配置本身见 §4） |
| 13 | docs/DATA_PIPELINE.md:55「[database] 定义 migrations **1–32**」 | packages/storage-sqlite/src/database.ts:1677 `{ version: 36, name: "workout_soft_delete_marker", up: migrateModelV36 }`；v33/v34/v35 依次在 :1674-1676 | **outdated**（实际到 36） | A |
| 14 | docs/DATA_PIPELINE.md:21「payload 摘要包含内容、canonical 合同、preserveAbsent 语义、引擎 name@version 和身份算法行为 fingerprint」 | apps/api/src/import-payload-identity.ts:120-136 逐项折入：`contractVersion`、`preserve`/`replace`、`engine`、`contentSha256`，可选 `identityAlgorithm`（:134）；引擎字符串形状见 :88-95；算法指纹来源 packages/health-export-parser/src/identity-algorithm.ts:127-137 | matches（逐项对应） | A |
| 15 | docs/DATA_PIPELINE.md:6「2026-10-12 目标改造（**设计，未上线**）：SQLite 直接增量同步」 | 直连车道已在运行时路径上：apps/api/src/direct-sync-plan.ts:55 `return { lane: "direct", deltaMode: "full", reasons: [] }`；apps/api/src/import-worker.ts:556-616 调用 `planDirectSyncLane` 并执行 `data-only`/`direct-sync` 两个 databaseTask；实现体 apps/api/src/direct-sync-ingest.ts:413-614 | **outdated**（已上线，不再是"设计"） | A |
| 16 | docs/DATA_PIPELINE.md:13「已有库通过 SQLite 在线 backup 生成私有候选库；不要直接复制运行中的 WAL 主库文件」 | packages/health-export-parser/src/cli.ts:189-195 `const source = new DatabaseSync(target, { readOnly: true }); await backup(source, staging);`；worker 侧在线备份 apps/api/src/import-worker.ts:1171-1192（`.partial-<uuid>` → 校验 → rename） | matches | A |
| 17 | docs/DATA_PIPELINE.md:12「ZIP 先检查路径/大小/数量/重复条目及导出根目录，不能信任文件名、客户端 metadata 或解压后路径」 | magic bytes apps/api/src/import-sources.ts:604-613；条目数上限 :656；符号链接拒绝 :657；不安全路径 :662；文件/目录冲突 :632-648；解压预算 :623-625 | matches | A |
| 18 | docs/DATA_PIPELINE.md:79「`docs/DATA_AUDIT.md` … 已取消 Git 跟踪」 | 写文件位置 apps/api/src/import-worker.ts:494 `const finalMarkdownReport = resolve(this.runtimeRoot, "docs/DATA_AUDIT.md")`；`git ls-files --error-unmatch docs/DATA_AUDIT.md` 报 `did not match any file(s) known to git` | matches | A |
| 19 | docs/RUST_DATA_ENGINE.md:33「默认 `RAI_IMPORT_ENGINE=typescript`」 | packages/health-export-parser/src/native-worker.ts:69（默认字面量 `"typescript"`）；apps/api/src/server.ts:133-136 只有在 name=rust 且 fallback=none 时才校验二进制 | matches | A |
| 20 | docs/RUST_DATA_ENGINE.md:14「目标必须是受控 `.importing.<UUID>` 候选库、realpath 相同且有匹配的一次性许可；许可不能来自上传内容或公共 HTTP 参数」 | 许可：packages/health-export-parser/src/native-record-writer.ts:80-84 `randomBytes(32)` + `setManifest("rai.native_import_permit", permit)` + `flushIfOwned()`，每次 apply 前重新武装；目标：:250-253 要求 `canonicalTarget === realpathSync(main)` 且匹配 `/\.importing\.[a-f0-9-]{36}$/` | matches（精度提示：正则只要求"36 个 `[a-f0-9-]` 字符"，不校验 UUID 的分段形状，比"UUID"宽松） | A |
| 21 | docs/RUST_DATA_ENGINE.md:9「Rust … 不写活动主库」 | packages/health-export-parser/src/native-record-writer.ts:250-253：目标 realpath 不等于连接 main、或不以 `.importing.<36>` 结尾就直接抛 `Native record writes require a CLI-owned staging database` | matches | A |
| 22 | docs/RUST_DATA_ENGINE.md:15「中转 SQLite 与候选文件使用每次 attempt 独立路径；旧孤儿进程不能覆盖新 attempt」 | apps/api/src/import-worker.ts:483-484 `const attempt = job.queue ? \`.attempt-${job.queue.attempts}\` : ""` 并拼进 `nativeSpoolRoot`；staging 路径同一后缀 :491 | matches | A |
| 23 | docs/RUST_DATA_ENGINE.md:22「Rust 引擎 version 进入 payload identity」 | apps/api/src/import-payload-identity.ts:88-95（`engine` 为 `<name>@<version>`，注释说明"升级二进制必须仍然移动这个 digest"）、:120-136 折入 digest | matches | A |
| 24 | docs/ALGORITHM.md:38「候选失败不得半发布」 | 候选链路 apps/api/src/import-worker.ts:1736-1767；直连车道提交/回滚二选一 apps/api/src/direct-sync-ingest.ts:613-616 | matches | A |
| 25 | docs/ALGORITHM.md:334「全部训练明确删除时，只有现场证明剩余来源及候选各派生训练块均为空，才能发布空 bundle」 | packages/application/src/services/recompute-pipeline.ts:312-317 向 gate 注入 `sourceBackfill` / `emptyCohort` 证据；:326-328 无 incumbent 时退回 `rai-bootstrap-invariants-v1` 且 `blocksActivation` 由 `recoveryIsolationHolds` 决定 | matches（证据管道存在） | B（阈值判定本身未展开） |
| 26 | docs/ALGORITHM.md:330「not_evaluable 是正式状态，不能按"不是 failed"绕过激活」 | 只能看到 gate 的调用点与 bootstrap 分支（packages/application/src/services/recompute-pipeline.ts:314-328）；`not_evaluable` 分支本体在 packages/storage-sqlite/src/model-transition-gate.ts:302，本次**未展开阅读** | cannot confirm | C |
| 27 | docs/ALGORITHM.md:331「回滚只到仍保留、数据 generation 兼容的完整 bundle；不承诺恢复任意已清理 run/历史二进制」 | 未阅读 `packages/storage-sqlite/src/model-release-repository.ts` 本体 | cannot confirm | C |
| 28 | docs/ALGORITHM.md:332「checkpoint 只在精确兼容配置/版本下复用」 | 未找到并阅读 checkpoint 复用判据的实现处（grep `reuse` 在 packages/storage-sqlite/src 只命中迁移列与非 checkpoint 逻辑） | cannot confirm | C |
| 29 | docs/ALGORITHM.md:333「激活/回滚还须匹配当前有效 override 快照（V4 lineage hash、V3 metric config ID 序列）；不匹配时拒绝并保留两个 active 指针」 | 未阅读该比对实现 | cannot confirm | C |
| 30 | docs/ARCHITECTURE.md:62「原始记录不能随模型回滚重写」 | 未阅读模型回滚实现 | cannot confirm | C |
| 31 | docs/DATA_PIPELINE.md:14「增量同步依赖 entity generation、路由指纹、dirty 范围与精确兼容 checkpoint」 | generation：apps/api/src/direct-sync-ingest.ts:495-500（`raw_generation`/`dependency_generation` 递增并在任务登记时绑定）；dirty：同文件 :508、:516（`dirtyFromAt` + `incrementalPlan`）；路由指纹：apps/api/src/import-worker.ts:565-577 的 `payloadSha256` 与 apps/api/src/import-sources.ts:278 `digestHealthKitRecordSnapshot`。「精确兼容 checkpoint」未展开 | partially matches（前两项 A，"精确兼容 checkpoint" C） | A/C |

## 2. 计划但未见落地 / 曾记录但已移除

| 项 | 文档位置 | 源码实况 | 判词 |
|---|---|---|---|
| SQLite 直连增量同步被记为"设计，未上线" | docs/DATA_PIPELINE.md:6 | 已在运行时路径：apps/api/src/import-worker.ts:556-616 选道并执行；apps/api/src/direct-sync-plan.ts:55 返回 `lane: "direct"` | outdated（文档落后于代码） |
| 管线图只画"私有候选 SQLite → 验证、generation/锁、原子发布 → 主 SQLite" | docs/ARCHITECTURE.md:11-16 | 代码里存在**第二条**路径：不换文件、不走候选，直接在主库一个事务里提交（apps/api/src/direct-sync-ingest.ts:449 `store.beginCallerTransaction()`、:613 `store.commitCallerTransaction()`） | outdated（不是错，是不全；这两条路径的差别正是风险点） |
| 导入时 shadow 全量重放"已取消" | docs/DECISIONS.md:8、README.md:11、docs/DATA_PIPELINE.md:14、docs/RUST_DATA_ENGINE.md:23 | 导入 CLI 实参表（apps/api/src/import-worker.ts:654-682）确实没有 shadow 开关；shadow 命名的表与 gate id 仍在（packages/storage-sqlite/src/database.ts:1062、:1088；packages/storage-sqlite/src/model-run-repository.ts:229） | matches（且 docs/DECISIONS.md:10 已预先声明"名字带 shadow ≠ 后台双跑"，与源码一致） |
| migration 数量 | docs/DATA_PIPELINE.md:55 | 到 version 36（packages/storage-sqlite/src/database.ts:1677） | outdated |
| `docs/DATA_AUDIT.md` 取消 Git 跟踪 | docs/DATA_PIPELINE.md:79 | `git ls-files` 无该路径；运行期写入点 apps/api/src/import-worker.ts:494 | matches |

## 3. B（推断）条目——源码强烈暗示但没有任何一行直接断言

- **B1** 直连车道的"同一事务"保护依赖调用方所有权：`RaiDatabase.open(..., { transactionOwner: "caller" })`（apps/api/src/direct-sync-ingest.ts:426）与 `beginCallerTransaction`/`commitCallerTransaction`（:449、:613）成对出现，且 `packages/health-export-parser/src/owned-transaction.ts:21-42` 在 caller 模式下只发 SAVEPOINT。**推断**：只要有一个组件在 caller 模式下自行 COMMIT，就会破坏"整批要么全成要么全退"；源码用"泄漏的 savepoint 会让调用方提交被拒"来兜（owned-transaction.ts:17-19），但该断言本身我未在调用方读到实现。
- **B2** `sourceMutations`（apps/api/src/server.ts:373）与 `mutationCoordinator`（:372）是两把互不相通的锁。**推断**：`POST /v1/import-jobs` 取源锁（apps/api/src/routes/import-routes.ts:17）与任意写路由取主锁（apps/api/src/server.ts:426）可以同时成立；但源锁路径只登记任务、不写主库，所以实际互斥缺口**未观测到后果**。
- **B3** 写租约的失败开放（apps/api/src/write-lease.ts:91-100）**推断**会让分析写窗口短暂处于"无单写者许可"状态；「同一时刻只有一个写者」在超时窗口内不再成立。文档与注释都承认这一取舍，但没有任何计数或告警被强制消费（`stats.timeouts` 只经 `recompute-thread.ts:39` 回传）。
- **B4** `ImportRemovalGuardError` 的 5% / 50 实体门槛（packages/health-export-parser/src/import-guard.ts:16-17、:38-46）**推断**是唯一抑制"部分载荷被当作完整快照导致静默删除"的运行期闸门；直连车道靠 `preserveAbsent` 恒为 true 结构性绕开它（apps/api/src/direct-sync-plan.ts:77-79），两条路径的保护并非同一套。

## 4. C（未知）条目——本次无法确认，不得当作事实

- **C1** `docs/ARCHITECTURE.md:68` 里"移动端凭证隔离"这一条安全边界：本次未阅读 iOS 侧凭证存储实现。
- **C2** `README.md:34` / `docs/ARCHITECTURE.md:66` 的 Nginx HTTPS、Bearer 与 systemd 资源预算：`deploy/` 未审计。
- **C3** `docs/ARCHITECTURE.md:51` 的"不增加 PM2 cluster"：进程内与进程级锁已核对（见主表 #12），但 PM2/systemd 进程管理配置未读。
- **C4** `docs/ALGORITHM.md:330-333` 四条模型发布/回滚合同：`model-transition-gate.ts` 的 `not_evaluable` 分支、`model-release-repository.ts`、checkpoint 复用判据均未展开阅读。
- **C5** `docs/README.md`（README.md:65）所称"54 项验收合同"的完成度：未核对 `docs/ALGORITHM.md` §16 的验收矩阵与测试一一对应。
- **C6** `var/` 中的观测：本机现有 80 个 `rai.sqlite.import.lock.stale.*` 目录与 12 个 `rai.sqlite.import.lock.candidate.<uuid>` 文件。这与"没有任何代码回收这两类路径"（apps/api/src/maintenance.ts:105-106、:750）一致，但**残留文件本身不是代码缺口的证明**，也不代表它们一定来自崩溃（可能来自历史版本行为）；本节只记录观测。

## 5. 与风险图的关系

本文件的主表 #5、#6、#13、#15 与 §2 的前两行，对应风险图（`.archify/rai-audit-20261013-160439/architecture-risks/architecture-risks.html`）中 "文档与源码不符" 卡片的三条结论；§3 的 B1–B4 对应图中"缺口（A）"三张卡片背后的推断层；§4 的 C4/C6 是图中明确标注为未知的部分。

## 6. 复核方式（只读）

```
git -C D:\running rev-parse HEAD
git -C D:\running status --short
git -C D:\running ls-files --error-unmatch docs/DATA_AUDIT.md
node D:\running\.archify\tools\check-geometry.mjs D:\running\.archify\rai-audit-20261013-160439\architecture-risks\candidate.json
```
