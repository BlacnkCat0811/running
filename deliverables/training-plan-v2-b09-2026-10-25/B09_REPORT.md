# B09 / S05-01–05（V2-5：一致性、异常恢复和资源）本机证据

- 批次：B09（实施计划 §10、§12.4 T19–T30、§15、§16.1）
- 日期：2026-10-25（Asia/Shanghai）
- 结论先行：**本机 macOS DEV 的故障注入/索引/基线证据已完成；G5 仍阻塞，未通过，不能宣告 B09 完成。**
  未执行 Linux 隔离 2C2G、真实 systemd、真实 SIGKILL 环境和 iPhone 真机；本报告不把这些项目写成已验收。

2026-10-25 续推：[本机崩溃恢复补充](local-crash-followup/REPORT.md)新增真实 SIGTERM/SIGKILL 的 COMMIT 前后恢复证据（16/16 PASS），
并完成当前工作区的全量后端回归（并发 2：2729 项 / 2726 通过 / 3 Windows 专属跳过 / 0 失败）。
下文“未做真实进程 kill”等表述是首轮历史状态，以补充记录更新本机覆盖范围；Linux/systemd/2C2G 的 G5 仍阻塞。

## 1. 代码身份与安全边界

| 项目 | 值 |
| --- | --- |
| 分支 / HEAD | `main` / `1b6a10b4769526b2930090e79860d2f93cc50318` |
| 工作区 | dirty（B01–B10 未提交实现累计；本批未 reset/clean/commit/push） |
| 本批新增源码 | `apps/api/test/training-plan-closed-loop-faults.test.ts`、`apps/api/test/training-plan-closed-loop-explain.test.ts`、`apps/api/test/helpers/training-plan-execution-race-child.ts`、`apps/api/test/helpers/training-plan-benchmark-fixture.ts`、`scripts/bench-training-plan-closed-loop.mjs` |
| 业务源码修改 | **0**（未修改 `apps/api/src`、iOS、contracts 或迁移脚本） |
| 安全隔离 | 所有测试/基准使用 `$TMPDIR/rai-b09-*`、`rai-execution-*`、`rai-latency-*` 临时 runtime/主库/控制库；未读写用户 `var/rai.sqlite`；未部署、未启动生产、未执行生产迁移 |

相关源码/测试最终 SHA256（工作区仍在变动，见 `logs/code-identity.txt` 的验证时点 `git status`）：

```text
5c30d82d…  apps/api/src/training-plan-execution-repository.ts
f17484cf…  apps/api/src/training-plan-execution-commands.ts
37db0a44…  apps/api/src/training-plan-evaluation-repository.ts
00dfafb6…  apps/api/src/training-plan-commands.ts
f809e3c4…  apps/api/src/mobile-goals.ts
```

> 说明：验证期间观察到 `training-plan-execution-commands.ts` 等工作区文件被其他批次继续修改（验证后又加入源变化 reconcile）；本报告按最终运行时哈希记录，不能只把 HEAD 当成本次验证的源码身份。

## 2. 新增测试与断言

### 2.1 B06 每个 SQL 写点 + 业务 COMMIT 失败

文件：`apps/api/test/training-plan-closed-loop-faults.test.ts`（8 个子测试）。
每个失败注入都先记录 `mobile_training_state` revision、state history、session history、current execution、execution history、operation 与 legacy goals revision 的快照，失败后逐项 `deepEqual`，不是只断言“抛了错”。

| 注入点 | 方式 | 结果 |
| --- | --- | --- |
| `mobile_training_state` UPDATE | `BEFORE UPDATE` 触发器 `RAISE(ABORT)` | PASS：状态 revision/状态行不变 |
| `mobile_training_state_history` INSERT | `BEFORE INSERT` | PASS：无状态历史追加 |
| `mobile_training_session_history` INSERT | `BEFORE INSERT` | PASS：冻结课程历史无半条 |
| `mobile_training_execution_history` INSERT | `BEFORE INSERT` | PASS：执行历史无半条 |
| `mobile_training_execution` INSERT（current upsert） | `BEFORE INSERT` | PASS：无 current execution |
| `mobile_plan_operations` INSERT（operation result） | `BEFORE INSERT` | PASS：无 operation 结果 |
| `mobile_training_execution` UPDATE（correct） | `BEFORE UPDATE` | PASS：旧链接 revision 1/run-easy、历史 1 条保持不变 |
| 业务 COMMIT | 延迟 FK（`DEFERRABLE INITIALLY DEFERRED`）在 COMMIT 时抛 `FOREIGN KEY constraint failed` | PASS：所有业务行回滚、`isTransaction=false`，无 operation |

