# Lane 3：API 运行时 / 安全 / 契约 / 任务链深度审查

- 审查对象：`git HEAD = 24aa7d8`（工作树干净）。重点为 `09ed8d0..HEAD` 的 API 侧大改（`server.ts` +215、`mobile-goals.ts` +535、新模块 `publication-guard.ts` / `plan-read-consistency.ts` / `plan-receipt.ts`、`read-store-manager.ts` +86）以及既有安全/契约边界。
- 审查方式：**只读**代码审查 + 定向实跑（未跑全量 `npm test`，由 Lead 后台执行）。未修改任何被跟踪文件，未 `git add/commit`，未读写 `var/` 真实库/真实健康数据，仅在 `/tmp` 建合成探针。
- 严重度：P0 数据丢失/安全漏洞/生产不可用；P1 发布阻断或契约/安全语义被破坏；P2 用户可见错误或高概率边界缺陷；P3 低影响/防御性/可维护性。
- 证据等级：**E1** 代码逐行阅读（静态）；**E2** 已实跑测试/命令或已复现（附输出）；**E3** 有条件验证（合成夹具）或需跨 lane 确认。

---

## 0 结论摘要

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 未发现数据丢失、凭证泄露或生产不可用级缺陷 |
| P1 | 0 | 鉴权矩阵、上传/解包、分享卡隐私裁剪、4xx/5xx 语义、CAS/幂等未发现被破坏 |
| P2 | 1 | `training-plan-state` 用主库文件 **mtime** 判定"发布中"⇒ WAL checkpoint 造成假阳性 503（A1） |
| P3 | 8 | 匿名只读集合遗留（A2）、guard 遗留 marker/无退避（A3、A4）、5xx 诊断被吞（A5）、OpenAPI 漂移（A6）、退役备份路由语义不一致（A7）、跨端终局码缺口（A8）、全量库下载无 no-store（A9） |

**总体判断：本 lane 范围内 HEAD 没有发布阻断项。** 本轮大改的三个新机制（回执 v2 规范化、跨库发布 guard、读写一致性重试）在代码和实跑证据上都成立：路由分类门禁（Fastify 真实路由表 vs 三张注册表）通过；匿名读默认 fail-closed；ZIP 上传的路径/符号链接/压缩比/预算校验齐全；share-card 只在服务端裁剪且匿名详情连坐标都不查；token 不进日志/错误体；CAS 与 409 映射已按上一轮报告修复并有回归。

真正值得先修的是 **A1**：它把"WAL checkpoint 正常写回主库文件"误判成"数据库已发布"，在导入/重算正在写主库时给 `/v1/mobile/training-plan-state` 制造间歇 503；同一仓库的 `read-store-manager.ts` 已明确记录"mtime 会因 checkpoint 变化、不能据此失效"，两处口径相反，且没有回归钉住。

---

## 1 范围与方法

### 1.1 覆盖文件

- 入口/安全/错误：`apps/api/src/server.ts`(2208)、`local-request-security.ts`、`api-error.ts`、`request-mutation-lifetime.ts`、`mutation-coordinator.ts`、`task-admission.ts`、`try-acquire-gate.ts`。
- HEAD 新增/大改：`publication-guard.ts`(新)、`plan-read-consistency.ts`(新)、`plan-receipt.ts`(新)、`plan-publication.ts`、`plan-digest.ts`、`mobile-goals.ts`、`read-store-manager.ts`、`data.ts` 读路径（`trainingPlanState` / `workoutSeries` / `workoutShareCard` / `privacyZones`）、`schemas.ts`。
- 路由模块：`routes/command-routes.ts`、`routes/import-routes.ts`、`run-coach.ts`、`coach-loop-routes.ts`。
- 上传/任务链：`import-routes.ts` 的 `/v1/imports/uploads`、`import-sources.ts`（`saveUpload`/`extractZip`/`backupStream`）、`command-queue.ts`、`worker.ts`、`recompute-worker.ts`、`worker-process.ts`（生命周期/隔离）。
- 契约：`packages/api-contracts/src/index.ts`（新增 `MOBILE_PLAN_OPERATION_QUERY_STATUSES` / `MobilePlanOperationQueryResponse`）、`apps/api/src/schemas.ts` 的 `openapiDocument`、`docs/IOS_NATIVE_API_CONTRACT.md`；iOS DTO 仅做**消费侧一致性抽查**（iOS 本体归 Lane 4）。
- 部署边界（只作安全对照，模板归属 Lane 5）：`deploy/nginx-rai.conf`、`deploy/rai.env.example`、`deploy/check-runtime-readonly.sh`。

### 1.2 实跑命令与结果（原样摘要）

