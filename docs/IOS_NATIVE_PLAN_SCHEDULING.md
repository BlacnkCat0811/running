# iOS 训练计划排期与设备副作用协议

状态：**现行**（2026-10-20 合并；适用于统一训练排课 v2 之后的设备侧行为）。
wire 形状（读/命令/预览/刷新、410 退役矩阵、回执字段）见
[IOS_NATIVE_API_CONTRACT](IOS_NATIVE_API_CONTRACT.md)；本文只写**设备侧不变量与失败语义**。

本文取代三份 2026-10-09 的时点文档（`IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL`、
`IOS_TRAINING_PLAN_IMPLEMENTATION`、`IOS_TRAINING_PLAN_STATE_V1`）中仍然有效的设备侧内容；
那三份的完整历史可从 Git 取回，指针见 [项目审查 §5](PROJECT_REVIEW.md)。

## 0. 边界

- 训练处方、预算、准备度、周期化与评分仍由服务端负责；iOS 只展示、适配并管理**系统排期副作用**。
- 系统排期 = 通过 WorkoutKit 写入 iOS/Apple Watch 日程；`scheduledWorkouts` 强匹配只证明调用端读到了系统日程，
  **不**证明物理手表已可见。两者是不同的验收项。
- 前台用户操作是唯一触发器：不在后台自动排期、不自动重试回执、不自动恢复“已成功”。

## 1. 本地状态所有权

| 状态 | 存放 | 清缓存是否会丢 |
|---|---|---|
| 展示缓存（计划/今日聚合） | `CacheStore` 的 `cache_entries` | 会（可联网重建） |
| **写入确认水位**（scope → revision） | `plan_write_acknowledgements`（独立表） | **不会** |
| 系统排期 ledger（本次/历史核验结果） | `app_metadata`（app 级） | **不会** |
| 待登记回执 / 撤回风险 | `plan_receipt_journal` + `app_metadata` | **不会** |
| 排期写前日志 | `PlanScheduleOperationJournal`（schema 1，app 级） | **不会** |

不变量：

1. **scope 隔离**：服务地址 + serverId + athleteId + datasetEpoch。水位不是全 app 最大 revision；
   换域读取该域自己的水位。
2. **四条写路径共用一次确认**：goals 保存、lock/relock、coach command、preview confirm 成功后
   都先持久化 `{revision, action, acknowledgedAt, planId?}`，再请求依赖读取；manual 回执不伪造 goals DTO。
   水位单调：旧 GET、旧缓存、迟到回执都不能回退它；事务内再检查一次水位。
3. `clearCache` / `clearAll` / 容量淘汰只清展示数据，**不清**水位、ledger、写前日志、待登记回执。
4. 落盘失败 fail-closed：本会话停止执行；用独立 UserDefaults 标记阻止离线重启加载旧执行缓存；
   联网完整读回并成功持久化后才解除。**所有本地持久层同时不可用时不承诺跨重启保护**，界面必须说明
   “服务端已保存、本地确认记录未持久化”，且不得把成功的业务写入重新提交成新业务操作。
5. 缓存读结果必须区分 `value / notFound / unsupportedSchema / corruptPayload / storageUnavailable`；
   安全元数据损坏**不能**当空数组处理、不能再写空覆盖；更高 schema 的日志保持风险状态并阻止新的替换。

## 2. 读取状态与执行授权

- 计划读取状态：`empty / loading(refreshing) / ready / cached / savedAwaitingRefresh / inconsistent(failed)`。
  展示状态与错误原因分开，不用互斥 enum 表达所有组合；`cached` 只作“上次安排”参照，**不授权**离线新排期。
- v2 统一状态（`TrainingPlanStateResponseV2`）是**投影**：`execution.permitted` 恒为 false，
  即使载荷写 `permitted: true` 也按合同违规处理；执行授权只能来自执行快照（`/training-plan-state` v1 聚合）。
- 客户端不提供 v1 回退：未知合同/未迁移显示类型化升级提示（`upgradeRequired` / `notMigrated` /
  `serverUnavailable` / `contractMismatch`），**不得**把失败显示成“休息”。

