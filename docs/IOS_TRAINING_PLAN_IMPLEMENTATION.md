# iOS 训练计划一致性与系统排期实现

2026-10-09 后续方案实施见 [事实快照、发布操作与排期恢复](IOS_TRAINING_PLAN_STATE_V1.md)。原文保留此前基线证据；不将其设备待验收项视为本轮完成。

实施日期：2026-10-09（Asia/Shanghai）。对应 2026-10-08 复核报告 F1–F8。
本文件描述当前代码与验证边界，不是训练效果、真机权限或配对手表交付证明。

## 1. 已实施的职责边界

| 报告方案 | 当前实现 | 自动回归 |
| --- | --- | --- |
| PR-1 / F1 | `CacheStore` 独立、不可淘汰的 scope 水位表；SQLite 事务接纳写回执、作废执行缓存、保存完整 goals/coach 回应；四条写路径共用 `acknowledgePlanWrite` | ModelRegression 四路径 × 正常/落盘失败 × 读取失败/重启；StoreRegression 真实事务、故障触发器、重开、清缓存与跨域 |
| PR-2 / F2 | 两页调用唯一 `PlanWatchSyncCoordinator`；完整三读后捕获 scope、配置、revision、有效 days、时区、小时、完成集合、本地日期、窗口和租约；所有 SDK await 边界重验 | 同 revision 闸门/结构、小时、完成集合、时区、午夜、身份切换、授权等待、写后失效、串行 cleanup |
| PR-3 / F3–F5 | `WorkoutScheduling` 可替换 adapter；唯一 WorkoutKit import；UUID + 精确规范化时刻 + localDate + 内容 + 未完成读回；逐日结果、完整覆盖、清空核验独立 | 错 ID/时间/内容/日期、跨日、UTC、静默清空失败/排期失败、三日两成功、容量/必需目标拒绝、午夜、取消撤回失败 |
| PR-4 / F6 | 无计划/结束/离线均保留显式撤回；app 级持久化 ledger；启动永远 unknown；同域刷新保留本会话核验；跨域旧排期、部分覆盖指纹变化与中断撤回风险单独显示 | 重启未知、实际确认集合、跨域、离线无当前处方撤回 |
| PR-5 / F7–F8 | `PlanPresentationSnapshot` 统一当前读出口；已保存待刷新/缓存/正在读取/版本不一致/不可用；本地日保护；滚动计数/原因明确“未来7日”；无骨架不生成 base 阶段 | 模型混合版本、legacy today 无 revision、全响应 fitness/全马/50km phases 空；原有 5K/10K/半马与自然周对齐回归 |
| PR-6 / F8 | 安全字段不乐观补齐；未知目标拒绝解码、未知计划状态不能执行或确认今日建议；缓存 schema 1 显式兼容，schema 2 新写入，未知/损坏拒绝；回执可加 UUID/时刻/幂等/exportNotes；前台显式重试账目 | safety 字段缺失、未知 enum、真实损坏/schema cache、旧新 schema wire、receipt 去重/冲突/重开、部分登记失败 |
| PR-7 / F8 | 手动页、setup、overview/week/upcoming/evidence/day/strength/watch 组件拆分；保留导航壳、sheet 身份、accessibilityIdentifier 和 CAS 草稿保护；preview 内部改名，HTTP 不变；删除非编辑态重复草稿构造 | 真 iOS SDK 类型检查、纯逻辑门禁和 workspace 构建；视觉/设备证明另列 |

服务端仍为处方、预算、准备度和评分真源。没有改变剂量常数、预测支持距离、HealthKit 权限或后台机制；没有创建 Watch 产品；没有修改冻结的窄屏 Web。

## 2. 水位、事务和存储故障

