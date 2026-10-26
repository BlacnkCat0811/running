# B10：原生全链路、兼容与发布候选 / S06-01–04

日期：2026-10-25（Asia/Shanghai）。状态：**Simulator 课程编辑/执行关联点击链已执行；真机、配对 Watch、旧构建交错与发布演练未执行；G6 未签收**。

## 环境

- 专用 Simulator：`RAI Technology Acceptance`（iOS 26.5，UDID 91C2D1F3-FB19-4843-B892-1A4F4AAF6D16），普通字号与 Accessibility XXXL 分别执行。
- 隔离 fixture：`scripts/prepare-phase5-fixture.mts` 在系统临时目录创建主库/控制库；API 绑定 127.0.0.1:8792，测试 token 仅用于本次运行；未读取/修改用户日常健康库。
- 课程编辑：`RAI_VISUAL_SESSION_COMMANDS=1 RAI_VISUAL_SESSION_COMMANDS_MODE=validation`。
- 执行关联：`RAI_VISUAL_EXECUTION_FACTS=1`，由 `apps/ios/tests/prepare-execution-fixture.py` 在隔离主库插入一条合成 run，并把课程可用时间前移，使“开跑前已发布”真实成立；不使用真实 HealthKit 样本。

## 任务 → 证据

| 任务 | 证据 |
| --- | --- |
| S06-01 原生生成/编辑/保存/重进/重启/冲突/关联纠错/完成回顾 | B05 普通字号与 Accessibility XXXL 两轮 `testSessionEditorMovePreviewSaveAndRestart` 1/1 通过（预览取消零写、同 ID 改期、重启重读）；B07 `testExecutionConfirmRetract` 见下 |
| S06-02 HealthKit 真机链 | **BLOCKED**：无 iPhone 12 Pro Max 真机、无真实 HealthKit 导出/后台同步证据；合成 run 不冒充真机 |
| S06-03 设备排期协调/配对 Watch | **BLOCKED**：无配对 Watch；本机 `scheduledWorkouts` 不冒充物理 Watch 可见性；编辑不自动调用 WorkoutKit 已由代码与回归证明 |
| S06-04 新旧 App/服务/能力/回滚 | 部分：能力关闭重放、404/410 分类、schema 2/4/5 读取、旧缓存兼容由 B04–B08 定向与 iOS 回归覆盖；**真实旧构建交错与隔离部署回滚未执行** |
| S06-05 运维/发布 | **BLOCKED**：需后续明确生产授权；本记录不部署、不迁移生产、不启用生产能力 |

## Simulator 点击链结果

| 用例 | 结果 | 证据 |
| --- | --- | --- |
| `testSessionEditorMovePreviewSaveAndRestart` 普通字号 | 1/1 PASS（162.1 s）：预览取消零写、同 ID 改期保存、重启重读 | B05 [normal-ui](../training-plan-v2-b05-2026-10-25/normal-ui/ui-tests.log) |
| `testSessionEditorMovePreviewSaveAndRestart` Accessibility XXXL | 1/1 PASS（162 s）：大字体全选替换日期、键盘关闭、保存、重启 | B05 [large-ui](../training-plan-v2-b05-2026-10-25/large-ui/ui-tests.log) |
| `testExecutionConfirmRetract` | 1/1 PASS（最终复跑 75.5 s；首次 160.8 s）：合成 run 作为候选、确认后 API 读回 completed/confirmed、撤回后 pending/invalidated | [ui-tests.log](../training-plan-v2-b07-2026-10-25/simulator-execution/ui-tests.log)、[确认截图](../training-plan-v2-b07-2026-10-25/simulator-execution/screenshots/execution-confirmed.png)、[撤回截图](../training-plan-v2-b07-2026-10-25/simulator-execution/screenshots/execution-retracted.png) |

这些是 Simulator UI 执行，不是 `build-for-testing`；三条用例都通过真实 HTTP 对隔离 API 读写，并在测试进程内用 API 断言服务端状态一致。合成 run 不冒充 HealthKit 真机样本。

## G6 判定

| 检查项（实施计划 §11.3） | 结果 |
| --- | --- |
| §14 全生命周期逐步通过 | 未完成：真机 HealthKit/配对 Watch/物理设备门缺失 |
| 当前 SHA 完整自动检查与历史兼容回归 | 后端 `RAI_TEST_CONCURRENCY=2 npm test` 2729/2726/3 跳过/0 失败；iOS `npm run test:ios` EXIT=0；远端 CI 未验证 |
| 新旧构建、能力关闭、未知提交重启、新数据格式回滚演练 | 仅源码/定向覆盖；真实构建交错与回滚演练 **BLOCKED** |
| 真机 12 Pro Max / Instruments | **BLOCKED** |

G6 不能签收。B11/G7 需要后续明确生产执行授权，本记录不预签。
