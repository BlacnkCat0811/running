# 阶段 1：no-op 回执事务迁入 ingest worker（补修与验收补齐）

**状态：** 阶段 1 补修完成，进入阶段 2 的条件已满足；**未启动阶段 2**
**日期：** 2026-10-21（Asia/Shanghai）
**基线：** 当前工作树，HEAD `9db450f1ba3a`；阶段 1 之前已有工作区修改全部保留
**范围：** B8 no-op 回执事务的 worker 化、关闭/回执可靠性补修、真实故障回归与 HTTP 验收

---

## 1. 结论

1. **worker 冷启动期间 close 悬挂已修复。** 每个 resident 现在有只能结算一次的启动状态；
   `ready`、`error`、任意退出码的 `exit` 与主动退休都走同一个结算入口。`close()` 等待
   所有已退休线程的真实 termination，而不是只等最后一条或忽略 pending Promise。
2. **严格回执读取不再把“无法读取”当成“没有回执”。** 已移除
   `existsSync(path) → null`；数据库缺失、不可打开、表/查询失败、回执 JSON 损坏或解析成
   `null` 全部抛错。只有成功查询且确实没有回执行才返回 `null`。
3. **恢复阻断不再发布终态或触发来源清理。** 无法核实提交结果时，作业保持
   `running + recovery_required`，`onTerminal` 不执行；server 的
   `onRecoveryRequired` 同时调用 `taskAdmission.blockUntilRestart(...)`，阻断全局单写者，
   而不只是停止导入队列。
4. **真实故障回归已补齐。** 新测试使用真实 `worker_threads.Worker` 与真实 no-op 事务：
   ready 前 close、ready 前 exit/error、提交后回复丢失并终止线程、提交前线程失败、
   数据库不可访问恢复阻断、重复 close 等均有外层截止时间。
5. **可复现 HTTP 证据已补齐。** `RAI_PHASE1_MODE` 现在选择持久化源码快照，不是修改输出
   标签。5 轮 × 60 秒、1.2 秒外部写锁、真实 HTTP
   `upload → inspect → import-jobs → poll` 的结果：锁等待 event-loop max 中位数
   **1067.5 ms → 61.1 ms**，健康检查 P95 中位数 **1061.9 ms → 17.6 ms**。
6. **冷启动仍是已知残留，不通过预热掩盖。** 本轮单独测得首包 **834.0 ms**；它不阻塞
   事件循环，但仍是后续独立优化项，不写成已解决。

---

## 2. 代码变更

### 2.1 worker 启动、退休与关闭

[import-worker.ts (line 252)](../apps/api/src/import-worker.ts)

- 新增 `IngestWorkerStartup`：`settled` + 单次 `resolve/reject`；`ready` 从一开始就是
  可失败的 Promise，不再先塞一个 `Promise.resolve()` 再替换。
- [ensureIngestWorker (line 1079)](../apps/api/src/import-worker.ts)
  在关闭期间拒绝创建线程；有效 `ready` 只结算一次；`error` 与 `exit`（不区分退出码）
  都会进入退休路径。
- [retireIngestWorker (line 1183)](../apps/api/src/import-worker.ts)
  先拒绝未结算的 `ready`，再按 taskId 拒绝在飞任务；终止 Promise 只创建一次，
  所有调用方共享。`termination` 的 rejection 被显式消费，不会变成进程级
  `unhandledRejection`。
- [close (line 499)](../apps/api/src/import-worker.ts) 等待所有已退休
  ingest 线程退出后再等 `runPromise`；不会提前释放许可或忽略 pending。
- [databaseTask (line 1265)](../apps/api/src/import-worker.ts) 在进入
  派发前、`await ready` 返回后、以及重试前检查 `closing`；关闭引发的启动 rejection
  不会被当成“再起一条线程”的重试信号。
- 旧线程的迟到 `ready` 被 `resident.retired` 拦住；迟到回复按 taskId 找不到等待者，
  只记日志，不改变新线程状态。

### 2.2 严格回执裁决

[import-publication.ts (line 49)](../apps/api/src/import-publication.ts)
新增 `parseStrictImportReceipt`；[line 82](../apps/api/src/import-publication.ts)
的 `readImportReceiptStrict` 直接以 `readOnly` 打开数据库：

- 数据库缺失 ⇒ 打开失败上抛，且不会创建空数据库；
- 数据库损坏/不可读、`import_manifest` 查询失败 ⇒ 上抛；
- 有回执行但 JSON 损坏、解析成 `null`、不是对象或缺少长期必填字段 ⇒ 上抛；
- 只有**成功查询且没有该 job 的回执行**才返回 `null`。

