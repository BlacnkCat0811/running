# 后端审查与 GPT‑5.6 Sol 执行方案

审查日期：2026-09-16。审查者：当前会话主模型；执行者：用户指定 GPT‑5.6 Sol。
审查基线：`bd1ee25`，工作目录 `/Users/ta/running`。既有 iOS 未提交改动不属于本次修改范围。

## 1. 结论与边界

后端已经具备：本地请求校验、路由 schema、写操作协调、读租约、
导入 staging/备份/回滚、任务恢复、上传容量与路径校验、模型输出校验。
不建议推翻这些机制，也不建议本轮改为微服务、引入 Redis 或更换数据库。

本次为代码审查与针对性故障注入，不是生产渗透测试、真实健康数据压力测试，
也不是所有评分公式的数学审计。主要阅读：

- `/Users/ta/running/apps/api/src/server.ts`：启动、生命周期、路由与写操作控制。
- 同目录的 `worker.ts`、`import-sources.ts`、`runtime-state.ts`、
  `read-store-manager.ts`、`mutation-coordinator.ts`、`local-request-security.ts`、
  `maintenance.ts`、`data.ts`、`weekly-plan-llm.ts`、`weekly-plan-service.ts`。
- `/Users/ta/running/packages/storage-sqlite/src/database.ts`、发布锁与主要读取仓储。
- 对应 API / storage 测试；application、parser 的关键调用关系。

本轮处理下面六项确定问题。P1 指正确性或关键可用性问题，P2 指局部性能、
资源治理或尚未在默认配置触发的边界问题；不代表发现六个公开网络漏洞。

## 2. 现状验证

修改前验证：

- `npm run typecheck`：通过。
- `npm test`：Node 610 项，607 通过、3 跳过、0 失败；Web 13 文件 / 84 项通过。
- 临时故障注入日志：`/tmp/rai-backend-review-20260916/repro-before.log`。
- 测试与复现均使用临时目录；没有导入、迁移、修改用户真实数据库。
- 独立合成基准：1,000 条来源中标记一条产生 **1,000 次写入**，
  一次测得约 **5,046ms**；ID 点查执行一次全表读取。
- 独立合成基准：约 20.4 MB、50 万行有外键的测试子表，
  9 次无迁移 open 对应 9 次全库外键扫描；去掉两次预热后的中位约 **50–56ms**。
  时间受本机并行负载影响，扫描/写入次数比单次耗时更可靠。
- 桌面 E2E 前置核查：`npm run test:e2e:web` 中 Web build 通过，
  但本机没有测试支持的 Chrome / Edge，启动 hook 失败；
  10 项桌面测试没有进入业务断言，1 项响应式测试按规定跳过。
  不把这项环境失败算作业务回归，也不算测试通过。

这些基线说明现有测试整体健康，但没有覆盖下面的故障路径。
临时日志不是长期交付物；修复须把复现转为仓库内自动化回归。

## 3. 本轮发现与可实施修复

### B1 / P1：导入入队持久化失败留下幽灵任务

**证据**：基线 `worker.ts:662–664` 先 `jobs.set`，再 `persistJobs()`，
最后才设置 `running` 和定时器。持久化抛错时没有撤销内存状态。
故障注入结果：`isRunning=false`，但 `latest()` 和 `findBySourceId()` 仍返回 `queued`。
`server.ts` 的来源幂等分支可能因此返回一个永远不执行的任务；上传来源还可能被失败清理删除。

**执行方案**

1. 使“成功入队”成为明确的提交点：完成持久化后才公布可执行任务，或在失败时可靠撤销内存登记。
2. 不启动 timer，不保留 `running=true`，不执行成功入队专属终态回调。
3. 保留既有终态重试与真实在途任务，不因补偿清理破坏历史任务。
4. 任务 ID 避免仅依赖毫秒时间，确保同一时刻重试不会覆盖旧任务。

**验收**

- 注入首次入队写失败：调用抛错，查询无新 queued 任务，worker 空闲。
- 恢复存储后同来源可重新创建；定时器和 close 正常。
- 固定时间下多次创建的任务 ID 不冲突，历史查询不被覆盖。

### B2 / P1：来源标记回写全部旧快照，复活并发删除的元数据

**证据**：基线 `import-sources.ts:415` 的 `markUsed` 读取全部来源，
改一行后 `writeSources` 对每行 upsert。暂停读取返回、删除另一行、继续标记，
可以复现被删行重新出现。这还让一次标记发生 N 次连接/写入。
`get(id)` 和批次幂等检索也先全表加载，未使用现有主键、唯一键索引。

**执行方案**

1. `RuntimeStateStore` 增加参数化单行查询：按 ID、幂等键；
   增加只对既有行执行的 `UPDATE ... WHERE id=?` 使用时间标记。