测试日志：`logs/faults-test.log`。B06 的六点 + correct 更新 + COMMIT 共 8 项断言全部通过。

### 2.2 B08 evaluation cursor 写入/COMMIT 失败与 SQLITE_BUSY

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| 首次 refresh，evaluation INSERT 失败 | 无 cursor、无 operation、state revision 不变 | PASS |
| 已有 cursor，refresh no-change，evaluation UPDATE 失败 | 旧 cursor 字节不变、无新 operation、旧操作可 replay | PASS |
| evaluation COMMIT 失败（延迟 FK） | cursor 与 operation result 一起回滚，旧 cursor 仍可读 | PASS |
| 另一连接 `BEGIN IMMEDIATE` 持写锁 | `database_busy` 有界失败（实测 2063 ms），旧 cursor/已提交 op 可 replay；释放后重试成功 | PASS |

日志：`logs/faults-test.log` 的 `B08/S04-03/T23` 子测试。

### 2.3 两真实进程竞争同一 run

`training-plan-closed-loop-faults.test.ts` 启动两个独立 Node/tsx 子进程（`helpers/training-plan-execution-race-child.ts`），父进程预置两堂已完成课程，两个子进程通过 ready/go 文件屏障同时提交同一 run 的 confirm：

- 恰好 1 个 `ok:true`，另 1 个 code = `training_execution_link_conflict`；
- 数据库仅 1 条 current execution、1 条 execution history、1 条 operation；
- 两堂课预期 state revision 不变（预置 completed，confirm 不改 lifecycle）；
- 用胜者完全相同 operationId/载荷重放：结果相同，执行历史仍 1 条，未追加。

日志：同文件 `B06/S05-01/T21` 子测试（winner 为 `synthetic-stable-session`，loser 为 `training_execution_link_conflict`）。

## 3. EXPLAIN QUERY PLAN（S05-03 / M04）

文件：`apps/api/test/training-plan-closed-loop-explain.test.ts`。构造 **1,500** 条 `mobile_training_session_history`、**1,500** 条 `mobile_training_execution`（其中 100 条 confirmed）和 1 条 evaluation，使用真实 schema/repository 写入。

| 查询 | EXPLAIN detail（本机 SQLite 3.51.3） |
| --- | --- |
| session history `(scope, local_date, available_at<=)` | `SEARCH mobile_training_session_history USING INDEX idx_training_session_history_date (scope=? AND local_date=? AND available_at<?)` |
| session history `(scope, plan_instance_id, session_id, available_at<=)` | `SEARCH ... USING INDEX idx_training_session_history_time (...)` |
| current execution `(scope, session_id)` | `SEARCH mobile_training_execution USING INDEX sqlite_autoindex_mobile_training_execution_1 (scope=? AND session_id=?)` |
| confirmed execution `(scope, training_session_id)` | `SEARCH mobile_training_execution USING INDEX idx_training_execution_confirmed_run (scope=? AND training_session_id=?)` |
| evaluation `scope` | `SEARCH mobile_training_plan_evaluation USING INDEX sqlite_autoindex_mobile_training_plan_evaluation_1 (scope=?)` |

断言同时要求 detail 含 `SEARCH`、`USING INDEX`（或具体索引名），且不含 `SCAN`；不绑定完整 plan 字符串，以兼容不同 SQLite 版本的 detail 文案。日志：`logs/explain-test.log`。

## 4. 性能/资源 DEV 基线（不是 G5 通过）

### 4.1 环境与数据