宽松的 `readImportReceipt` 保持原语义，只用于启动时尽力恢复；历史回执格式没有迁移。

### 2.3 恢复阻断与终态边界

[import-worker.ts (line 808)](../apps/api/src/import-worker.ts)
在 `writeMayHaveCommitted` 的 catch 路径：

- 先退休仍存活的 ingest 线程并等待真实 termination；
- 用严格读取裁决；查不到回执才走既有失败流程；
- 读取抛错或线程终止无法确认时设置 `terminalDecisionWithheld`、`recoveryBlocked`，
  作业保持 `running + recovery_required`，不发布 summary/status；
- [line 923](../apps/api/src/import-worker.ts) 的 finally 在 withheld
  分支跳过 `onTerminal` 和来源清理，只落诊断性能账本。

[server.ts (line 597)](../apps/api/src/server.ts) 的
`onRecoveryRequired` 同时设置 `databaseRecoveryRequired`、使 readiness 失效，并调用
`taskAdmission.blockUntilRestart("import_publication_recovery_required")`。测试
`import-worker-reuse.test.ts:590` 直接验证该回调会让 `admission.acquire()` 返回 `null`。

### 2.4 基准与证据

- [noop-lock-bench.ts](../deliverables/phase1-main-thread-blocking/bench/noop-lock-bench.ts)
  按 `RAI_PHASE1_MODE` 从 `snapshots/<mode>/apps/api/src` 物化独立 API 子进程；
  不导入当前源码，不调用私有 `run()`。
- [noop-resource-bench.ts](../deliverables/phase1-main-thread-blocking/bench/noop-resource-bench.ts)
  同样通过真实 HTTP 入口测量冷启动与连续 100 批。
- 三个快照分别对应：阶段 1 之前、阶段 1 原实现、补修后实现。快照哈希、差异和复现方式见
  [snapshots/manifest.json](../deliverables/phase1-main-thread-blocking/snapshots/manifest.json)
  与 [bench/README.md](../deliverables/phase1-main-thread-blocking/bench/README.md)。

---

## 3. 故障矩阵

| 场景 | 测试 | 结果 |
|---|---|---|
| worker 创建后、ready 前 close | `import-worker-reuse.test.ts:381` | 通过：ready 结算、线程退出、close 完成、`started=1`、重复 close 不重复退休 |
| ready 前真实 exit（实际退出码 0） | `import-worker-reuse.test.ts:425` | 通过：启动等待被结算，任务 failed，不悬挂 |
| ready 前 error 事件 | `import-worker-reuse.test.ts:456` | 通过：启动等待被拒绝，close 在截止时间内完成 |
| 关闭与派发重试竞争 | `import-worker-reuse.test.ts:381` | 通过：关闭期间不新建线程、不派发任务 |
| 提交后回复丢失、真实线程终止 | `import-worker-reuse.test.ts:489` | 通过：拦截真实 worker 回复并 terminate，严格读取持久回执恢复同一成功结果 |
| 提交前线程失败 | `import-worker-reuse.test.ts:538` | 通过：外部写锁持有期间终止真实线程，无回执、无半提交、任务结算 |
| 提交结果不确定且原数据库不可访问 | `import-worker-reuse.test.ts:590` | 通过：`running/recovery_required`、`hasPending=true`、全局 admission 被阻断、`onTerminal` 未调用 |
| 有效数据库中查无回执 | `import-publication.test.ts:186` | 通过：只有成功查询且无行时返回 `null` |
| 数据库缺失 | `import-publication.test.ts:201` | 通过：上抛且不创建空数据库 |
| 数据库损坏、JSON 损坏、JSON `null`、字段损坏 | `import-publication.test.ts:215` | 通过：全部上抛 |
| 进入提交区后取消 | `import-worker-reuse.test.ts:332` | 通过：返回 `publishing`，线程不退休，提交后仍成功 |

每个故障测试均设置 25–30 秒外层 `timeout`；辅助 `closeWithDeadline` 在超时时终止真实线程并
判失败，不把“超时”当成关闭成功。

---

## 4. 验收证据

### 4.1 源码快照

| 快照 | 作用 | apps/api/src 指纹 |
|---|---|---|
| `baseline` | 阶段 1 之前：no-op 回执事务在主线程；四个阶段 1 文件取 HEAD，其他工作区修改保留 | `163e0d9d…a42975` |
| `phase1-prefix` | 阶段 1 原实现：worker 化但关闭/严格回执未补修 | `f198b3a5…e53575` |
| `repaired` | 本轮补修后的当前实现 | `b72cc56e…d80c0f` |

差异文件：