```text
# 1) 真实路由表 vs 写路由/读路由分类注册表（Fastify onRoute dump）
node --import tsx --test --test-name-pattern "every mounted write route" apps/api/test/server-runtime.test.ts
→ ✔ every mounted write route is classified (2979ms)，tests 1 / pass 1 / fail 0

# 2) 鉴权/错误语义单测
node --import tsx --test local-request-security.test.ts api-error.test.ts
→ tests 16 / pass 16（含 "anonymous reads open only for the listed routes on the listed hosts"、
  "without a public host list nothing is readable without a token"、"authenticated remote still checks origins"）

# 3) 计划/回执/一致性/store/分享卡/隐私区/命令队列
node --import tsx --test plan-read-consistency plan-receipt-v2 plan-receipt-identity plan-error-semantics \
  read-store-manager share-card privacy-zones command-queue
→ tests 75 / pass 75 / fail 0

# 4) 并发/生命周期
node --import tsx --test mutation-coordinator request-mutation-lifetime task-admission try-acquire-gate mobile-plan-sync
→ tests 16 / pass 16 / fail 0

# 5) schema/OpenAPI/合同门禁
node --import tsx --test schemas.test.ts
→ tests 16 / pass 16 / fail 0

# 6) 跨进程发布 guard 压力（真实两进程 + 真实 API 进程）
node --import tsx --test plan-publication-stress.test.ts
→ tests 2 / pass 2；ℹ HTTP readers n=200: 200=60 503=140 p50=39.2ms p95=108.7ms inconsistent_200=0
  ℹ reader 503 codes: {"plan_snapshot_changed":140}
  ℹ HTTP writers n=50: 200=50 409=0 503=0

# 7) 主计划读路径延迟（合成 ~42.6k 行，非 var/）
node --import tsx --test plan-snapshot-latency.test.ts
→ ℹ empty db n=20: p50=6.17ms p95=7.14ms
  ℹ ~42600 rows n=20: p50=15.69ms p95=26.38ms
```

```text
# 8) WAL checkpoint 是否改主库 mtime（/tmp 合成库，node:sqlite）
rows0 { c: 0 }
after inserts: ino same = true mtime same = true deltaMs = 0.000
reader sees rows { c: 20 }
after checkpoint: ino same = true mtime same = false deltaMs = 8.383   ← mtime 变了，inode 没变
```

```text
# 9) GET 路由 ↔ OpenAPI paths 漂移扫描（复用 test/source-scan 的注释剥离扫描器）
GET routes scanned: 49
MISSING from openapi: [ "/v1/handshake", "/v1/recovery-trends" ]
```

### 1.3 未跑 / 不归本 lane

- 全量 `npm test`（Lead 后台执行中），本 lane 不重复。
- 真实 import worker 与 HTTP 读的并发（`plan-publication-stress.test.ts` 注释已声明该路径仅合成覆盖）。
- iOS 侧 `npm run test:ios`、真机/Simulator（Lane 4）；`deploy/` 模板本身（Lane 5）。
- 任何需要读写 `var/` 或真实健康数据/上传包的实验，一条都没做。

---

## 2 发现清单

| ID | 严重度 | 标题 | 位置 | 证据等级 |
| --- | --- | --- | --- | --- |
| A1 | P2 | `training-plan-state` 以主库 `mtime` 判定"发布中"⇒ WAL checkpoint 假阳性 503，且该分支不重试 | `apps/api/src/data.ts:547,640-653`；对照 `apps/api/src/read-store-manager.ts:81-93` | E2（机制实测）+E1（调用路径） |
| A2 | P3 | 匿名只读集合未随 D17 收敛：iOS 专属聚合（today/coach-loop/coach-execution/workout-plan/goals）仍在公开读集合，而同域 `training-plan-state`/`run-coach` 需 token | `apps/api/src/server.ts:259-289,293-315`；`deploy/rai.env.example:42-48` | E1+E2（分类测试通过≠分类合理） |
| A3 | P3 | 发布 guard 的 pending marker 在崩溃/清理失败后无启动清扫，重启后最多 120s 计划读 503 | `apps/api/src/publication-guard.ts:36,93-102`；`apps/api/src/mobile-goals.ts:387-410` | E1+E3（合成语义） |
| A4 | P3 | guard 读重试 3 次之间无任何退避，压力下读侧 140/200 得 503；`/synced` 又在控制库写事务内做整份主库快照，拉长 pending 窗口 | `apps/api/src/plan-read-consistency.ts:119-150`；`apps/api/src/data.ts:553-556`；`apps/api/src/server.ts:1252-1305` | E2（压力/延迟实测） |
| A5 | P3 | `apiErrorPayload` 把白名单外的所有 5xx code/message 压成 `internal_error`，吞掉自述诊断（`restore_recovery_required`、`plan_operation_status_unknown`、run-coach 500） | `apps/api/src/api-error.ts:18-34`；`apps/api/src/restore-journal.ts:13-21`；`apps/api/src/plan-publication.ts:25-42` | E2（探针输出） |
| A6 | P3 | OpenAPI 漂移：`GET /v1/handshake`、`GET /v1/recovery-trends` 已挂载并分类却不在 `openapiDocument.paths`；文档门禁只覆盖写路由 | `apps/api/src/schemas.ts:828+`（paths）；`apps/api/src/server.ts:947,1583-1587`；`apps/api/test/schemas.test.ts:337-380` | E2（扫描输出 + 门禁代码） |
| A7 | P3 | 同族"已退役备份"语义两副面孔：`POST /v1/backups` 被分类为 databaseRequired，无库时先被 409 拦住，到不了设计中的 410；`DELETE /v1/backups/:name`（lockOnly）却可达 410 | `apps/api/src/server.ts:351,427-431,2053-2058` vs `:368-372,2070-2074` | E1 |
| A8 | P3 | 服务端 `409 coach_loop_contract_required` 不在客户端终局码集合 ⇒ 旧协议排期回执永久"可前台重试"（跨 lane 待 iOS 侧确认影响） | `apps/api/src/server.ts:411-421`；`apps/ios/RAI/PlanMutationDisposition.swift:32-52`；`apps/ios/RAI/NativeAppModel.swift:1543-1560` | E1（跨端代码对照） |
| A9 | P3 | `GET /v1/backups/:name` 全量 SQLite 流式下载无 `Cache-Control: no-store`，且 `content-disposition` 直接拼接请求参数名 | `apps/api/src/server.ts:2060-2065` | E1 |

