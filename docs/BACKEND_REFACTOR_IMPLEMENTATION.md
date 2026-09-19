# 后端重构实施记录

原始记录日期：2026-09-18。当前部署决策已调整为：2 核 2GB 云服务器承载
HTTPS、API、计算与唯一可写数据集，不迁移 N100，不依赖 FRP。
部署入口使用 `deploy/README-CLOUD-2C2G.md`。没有在真实服务器安装、迁移或触发实际数据重算。

## 已落地的职责划分

| 模块 | 实现 |
|---|---|
| HTTP 启动/依赖装配 | `apps/api/src/server.ts` |
| 导入路由、202 接受、状态、取消 | `apps/api/src/routes/import-routes.ts` |
| 可排队的其他写操作 | `apps/api/src/routes/command-routes.ts` |
| 串行重型任务准入 | `apps/api/src/task-admission.ts` |
| 导入执行器/队列 | `apps/api/src/import-worker.ts` |
| 增量依赖分析 | `import-dataset-analysis.ts`，生产队列通过独立 Worker 线程执行 |
| 计算、预测训练执行器 | `recompute-worker.ts`、`prediction-worker.ts`；`worker.ts` 仅保留兼容重导出 |
| 子进程退出/终止 | `apps/api/src/worker-process.ts` |
| 数据库发布意图和应用回执 | `apps/api/src/import-publication.ts` |
| 其他写操作队列、同事务幂等应用 | `apps/api/src/command-queue.ts` |
| 任务、来源及执行元数据 | `apps/api/src/runtime-state.ts` |
| 阶段计时与进程指标 | `import-performance.ts`、`runtime-telemetry.ts` |
| 有界原始样本缓存 | `packages/application/src/services/bounded-cache.ts` |
| 可重复隔离基准 | `apps/api/src/benchmark-import.ts` |

没有把现有纯计算包重写成 Python/Rust；算法和历史数据语义未主动改变。
不是“一次拆完 server.ts 的所有只读路由”，而是把本次变化涉及的写入/调度边界抽出。

## 1. 导入接受与执行分离

`POST /v1/import-jobs`：

- 同一来源已有 queued/running/succeeded 任务：返回原任务（200）。
- 新来源：先持久化再返回 202；执行时才获取主库写入许可。
- 默认最多 8 个等待/运行的导入，超出返回 429 和 Retry-After。
- 不同来源顺序执行，不把 HealthKit 增量包合并成“只留最新一个”。
- 查询来源任务不再受内存中最近 20 个已完成任务的显示窗口限制。
- `/v1/import-jobs/active` 优先返回真正执行中的任务，再返回队头；不会被后来任务遮住。
- 任务状态可带 queuePosition/waitingReason，旧 Swift/Web 解码器可以忽略新字段。
- 已接受任务、尚未完成来源清理的任务会保护上传源，避免 TTL 清理误删。
- 同步批次绑定原始 ZIP 摘要；同幂等键不同内容返回
  `sync_batch_content_mismatch`，不错误复用。旧批次若没有摘要且原文件已消失，则不能证明一致，明确拒绝。

新增 `POST /v1/import-jobs/:id/cancel`：

- 等待任务可取消并落盘。
- 运行任务记录取消请求，在安全点终止子进程。
- 正在发布数据库的任务拒绝取消，不能把已发布数据谎报为“未应用”。

应用关闭时，新协议的排队任务不被标记成失败；运行任务在安全边界停止，保留来源供重启。
重启中断最多尝试 3 次，永久业务失败不会无限自动重跑。
旧版本缺少 queue scope 的 running 任务沿用明确 interrupted 失败，不推测它属于哪个数据集。

## 2. 统一准入与兼容行为

导入、重算、预测训练、异步写命令共用主库 MutationCoordinator。
重型执行器按申请顺序获得许可，每完成一项计算让出许可，避免长期霸占。
各导入/命令队列内部 FIFO；不同类型之间不承诺按所有 HTTP 到达时间建立全局总序。

API 读取、任务查询、队列提交继续可用。上传准备最多一条链路，可与计算并行，
仍受既有 ZIP/解压/磁盘配额约束；“一个计算任务”不等于禁止所有后台 I/O。

