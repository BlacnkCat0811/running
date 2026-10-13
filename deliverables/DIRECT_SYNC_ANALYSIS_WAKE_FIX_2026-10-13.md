# 直连车道「分析任务无人唤醒」修复（2026-10-13）

## 0. 结论

`direct-sync` 车道在同一个主库事务里登记了 `recompute_jobs` 行，但**没有任何代码在登记之后唤醒消费者**
（`RecomputeWorker.schedule()`）。后果不是"分析慢一点"，而是**写通道被永久封死**：
`isDatabaseWriteBusy()` 把 `status='queued'` 算作忙 ⇒ 所有写端点 409，
而被 409 的请求走不到它后面的 `schedule()` ⇒ 这条链没有自愈路径。

修复 = 补上唤醒点（`onTerminal`）+ 加一道**低频兜底巡检**（任何来源漏唤醒都在一个周期内自愈）。

---

## 1. 症状（线上实测）

| 项 | 值 |
|---|---|
| 触发 | 2026-10-13 17:22:46 / 17:23:34 两轮 iOS 同步（UA `RAI/1 CFNetwork/...`） |
| 卡住的任务 | `recompute_job_0df5316b-4723-429d-aa85-464fe7908906` |
| `status` | `queued`（直到 17:31:36 复查仍是） |
| `started_at` | `null`（**从未被 claim**） |
| `recompute_job_events` | 只有一条 `Task queued`，**没有 `claimed`** |
| 连带 | `runtime-status.busy = true`；11 个写端点全部 409 |

## 2. 根因

**单点**：`apps/api/src/server.ts:483` 的 import 终态回调 `onTerminal` 只做导入源清理，
不含 `recomputeWorker.schedule()`。

**为什么旧链路不需要它**：旧链路 spawn CLI 子进程，子进程内联自我消化
（`packages/application/src/model-v2-cli.ts:75` 的 `service.runNextJob()`）。
直连快车道**不 spawn CLI**（这正是本轮改造的收益），于是那个消费者一并消失。

### 2.1 登记方 vs 唤醒方（穷尽清单）

生产代码里往主库登记分析任务的入口共 5 处，逐条核对唤醒路径：

| 登记入口 | 位置 | 唤醒路径 |
|---|---|---|
| **direct-sync 车道** | `apps/api/src/direct-sync-ingest.ts:509` | ❌ **无 —— 本次缺陷** |
| 训练区回填 | `apps/api/src/server.ts`（`enqueueFullRecompute` / `enqueueSnapshotRefresh`） | ✅ 同函数内 `if (queued && !closing) recomputeWorker.schedule()` |
| `POST /v1/model-runs` | `apps/api/src/server.ts` | ✅ 紧跟 `recomputeWorker.schedule()` |
| `CommandQueue` 应用 | `apps/api/src/command-queue.ts:203,206` | ✅ `server.ts` 的 `onApplied` 回调里 schedule |
| workout override | `packages/application/src/service.ts`（`appendWorkoutOverride`） | ✅ 路由内紧跟 schedule |

### 2.2 为什么 5 分钟定时器没能救活

`checkTrainingZoneBackfill` **只在它自己 enqueue 时**才 schedule（`if (queued && !closing)`）。
它既不"发现队列里有任务"，也不巡检 ⇒ zone profile 已是最新时它什么也不做。

### 2.3 消费端**不**是缺口

- `packages/contracts/src/index.ts`：`PAYLOAD_SCOPED_JOB_OWNERSHIP` 里 `import` 的
  `applicationRequestModes` 含 `DIRECT_SYNC_ANALYSIS_REQUEST_MODE`；
- `packages/application/src/service.ts` 的 `runNextJob()` 有 `import` → `runDirectSyncAnalysis` 分支。

⇒ 唤醒后能正常跑。缺陷纯粹是"没人叫醒它"。

### 2.4 为什么既有测试全绿却没抓到

本仓涉及该链路的用例**都直接调 `service.runNextJob()`**（例如
`apps/api/test/direct-sync-analysis-registration.test.ts` 的步骤 1 用例）。
它们回答的是"消费者能不能跑"，从不回答"生产里谁在登记之后唤醒它"。

同族纪律：**"消费者存在" ≠ "消费者会被叫醒"**。

---

## 3. 改动（4 个文件，+120 行）

### 3.1 `apps/api/src/server.ts`