> 说明：A2 是"配置口径"问题（默认关闭，`RAI_PUBLIC_HOSTS` 为空即不可达），故定 P3 而非 P2；A3/A4/A8 的失效方向均为"可重试的 503/保留重试"，不是数据损坏。

---

## 3 每项详情

### A1（P2）`training-plan-state` 用主库 `mtime` 判定"发布中"⇒ WAL checkpoint 假阳性 503

**位置**：`apps/api/src/data.ts:536-669`（`RaiReadStore.trainingPlanState`），关键分支：

```ts
// data.ts:547
const fileIdentity = readSnapshotFileIdentity(this.path);      // { ino, mtimeMs }
...
// data.ts:641-648
const currentFile = readSnapshotFileIdentity(this.path);
if (currentFile === null) { this.cache.clear(); continue; }
if (fileIdentity.ino !== currentFile.ino || fileIdentity.mtimeMs !== currentFile.mtimeMs) {
  throw new PlanOperationError("plan_snapshot_changed",
    "训练数据库在读取期间发布，请重读完整快照。", 503);
}
```

**问题**：`mtimeMs` 变化不等于"文件被替换/发布了新快照"。SQLite 的 WAL checkpoint 会把 WAL 页写回主库文件，主库 mtime 随之变化，而 **inode 不变**、读连接看到的快照也没有被替换。同仓库 `read-store-manager.ts` 已经把这个事实写进注释并据此决定"只按 inode 重开连接"：

```ts
// read-store-manager.ts:81-93（摘要）
// ... mtime alone must not reopen: every WAL checkpoint touches the main file,
// and rebuilding the store ... is pure latency with no consistency benefit
if (this.store !== null && (this.openedIdentity === null || this.openedIdentity.ino !== identity.ino)) this.closeStore();
```

两处口径相反：`trainingPlanState` 把 mtime 变化当作"发布"，于是 **主库有其它写者正在 checkpoint 时（导入 worker、重算 worker 写分析结果），主计划读会无谓地返回 503**。该分支是 `throw` 而不是 `continue`，连一次重试机会都没有（同一函数对"stat 瞬态失败"是 `continue`，对"inode 变化"是 throw，语义本来就不一致）。

**实测证据（E2）**：在 `/tmp` 合成库上用 `node:sqlite` 建 WAL 库，写入 20 行并 `wal_checkpoint(TRUNCATE)`：

```text
after inserts:  ino same = true  mtime same = true   deltaMs = 0.000
after checkpoint: ino same = true mtime same = false deltaMs = 8.383
```

即 **checkpoint 只改 mtime、不改 inode**，正好命中上面的 `||` 条件。`trainingPlanState` 的读时长实测 p50≈15.7ms / p95≈26.4ms（42.6k 行合成库，见 §1.2 #7），一次 checkpoint 落在这段窗口内就会 503。

**影响**：`GET /v1/mobile/training-plan-state` 是 iOS 的旗舰计划读，503 带 `Retry-After: 1`（`api-error.ts:45-56`），客户端会重试，所以是**可自愈的间歇错误**，不是数据错误；但在"导入刚结束、重算正在写库，用户打开 App"这一最典型时序下正是触发窗口，并且每次重试都可能再撞上（重算期间 checkpoint 会反复发生）。

**建议**：主库身份的判据只用 `ino`（与 `ReadStoreManager` 对齐）；跨连接提交的检测已有 `PRAGMA data_version`（data.ts:558/662）和 guard epoch，mtime 顶多作为诊断字段。若坚持保留 mtime 语义，至少把该分支改成 `continue`（与瞬态 `null` 一致），而不是直接 503。