旧同步写接口保留原返回契约，短暂交接最多等待 2 秒，长期忙碌仍返回 409。
要获得持久化等待语义，应使用新 `/v1/commands`，不能把旧接口的 409 当成已经入队。
任务取消只允许写控制行；导入替换期间不允许旧主库的重算/训练取消写穿透屏障。
恢复/删除数据库是维护操作，任何导入/命令待执行时拒绝，不能绕过队列切换数据集。

## 3. 其他写操作：异步命令 API

提交：`POST /v1/commands`，需要正常 Bearer 鉴权。

```json
{
  "idempotencyKey": "client-persisted-request-0001",
  "kind": "recompute",
  "payload": {}
}
```

支持：

| kind | payload |
|---|---|
| workout_override | 原训练覆盖字段 + trainingSessionId |
| training_zones | 原分区设置字段，包括 expectedRevision |
| recompute | 空对象 |
| prediction_training | 原训练请求，可选 asOf |
| activate_model | `{ "id": "目标模型运行 ID" }` |
| activate_prediction | `{ "id": "目标预测模型 ID" }` |

新提交返回 202。客户端保存 `id`，调用 `GET /v1/commands/:id` 查询；
`POST /v1/commands/:id/cancel` 只能取消尚未开始的命令。
同键同内容复用；对象属性顺序不影响摘要；同键不同内容返回 409；
最多 16 个待执行命令，满时 429。不同业务动作必须生成新的幂等键。

**succeeded 表示这项写操作已提交，不表示它触发的后续重算/训练已经完成。**
例如 result.jobId / result.runId 应继续通过原任务 API 查询。
客户端不能拿到 202 就更新“同步成功”水位，也不能把取消失败当成操作未发生。
现有客户端仍可使用旧接口；本轮未强制改写所有 iOS/Web 写流程。

### 跨库确认

业务写入和 `rai.applied-command.<id>` 回执在**主库同一事务**提交；
之后才更新 runtime 的命令状态。训练覆盖/分区设置/预测服务增加显式 savepoint
组合模式，旧调用默认仍拥有自己的 BEGIN IMMEDIATE 事务。
业务提交后若任务确认失败，下一次只读取回执补确认，不重复增加覆盖 revision 或计算任务。

运行时 scope 包含 serverId、athleteId、datasetEpoch。换数据集/回滚旧备份时仍需遵循部署契约
更新 datasetEpoch；不要在停服后偷偷替换数据库却保留原身份，系统无法推断任意外部文件操作的业务含义。

## 4. 导入发布与重启恢复

仍使用 staging 计算，仍保留主库写保护。没有直接缩短锁以牺牲数据一致性。

发布流程：

1. 候选库写入本次导入应用回执并完成检查点。
2. runtime 持久化 prepared 意图，包含旧库回退位置。
3. 执行现有替换、可读性验证、报告提交。
4. 标记 committed，再解除读取替换屏障。
5. 持久化任务成功、完成来源清理，再用 runtime 同一事务确认已清理并删除发布意图。

重启：

- prepared + 回退库存在：恢复旧库，重新生成旧库报告，再从安全边界重跑。
- committed + 主库有对应回执：补记成功，不重复导入。
- 意图与文件矛盾、回退库丢失或提交回执不存在：拒绝不安全恢复，要求人工处理。
- 回退库先做完整性检查；存在不带本次候选回执的陌生活动库时，不直接覆盖它。
- 在线回退没有完成时保留上传源/发布意图，暂停后续主库写入直到重启恢复，不能继续消费队列。
- 元数据内文件路径受主库路径/备份目录限制，不把损坏记录当成任意删除文件的授权。

这些逻辑覆盖进程中断与确认窗口，不承诺在磁盘损坏、任意外部篡改、断电丢写后都能自动恢复。
继续保留完整备份；不能因有日志而关掉备份或设置 synchronous=OFF。

## 5. 性能优化与观察