① import 终态回调补唤醒（`onTerminal` 内）：

```ts
recomputeWorker.schedule();
```

放在**终态回调**而不是某条成功分支里 —— 失败路径同样可能留下已登记的任务。

② 低频兜底巡检（`recomputePollTimer`，60 s，`unref()`）：

```ts
const recomputePollTimer = setInterval(() => {
  if (closing) return;
  recomputeWorker.wakeIfPending();
}, 60_000);
recomputePollTimer.unref();
```

### 3.2 `apps/api/src/recompute-worker.ts`

新增 `wakeIfPending(): void` —— **只在确有待处理任务时**才 `schedule()`；
空闲时只做一次只读 `SELECT`（`hasPending()`），**不 spawn worker 线程**，稳态成本约等于零。
库暂不可用时走既有的 `onDatabaseError` 通道并返回，不改变失败语义。

### 3.3 测试

| 文件 | 新增 |
|---|---|
| `apps/api/test/recompute-worker.test.ts` | 行为级：空队列不动作；有 queued 任务就唤醒 |
| `apps/api/test/direct-sync-analysis-registration.test.ts` | 源码级：`onTerminal` 里必须有 `schedule()`；`server.ts` 必须有 `wakeIfPending()` 调用；`RecomputeWorker` 上必须存在该方法 |

---

## 4. 验证（实跑）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0**（日志 `runlogs/2026-10-13-typecheck-wake-fix.log`） |
| 两个新增/修改的测试文件 | **11/11 pass，EXIT=0** |
| 受影响面批 1（write-lease 等） | **18 ok / 0 not ok** |
| 受影响面批 2（analysis-failure-isolation、direct-sync-* 共 6 文件） | **33/33 pass，EXIT=0**（`runlogs/2026-10-13-wake-fix-batch2.log`） |
| 受影响面批 3（server-runtime、worker） | **128 用例 / 127 pass / 0 fail / 1 skip**（skip 是 Windows 专属用例，平台性跳过）—— 修复后重跑，见 §4.3 |
| 最终确认：两个测试文件连跑 2 次 | **12/12 pass，EXIT=0**（`runlogs/2026-10-13-final-run1.log`、`run2.log`） |

### 4.1 突变验证（跑绿 ≠ 断言有效）

五条断言**逐条突变到红**，且已全部恢复（`git diff` 复查无残留）：

| 突变 | 期望 | 实测 |
|---|---|---|
| 删掉 `onTerminal` 里的 `recomputeWorker.schedule()` | 源码守卫红 | ✅ `not ok 7` |
| 删掉巡检里的 `recomputeWorker.wakeIfPending()` | 源码守卫红，且错误消息点名"兜底巡检被移除" | ✅ 命中预期文案 |
| `wakeIfPending` 改名 | 源码守卫红 + 行为用例 `TypeError` | ✅ |
| `if (pending)` → `if (false && pending)`（**方法仍在、逻辑失效**） | 行为断言红，且**不是** `TypeError` | ✅ `not ok 4` |
| 同上，**组合验证**是否也红 | 红 | ✅ `not ok 5` |

第 4、5 条是必要的：第 3 条突变红在 `TypeError`，按纪律那不算"抓住行为"。

### 4.2 端到端（此前标注为"未验证"，现已补）

新增用例「组合验证：登记后经唤醒真的被消费者跑完（不 stub spawn）」**不 stub `runOneInWorkerThread`**，
因此覆盖「登记 → `wakeIfPending()` → schedule → worker 线程 → `claimNext()` → `runDirectSyncAnalysis`
→ 终态 `succeeded`」整条链路 —— 即 2026-10-13 线上断掉的那一步。

⚠️ 该用例的**探针**最初用 `readOnly: true` 打开库，撞上 worker 的写事务会抛 `database is locked`
（该连接没有 `busy_timeout`）⇒ 会被误判成"任务没跑完"。已改为读写连接 + `busy_timeout = 5000`，
并把探针读错误吞掉重试（"读不到" ≠ "没跑完"）。这是**夹具**缺陷，不是生产缺陷。

### 4.3 既有失败：409 窗口不足（**非本次引入**，已实测定性）

**现象**：`server-runtime.test.ts` 的 `workout route privacy: token=true, anonymousRoutes=unset` 失败 ——
`POST /v1/performance-entries` 期望 400、实得 409 `任务执行期间不能录入成绩`。