2. 时间更新保持单调，不用 upsert 创建不存在的行；保留 corruption recovery 包装与关闭连接。
3. `ImportSourceManager.get`、幂等查询、`markUsed` 改用这些操作，删除全表回写辅助函数。
4. 可将相同摘要的已导入来源查询移到 SQL；不能破坏幂等收据保留语义。
5. `recent` 的文件存在性过滤必须保留；不要先 LIMIT 10 导致陈旧路径挤掉有效记录。

**验收**

- 标记 A 不修改 B；被删 B 不复活；已删 A 不被标记重新创建。
- 旧时间不能覆盖新时间；相同 batch 仍返回相同 source ID。
- 点查 / 标记不调用 `sources()`；借此验证工作量不随来源总数线性增长。
- 现有上传、去重、收据保留、来源清理与损坏恢复测试通过。

### B3 / P1：每次业务写连接都重复做全库外键检查

**证据**：基线 `database.ts:1763–1767` 无论 `pending.length` 是否为零，
均执行 `PRAGMA foreign_key_check`。`server.ts` 的 `openMainDatabase` 每个写请求调用
`RaiDatabase.open()`。针对已完成迁移的空闲库连续打开 3 次，记录到 3 次检查。
这证明存在重复扫描；尚未测量真实大库延迟，不能据此声称已获得某个加速倍数。

**执行方案**

1. 给 `RaiDatabaseOpenOptions` 增加显式外键验证策略，例如
   `foreignKeyValidation: "always" | "after-migration"`，默认 `"always"`，
   保持 CLI、启动、恢复与既有调用者的严格语义。
2. API 热写路径在启动严格校验后选择 `"after-migration"`；
   有真实迁移时仍强制检查。恢复/导入发布保留原有严格检查。
   特别注意：现有路由的文件存在检查不等同于严格验证成功，
   `databaseRecoveryRequired=true` 时不能盲目启用热策略；
   应继续严格验证或拒绝普通写入，同时让恢复接口保持可用。
3. 不关闭 `PRAGMA foreign_keys=ON`，不删 checksum 校验，不直接修改旧迁移。
4. 如其他写 worker 也切换策略，须分别证明其生命周期中有严格验证边界；
   本轮最低交付只要求 API 热路径，不扩大风险。

**验收**

- 默认 open 对已升级但存在外键破坏的库仍拒绝。
- 热策略、无迁移的 open 不发出全库检查语句；每次写入仍受外键约束。
- 热策略、有待执行迁移时依然检查；checksum 和未知迁移版本仍拒绝。
- 启动因外键损坏进入 recovery_required 后，普通写请求不能借热策略绕过故障。
- 记录合成大表基准的前后时间 / 扫描次数；不得以单次耗时设脆弱 CI 阈值。

### B4 / P2：LLM 单次超时的下限会突破总预算

**证据**：基线 `weekly-plan-llm.ts:170` 使用
`Math.max(MIN_ATTEMPT_MS, Math.min(timeoutMs, remaining))`。
`MIN_ATTEMPT_MS=5000` 会将短预算上调。
注入 `totalBudgetMs=50, timeoutMs=30` 与等待 AbortSignal 的假 fetch，
实际耗时约 **5002ms**。默认 50 秒预算不是此短配置，不能说默认请求必然超时。
现有测试还用正则固定了这个错误表达式。

**执行方案**

1. 每次尝试的 timeout 不得大于 `timeoutMs` 和剩余总预算；预算耗尽直接结束。
2. 最小尝试预算只决定“是否值得开始重试”，不能延长首次尝试或截止时间。
3. 保留默认总预算 50 秒、单次 45 秒、有限重试和首个上游错误优先于后续超时的语义。
4. 非法 timeout 配置要明确拒绝或安全规整；不能变为 NaN/Infinity 定时器。
5. 将固定错误表达式的测试改为行为断言；保留与客户端超时常量的兼容检查，
   不修改 Swift。

**验收**

- 短总预算、短单次预算、预算耗尽、失败后重试均不产生 5 秒保底延长。
- 用可控 fetch / 信号和适度时间裕量验证，不要求调度器毫秒级精确。
- 不可重试错误不重试；重试失败诊断不被最后的 AbortError 掩盖。

### B5 / P2：上游模型响应缺少体积上限，错误响应未释放

**证据**：基线 `weekly-plan-llm.ts:183–187` 非 2xx 直接抛错；
成功响应直接 `response.json()`。可控 ReadableStream 返回两次 500，
观察到两次请求、零次 `cancel()`。代码没有成功响应字节数上限。
这是资源边界缺失，不是已证明当前供应商正在返回巨大响应。

**执行方案**

1. 非 2xx 响应主动取消响应体，再按既有规则决定重试；
   清理失败不能替换原始 HTTP 错误，也不能无限等待。
2. 成功响应使用流式字节计数，设置明确常量上限（建议 1 MiB，
   远大于正常一周课表）；有 Content-Length 可预检，但实际读取仍必须计数。
3. 超限取消读取、返回安全的 `LlmRequestError`，不重试相同过大响应。
4. 不泄露上游响应原文、密钥或 prompt；正文读取也必须受同一尝试截止时间约束。