| 项目 | 值 |
| --- | --- |
| 主机 | macOS 26.6.2 / Darwin 25.6.0 / x86_64 |
| CPU | AMD Ryzen 5 3600X 6-Core（6 logical） |
| 内存 | 16 GiB（17,179,869,184 B） |
| Node / SQLite | v22.23.2 / 3.51.3 |
| 主机负载（benchmark 开始/结束） | load average `[22.73, 20.95, 20.10]` → `[14.61, 19.07, 19.45]`（共享 DEV 机，有其他构建/测试进程并行） |
| 样本/并发 | route-inject：cold n=10、hot n=30；HTTP：cold n=1（进程启动后首请求）、hot n=30；benchmark 并发 1 |
| 空库场景 | 主库 0 行；控制库 24 sessions + 24 confirmed executions |
| 约 43k 行场景 | 主库 **43,000** 行：40,600 `health_records` + 400 `canonical_nights` + 400 `canonical_hrv_days` + 400 `workouts` + 400 `training_sessions` + 800 `workout_statistics`；控制库同 24 sessions/24 executions |
| DB 文件大小 | 空库/控制库合计 1,249,280 B；43k 场景合计 20,467,712 B |

命令：

```bash
node --import tsx scripts/bench-training-plan-closed-loop.mjs \
  --json=deliverables/training-plan-v2-b09-2026-10-25/logs/bench-training-plan-closed-loop.json
```

原始结果：`logs/bench-training-plan-closed-loop.json`；运行日志：`logs/bench-training-plan-closed-loop.log`。脚本不接触 `var/rai.sqlite`。

### 4.2 GET `/v1/mobile/training-plan-state` v2（sessions + executions + update）

实际 HTTP（本地 `127.0.0.1` 临时 API 进程，headers：`X-RAI-Training-Contract: 2`、`X-RAI-Training-Sessions: 1`、`X-RAI-Training-Updates: 1`）；route-inject 为同一 Fastify route handler 不含网络/进程跳转的对照。

| 场景 | 路径 | cold | hot p50 | hot p95 | hot p99 | hot max |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 空主库 | HTTP（cold n=1 / hot n=30） | 204.1 ms | 183.7 ms | 248.2 ms | 257.5 ms | 257.5 ms |
| 空主库 | route-inject（cold n=10 / hot n=30） | 87.8 ms p50 | 80.7 ms | 140.3 ms | 148.2 ms | 148.2 ms |
| 43k 行 | HTTP（cold n=1 / hot n=30） | 340.3 ms | 239.1 ms | 378.6 ms | 417.2 ms | 417.2 ms |
| 43k 行 | route-inject（cold n=10 / hot n=30） | 70.5 ms p50 | 67.5 ms | 336.6 ms | 882.2 ms | 882.2 ms |

说明：HTTP 结果包含真实 API 进程、Fastify 队列/序列化与 localhost；route-inject 结果更接近 handler 内成本。**本机负载平均 20+，且 43k 场景 HTTP hot p99 与 route hot max 受并行构建/测试噪声影响，绝对毫秒不能作为目标云机或 2C2G 指标。** 本报告不把 43k 行或空库数字写成 G5 通过。

### 4.3 B06 候选查询

数据来自 43k 行近似主库；`service.candidates` 使用真实 `executionCandidateFacts` SQL + control execution claim 查询。cold 为每样本新建 store/read/service，hot 为同一上下文 n=30。

| 范围 | cold p50 | hot p50 | hot p95 | hot p99 | hot max | 返回 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ±2 天 | 44.4 ms | 39.0 ms | 80.1 ms | 97.0 ms | 97.0 ms | 窗口内事实 |
| 31 天 | 43.0 ms | 34.3 ms | 44.2 ms | 47.2 ms | 47.2 ms | 分页上限 |
| 50 条/页（31 天） | 35.3 ms | 32.9 ms | 49.8 ms | 57.2 ms | 57.2 ms | 50（nextCursor 非空） |

空库对应 B06 查询返回 0 条，hot p50 27–31 ms（主要是 control store 读/解析与空候选查询的固定成本）。完整数据见 JSON。

### 4.4 B08 输入键计算（facts 窗口 28+7 天）

| 场景 | cold p50 | hot p50 | hot p95 | hot p99 | hot max | 窗口 facts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 空主库 | 5.6 ms | 0.9 ms | 4.5 ms | 13.8 ms | 13.8 ms | 0 |
| 43k 行 | 8.2 ms | 3.2 ms | 7.3 ms | 17.0 ms | 17.0 ms | 211 |