**未验证边界**：未在生产规模的真实 `var/rai.sqlite` 上统计"读窗口内恰好 checkpoint"的频率（不允许读写真实库）；频率结论来自机制 + 延迟数据，属 E2/E3 之间。

---

### A2（P3）匿名只读集合未随 D17 收敛：iOS 专属聚合仍在公开读集合

**位置**：`apps/api/src/server.ts:259-289`（`publicReadRoutes`）、`:293-315`（`tokenRequiredReadRoutes`）；`deploy/rai.env.example` 的 `RAI_PUBLIC_HOSTS` 注释。

**现状（分类本身通过门禁，问题在分类是否仍合理）**：

- 匿名公开读里包含：`/v1/mobile/today`、`/v1/mobile/goals`、`/v1/mobile/workout-plan`、`/v1/mobile/statistics`、`/v1/mobile/trends`、`/v1/mobile/coach-loop`、`/v1/mobile/coach-execution`，以及 dashboard/data-summary/data-audit/workouts/trends 等。
- 需要 token 的同域读：`/v1/mobile/training-plan-state`、`/v1/mobile/run-coach`、`/v1/mobile/plan-operations/:id`、`/v1/workouts/:id/share-card`、`/v1/privacy-zones`。

问题不是"漏了鉴权"（hook 默认拒绝，`local-request-security.test.ts` 实跑通过），而是**同一语义面上口径不一致**：

1. `publicReadRoutes` 的注释（server.ts:233-258）写明这套集合是为**已退役的 Web SPA**引入的，且逐条解释了哪些读"故意不在集合里"（备份、诊断、导入源、jobs、openapi）——但完全没有为 `/v1/mobile/*` 这几个 iOS 专属聚合给出理由。
2. `/v1/mobile/today`、`coach-loop` 返回的内容与 `training-plan-state` 高度重叠（目标、今日、恢复、伤病标记；见 `data.ts:612-628` 的 `injuryFlags` 进入 coherenceToken）。如果"计划快照是安全相关、必须 token"（把 `training-plan-state`/`run-coach` 排除在公开集合外的实际效果），那么 `today`/`coach-loop`/`workout-plan` 把它们放进公开集合就自相矛盾。
3. `deploy/rai.env.example:47` 的注释仍写"公开的只有健康数据读接口"，而实际公开集合里含计划、目标（`raceTarget`）、教练闭环状态，超出了这句话的字面承诺。
4. 历史：这些条目是在 Web SPA 还在时随"移动端聚合 API"一起加进集合的（`git log -S '"/v1/mobile/today"'` → `8b2134a`，`-S '"/v1/mobile/coach-loop"'` → `a5bc050`）。D17 退役 Web 后没有回收。

**当前风险**：`RAI_PUBLIC_HOSTS` 默认空、`deploy/rai.env.example` 也是空，所以**默认与部署模板都不可达**；只有当运维显式开启这个"原为浏览器 SPA 而设、Web 退役后不再需要"的开关时，互联网才可无 token 读到 iOS 专属聚合。属配置口径/隐私边界问题，不是当前线上漏洞。

**建议**：既然 Web 已退役，把 `/v1/mobile/*` 从 `publicReadRoutes` 整体移除（保留 documents 里对 dashboard 等既有项的说明），或至少把 `training-plan-state` 的同源聚合（today/coach-loop/workout-plan/goals）一起归入 token 侧；同时更新 `deploy/rai.env.example` 与 `docs/` 的措辞。

**未验证边界**：没有任何客户端在 `RAI_PUBLIC_HOSTS` 开启态下的真实调用证据（iOS 不走匿名读）；此条依据是代码/文档口径，非运行时复现。

---

### A3（P3）发布 guard 的 pending marker 崩溃遗留，重启后最多 120s 计划读 503

**位置**：`apps/api/src/publication-guard.ts`、`apps/api/src/mobile-goals.ts:372-410`。

`withPublicationTransaction` 的顺序是：`BEGIN IMMEDIATE; epoch+1, pending_since=now; COMMIT` → 业务事务 → `endPublicationMarker()`（自己一个 `BEGIN IMMEDIATE`，**best-effort**：出错只吞掉）。因此存在两种遗留：

1. 进程在"marker 已提交、业务事务未提交/未清理"之间崩溃 → 控制库里留下 `pending_since`；
2. `endPublicationMarker()` 的 `BEGIN IMMEDIATE` 撞上 2s `busy_timeout`（外部 CLI/第二个进程持写锁）→ marker 不清。

全仓只有 `beginPublicationGuard`/`endPublicationGuard` 两处会写 `pending_since`，**启动时没有任何清扫**（`ensurePublicationGuardSchema` 只 `INSERT OR IGNORE` 初始行，`acquireDatabasePublicationLock`/`recoverInterruptedRestore` 都不碰它）。于是"崩溃后快速重启"会命中 `isPublicationGuardPending`（120s lease，`publication-guard.ts:36,93-102`），期间：