- `snapshots/phase1-prefix-from-baseline.diff`
- `snapshots/repaired-from-phase1-prefix.diff`

每个快照目录带 `SHA256SUMS`。基准 JSON 记录实际执行的 fingerprint。

### 4.2 锁等待：5 轮 × 60 秒（真实 HTTP）

方法：隔离 API 子进程、外部 SQLite writer 持 `BEGIN IMMEDIATE` 1.2 秒、每轮一次真实 no-op
导入、四个并发请求循环交替请求 `/v1/health` 与 `/v1/dashboard`；`event-loop max` 在锁释放时
采样，专门覆盖 `BEGIN IMMEDIATE` 等待窗口。原始逐请求数据为 `.requests.ndjson.gz`。

| 指标 | baseline | phase1-prefix | repaired | 门槛 |
|---|---:|---:|---:|---:|
| event-loop max 中位数 | 1067.5 ms | 57.9 ms | **61.1 ms** | ≤100 ms |
| event-loop max 最差轮 | 1076.9 ms | 71.4 ms | **63.8 ms** | ≤100 ms |
| 健康检查 P95 中位数 | 1061.9 ms | 12.2 ms | **17.6 ms** | ≤250 ms |
| 健康检查 P95 最差轮 | 1063.1 ms | 19.5 ms | **28.4 ms** | ≤250 ms |
| 普通读 P95 中位数 | 1051.9 ms | 17.4 ms | **16.8 ms** | 记录项 |
| 5xx（锁窗口） | 0 | 0 | 0 | 0 |

补充：

- repaired 全轮 event-loop max 最差为 **90.6 ms**，也低于 100 ms；prefix 为 96.7 ms。
- 从 baseline 到 repaired，锁窗口 event-loop max 中位数下降 **94.3%**，健康检查 P95 下降
  **98.3%**。
- prefix → repaired 的锁窗口中位数 57.9 → 61.1 ms、健康 P95 12.2 → 17.6 ms，均在测量噪声
  和门槛内，没有引入可观测回归。
- 每轮锁窗口样本约 238–292 个请求；5 轮共 5 次真实 no-op 导入，全部成功。
- `baseline` 运行不启用 `enforce`（它是反证基线，本来就应失败）；`repaired` 运行启用
  `enforce`，JSON 中的 `threshold` 为全 true。`phase1-prefix` 也通过同一门槛。

原始数据：

- `evidence/http-lock-baseline.json`
- `evidence/http-lock-phase1-prefix.json`
- `evidence/http-lock-repaired.json`
- 对应 `*.requests.ndjson.gz`

### 4.3 冷启动、无竞争与 100 批资源

通过同一真实 HTTP 入口，首次 job 单独记为冷启动，随后连续 100 批 no-op：

| 指标 | baseline | phase1-prefix | repaired |
|---|---:|---:|---:|
| 冷启动首包 | 192.8 ms | 843.6 ms | **834.0 ms** |
| 100 批 p50 | 437.8 ms | 471.0 ms | **435.4 ms** |
| 100 批 P95 | 482.7 ms | 569.8 ms | **474.8 ms** |
| 100 批 max | 673.5 ms | 814.3 ms | **609.0 ms** |
| 结束后 `importPending` | false | false | **false** |
| 导入临时文件 | 0 | 0 | **0** |
| 100 批 5xx | 0 | 0 | **0** |
| 进程 RSS 起始 → 结束 | 177.4 → 116.2 MiB | 185.8 → 159.6 MiB | 172.1 → 151.9 MiB |

无竞争 P95 增量（repaired − baseline）= **−7.9 ms**，门槛为 `max(10% × 482.7, 20 ms) = 48.3 ms`，通过。
repaired 相对 prefix 的 P95 还下降了 95.0 ms。

冷启动仍比 baseline 多约 641 ms；这是一次性 resident worker 创建成本，已单列，不用预热隐藏。
线程复用由 `import-worker-reuse.test.ts` 的真实计数覆盖（20 小批 `started=1/tasks=20`）。

---

## 5. 测试与门禁

在最后一次生产代码修改之后执行：

```bash
npm run typecheck
RAI_TEST_CONCURRENCY=2 npm test
npm run check:package-boundaries
npm run check:training-plan-single-writer
npm run check:acceptance-matrix
npm run check:scripts
npm run check:docs
npm run smoke:api
git diff --check
```

结果：