- scope 继续由服务地址、serverId、athleteId、datasetEpoch 隔离。水位不是全 app 的最大 revision。
- goals PUT、lock/relock、coach command、preview confirm 收到成功后，先持久化 `{ revision, action, acknowledgedAt, planId? }`，再请求依赖读取。manual 回执不伪造 goals DTO。
- 水位单调；旧 GET/旧缓存和迟到回执都不能回退；事务内检查水位，迟到低版本确认不会删除高版本缓存。说明字段不可解码时仍使用水位表中的标量 revision。
- `clearCache` / `clearAll` / 缓存淘汰只清展示数据，不清确认水位、app 级系统排期 ledger 或待登记账目。换域读取该域自己的水位。
- SQLite 落盘失败时，本会话 fail-closed，并用独立 UserDefaults best-effort 隔离标记阻止离线重启加载旧执行缓存；联网完整读回后重新持久化确认，成功才解除隔离。
- **所有本地持久层同时不可用时，不能保证跨重启保护。** UI 明确显示“服务端已保存，本地确认记录未持久化”，要求联网确认；不将成功的业务写入重新提交成新业务操作。
- 缓存 schema 1 与 2 的 DTO 形状相同；版本只明确封装演进。未知 schema / 损坏 / 不可用有分类，不打印健康 payload 或凭证。

## 3. 排期、覆盖与回执

1. 显式同步获取一致 goals/today/workout-plan；today 的 revision、时区及本地日必须成立。generatedAt 不参与租约。
2. 支持性先于授权。仅 notDetermined 请求授权；denied/restricted 不重复弹窗、不默认建议重装或重置隐私。
3. 每日建立新 WorkoutPlan UUID。日期可读、排期时刻可规范化且仍落在该 localDate；跨午夜的推迟时刻拒绝。
4. 严格导出检查不允许 mapper 对必需步骤、次数、剂量的截断/钳制或目标丢弃伪装成完整处方；无法按服务端整米/整秒回执语义保留的兼容剂量拒绝导出；SDK 不支持必需步骤或 alert 时拒绝整日，不静默删步。
5. 目标区间只允许不改变数值集合的上下界排序；心率钳制、单侧目标被删等改变强度意图的情况拒绝整日。回执 structure 是实际导出结构，metadata 说明排序差异，不称为生理“无损”。
6. removeAll 后必须读回为空，才继续替换。排期后读回 UUID、时刻、日期、内容和 complete 状态；无日期不按内容猜。当前执行一次读回，不未经测量引入猜测等待/无限重试。
7. 完整覆盖依据全部 owed 日期（含映射/容量/SDK 拒绝日），不是仅比较 pending 与 confirmed。休息、已过去、已完成、服务端不可执行日单独列 filtered，不算用户还欠的训练。
8. 两页均登记所有且仅有强匹配成功日，即使整次部分失败。服务端登记失败不推翻本机核验结果。
9. 同步失效后（包括服务端回执登记等待期间）仅撤回本操作已提交的 UUID/时刻条目并读回；协调器串行到 cleanup 结束。撤回失败携带 submitted IDs，持久化撤回风险并提示用户显式撤回；不删除下一操作。
10. `/synced` 是**本地系统排期回执**，不是物理手表收件确认。独立真机验证 UUID 读回稳定性和表端实际可见。

### 错峰升级

`/v1/handshake.planReceiptMetadata` 是可选能力位；新服务器为 true，旧服务器缺省为不支持新元信息。
客户端没有该能力时只发送原有 localDate/kind/revision/structure，structure 仍为真实导出；不会试探性提交未知字段导致 400。
新服务器接纳可选 workoutID/scheduledAt/idempotencyKey/exportNotes，旧回执不改写。
相同幂等键/相同业务输入重试返回最初 recordedAt；同键不同输入拒绝。旧服务不支持幂等，新客户端不宣称旧服务的重试去重保证。
待登记账目 scope 隔离、不参与缓存淘汰，仅由前台用户点击重试发送，不增加后台同步。

## 4. 页面与文件组织

`TechPlanView` 仅保留导航兼容壳。`TechManualPlanView` 保留编辑事务、取消/放弃/重载；只在进入编辑或明确重载时构造草稿。
`TechRunCoachView` 组合独立语义组件，不另建一份镜像 NativeAppModel 的 ViewModel。拆文件是职责优化，不是 FPS 保证。
两个页面都使用 `TechPlanWatchSection`：自然周历史/进度独立常显，滚动执行窗口折叠展示；暂停/结束和无计划仍能离线撤回。
没有测得设备主线程瓶颈，因此不开展剂量、通知生命周期或动画性能专项，也不删除 reminder/scenePhase/完成日期依赖。

## 5. 验证与发布边界

