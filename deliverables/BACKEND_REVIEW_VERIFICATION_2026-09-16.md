# 后端优化独立复核与验收

日期：2026-09-16  
审查与复核：当前会话主模型  
实施：用户指定的 GPT‑5.6 Sol（工具实际使用 `gpt-5.6-sol`）

## 1. 交付结论

本轮六项修复 B1–B6 已实施，主模型已逐项复核源代码与新增测试，
并独立执行故障注入、合成基准和总体验证。
**代码与非浏览器验证完成；桌面浏览器验收仍受环境限制。**
后续查询优化与架构整理仅提供路线，没有宣称已实施。

- 审查与详细实施方案：
  `/Users/ta/running/deliverables/BACKEND_REVIEW_AND_SOL_PLAN_2026-09-16.md`
- Sol 分项实施记录、改动文件与定向测试：
  `/Users/ta/running/deliverables/BACKEND_SOL_EXECUTION_2026-09-16.md`

## 2. 主模型独立复核

| 项目 | 修改前 | 修改后 |
|---|---|---|
| 入队持久化故障 | worker 空闲，但 latest/bySource 残留 queued 任务 | latest/bySource 均为 null，无幽灵任务 |
| 并发删除其他来源 | 标记操作回写旧快照，已删行复活 | 同样注入删除，已删行保持不存在 |
| 1,000 条来源中标记一条 | 1,000 次写、1 次全表读，约 5046ms | 1 次写、0 次全表读，约 10.4ms |
| 来源 ID 点查 | 全表读取后筛选 | 参数化主键查询，无全表读取 |
| 50 万行合成外键表，9 次热打开 | 9 次外键扫描，暖中位约 50–56ms | 热策略 0 次扫描，暖中位约 3.85ms |
| 同一合成库的默认严格打开 | 每次外键扫描 | 仍为 9 次扫描，暖中位约 46ms |
| LLM 总预算 50ms / 单次 30ms | 约 5002ms | 约 34ms |
| 两次上游 500 响应 | 请求 2 次，响应体 cancel 0 次 | 请求 2 次，cancel 2 次 |

基准使用临时合成数据库，不包含用户健康数据。
外键基准文件约 20.4 MB，先预热 2 次，再测量 7 次取中位数；
来源基准为单次操作，耗时会受本机并行负载、缓存与文件系统影响。
因此以写入/扫描次数作为主要结构性收益，**不将这些数字解释为整体 API 提速倍数**。

独立复现日志：

- `/tmp/rai-backend-review-20260916/repro-before.log`
- `/tmp/rai-backend-review-20260916/repro-after.log`
- `/tmp/rai-backend-review-20260916/benchmark-before.json`
- `/tmp/rai-backend-review-20260916/benchmark-after.json`
- `/tmp/rai-backend-review-20260916/benchmark-source-before.json`
- `/tmp/rai-backend-review-20260916/benchmark-source-after.json`

这些 `/tmp` 日志可能被系统清理；关键结果已记录在本报告，
故障回归已写入仓库测试，不依赖临时日志才能验证修复。

## 3. 安全与兼容边界复核

- 默认外键验证仍严格，写时约束、迁移 checksum、真实迁移后的验证均未移除。
- API 仅在非 `databaseRecoveryRequired` 状态选择热策略；
  新增 runtime 回归证明启动外键失败后无法绕过验证创建重算任务。
- 入队持久化失败会保留上传来源供重试；不是把失败任务假装成功。
- 课表生成使用独立并发门，保留最终 revision CAS；
  本地假上游 runtime 测试覆盖并发拒绝、生成期间编辑以及冲突后重试。
- 响应正文上限按实际字节计数；新增测试覆盖伪小长度、无长度、
  慢正文、错误响应释放、中文 UTF‑8 跨 chunk 字节边界。
- 复核要求 Sol 补充了 runtime 上游等待的有限失败窗口，避免新测试无限挂起。
- 未改 Web 源码、窄屏冻结区域或 iOS 文件；既有 iOS tracked diff 校验摘要未变。
- 没有对真实数据库执行迁移、导入或清理，没有真实上游模型调用，没有自动提交 Git。

## 4. 验证结果

- `npm run typecheck`：通过。
- `npm test`：Node **628 项 / 625 通过 / 3 跳过 / 0 失败**；
  Web **13 文件 / 84 项通过**。相较基线新增 18 项 Node 回归。
- `npm run build`：通过。
- `npm run smoke:api`：通过，使用隔离空数据库验证启动、健康状态与关闭。
- Sol 的 API runtime 测试：14/14 通过；主模型全量测试再次覆盖。
- `git diff --check`：通过。

桌面浏览器限制：

- 已执行 `npm run test:e2e:web`；其构建步骤通过。
- 本机无测试支持路径中的 Chrome / Edge，before hook 报
  `未找到可用于 E2E 的本机 Chrome 或 Edge`。
- 10 项桌面测试未进入业务断言，1 项响应式测试按脚本规则跳过。
- 未运行 responsive / 全量 E2E，未安装浏览器、修改测试来伪造通过。
- 环境具备 Chrome 或 Edge 后，需补跑 `npm run test:e2e:web` 完成浏览器验收。

## 5. 后续建议

先补齐桌面浏览器验收，再按审查报告第二阶段开展真实规模的合成查询基准。
不要仅根据本次小型基准新增索引或拆分服务。
`apps/api/src/server.ts` 的整体模块化、请求断开后的外部任务取消、
三类数据库的统一恢复策略仍属于后续工作，不在本轮“已完成”范围内。