**根因（实测，不是推测）**：该 409 由 `isDatabaseWriteBusy()`（`apps/api/src/server.ts:1133`）发出，
它把「存在 queued/running 的 recompute 任务」算作忙。而这个测试库**自己先跑过一次 full recompute**
（`apps/api/test/server-runtime.test.ts:2260-2261`）⇒ 库里有 `active_model_run` 与
`active_daily_zone_profiles`（实测 2 行）
⇒ 服务启动时 `checkTrainingZoneBackfill` 不再早退（`if (!active) return` 不成立），
走到 `latest_profile_date < localToday()` 分支 ⇒ **`enqueueSnapshotRefresh()`**
（分支归属由实测反证：该 job 终态为 `succeeded` / phase `snapshot_refreshed`，
而 `needsFullTrainingZoneBackfill` 为真会走 `full_recompute`）。
于是从「端口可用」到该 job `succeeded` 之间，**每个写端点都 409**。

实测（复现脚本 `.workbuddy/tmp/repro-409.mts`，本机同环境，场景与该用例逐行对齐）：

| 时刻 | POST 状态 | `busy` | `recomputeJob` |
|---|---|---|---|
| t=34 ms | 409 | true | `queued`，`startedAt=null` |
| t=848 ms | 409 | true | `queued`，`startedAt=null` |
| **t=7545 ms** | **200** | false | `succeeded` / `snapshot_refreshed` |

⇒ 409 持续 **≈7.5 s**（其中 worker 线程 spawn 要重新注册 `tsx`，仓库注释实测同机 ≈2.5 s）；
而容忍机制 `postToleratingStartupRecompute` 只有 **20 × 250 ms ≈ 5.0 s**
⇒ 第 20 次仍拿到 409 ⇒ 断言 400 失败。

**归属**：不是本次改动引入（下表对照），也不是直连同步的缺陷。
它是**测试窗口按"生产速度"设定、而本机 `tsx` 冷启动更慢**造成的边界失败 ——
更快的机器上会绿，属典型 flaky。生产侧含义：服务重启后，启动期重算跑完之前写端点会 409
（本机 ≈7.5 s，生产是编译态、更短）—— 这正是该辅助函数存在的理由。

| 对照步骤 | 结果 |
|---|---|
| 隔离单跑（当前工作区） | ❌ `not ok 1`（1/1 fail） |
| **`git stash` 掉本次两处生产改动后，在干净 HEAD 上隔离单跑** | ❌ **同样 `not ok 1`** |

**已修（2026-10-13，只改测试文件）**：`postToleratingStartupRecompute` 由「盲重试 20 × 250 ms」
改为「**轮询 `/v1/runtime-status` 直到 `busy === false`，再发那一次要断言的请求**」，
预算 60 s，超时抛**点名原因**的错误（"启动期重算 60 s 内没有结束"），
而不是把"服务还忙"伪装成"这个接口判错了"。
判据依据：`/v1/runtime-status` 的 `busy`（`apps/api/src/server.ts:982`）含
`recomputeJob.status === "queued" | "running"`，与本场景下的 `isDatabaseWriteBusy()` 等价。

| 验证 | 结果 |
|---|---|
| 隔离跑该用例 | ✅ `ok`（duration 20.3 s，含等待 ≈7.5 s） |
| `npm run typecheck` | **EXIT=0** |
| **突变**：`if (snapshot.busy === false) break` → `if (true) break` | ❌ 回到 `expected: 400 / actual: 409` ⇒ 证明"等待"正是修复点 |

生产代码零改动。

### 4.4 未跑的门禁（如实标注）

- **`npm test` 全量未跑**：本机 `load averages` 实测 9.98 / 8.60 / 5.95，
  按项目纪律全量门禁必须独占跑，否则会伪造"文件级 not ok + 跨目录不相关"的失败。
  已改为按受影响面分 3 批跑。
- **web 侧测试未跑**：本次改动不触碰 `apps/web`。
- 未做**真机 / 真线上服务**复现（本环境只有本机）；但"本机真进程 + 真 worker 线程"这一层已由 §4.2 覆盖。

---

## 5. 残余风险