自动入口：`npm run test:ios`（新增 scheduler regression 已挂聚合入口）、`npm run typecheck`、`npm test`、`npm run build`。
涉及的是 iOS/API 契约，未改 Web 显示，不运行 responsive/mobile Web 测试。
模拟器用现有 `run-visual-tests.sh` 的隔离服务/数据库，仅证实其实际执行的 UI 步骤；配对手表清单见 [IOS_NATIVE_RUNBOOK](IOS_NATIVE_RUNBOOK.md)。
发布前必须分别保存：
- 系统 scheduledWorkouts 的 UUID/规范化时刻/内容与每日确认集合；
- 真实配对手表的可见/不可见状态。

尚未执行的人工检查不能标成通过。回滚页面拆分不应删除水位/ledger/journal；删除新增幂等索引可以回退元信息去重实现，但不得重写旧回执或整体降低执行 revision。

### 可执行反向验证

发布审计可运行 `RAI_PLAN_WATCH_MUTATIONS=1 bash apps/ios/tests/run-plan-watch-tests.sh` 与
`RAI_PLAN_STATE_MUTATIONS=1 bash apps/ios/tests/run-model-tests.sh`。
所有突变只写临时副本，先编译成功，再要求行为断言拒绝忘记水位、仅 ID 租约、错 UUID、pending 冒充覆盖、静默清空冒充成功；不把编译失败算“真红”。

## 6. 本次实际验证结果

验证日期：2026-10-09（Asia/Shanghai），工作区基线 `73d68450f3df6fa4f771a80b710c442baa738560`。
修改留在工作区，尚未创建提交或远端 PR。

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | TypeScript 全仓类型检查 |
| `npm test` | Node 1,404 通过、3 跳过、0 失败；Web 25 文件 / 182 测试通过 | 既有显式跳过仍保留，不声称 1,407 全部执行通过 |
| 定向 API / schema 五文件 | 45/45 通过 | 完整 phase/phases、CAS/预览确认、回执持久化/幂等、旧新 wire schema |
| `npm run build` | 通过 | Web 生产构建；未改 Web 显示，不运行冻结的窄屏/响应式 E2E |
| `npm run test:ios` | 通过；84 份真实 iOS SDK 类型检查；新增排期回归 49 项；生产 store 82 项；展示回归 200 项 | 3 个高德 SDK 依赖文件在该类型检查通道排除；完整 app 另以 workspace 构建验证 |
| 最终 `RAI.xcworkspace` Debug Simulator 构建 | `BUILD SUCCEEDED` | 包含 filesystem-synchronized 新文件及原 SDK 文件；不是签名真机构建 |
| 五类语义反向验证 | 5/5 由指定行为断言拒绝 | 忘记水位、仅 ID 租约、错 UUID、pending 冒充覆盖、清空冒充成功；全部先编译成功 |
| 专用模拟器 UI | 六个相关用例均取得通过结果 | 手动计划、大字体编辑、教练生命周期、大字体日历、赛事设置、预览/取消、结束或无计划/离线重启撤回；不是全 UI 套件 |
| 文档链接检查 / `git diff --check` | 通过 | 本地文档引用、空白格式 |
| 配对 iPhone / Apple Watch | **未执行，发布前仍待人工验收** | UUID 真实读回稳定性、权限恢复实际入口、读回延迟和真实表端可见性不能以 fake/模拟器替代 |

模拟器第一轮新增撤回用例因“模拟器必定 unsupported”的测试假设失败；现场实际为授权拒绝。
测试改为核对明确的支持/授权拒绝结果，不放宽为“任意结果均通过”；补齐 refused/restricted 状态回归后复验通过。
最终源码构建与新增撤回 UI 用例已再次通过，其他五个用例的通过证据来自此前相关页面构建；不把不同轮次合计包装成某一次六用例全绿运行。

脱敏逻辑日志、初轮失败与复验日志、截图索引保留在本地：
`/Users/ta/running/var/reports/ios-training-plan-implementation-2026-10-09/`。
该目录被 Git 忽略，截图来自隔离数据副本，只用于本机验收，不应未经审查公开上传。
原始 `.xcresult` 与编译产物位于相应 `/tmp/rai-plan-visual-*` 目录，未添加到仓库。