- `RaiReadStore.trainingPlanState`（data.ts:553-556）每次尝试一看到 pending 就 `continue`，三次后 503；
- `CoachLoopRuntime.read()`（plan-read-consistency.ts:137）同样在 pending 时跳过 build，三次后 503。

即**重启后的头两分钟，计划读持续 503**，而真实数据其实是完好的（marker 的语义是"可能有跨库混合读"，不是"数据损坏"）。失效方向是 fail-closed（宁可 503 不返回混合快照），所以定 P3；但"本进程已经重启、旧 publication 不可能还在进行"这一信息在启动时是确定的，清扫它没有风险。

**建议**：控制库打开后（`openControlDatabase`）在第一个写事务里做一次 `endPublicationGuard`（或把 `pending_since` 清空并保留 epoch），并在注释里说明"重启后不可能有在飞 publication"。这样 A3 与 A4 的可用性代价都会下降。

**未验证边界**：未真实 kill -9 一次写入事务来复现（会动控制库；合成库无法覆盖 API 启动路径），属 E1+E3。

---

### A4（P3）guard 读重试无退避；`/synced` 在控制库写事务内做整份主库快照

**位置**：`apps/api/src/plan-read-consistency.ts:119-150`、`apps/api/src/data.ts:542-667`、`apps/api/src/server.ts:1252-1305`。

两个事实叠加：

1. 重试循环的"放弃本次尝试"分支（guard pending、epoch 变化）**没有任何等待**：

```ts
// plan-read-consistency.ts:133-148（摘要）
for (let attempt = 0; attempt < attempts; attempt += 1) {
  const guardBefore = readSnapshotGuardSafe(options.readGuard);
  if (guardBefore !== null && isPublicationGuardPending(guardBefore, now())) continue;  // 立即下一轮
  ...
  if (guardChanged) continue;                                                            // 立即下一轮
}
throw options.changedError();
```

三次尝试跨越的时间远小于一次发布的持续时间，因此"有发布在飞"基本必然走到 503，退避/让行没有任何物理机会。

2. 本进程的写路径把 pending 窗口拉长到与"读一整份主库快照"等长：`POST /v1/mobile/workout-plan/synced` 在 `withPublicationTransaction` 内部调用 `withReadStore(store => store.trainingPlanState(...))`（server.ts:1252-1255），而 `trainingPlanState` 的实测 p50≈15.7ms / p95≈26.4ms（42.6k 行合成库）。这段时间里控制库写锁被持有、marker 为 pending，**所有**并发计划读（`/training-plan-state`、`/coach-loop`、`/coach-execution`）都会 fail-closed。

**实测（E2，压力夹具不是生产时序）**：`plan-publication-stress.test.ts` 用独立发布进程以 4ms 窗口 / 2ms 间隔连续发布 60 次，200 次真实 HTTP 读中 **60 个 200、140 个 503**（全部 `plan_snapshot_changed`），且 `inconsistent_200=0`。测试注释已声明"503 比率只报告、不断言"，所以这是**已知的设计取舍**：一致性优先于可用性，客户端靠 `Retry-After: 1` 重试。本 lane 不主张它破坏契约，但指出两点可改进：读侧在"pending/epoch 变化"时应等待 1–5ms 再重试（而不是空转三轮）；`/synced` 可以把 `matchesCurrent` 的校验改成"先做事务外快照 + 事务内复查关键字段"，避免在控制库写事务内跑整份主库快照。

**未验证边界**：生产写频率下用户实际感知到的 503 比例未测（无真实运行环境）。

---

### A5（P3）`apiErrorPayload` 吞掉自述 5xx 诊断

**位置**：`apps/api/src/api-error.ts:18-34`。

```ts
code: status >= 500 && !["plan_snapshot_changed", "plan_operations_unavailable",
        "coach_snapshot_changed", "database_busy"].includes(String(providedCode))
  ? "internal_error"
  : ...
message: ... ? "本地服务处理请求失败" : message
```

白名单只收了 4 个瞬时码。用探针实跑（E2）：

```text
restore_recovery_required   503 => 503 internal_error | 本地服务处理请求失败 | retryAfter=null
plan_operation_status_unknown 500 => 500 internal_error | 本地服务处理请求失败 | retryAfter=null
mobile_goals_database_busy(实际 code=database_busy) 503 => 503 database_busy | 原文 | retryAfter=1
```

两处与其自身文档直接冲突：

- `restore-journal.ts:13-21` 把 `restore_recovery_required`(503) 定义为带 code 的领域错误，意思是"恢复/删除失败，需重启检查"；客户端拿到的却是通用 `internal_error`，只剩服务端日志能看出发生了什么。
- `plan-publication.ts:19-24` 的注释明确写"违反时抛 500（`plan_operation_status_unknown`）……一个有可诊断的码"，但实际响应体里 code 被改写成 `internal_error`。