🟡 `RecomputeWorker.drain()` 在**连续 3 次**取库失败后会调 `failOutstanding(error)`，
把 `queued` 任务判为 `failed`。巡检提高了这条路径的触发概率（周期 60 s），
但在"库被长期独占"的场景下现有调用点同样会触发，**不是本次引入**。
本次修复刻意**不改**这条失败语义（改了风险更大）。

🟡 巡检周期 60 s 意味着"漏唤醒"最坏情况延迟一分钟才自愈。若要求更短，调 `setInterval` 参数即可。

---

## 6. 线上恢复

线上那条卡住的任务**不需要手工干预**：部署（拉代码 → build → 重启 `rai-api`）后，
启动路径的 `recomputeWorker.schedule()` 会把它拾起并跑完。

在此之前，线上写端点仍会持续 409 —— 这是"未部署"的状态，不是新问题。

---

## 7. 状态更新（2026-10-13 晚）：已提交、已推送、已部署

> 本节为**追加**，上文正文保持当时口径不改（历史可追溯）。

### 7.1 提交（5 个，`60678af` 之上；rebase 到远程 `f552908` 后推送）

| SHA | 内容 |
|---|---|
| `e539110` | `docs:` 本报告 + `deliverables/README.md` 登记 |
| `2ba4b2c` | `fix(api):` 直连车道登记分析任务后必须唤醒消费者 |
| `c20b8a0` | `test(api):` 写门禁等待改为按 `runtime-status` 判忙 |
| `c829141` | `fix(ios):` HealthKitSync 6 条类型错误 + 两支回归清单（本批一并收口的当日既有工作） |
| `054b3d3` | `test(gates):` pre-commit 加「iOS 门禁跳过 ≠ 放行」认账闸门（同上） |

最终校验：`git diff 60678af..HEAD --stat` 的 **deletions = 21**，与提交前 `git diff --stat` 逐字节相同。

### 7.2 全量门禁的如实结果

`npm test`（43 分钟）= node **1786 / 1770 pass / 12 fail / 4 skip** + vitest **1 fail / 185**，**EXIT=1**。

逐个降并发复验后分为两类：

| 类别 | 文件 | 判据 |
|---|---|---|
| **环境性红**（全量并发下超时） | `benchmark-import`、`data-only-import-queue`、`import-queue-live`、`native-import-worker`、web `app-token-gate` | 隔离单跑**全绿** |
| **既有红**（3 次复现均红） | `deploy-upgrade`（`backup-reminder` 断言）、`connection-contention`（`open() 只用了 92 ms`） | 单跑仍红，且 `git diff` 对这 2 个文件**为空** |

⚠️ `deploy-upgrade` 那条是 **PR6 退役备份入口、但测试仍在断言 `backup-reminder`** 的遗留 —— 建议单独立项。

### 7.3 部署（`60678af` → `054b3d3`，Fast-forward）

- 影响面：**仅 `apps/api/src/{server.ts,recompute-worker.ts}` 属运行时改动**；
  `package.json` / `package-lock.json` / `apps/web` / `database.ts` / `deploy/` **全空** ⇒ 不 build、无迁移、无 unit 同步
- 迁移只读闸门：`pending: []`、`version: 36`
- 🔴 **备份入口已退役**：`POST /v1/backups` 返回 **410 `backup_creation_retired`**（PR6 的改动）
  ⇒ 改用 SQLite 一致性备份 `VACUUM INTO` → `/var/lib/rai/var/backups/rai.pre-deploy-20261013.sqlite`
- 重启 **20:12:32 CST**，`NRestarts=0`；日志 `Anonymous read enabled ... publicReadRoutes:29, tokenRequiredReadRoutes:20`
  + `RAI local API ready`，无报错

### 7.4 修复的线上闭环证据

| 时刻 | `recompute_job_0df5316b` |
|---|---|
| 17:23:21（修复前登记） | `queued`，`started_at = null` |
| 20:12:01（重启前复查） | `queued`，`started_at = null`（**滞留 2h48m**） |
| 20:12:52（重启后 20 s） | **`running`** ← 启动路径的 `schedule()` 把它拾起 |
| 20:15:15 | **`succeeded`**，`error = null`（partial 重算 ≈2 分 23 秒） |

`busy` 由 `true` 转 `false`。端点核对：health `status:ok` / `databaseReady:true`；
data-summary `issues: []` 且 counts 与迁移闸门时一致；`mobile/today` `state:valid` / `recoveryDate` 为当天；
SPA `/` 与 `/settings` 均 200。
