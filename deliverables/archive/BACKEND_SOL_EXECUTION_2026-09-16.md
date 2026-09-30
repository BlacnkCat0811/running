# 后端 B1–B6 执行记录

执行日期：2026-09-16  
执行者：用户指定 GPT-5.6 Sol  
工作目录：`/Users/ta/running`

## 1. 结论

B1–B6 已全部实施并加入回归测试。修改范围仅包含 `apps/api`、`packages/storage-sqlite` 及本执行记录；未修改 `apps/ios`、`apps/web`、旧审查报告或真实 `var` 数据库，也未执行 git commit/reset/checkout。

## 2. 分项完成情况

### B1：导入入队持久化与任务 ID — 完成

- 将首次持久化设为入队提交点：持久化失败时立即撤销内存任务，不启动定时器、不置 `running`、不调用终态回调。
- 新增 `ImportJobEnqueuePersistenceError`，API 可识别“任务从未成功入队”，保留上传来源供存储恢复后重试，而不是误清理来源。
- 任务 ID 改为“时间前缀 + UUID”，固定同一毫秒生成 100 个 ID 的回归无冲突。
- 回归覆盖：无幽灵 queued 任务、worker 空闲、同来源可重试、回调不触发、ID 不覆盖。

### B2：来源点查与原子 markUsed — 完成

- `RuntimeStateStore` 新增按 ID、按幂等键、按摘要查询最近已导入来源的参数化单行 SQL。
- `markSourceUsed` 改为 `UPDATE ... WHERE id = ?`，不存在的行不会创建，时间戳只允许单调前进。
- `ImportSourceManager.get`、同步批次幂等查找、摘要历史查找、`markUsed` 均不再读取或回写全表。
- `recent` 仍读取候选后检查真实文件存在性，再排序取 10 条，未引入“先 LIMIT 10 被陈旧路径挤占”的回归。
- 回归覆盖：点查/标记不调用 `sources()`、并发删除不复活、旧时间不覆盖新时间、删除行不重建、幂等键点查。

### B3：外键验证策略 — 完成

- `RaiDatabaseOpenOptions` 新增 `foreignKeyValidation: "always" | "after-migration"`，默认保持 `always`。
- `after-migration` 仅在无待执行迁移时跳过全库 `foreign_key_check`；真实迁移后仍强制检查。
- `PRAGMA foreign_keys = ON`、迁移 checksum、未知版本拒绝逻辑保持不变。
- API 热写仅在已通过启动/恢复严格验证时使用 `after-migration`；`databaseRecoveryRequired` 状态继续使用 `always`，不能绕过启动外键失败。
- 回归覆盖：默认严格拒绝损坏、热策略保留写时 FK 约束、待迁移时仍检查、启动 FK 失败后热写无法绕过。

### B4：LLM 短预算截止 — 完成

- 单次尝试上限改为 `min(timeoutMs, remaining)`，不会被 5000ms 下限抬高。
- 5000ms 仅作为“是否值得启动重试”的门槛；预算耗尽直接结束。
- 非有限、非正的 timeout/总预算配置明确拒绝。
- 删除固定错误 `Math.max(...)` 实现表达式断言，改为短预算、慢正文和重试行为测试；客户端 60 秒兼容检查保留。
- 保留有限重试、不可重试错误停止，以及首个上游错误不被末次截止 AbortError 覆盖的语义。

### B5：LLM 响应资源上限 — 完成

- 新增 1 MiB 成功响应正文硬上限。
- `Content-Length` 只作提前拒绝；实际流读取始终逐块累计字节，防止伪小/缺失长度绕过。
- 超限立即取消 reader，返回不可重试 `LlmRequestError`，不累计后续正文。
- 非 2xx 主动取消响应体；清理失败为 best-effort，不替换原 HTTP 错误、不等待清理挂起。
- 正文读取与 fetch 共用同一尝试 AbortSignal/截止时间。
- 回归覆盖：非 2xx cancel、无长度超限、伪小长度超限、声明超限、跨 UTF-8 中文字符字节边界的正常多块 JSON、畸形 JSON、慢正文截止。