注意同一文件里作者已经因为这个问题把"退役备份"从 501 改成 410（`server.ts:2049-2052` 的注释），说明原则是清楚的，只是 5xx 白名单没有随新错误类更新。

**建议**：把"领域 5xx"改成 `statusCode` + 显式 `expose: true`/白名单集中登记（单一来源），或让 `RestoreRecoveryRequiredError` 走 409/422 并附 code；至少把 `restore_recovery_required`、`plan_operation_status_unknown` 加入白名单。

**未验证边界**：iOS 是否对 `restore_recovery_required` 有专门分支——grep 无命中（`apps/ios` 无该字符串），故目前影响限于诊断面，不定 P2。

---

### A6（P3）OpenAPI 漂移：`/v1/handshake`、`/v1/recovery-trends` 未登记

**位置**：`apps/api/src/schemas.ts:828` 起（`openapiDocument.paths`）；`apps/api/src/server.ts:947`（handshake）、`:1583-1587`（recovery-trends）。

用 `test/source-scan.ts` 的注释剥离扫描器枚举全部 `*.get("…")` 路由并与 `openapiDocument.paths` 对比（E2）：

```text
GET routes scanned: 49
MISSING from openapi: [ "/v1/handshake", "/v1/recovery-trends" ]
```

原因在门禁强度：`schemas.test.ts:337-380` 的 "every registered mutation route is documented in OpenAPI" 只覆盖**写**路由（三张写注册表），读路由只在 `server-runtime.test.ts` 里被要求"必须分类"，没人要求"必须进 OpenAPI"。`/v1/handshake` 是客户端能力协商入口（含 6 个 contractVersion 与 `directSyncBounds`），`/v1/recovery-trends` 是 iOS 恢复趋势读；两者缺席会让拿 openapi.json 做集成的调用方以为它们不存在。

**建议**：在 `server-runtime.test.ts` 的读路由分类循环里追加"publicRead ∪ tokenRequired ⊆ openapiDocument.paths"（或按 path 模板化后比较）；补两个 path 条目。

**未验证边界**：无（纯静态 + 扫描输出）。

---

### A7（P3）退役备份路由在"无库"时到不了设计中的 410

**位置**：`apps/api/src/server.ts:335-353`（`databaseRequiredMutationRoutes` 含 `/v1/backups`）、`:409-448`（preHandler）、`:2053-2058`（POST 410）、`:368-372` + `:2070-2074`（DELETE `/v1/backups/:name` 属 lockOnly，410 可达）。

`POST /v1/backups` 的 handler 只做一件事：抛 `ClientRequestError("backup_creation_retired", …, 410)`，注释（server.ts:2043-2052）说明"保留挂载、返回明确维护提示，而不是 404 / 501"，其中 410 而非 501 的理由正是"`apiErrorPayload` 会把所有 5xx 的 message 压掉"。但该路径被登记进 `databaseRequiredMutationRoutes`，于是 preHandler 在 handler 之前就先查 `existsSync(databasePath)`：

```ts
// server.ts:427-431
if (routeUrl !== undefined && databaseRequiredMutationRoutes.has(routeUrl) && !existsSync(databasePath)) {
  return reply.code(409).send({ code: "database_not_ready", message: "本地 RAI 数据库尚未就绪，请先导入或恢复数据" });
}
```

刚装好（无库）、或刚 `DELETE /v1/database` 的应用上，`POST /v1/backups` 得到 409 `database_not_ready`，而不是文档承诺的 410 `backup_creation_retired`；同族的 `DELETE /v1/backups/:name` 因为被归到 `lockOnlyMutationRoutes` 反而能正常返回 410。两个"同一个退役决策"的端点，响应语义取决于各自被塞进哪张表。

**建议**：把 `/v1/backups` 从 `databaseRequiredMutationRoutes` 移到 `lockOnlyMutationRoutes`（它本来就不碰库），或在 handler 之前短路 410。

**未验证边界**：无（静态；`schemas.test.ts`/`server-runtime.test.ts` 只校验"分类存在"，不校验"分类是否让语义可达"）。

---

### A8（P3，跨 lane）`coach_loop_contract_required` 409 不在客户端终局码集合

**位置**：服务端 `apps/api/src/server.ts:409-421`；客户端 `apps/ios/RAI/PlanMutationDisposition.swift:32-52`、`apps/ios/RAI/NativeAppModel.swift:1543-1560`。

当数据集已被新版教练合同接管（`coachLoopManaged()`），preHandler 对一批旧协议路由返回：

```ts
return reply.code(409).send({ code: "coach_loop_contract_required",
  message: "当前课表由新版教练合同管理，请使用 /v1/mobile/coach-loop；旧协议不能执行追加课。" });
```