**验收**

- 非 2xx 响应确实被取消，错误代码与重试行为不变。
- 超限无 Content-Length、伪小 Content-Length、正常多字节 JSON、畸形 JSON均覆盖。
- 超限后不继续累计、不重试；慢响应体在截止时间结束。
- 原有模型回退、截断提示和输出校验测试通过。

### B6 / P2：课表生成没有独立并发门，CAS 只能阻止最终覆盖

**证据**：生成路由在 `metadataOnlyMutationRoutes` 中豁免主库锁；
基线 `server.ts:858–898` 先读取 revision、等待外部模型，最后才 CAS 写 goals。
因此同 revision 的并发请求可以同时调用上游，随后一个成功、其余冲突；
已有 CAS 是正确性保护，但不能避免重复计算/请求成本。

**执行方案**

1. 增加单实例的“课表生成”并发门，覆盖取输入、模型调用和持久化；
   忙时快速返回稳定 409 `weekly_plan_generation_busy`，不排无限队列。
2. 不能持有全局主库 mutation lock 等待模型：上传、普通 goals 编辑、
   读取和既有数据库恢复机制不得被这一慢操作全面锁住。
3. 使用 `try/finally` 保证成功、失败、revision 冲突都释放；
   保留最终 CAS，防止用户在生成期间编辑 goals 被覆盖。
4. 可提取小型受测模块，不借机拆分全部 server；不改任何原生客户端。

**验收**

- 用本地假上游或受控 deferred callback 发出两个并发生成请求，
   上游最多调用一次，第二请求快速 409。
- 第一请求成功/失败之后允许再次生成。
- 生成期间 goals 编辑可完成；旧生成最终 CAS 冲突，不覆盖编辑结果。
- 至少一条真实 API runtime 测试验证该门确实接入路由，
   不能只测试未被 server 使用的 helper。

## 4. 执行顺序与文件边界

建议依次 B1 → B2 → B3 → B4/B5 → B6；各项先建立回归，再实现。
Sol 可修改 API 源码与测试、storage-sqlite 源码与测试，新增小型同层辅助模块。
本报告由主模型维护；Sol 将交付记录写入
`/Users/ta/running/deliverables/BACKEND_SOL_EXECUTION_2026-09-16.md`。

禁止：

- 修改 `/Users/ta/running/apps/ios` 或既有其他未提交工作。
- 修改 Web 响应式冻结区域、增加移动端测试或运行 responsive / 全量 E2E。
- 操作真实 `var/rai.sqlite`、用户导出、真实上游模型密钥；不做真实模型收费调用。
- 删除旧迁移、放松导入删除保护、禁用外键约束、清理幂等收据以“提速”。
- 为使测试通过而取消安全断言；如断言固定错误实现，用等效行为覆盖替代。
- 自动 git commit / reset / checkout 用户文件。

## 5. 完成判据

Sol：新增定向回归并运行相关 API / storage 测试、`npm run typecheck`。
主模型：复核 diff，补充独立故障/性能验证，然后运行：

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:e2e:web`（本轮涉及真实 API 路由，需桌面流程回归）。

E2E 必须先确认其真实数据库分支使用隔离副本，不允许启动测试时迁移用户真实库。
报告逐项记录已完成、未完成、测试结果和环境限制；测试失败不得描述为全部完成。

## 6. 后续优化路线（本轮不实施）

### 第二阶段：测量后再优化查询，约 1–3 个工作日（粗估）

- 构造去标识化合成的 10万 / 100万级 health_records，
  分别测冷/热 dashboard、workout detail/series、prediction 与 recovery。
- 对同步查询记录查询时间、事件循环延迟和响应 p50/p95；
  用 EXPLAIN QUERY PLAN 判断是否有历史范围扫描。
- 优先调查 `metricIntervals` / `averageRawMetric` 的重叠时间条件、
  workoutSeries 中重复读相同时间序列，和大表审计。
- 只有测量证明受益才新增迁移索引或请求级数据复用；
  记录新增索引体积、导入写入代价与正确性对照。
- CPU/扫描热点若仍明显，再评估只读 worker，而不是先引入多数据库或微服务。

### 第三阶段：服务结构与运维，约 2–4 个工作日（粗估）

- 提取 `buildApp(config,deps)` 与启动入口，逐域拆路由；
  保留运行时路由分类测试，避免重构丢失权限/schema/写锁。
- 统一配置校验、request ID、任务关联日志和慢操作指标；日志不记录健康 payload/密钥。
- 明确 runtime/control/main 三库的备份与恢复边界，以及幂等收据保留策略。
- 对发布中断、磁盘不足、损坏数据库、长期客户端断开进行故障演练。
- 若要支持非本地多用户，再单独设计用户隔离、身份认证、配额与部署安全；
  不把当前单用户本地架构假定成公网多租户服务。

以上工期是便于排期的粗估，不是已实施或已验证的性能承诺。