### B6：独立课表生成并发门 — 完成

- 新增单实例 fail-fast `TryAcquireGate`，不排队、不使用全局 mutation lock。
- 门覆盖读取生成输入、上游模型调用和最终 CAS 持久化；忙时稳定返回 `409 / weekly_plan_generation_busy`。
- `try/finally` 保证成功、失败、CAS revision 冲突均释放；既有 CAS 保留。
- 真实 API runtime 测试使用本地假上游验证：两个并发生成最多一次上游调用；第二个快速 409；生成期间 goals 编辑成功；旧生成 CAS 冲突不覆盖编辑；冲突后可再次生成。等待假上游首次调用带 5 秒失败窗口，故障时仍进入 `finally` 清理 API 与本地上游。

## 3. 修改文件

### API 源码

- `/Users/ta/running/apps/api/src/import-sources.ts`
- `/Users/ta/running/apps/api/src/runtime-state.ts`
- `/Users/ta/running/apps/api/src/server.ts`
- `/Users/ta/running/apps/api/src/try-acquire-gate.ts`
- `/Users/ta/running/apps/api/src/weekly-plan-llm.ts`
- `/Users/ta/running/apps/api/src/worker.ts`

### API 测试

- `/Users/ta/running/apps/api/test/import-sources.test.ts`
- `/Users/ta/running/apps/api/test/server-runtime.test.ts`
- `/Users/ta/running/apps/api/test/try-acquire-gate.test.ts`
- `/Users/ta/running/apps/api/test/weekly-plan.test.ts`
- `/Users/ta/running/apps/api/test/worker.test.ts`

### storage-sqlite

- `/Users/ta/running/packages/storage-sqlite/src/database.ts`
- `/Users/ta/running/packages/storage-sqlite/test/foreign-key-validation.test.ts`

## 4. 验证结果

1. 定向 B1–B6 测试：
   - 命令：`node --import tsx --test apps/api/test/worker.test.ts apps/api/test/import-sources.test.ts apps/api/test/weekly-plan.test.ts packages/storage-sqlite/test/foreign-key-validation.test.ts apps/api/test/try-acquire-gate.test.ts`
   - 结果：184 项，182 通过，2 跳过，0 失败。
   - 跳过项均为既有平台限定测试。

2. 真实 API runtime：
   - 命令：`node --import tsx --test --test-concurrency=1 apps/api/test/server-runtime.test.ts`
   - 结果：14 项全部通过。

3. API + storage-sqlite 全量相关测试：
   - 命令：`node --import tsx --test apps/api/test/*.test.ts packages/storage-sqlite/test/*.test.ts`
   - 结果：405 项，402 通过，3 跳过，0 失败。

4. TypeScript：
   - 命令：`npm run typecheck`
   - 结果：通过。

5. Diff 基础检查：
   - 命令：`git diff --check`
   - 结果：通过。

桌面 E2E 未由本执行者重复运行；主模型已记录 build 通过、当前机器无候选 Chrome/Edge 导致 before hook 失败，该环境问题不属于本次后端实现。

## 5. 未完成项

无。性能基准复跑与后续总体验收由主模型按原计划独立完成。

## 6. 主模型复核后的收尾验证

- 修正 `TryAcquireGate` 注释：明确其差异是争用时返回 `null`，而不是
  `MutationCoordinator` 的冲突异常，不再错误声称原协调器会排队。
- API runtime 假上游首次调用等待增加 5 秒失败窗口；超时异常仍由测试
  `finally` 关闭 API、释放首个响应并关闭本地上游。
- 正常流式 JSON 用真实中文内容，并将“轻”的 UTF-8 三字节拆到三个 chunk
  之间，验证按字节计数后整体解码不会破坏多字节字符。

收尾定向重跑：

1. `node --import tsx --test apps/api/test/try-acquire-gate.test.ts apps/api/test/weekly-plan.test.ts`
   - 56 项全部通过。
2. `node --import tsx --test --test-concurrency=1 apps/api/test/server-runtime.test.ts`
   - 14 项全部通过。
3. `npm run typecheck`
   - 通过。
4. `git diff --check`
   - 通过。