- 原始样本查询使用 run-local LRU：最多 16 个查询窗口、20,000 条样本；
  不缓存超大窗口。每次完整计算/快照刷新清空；独立 shadow reference 前也清空。
- 缓存键包括来源、时间边界和类型；缓存的是同次计算内不变的原始查询，不跨数据版本复用。
- 距离历史的时间戳预先转成数值，减少反复 Date.parse；不改过滤边界与负荷公式。
- 延续原增量 dirtyFromAt、特征前缀复用和基线依赖规则，不把历史 HRV/睡眠变动误判成仅新增训练。
- 中间进度写库节流，阶段与终态保留。
- 补充 features / trainingMetrics / modelReplay / shadowValidation 的阶段时间与计算进程峰值 RSS；
  写入重算事件，并通过 IPC 汇入导入 performance。
- 上传响应带 receive/extract/inspect 时间和 Server-Timing；重复批次只验证字节摘要，不再解压。
- `GET /v1/performance`：累计请求时间、5xx 数、事件循环延迟、进程 RSS/CPU 和准入状态，
  需要 Token，不包含原始请求路径、请求体或健康样本。
- 进程 RSS 不等于 systemd 整个服务组峰值；后者仍需在 N100 的 cgroup/systemd 查看。

没有盲目增加主业务表索引或全量强制 64MB/连接缓存。新加的索引只服务新增的任务查询。
SQLite 已有 WAL/NORMAL/锁等待策略继续保留，额外 shadow 对照默认仍开启。

## 6. 隔离基准工具

```bash
npm run data:benchmark -- \
  --database /path/to/baseline.sqlite \
  --input /path/to/apple_health_export \
  --output /path/to/new-benchmark.json \
  --runs 3
```

默认仅预演。显式加 `--execute` 才运行：

- 只读打开基线，通过在线 backup 捕获一次一致性副本。
- 每个 trial 从**同一个副本**恢复，分别测试 shadow/off。
- 固定 evaluatedAt，交替模式顺序，减少时间参数和缓存预热偏差。
- 所有写入/报告/模型发布在临时目录；不切换真实 active 数据库。
- 输出文件必须不存在，0600 权限；包含阶段计时与任务结果，不输出原始健康记录。
- 有失败任务时输出报告并返回非零；支持取消与一小时/任务的执行上限。

它不测手机上传或 FRP。先用新增一跑、历史更正、恢复数据更新、无变化等受控输入各跑一组；
仅看最终 durationMs 或一个微型样本不能宣称真实数据快了几倍。

## 7. 部署与验收边界

runtime.sqlite 新列/辅助表按现有元数据初始化流程增补；未增加主库 schema migration。
应用业务表没有自动重建，不需要为本轮重跑真实健康数据导入。
升级前仍需完整冷备份，且不要混跑两个不同版本 API。

验收覆盖：队列满、来源保留、取消、重启恢复、不同内容复用键、数据库发布中断、
命令提交后确认失败、SQL 事务回滚、缓存边界、旧接口/OpenAPI/桌面 API 流程。
桌面浏览器 E2E 必须有 Chrome/Edge；不扩展 390px 响应式范围。

条件性项目仍未启用：乐观短锁、Rust 热点替换、多节点执行/自动云端接管。
只有真实基准证明瓶颈且等价性测试通过后再决定，不把它们当成已验证的提速手段。

## 8. 本轮验证结果

- `npm run typecheck`：通过。
- `npm test`：Node 后端/共享包 677 项通过、3 项按既有条件跳过；Web 84 项通过。
- `npm run build`：通过。
- 实际子进程导入测试通过：首次导入、增量分析线程、shadow 对照、发布回执和重启查询。
- 隔离基准工具测试通过：两种模式都从同一基线插入一条训练，原基线保持不变，已有报告不会被覆盖。
- 故障注入覆盖确认事务失败、发布中断、陌生活动库、客户端断线和控制请求与导入交接。
- 桌面 E2E 已尝试，但本机缺少 Chrome/Edge，在浏览器启动前置检查被阻塞；不能算作通过。
- 未在云服务器/N100 上部署；尚无真实用户数据的提速比例或目标机器资源峰值结论。