这批路由的匹配前缀是 `["/v1/mobile/today","/v1/mobile/run-coach","/v1/mobile/training-plan-state","/v1/mobile/workout-plan","/v1/mobile/goals","/v1/mobile/lock"]`，因此 **`POST /v1/mobile/workout-plan/synced` 也被拦**（它 `startsWith("/v1/mobile/workout-plan")`）。而 iOS 只在 `receipt.contractVersion == 2 || receipt.coachLoop != nil` 且 `coachLoop == nil` 时才走这个端点（`APIClient.swift:225-250`）；旧手动计划排期回执（coachLoop 为 nil 的 legacy/v2）正是走它。

客户端错误处置：`coach_loop_contract_required` **不在** `terminalPlanReceiptErrorCodes` 里（PlanMutationDisposition.swift:44-52 只有 5 个 `plan_receipt_*` + 2 个 `coach_receipt_*`），所以该回执被"保留重试"，用户看到的是"X 天的系统日程回执未在服务端登记；可前台重试"——但服务端在 coach-loop 接管期间**永远**会 409，重试不可能成功；只有结束教练合同后才会放行。

**影响判断**：不是数据错误，且需要"先有 legacy 排期回执待登记、再启用教练合同"这一窄时序才会出现；`hasPendingPlanReceipts` 又会反过来限制教练相关开关（iOS 已在 `NativeAppModel.swift:1542` 的注释里记录过这个"永久锁死"形态，闸门在 `:472`、定义在 `:1462`）。是否构成真实用户闭环需要 iOS 侧确认（Lane 4），故标 E1 跨 lane、P3。

**建议**：二选一——服务端把 `/v1/mobile/workout-plan/synced` 排除出该门（回执不是"执行追加课"），或把 `coach_loop_contract_required` 加入客户端终局码并作废该条回执。

**未验证边界**：未在 iOS 上跑通该时序（真机/Simulator 属 Lane 4，且需要构造 coach-loop 已启用 + legacy pending 回执）。

---

### A9（P3）全量 SQLite 下载缺 `no-store`，`content-disposition` 拼接请求参数

**位置**：`apps/api/src/server.ts:2060-2065`。

```ts
app.get<{ Params: { name: string } }>("/v1/backups/:name", { schema: { params: backupParamsSchema } }, async (request, reply) => {
  const stream = await maintenance.backupStream(request.params.name);
  reply.header("content-type", "application/x-sqlite3");
  reply.header("content-disposition", `attachment; filename="${request.params.name}"`);
  return reply.send(stream);
});
```

两点小问题：

1. 这是**整个健康数据库**的下载，却没有 `Cache-Control: no-store`（同文件的 `/v1/mobile/*`、`/v1/diagnostics`、`/v1/exports/workout-summary` 都加了）。Token 保护仍在，但中间缓存/代理没有语义禁止缓存整库。
2. `content-disposition` 直接把请求参数拼进头部：`backupParamsSchema` 的 pattern 是 `^[^/\\]+\.sqlite$`（schemas.ts:31-38），允许 `"`、空格、`;` 等字符（例如 `a";b.sqlite`），虽然最终路径受 `basename`+`endsWith` 双重校验（maintenance.ts:237-249）不会越界，但响应头内容不是 app 生成的规范文件名。Node 会拒绝换行符，不会造成头注入，属健壮性问题。

**建议**：`reply.header("Cache-Control", "no-store")`；`filename` 用 `basename` 后做白名单化（或统一用 `encodeURIComponent` 的 `filename*=UTF-8''…`）。

**未验证边界**：无（静态）。

---

## 4 证据等级与未验证边界

| 结论 | 证据 | 说明 |
| --- | --- | --- |
| 写路由/读路由分类完整（无未登记路由） | E2 | `server-runtime.test.ts` 用 Fastify 真实 `onRoute` dump 对比三张注册表，实跑通过 |
| 匿名读默认 fail-closed、Host/Origin 生效、常量时间比较 | E2 | `local-request-security.test.ts` 16 项全绿（含 "without a public host list nothing is readable without a token"） |
| ZIP 上传硬化（路径/符号链接/压缩比/声明大小/预算/临时目录清理） | E1 | `import-sources.ts:330-420,615+`；本 lane 未构造恶意 ZIP 实跑（不做真实上传包实验），标 E1 |
| 分享卡只在服务端裁剪、匿名详情不查坐标 | E2 | `share-card.test.ts` + `privacy-zones.test.ts` 实跑（14 项几何/防弦线用例）；`data.ts:1517,1525,1544-1548` |
| token 不进日志/错误体 | E1 | 全仓 grep `authorization` 仅鉴权处；Fastify logger 无自定义 serializers；`apiErrorPayload` 不回显请求头 |
| 4xx 语义（409 CAS、410、413/415/429/507、503+Retry-After） | E2 | `plan-error-semantics.test.ts`、`api-error.test.ts` 实跑 |
| guard 在跨进程并发下不返回混合快照 | E2 | `plan-publication-stress.test.ts` 两进程 300 次发布 + 2000 次 guard 读，`inconsistent_200=0` |
| A1 的 WAL checkpoint ⇒ mtime 机制 | E2 | `/tmp` 合成库探针（§1.2 #8） |
| A1 在生产数据量/真实库上的触发频率 | **未验证** | 不允许读写 `var/rai.sqlite`；频率结论由机制 + 延迟数据推断 |
| A3 崩溃遗留 marker 的真实重启时序 | **未验证**（E3） | 只做了语义/代码路径核对，未 kill -9 真实写入 |
| A4 生产写频率下的 503 比率 | **未验证** | 压力夹具是人为 4ms/2ms 连续发布，不代表生产 |
| A8 的真实用户闭环 | **待 Lane 4 确认** | 需要 iOS 侧构造 coach-loop 已启用 + legacy pending 回执 |
| 真实 import worker 与 HTTP 读并发 | **未验证** | `plan-publication-stress.test.ts` 自身声明该路径仅合成覆盖；本 lane 不做真实导入 |
| `apps/ios` 全量门禁 | 不在本 lane | 由 Lane 4 跑 `npm run test:ios` |
| `deploy/` 模板本身 | 不在本 lane | 由 Lane 5 负责；本 lane 只引用其与代码安全口径的不一致（A2） |

