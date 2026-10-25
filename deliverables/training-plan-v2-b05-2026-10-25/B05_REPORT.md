# B05：原生课程编辑 / S02-03–05

日期：2026-10-25（Asia/Shanghai）。状态：**已验收，G2 已签收**。G3–G7 未签收。

## 实现范围

- [APIModels](../../apps/ios/RAI/APIModels.swift) / [APIClient](../../apps/ios/RAI/APIClient.swift)：独立课程合同 1；精确协商头与新 URL；结构显式 null；patch 遗漏与清除不同；新路由 404 不当业务 notFound。
- [Publisher](../../apps/ios/RAI/TrainingPlanPublisher.swift)：复用现有唯一 pending row，编码一次后持久化原 UUID/字节；确认分开保存 state/goals 水位；关能力仍可查询已提交结果；未知结果保留原操作。
- [NativeAppModel](../../apps/ios/RAI/NativeAppModel.swift)：独立能力判断；提交前取消旧读并失效 Store；完整重读与保存回执分开；关闭页面不清账，不调用 WorkoutKit。
- [原生表单](../../apps/ios/RAI/Skins/Technology/TechTrainingSessionEditor.swift) / [统一页](../../apps/ios/RAI/Skins/Technology/TechPlanView.swift)：日期、距离、类型、分段剂量/重复次数、配速/心率目标、说明、取消、休息、解除保护；预览与显式保存；能力缺失保留只读说明。
- [Publisher 回归](../../apps/ios/tests/TrainingPlanPublisherRegression.swift) / [Simulator 回归](../../apps/ios/tests/VisualAcceptance.swift)：journal 故障、HTTP 404/503、重启查询、精确字节重放、能力关闭、水位、实际点击和服务端状态对照。

## 已取得证据与真实失败

- 独立 Swift Publisher 回归通过，包含新增课程命令场景；见 [日志](logs/rai-session-publisher.log)。
- 跨平台 iOS source gates 11 支通过，2 支按其既有人工入口排除；见 [日志](logs/rai-session-ios-gates.log)。
- 全应用 Simulator 构建已通过。实际 UI 测试完成保存，API 断言同一课程 ID/新日期/用户保护正确，但**重启后首次打开显示了空选择初始化的表单**，该轮 UI 失败，不能签收。
- 失败截图与点击记录保留在 [failed-ui](failed-ui/ui-tests.log)。已把 `editingSession + isPresented` 两个状态改为一个带身份的 `sheet(item:)` 目标；加入“首次点击日期必须等于所选课程”断言。修复后的普通字号真实点击链 1/1 通过，见 [普通字号 UI](normal-ui/ui-tests.log)：预览取消零写、同 ID 改期保存、进程重启后重读保持。
- 视觉复核发现键盘遮挡确认区，已增加字段焦点并在预览时收键盘。Accessibility XXXL 首次运行暴露了测试输入光标位于字符串中间、未完全替换旧日期的问题，服务端正确返回“日期非法”，没有提交。证据见 [大字体失败过程](failed-large-ui/ui-tests.log) 和截图；已改用全选替换并在预览前断言完整日期，增加预览后键盘为 0 的可见性断言。
- 修复后的 Accessibility XXXL 真实点击链 **1/1 通过**（162 s）：预览取消零写、同 ID 改期保存、进程重启后重读保持；日志与截图见 [大字体复跑](large-ui/ui-tests.log)、[预览](large-ui/screenshots/session-move-preview.png)、[保存](large-ui/screenshots/session-move-saved.png)、[重启](large-ui/screenshots/session-move-restart.png)。该轮与普通字号轮使用同一隔离 fixture 和 `RAI Technology Acceptance` 模拟器。
- 初次选择 iPhone 12 Pro Max Simulator 时系统停在 Data Migration，已停止该次初始化并改用已启动的专用 `RAI Technology Acceptance`；该尝试不当应用验收。
- 中间 Swift 编译曾发现过大的视图表达式和不存在的颜色成员；已拆分视图并使用现有 cyan，完整应用构建通过。部分被后续修复替代的聚合运行已中止，不算 PASS。

## G2 验收

2026-10-25 在 B05 源码身份上签收 G2：

- [x] 日期、距离、目标、类型/强度、休息、取消、新增、解除保护均由 B04 真实 HTTP 用例覆盖（[B04 记录](../training-plan-v2-b04-2026-10-25/B04_REPORT.md) §任务表）；B05 原生表单调用同一独立课程合同。
- [x] 周三 8km → 周四 10km → 多次重算：B04/T09 与 `phase5-training-plan.test.ts` 的 B04 真实路由用例断言同 ID、内容保留、源日不复活；B05 点击链再次断言同 ID 改期保存与重启恢复。
- [x] 同日碰撞、同键重复、异键陈旧提交、六个业务 SQL 写点与 COMMIT 故障：B04 定向用例全部通过（38/38 + 双进程 CAS + 设备排期）。
- [x] App 重启与清空客户端后重读：普通字号与 XXXL 点击链都执行 `terminate → launch → 重新握手 → 完整读`；`TrainingPlanStoreRegression` 覆盖缓存清除后仅参考、不重放已提交操作。
- [x] journal 失败、服务端已保存但重读失败分别提示：`TrainingPlanPublisherRegression` 最终日志 PASS；关闭能力后仍能查询已提交结果。
- [x] 现有皮肤、今日锁、反馈、手表撤回与旧服务器兼容不回归：B05 的 `rai-session-ios-g2.log`（完整 iOS 聚合）与普通/大字体两轮 Simulator 真实点击均通过；未自动调用 WorkoutKit。

G2 只证明课程编辑与原生恢复；G3 执行关联、G4 自动发布仍未签收。

## 环境与隔离

复用 B04 的 dirty `main` 源码与合成隔离约束。`run-visual-tests.sh` 新增显式 opt-in：
`RAI_VISUAL_SESSION_COMMANDS=1` 只在临时 fixture 离线升级课程身份；
`RAI_VISUAL_SESSION_COMMANDS_MODE=validation` 为该临时服务开启课程写。
未设置时维持原 Phase5 行为。没有连接个人/生产 API，没有 HealthKit 真机样本或物理 Watch 送达证据。

G2 已完成：普通字号 1/1、Accessibility XXXL 1/1、iOS 聚合与 B04 后端全量回归均有日志。B06–B11 不因此当已实现；本记录不签收 G3–G7。