## 3. 导出映射（严格、不可退化）

1. 唯一 SDK 边界：`WorkoutKitBridge`；唯一 mapper：`WorkoutPlanMapper`。
2. mapper 返回 `exact / normalized / unsupported` 与原因码；`normalized` 只允许不改变目标数值集合的
   上下界排序。**不允许**步骤删减、次数截断、剂量钳制、单侧心率目标猜测、阈值推断。
3. 无法按服务端整米/整秒回执语义保留的兼容剂量拒绝导出；SDK 不支持必需步骤/alert 时拒绝整日。
4. 回执 `structure` 是**实际导出结构**；排序差异写入 metadata，不宣称“生理无损”。

## 4. 排期操作：写前日志与阶段机

`PlanScheduleOperationJournal` 先落盘再产生副作用；日志里记录 scope、operationId、goals revision、
coherenceToken、窗口/提醒小时、每条 UUID/精确时刻/最小实际处方与摘要、清理目标、逐项阶段。
不含 token、路线或原始健康样本。

阶段顺序（**写日志失败即停止后续 SDK 副作用**）：

```
完整快照 → 全量 mapper/SDK/容量预检 → 持久 prepared → 持久 clearing → 清理
  → 每条持久 submitting → schedule → 持久 returned → 持久 verifying → 强读回
  → 日志/ledger/待登记回执同一本地事务提交
```

- **预检失败不先删旧课表**：任一必需训练不可导出（容量/必要目标/剂量）→ 整体不替换，展示失败日期；
  不提供隐式“只同步可导出日”（若要提供，必须是用户显式选择并说明覆盖影响）。
- 普通替换只定向删除已知同 scope 的旧 UUID 与时刻；发现未知或其他 scope 的系统条目要求显式管理。
  `removeAll` 只用于用户显式选择的“撤回 RAI 系统旧排期”。
- 调用返回 ≠ 核验；部分、清理失败、存储失败都不能包装成成功。

## 5. 强读回与覆盖判据

- 读回必须同时匹配 **UUID + 规范化精确时刻 + localDate + 内容 + 未完成状态**；
  只比日期、只比内容、只看 `schedule` 返回都不可接受。
- 覆盖分母是**全部 owed 日**（含映射/容量/SDK 拒绝日），不是 pending 与 confirmed 的差；
  休息、已过去、已完成、服务端不可执行日单独列 filtered，不算用户欠的训练。
- `removeAll` 后必须读回为空才继续替换。
- 一次读回是当前策略；加入重读必须先有真机延迟测量，且总时长/次数受限、可取消，等待期间重验完整快照与租约。

## 6. 撤回与“先撤回再下发”

- 操作失效后只撤回**本操作**已提交的 UUID/时刻并读回；协调器串行到 cleanup 结束；撤回失败携带
  submitted IDs、持久化撤回风险并要求用户显式撤回，不删除下一操作。
- 模式/配置切换协议（v2 PR6）：`prepared`（持久化新旧上下文）→ 身份核验（系统清单只含旧 UUID）
  → `clearing` → 移除旧条目 → **强读回必须为空** → `verifying`（仅切换时登记撤回，失败中止下发）
  → 逐项 `scheduling/submitting` → 最终读回。任一步失败停在可恢复的 `.clearing`，恢复会重新撤回。
- 恢复使用日志里的**原实际处方**比对系统返回；定向撤回用系统清单返回的真实 `WorkoutPlan`，
  不依赖旧进程内字典，也不拿新版服务端处方猜测旧条目。
- 启动遇到未结束操作只显示“中断，需核验/撤回”，由用户前台选择；**不自动恢复成功**。

## 7. 回执（`planReceiptContractVersion = 2`）

- 独立能力版本，不复用 legacy `planReceiptMetadata` 布尔。
- v2 必需：scope、localDate、kind、revision、workoutID、scheduledAt、verifiedAt、timezone、
  实际 structure、prescriptionDigest、operationId、coherenceToken、lifecycleEvent。
  `verifiedAt` 是客户端本次观察时间，`recordedAt` 是服务端接收时间，不能互换。