---

## 5 与既有审查的关系

### 5.1 历史审查项在 HEAD 的状态（仅本 lane 范围）

| 历史项 | 当前状态 | 证据 |
| --- | --- | --- |
| 回执 v2 线格式（Swift 省略 nil vs 规范形状） | **先前已修，当前已修** | `plan-receipt.ts:45-89` 先规范化再比较；`normalizeSessionStructure` 允许 nil 省略；`plan-receipt-v2.test.ts` / `plan-receipt-identity.test.ts` 实跑通过 |
| revision 冲突 409（而非 500） | **先前已修，当前已修** | `MobileGoalsRevisionConflictError.statusCode = 409`（mobile-goals.ts:1249-1258）；`/lock`、`/goals`、`/confirm`、coach-loop 各自 catch 并带 `currentRevision`；`plan-error-semantics.test.ts` 实跑通过 |
| coach-loop 跨库回验 | **先前已修，当前仍成立** | `readStableSnapshot` + `publicationGuardChanged`；`plan-read-consistency.test.ts` 实跑通过；跨进程压力 test 实跑通过 |
| 503 `Retry-After` | **先前已修；当前仍有覆盖缺口** | `retryAfterSeconds` 只对 429/三个 503 码生效（api-error.ts:43-56）；`restore_recovery_required` 这类"领域 5xx"仍被压成 internal_error（A5） |
| publication guard | **新落地，行为成立** | 跨进程压力 test 实跑通过；遗留 marker/无退避属新增可用性/恢复边角（A3、A4） |
| 幂等键 scope 分区 | **先前已修，当前已修** | `migratePlanPushIdentity` + `(scope_key, idempotency_key)` 唯一索引（mobile-goals.ts:1087-1175）；`plan-receipt-identity.test.ts` 实跑通过 |
| `/synced` 同事务 `matchesCurrent` | **先前已修，当前已修** | server.ts:1246-1305；transaction 内读快照并登记回执，事务外不再二次读；A4 只讨论持锁时长，不质疑正确性 |
| 上传 ZIP 限额 4GiB→64MiB | **已修，当前成立** | `server.ts:136-139`（默认 64 MiB，env 可覆盖）+ multipart `fileSize` 限制 + `saveUpload` 预算三处；nginx 侧 4g 是"不小于"的宽松值（模板归 Lane 5） |
| Web 退役后 `/v1` 路由保留 | **当前成立** | 备份/模型/数据运维/审计/导入管理/手工成绩/隐私区/性能遥测路由均仍在 `mountedRoutes`（`server-runtime.test.ts` 全量 dump 对比通过）；`/v1/performance` 作为运维遥测路由保留，未被误删 |

### 5.2 与同轮其他 lane 的分工

- A8 的服务端部分在本 lane，**客户端终局码是否该补**需 Lane 4 复核（`PlanMutationDisposition.swift` 归 iOS 范围）。
- A2 提到的 `deploy/rai.env.example` 注释与 nginx 模板口径归 Lane 5；本 lane 只指出"代码侧公开集合"与"部署侧文案"不一致。
- A5 的 5xx 白名单与 `docs/IOS_NATIVE_API_CONTRACT.md` 的错误码表若有关联，需要 Lane 4/文档 owner 一起更新。

### 5.3 明确没有重报的项

以下均为**核实后确认在 HEAD 已修复/不成立**，本轮不重报：`/v1/export` 匿名泄露、share-card 原始坐标泄露（D9）、幂等键跨库串用、回执 v2 严格形状导致真实回执被拒、`/lock` 500、`/confirm` 丢失已提交结果（已改为恒记忆）、`/goals` weekPlan 无库仍可写（已加 409）、handshake 与 legacy 路由门禁自相矛盾（已改为不宣告 `planSnapshotContractVersion`）、`MobileGoalsDatabaseBusyError` 500（已改 503 + `database_busy` + Retry-After）。
