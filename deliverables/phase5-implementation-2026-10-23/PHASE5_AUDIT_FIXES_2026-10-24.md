# 阶段 5B 审计问题修复与复验

日期：2026-10-24（Asia/Shanghai）  
输入：用户指定的 `/Users/ta/Downloads/RAI_Phase5_Audit_2026-10-24/REPORT.md`，R1（P1）及 R2–R4（P2）。  
范围：在已有阶段 5 未提交工作区上修复四项问题；不部署、不启用生产写能力、不操作个人或生产数据库。

## 修复与证据映射

| 问题 | 修复 | 回归证据 |
|---|---|---|
| R1 / P1 事实更新期间绕过生成准入 | runtime 与统一生成共用 `coach_sync_pending` 判据；读取前、生成后及提交时复核；保留 data_version/配置指纹。HTTP refresh 与 submit 都先重放持久结果，不等待主库 mutation lease；新生成仍受就绪检查，暂停只撤销执行 | `training-plan-commands.test.ts` 就绪闩锁覆盖生成前/中/提交前；`training-plan-ownership.test.ts` 比较旧 runtime 与 `prepareUnified`；真实 router 覆盖 unmanaged/managed、import/full_recompute 忙、任务成功/失败后的释放、暂停与恢复、重放优先、所有业务表零新增 |
| R2 / P2 暂停保留旧锁且今日读不一致 | 同一 publication transaction 清空 unified/goals 当前锁。统一 owner 的停止状态进入既有 `trainingStopped` 决策，`/today` 与 v1 聚合均返回休息建议/无锁，执行窗口全部不可执行；历史与设备账目保留 | 真实 router：生产 Store 合成锁课 → pause → today/v1/v2/workout-plan → resume；历史前缀/回执账目保留。注入 pause 历史写入失败，验证清锁与所有业务行一起回滚 |
| R3 / P2 在途预览关闭后仍接纳回包 | 取消预览推进 generation 并释放 preview busy；旧回包与 defer 不得覆盖新预览。面板按钮/手势消失/草稿改变统一取消 preview Task；新打开清理旧候选，确认匹配当前草稿。提交/查询代次与 journal 保留 | `TrainingPlanPublisherRegression.swift` URLProtocol 响应闩锁：在途关闭/草稿改变 → 回包 → 重新打开必须再预览、旧/新请求交错、提交/查询关闭仍可确认且保留 journal；`ModelRegression.swift` 不匹配草稿零提交、读状态仍可用 |
| R4 / P2 managed 自动刷新提前返回 | `ensureWeeklyPlan` 优先处理已迁移 scope，验证 owner-ready 后进入统一 Coordinator；旧 managed 保护只用于未迁移路径 | 真实隔离服务等待生产 60 秒 startup tick：managed active 空窗口自动发布 7 天、revision/operation/receipt 各一次；paused 与损坏 owner 所有业务表不变。没有直接调用 Coordinator 代替入口验收 |

暂停不删除历史处方、历史回执或设备撤回账目；API 停止执行授权不代表物理 Watch 已完成撤回。
事实更新 HTTP 用例使用临时主库内持久 running import continuation / full_recompute 行，经过生产 readiness 判据与真实 router；
不是实际导入大文件/生产重算耗时任务的全流程验收。Publisher 时序由 transport 控制，不冒充 Simulator 手势或配对设备验收。

## 当轮验证

最终命令、退出码和日志保存在 [修复证据目录](evidence/audit-fixes-2026-10-24/)；
失败与中间尝试见 [attempts/README.md](evidence/audit-fixes-2026-10-24/attempts/README.md)（不作为最终证据）。
本轮修复后已在当前工作区重新执行验证；结论以最新一次工作区日志为准，不再引用修复前日志。

## 验收口径修订与边界

- T15 / G2：生成 lane busy 与事实任务就绪分开验证；本轮增加后者及提交前检查。
- T17 / G3：增加 unmanaged 锁课暂停的跨读模型、事务回滚与 managed 真实定时入口，不用 managed `/lock` 的 409 替代。
- T06 / T20 / G4：增加新 Publisher 的在途取消/迟到回包、草稿绑定、已发送提交/查询 journal 保留。
- T26 **部分通过**：既有 Simulator 只覆盖预览、取消、确认、冲突、普通重启重读；响应丢失→查询、未知 pending 重启、能力关闭的 Simulator 证据仍缺。本轮未重跑 Simulator UI。
- T27 **未执行**；T30 **部分**。没有新增真机/配对 Watch、旧 App 交错升级或生产回滚演练。
- 生产 `trainingPlanCommandContractVersion` 继续关闭；未部署、未提交 Git、不进入阶段 6。既有证据与 SHA256SUMS 保持原样，当轮日志独立存放。

R1–R4 的代码修复及隔离回归不能替代完整阶段 5 的原生、设备与发布验收。