计算覆盖 `trainingPlanInputFacts` 的 28 天历史 + 7 天前瞻 SQL，以及 `trainingPlanDesiredInputKey` 的 facts/config/overrides/execution digest 合成；键长 64 hex。

### 4.5 进程资源

benchmark 进程（含空库与 43k 两个场景、实际 HTTP server 的 spawn/停止、route-inject 与全部样本）：

```text
user CPU 17,264.3 ms; system CPU 2,666.4 ms
RSS before 118,398,976 B; after 179,597,312 B
heapTotal 87,478,272 B; heapUsed 46,772,520 B; external 7,220,796 B
```

这些是 **benchmark harness 进程**的观测值，不是 API 服务稳态 RSS；没有做多轮稳态/重启/2GiB 压测，不能作为 2C2G 资源签收。

### 4.6 现有 `plan-snapshot-latency.test.ts`

文件自带 fixture/种数据（空库 + 40k health_records、400 nights/hrv、400 workouts/sessions、800 stats、200 control history），无需外部环境。已执行：

```bash
node --import tsx --test --test-concurrency=1 apps/api/test/plan-snapshot-latency.test.ts
```

结果：PASS（n=20）——空库 p50=15.60 ms / p95=44.31 ms；约 42.6k 行 p50=44.19 ms / p95=81.17 ms。日志：`logs/plan-snapshot-latency.log`。测试预算不是 G5 通过。

## 5. 已执行命令与结果

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | PASS（exit 0） | `logs/typecheck.log` |
| `npx tsc --noEmit -p tsconfig.json` | PASS（exit 0，最终文件） | `logs/tsc-noemit-final.log` |
| `node --import tsx --test --test-concurrency=1 apps/api/test/training-plan-closed-loop-faults.test.ts` | PASS 8/8 | `logs/faults-test.log` |
| `node --import tsx --test --test-concurrency=1 apps/api/test/training-plan-closed-loop-explain.test.ts` | PASS 1/1 | `logs/explain-test.log` |
| `node --import tsx --test --test-concurrency=1 apps/api/test/plan-snapshot-latency.test.ts` | PASS | `logs/plan-snapshot-latency.log` |
| `node --import tsx --test --test-concurrency=2 <training-plan 定向 24 文件>` | PASS 168/168（198.6 s，skipped 0） | `logs/targeted-training-plan-concurrency2.log` |
| `npm run check:training-plan-single-writer` | PASS（R1–R5，违规 0） | `logs/check-training-plan-single-writer.log` |
| `npm run check:scripts` | PASS | `logs/check-scripts.log` |
| `npm run check:acceptance-matrix` | PASS（80 条 cited 80） | `logs/check-acceptance-matrix.log` |
| `npm run check:package-boundaries` | PASS | `logs/package-boundaries.log` |
| `node --import tsx scripts/bench-training-plan-closed-loop.mjs ...` | PASS（exit 0） | `logs/bench-training-plan-closed-loop.log` / `.json` |
| `RAI_TEST_CONCURRENCY=2 npm test`（B09 续推 + 最终源码身份） | PASS：2729 项 / 2726 通过 / 3 项 Windows 专属跳过 / 0 失败 | [local-crash-followup/logs/full-npm-test.log](local-crash-followup/logs/full-npm-test.log)、[full-test-result.json](local-crash-followup/full-test-result.json) |
| `node --import tsx --test --test-concurrency=1 apps/api/test/training-plan-closed-loop-crash.test.ts` | PASS：16/16（真实子进程 SIGTERM/SIGKILL × COMMIT 前/后） | [local-crash-followup/logs/crash-tests.log](local-crash-followup/logs/crash-tests.log) |

定向 24 文件包括：`training-plan-*`（含新 faults/explain）、`phase5-training-plan`、`coach-execution-assessment`、`plan-publication-stress`、`plan-snapshot-latency`。完整 `npm test` 已在 B09 续推（最终源码身份、含 crash test）通过：2729/2726/3 跳过/0 失败；本报告不把定向通过写成替代全量。

> 过程中的一个门禁修正：早期基准脚本直接调用 `applyMigration`，被 `check:training-plan-single-writer` R4 判红；将 benchmark 的控制库 fixture 移到 `apps/api/test/helpers/training-plan-benchmark-fixture.ts`（测试树 R4 豁免）后最终通过。未修改业务源码，也未放宽门禁。