- `typecheck`：通过；
- 导入相关聚焦测试：`59/59` 通过（含新增真实 worker 故障回归）；
- 全量测试：首轮 `2246` 项、`2232` 通过、`1` 失败、`13` 跳过；失败点是既有
  `server-runtime.test.ts` 用宽松读取在 server 持有瞬时读锁时误读为 `null`。该断言改为
  严格读取后单独复现通过（生产代码未因此修改），第二轮全量 `2246` 项、`2233` 通过、
  `0` 失败、`13` 跳过，`RAI_TEST_CONCURRENCY=2`，耗时约 534 秒，退出码 `0`。
- `check:package-boundaries`：16 包 / 31 条 src 边 / 4 条禁线，通过；
- `check:training-plan-single-writer`：467 生产源 / 124 测试源 / 0 违规，通过；
- `check:acceptance-matrix`：80 条 / cited 80 / missing 0，通过；
- `check:scripts`：18 个 package.json / 105 条 script，通过；
- `check:docs`：54 个文档 / 548 条本地链接 / 0 问题，通过；
- `smoke:api`：隔离 runtime root 下健康检查与 SIGTERM 关闭通过；
- `git diff --check`：通过。

新增故障测试已进入 `apps/api/test/*.test.ts` 聚合发现链；`scripts/run-tests.mjs` 会从
`apps/api/test` 递归发现，无需单独手工入口。

---

## 6. 进入阶段 2 条件核对

| 条件 | 证据 | 状态 |
|---|---|---|
| 启动期间关闭不再悬挂，关闭期间不重建线程 | 真实 worker 测试 381/425/456；started=1 | 通过 |
| 数据库不可读取时不误判“没有提交” | 严格读取测试 186/201/215；恢复阻断测试 590 | 通过 |
| 真实 worker 提交前失败、提交后回复丢失、恢复阻断测试通过 | 489/538/590 | 通过 |
| HTTP 并发响应及最终回归门禁通过，证据可复现 | 5×60 锁窗口证据；快照与逐请求数据；全量门禁 | 通过 |
| 报告保留冷启动残留与未测生产资源边界，不宣称全部解决 | §4.3、§7 | 通过 |

**结论：阶段 1 补修与验收补齐完成，满足进入阶段 2 的条件。按本次指令停在这里，未进入阶段 2。**

---

## 7. 残留风险与未验证边界

- **冷启动 834 ms**：一次性 worker 创建/模块加载成本，未纳入 100 ms 锁窗口门槛，也未通过
  预创建线程掩盖；后续应作为独立优化项评估。
- **生产 2 核 2 GiB 容量未测量**：本报告全部 HTTP 数据来自 Darwin 开发机隔离子进程，
  不是生产容量结论。
- **HTTP 负载模型有限**：每轮一个 1.2 秒锁窗口 + 60 秒持续健康/普通读请求，4 并发；
  全轮 max 已记录，但不代表所有生产流量形态。
- **100 批是单次观测**：RSS 没有持续增长、`pending=false`、无导入临时文件，但这不等于
  对所有载荷规模的内存上界证明。
- `/v1/performance?reset=1` 仅由 `RAI_PHASE1_BENCH_RESET=1` 在验收环境启用，默认部署
  不改变诊断语义；它不参与业务路径。
- 本批没有修改 schema、SQL 索引、导入车道、回执格式或 iOS；阶段 2 的分批/预热方案未启动。

---

## 8. 回滚

本批没有 schema、持久格式或公开 API 破坏性变化，回滚采用代码回退：

1. 停止任务准入；
2. 等待 ingest worker 与写事务退出；
3. 用严格读取核实相关 job 的持久回执和终态；
4. 回退代码版本；
5. 启动兼容版本。

回滚前不得删除回执、队列、上传目录或数据库文件。已提交的 no-op 回执是合法业务记录，
代码回退不需要回退数据。

---

## 9. 证据索引

- [snapshots/manifest.json](../deliverables/phase1-main-thread-blocking/snapshots/manifest.json)
- [bench/README.md](../deliverables/phase1-main-thread-blocking/bench/README.md)
- [evidence/README.md](../deliverables/phase1-main-thread-blocking/evidence/README.md)
- `evidence/http-lock-{baseline,phase1-prefix,repaired}.json`
- `evidence/http-resource-{baseline,phase1-prefix,repaired}.json`
- `evidence/superseded/README.md`：旧标签式 baseline 与非 HTTP 资源的不可复现限制

---

## 10. 限制

- 基准机器为 Darwin、开发机，不是生产 2 核 2 GiB 环境；
- `monitorEventLoopDelay` 分辨率 20 ms；
- 本轮只对 no-op 回执路径和工作区已有的读路径做验收，没有覆盖所有导入载荷；
- 全量测试实际并发数、失败、跳过以第 5 节记录为准；
- 未测量项继续登记为未测量，不写成“无问题”。