- 服务端登记只代表“客户端报告了核验事实”，不是服务端直接观察 SDK，更不是物理表端交付证据。
- `withdrawn` / `replaced` 是**追加**事件：不删除、不改写已登记历史；执行关联按核验至撤回/替换的有效区间解释。
- 历史回执与当前排期隔离：只有 scope、revision、localDate、UUID 与精确 scheduledAt 都属于当前 ledger 的
  核验回执，才能因 `matchesCurrent=false` 或范围冲突把当前排期标为待撤回。
- 旧四字段回执继续接纳并标 legacy；新客户端连旧服务只发旧字段，不伪装新保证。

## 8. 发布操作幂等（服务端面，设备侧只消费）

- `GET /v1/mobile/plan-operations/:id` 返回 `committed / notFound / scopeMismatch / expired`；
  只有明确 `notFound` 才按原键、原字节、原身份重试。
- 完整结果保留 **90 天**（`mobile-goals.ts` 的 `Date.now() + 90 * 86_400_000`）。
  查询已过期操作返回 **HTTP 200 + `status: "expired"`**；只有**重放同一 operationId 的写**才是
  `410 plan_operation_expired`，且不重新执行副作用；墓碑不得删除后重放。
- 2026-10-20 起旧计划写面（`/v1/mobile/goals`、`/run-coach`、`/workout-plan/{preview,confirm,generate}`）
  统一 410 `legacy_surface_retired`，替代面是 `/v1/mobile/training-plan/commands{/preview,/refresh}`。
  **已知缺口**：统一训练页仍渲染“手动课表”入口（`TechPlanView.swift` 的 `manualPlanEntry`），
  无教练计划时保存/预览/确认会命中 410；客户端写路由尚未切到 v2，也没有 handshake 能力位。
  这是当前 P1（见 [项目审查 §2](PROJECT_REVIEW.md) AR-1），不是已接受的产品行为。

## 9. 诊断、隐私与回滚

- 诊断事件上限 500 条，只保留 operationId、脱敏 scope、阶段/版本/数量/错误码；用户主动导出本地脱敏 JSON，
  不上传远端遥测；不记录 token、健康原始样本或路线。
- 升级顺序：服务端先增能力、客户端后使用；回退**不**删除新增表、墓碑、事件、水位、ledger、日志。
- 不可解析的安全账目从备份恢复或人工诊断，**不要删除后重新排期**。
- 备份控制库并在隔离库演练事务失败、重启、迁移/恢复；不在真实健康主库上做故障注入。

## 10. 验证入口与设备证据边界

- 自动入口（2026-10-20 口径）：`npm run test:ios`（含 `TrainingPlanV2Regression`、
  `PlanWatchContextRegression`、排期/存储/回执回归与结构门禁）、`npm run typecheck`、`npm test`；
  改文档另跑 `npm run check:docs`、`npm run check:doc-refs`、`npm run check:acceptance-matrix`、`npm run check:scripts`。
- `npm run check:training-plan-single-writer` 守“唯一写者”源码形状（不是运行时唯一性证明）。
- 反向验证：`RAI_PLAN_WATCH_MUTATIONS=1 bash apps/ios/tests/run-plan-watch-tests.sh` 与
  `RAI_PLAN_STATE_MUTATIONS=1 bash apps/ios/tests/run-model-tests.sh`；突变必须“先编译成功，再被行为断言拒绝”。
- 仍必须由配对 iPhone + Apple Watch 验证（不得用 fake scheduler 或 Simulator 替代）：
  UUID/时刻稳定、真实表端可见、读回延迟、授权各状态、运行期部分成功、定向/全部撤回、
  每个副作用后强杀重启、读回/回执期间改计划/提醒/跨午夜、模式切换时旧条目确实先消失。
- 真机清单与步骤见 [IOS_NATIVE_RUNBOOK](IOS_NATIVE_RUNBOOK.md)；回执/诊断的字段级合同见
  [IOS_NATIVE_API_CONTRACT](IOS_NATIVE_API_CONTRACT.md)。