## 6. 未执行 / 阻塞项

| 项目 | 状态 / 原因 |
| --- | --- |
| Linux 隔离 API/SQLite 2C2G | **BLOCKED**：本机无隔离 Linux runtime/固定 2C2G cgroup；未执行 |
| 真实 systemd 启停/信号 | **BLOCKED**：无真实 systemd 环境；未执行 |
| 真实 SIGKILL/SIGTERM 进程退出恢复 | **本机已补充 16/16**（`local-crash-followup/`：真实子进程、COMMIT 前/后 × 4 lane）；仍不能替代 Linux systemd/2C2G |
| iPhone 12 Pro Max 真机/Instruments | **BLOCKED**：本机无真机；未执行 |
| 2GiB RSS 无 OOM、多轮稳态、重启 | **BLOCKED**：未做多批稳态/2C2G 压测 |
| 全量 `npm test` | 已执行（B09 续推，最终源码身份）：2729 项 / 2726 通过 / 3 跳过 / 0 失败；见 local-crash-followup |
| iOS 相关回归 | 未执行；本批不涉及 iOS 行为改动 |

## 7. 发现的问题

1. **未发现需要修改业务源码的真实缺陷。** B06 的六个写点、current upsert 更新、COMMIT 失败全部原子回滚；B08 cursor 的 INSERT/UPDATE/COMMIT 失败均与 operation result 一起回滚；SQLITE_BUSY 不丢已提交操作；两进程竞争只允许一笔成功且同键重放不追加。
2. **资源观察（非缺陷）**：本机 route-inject GET v2（sessions/executions/update）空库 hot p50 约 81 ms、43k 主库约 68 ms，HTTP 空库 hot p50 约 184 ms、43k 约 239 ms；同时主机 load average 约 20，存在明显并行构建噪声。该差异提示 `trainingPlanStateRow`/control-state 解析与 update view 的固定成本值得在目标 Linux 环境复测；不能据此扩大重构或宣称 G5。
3. **环境限制**：工作区在验证期间被其他批次继续修改（91 个 dirty 条目），本报告用最终文件哈希而不是 HEAD 单独标识；任何后续 B09 复跑应以新哈希重新记录。

## 8. G5 判定

| 检查项（实施计划 §10.4） | 本机结果 |
| --- | --- |
| 新写点全故障回滚与崩溃恢复 | macOS 进程内故障注入 PASS；真实 SIGTERM/SIGKILL 16/16 本机 PASS（见 local-crash-followup） |
| Linux 真实锁/进程信号/重启 | **BLOCKED（未执行）** |
| 2C2G 固定数据/负载资源签收 | **BLOCKED（未执行）**；仅有本机 DEV 基线 |
| 性能改动前后语义差分 | 本批未改业务源码；未做差分 |
| 缺少隔离 Linux 环境时本门为阻塞 | **成立：G5 仍阻塞，B09 不能宣告通过** |

**总体结论：B09 本机可做部分（S05-01 的进程内原子性、S05-02 的 DEV 基线、S05-03 的 EXPLAIN 证据）已完成；S05-04 未验证 Worker 路径，S05-05 Linux/2C2G/systemd/SIGKILL 与真机均未执行。G5 仍阻塞，禁止把本报告数字当作 2C2G 验收或发布证据。**

## 9. 附件

- `logs/code-identity.txt`：HEAD、branch、91 条 dirty 状态、相关文件 SHA256
- `logs/host.txt`：macOS/内核/CPU/内存
- `logs/typecheck.log`
- `logs/faults-test.log`
- `logs/explain-test.log`
- `logs/new-tests-final.log`（faults+explain 合并复跑 9/9 PASS）
- `logs/plan-snapshot-latency.log`
- `logs/targeted-training-plan-concurrency2.log`
- `logs/check-training-plan-single-writer.log`
- `logs/check-scripts.log`
- `logs/check-acceptance-matrix.log`
- `logs/package-boundaries.log`
- `logs/bench-training-plan-closed-loop.log`
- `logs/bench-training-plan-closed-loop.json`
