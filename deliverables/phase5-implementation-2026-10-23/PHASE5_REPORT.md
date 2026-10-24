# 阶段 5：训练计划 v2 实施与验收报告

**日期：** 2026-10-23（Asia/Shanghai）  
**代码基线：** `/Users/ta/running`，HEAD `fc793e0db4f6ecb04f800f01d625f5f50edf5c68` + 本工作区变更  
**输入：** [阶段 5 审查与实施方案](../phase5-review-2026-10-23/PHASE5_REVIEW_AND_IMPLEMENTATION_PLAN.md)  
**结论口径（2026-10-24 修订）：** **5A 主要修复已落地；5B 审计的 R1–R4 已修复并补回归，完整端到端验收仍未完成。**
本报告原有“代码闭环完成”不作为完整签收；当轮修复与复验见 [审计修复记录](PHASE5_AUDIT_FIXES_2026-10-24.md)。
生产 `trainingPlanCommandContractVersion` 仍未宣告，未部署生产；配对设备/新旧 App 交错升级等未执行项
在 §6/§9 分层列出；既有 Simulator 仅覆盖部分用户链路（T26）。本文不把隔离回归写成生产或完整端到端验收通过。

## 1. 结论摘要

| 交付层 | 状态 | 说明 |
|---|---|---|
| 5A：入口/合同冻结、F1 幂等、F2 能力分离、F5 夹具、F6 窗口文案、F7 指纹实验 | 完成 | 见 §4；F1/F2/F7 均有失败前/通过后或定向回归证据 |
| 5B：unified 所有权、四动作+refresh、iOS Publisher、原生端到端 | R1–R4 已修复；完整验收未完成 | 当轮 API/Publisher 复验见审计修复记录；T26 部分，T27 未执行，T30 部分 |
| 生产能力启用/生产发布 | **未执行** | `RAI_TRAINING_PLAN_COMMAND_MODE=validation` 外不宣告写能力；未改生产、未访问生产库 |
| SQLite/单写者/健康样本只读约束 | 保持 | 未新增客户端/未改评分核心/未新增健康写入 |

## 2. 本次实际变更

### API / 共享合同

| 文件 | 变更 |
|---|---|
| `apps/api/src/training-plan-routes.ts` | `submit` 在 revision/TTL/生成之前先调用持久 `replayCommand`；`refresh` 先 `replayRefresh`；新增 admission 注入 |
| `apps/api/src/training-plan-commands.ts` | `replayCommand`/`replayRefresh`、动作白名单、operationId/scope 校验、候选校验前移、`goalsRevision`、coach receipt 指针、候选 TTL 边界 `<=` |
| `apps/api/src/training-plan-generation.ts`（新增） | 统一生成准入/释放；生成前捕获事实+数据版本，提交前复核 |
| `apps/api/src/training-plan-ownership.ts`（新增） | unified 配置与 coach-loop settings 的互译；当前赛事目标/运行状态的唯一映射 |
| `apps/api/src/mobile-goals.ts` | `bindTrainingPlanOwner`、owner-ready、`currentCoachLoopState`、事务内 `reconcileTrainingPlanOwner`、锁/写路径统一 |
| `apps/api/src/coach-loop-runtime.ts` | `prepareUnified`（统一命令生成）与 owner 状态读取；coach-loop 写入回写 unified |
| `apps/api/src/server.ts` | 候选写准入守卫、handshake 能力条件、managed v2 读、生成 deps/refresh replay、`/workout-plan` 与 lock 的暂停/结束约束 |
| `packages/api-contracts/src/index.ts` | `TrainingPlanCommandResponse.goalsRevision` |
| `packages/api-contracts/src/handshake-registry.ts` | 写能力登记为候选/版本 2，消费者改为 iOS Publisher |
| `scripts/prepare-phase5-fixture.mts`（新增） | 临时目录合成 fixture + dry-run/apply/repeat 迁移，不覆盖现有库 |

### iOS

| 文件 | 变更 |
|---|---|
| `apps/ios/RAI/TrainingPlanPublisher.swift`（新增） | 持久 intent、原字节重放、独立 state/goals 水位、committedAwaitingRead、恢复/终局状态机；不触碰 WorkoutKit |
| `apps/ios/RAI/APIModels.swift` | v2 命令 DTO；`legacyPlanWritesSupported` / `trainingPlanV2CommandsSupported` 独立能力 |
| `apps/ios/RAI/APIClient.swift` | v2 preview/submit/refresh 方法与 header 协商 |
| `apps/ios/RAI/NativeAppModel.swift` | Publisher 转发、命令上下文、提交/恢复/完整重读、旧写 fail-closed、身份变化作废 |
| `apps/ios/RAI/CacheStore.swift`、`TrainingPlanStore.swift` | 独立命令水位持久化与读侧下限校验 |
| `apps/ios/RAI/Skins/Technology/TechPlanView.swift` | 四动作命令面板、配置预览/确认/刷新、冲突/待查询入口；手动课表只读 |
| `apps/ios/RAI/Skins/Technology/TechCoachLoopSection.swift` | v2 不可用时保留 coach-loop 生命周期入口；v2 可用时由统一面板负责暂停/恢复/刷新 |
| `apps/ios/RAI/Skins/Technology/TechViews.swift` | 首次在设置面板输入 Token 时同一击即保存并连接，不再需要点两次 |
| `apps/ios/tests/check-export-determinism-live.py`、`run-visual-tests.sh` | 修复探针源清单过期、清空 stale xcresult、卸载旧 app 容器、合成 fixture/401/410 负例 |
| `apps/ios/tests/*`、`apps/ios/tests/run-*.sh` | 能力组合、Publisher、Store 水位、v2 现场验收与跨平台编译清单 |

### 文档/决策

- `docs/DECISIONS.md` 新增 **D20**（D5-A～E）；D19 增补阶段 5 现状。
- `docs/IOS_NATIVE_API_CONTRACT.md`：handshake 条件、managed v2 读、命令错误码、§3.7 客户端现状。
- `docs/PROJECT_REVIEW.md`：AR-1/AR-2 的阶段 5 状态标注（不宣称生产完成）。
- `docs/IOS_NATIVE_RUNBOOK.md`：仿真器脚本改为合成 fixture，不再使用 `var/rai.sqlite`/`RAI_VISUAL_DATABASE`。

## 3. 决策（D5-A～E，详见 D20）

| 决定 | 选择 |
|---|---|
| D5-A 所有权 | unified 是配置、运行状态、计划意图、当前锁的唯一权威；goals 是兼容投影；coach-loop/lock/命令同一 publication transaction；receipt/历史/operation 独立追加 |
| D5-B 手动课表/偏好 | 只开放四动作 + refresh；逐日手动课表保持只读；完整偏好/手动保存需 §4.2 合同扩展 |
| D5-C start/end 等 | start/end、lock、反馈、手表回执保留既有合同；end 不等于 pause；统一汇入 owner |
| D5-D 七日窗口 | 只展示已发布日期；缺失显示“未生成/待刷新”，不是休息；阶段 5 不自动补齐；`refreshDecision` 的任一天命中判据保持 |
| D5-E 能力版本 | 写能力版本 2 只在隔离验证候选 + 客户端 header 时宣告；生产关闭；未知/缺失/未协商只读；v2 不放行旧 URL |

## 4. F1–F7 处理结果

| 发现 | 结果 | 证据 |
|---|---|---|
| F1 HTTP 重放先撞 revision | 修复：`replayCommand` 在 `planFor`/生成前；`httpRefresh` 同理；最终事务仍重复幂等+CAS | `training-plan-commands.test.ts` 两个 HTTP action 用例；`phase5-training-plan.test.ts` 重启后重放 |
| F2 旧写授权混用 | 修复：`legacyPlanWritesSupported` 与 `trainingPlanV2CommandsSupported` 分离；无握手/未知版本 fail-closed | `ModelRegression.swift` readOnly 能力循环；`TrainingPlanV2Regression.swift` 版本矩阵；`TrainingPlanPublisherRegression.swift` URL 断言 |
| F3 双写者 | 修复：unified owner + goals 投影 + receipt 指针；lock/coach/命令同一事务；managed preHandler 只在 owner-ready 放 v2 读 | `phase5-training-plan.test.ts`、`training-plan-commands.test.ts` 故障/所有权断言 |
| F4 完整旧编辑器缺口 | 保持只读；不新增伪动作、不把 refresh 当保存 | `TechPlanView.swift` 的 `manualPlanEntry`；D20.2 |
| F5 视觉夹具依赖退役接口 | 修复：合成 fixture + 离线迁移 + 真实 authenticated v2 准备；保留 401/410 负例；默认 Phase5Acceptance | `run-visual-tests.sh`、`scripts/prepare-phase5-fixture.mts`；`visual-run.log` |
| F6 七日窗口语义 | 保持既有判据，UI 明示部分窗口；新增决策测试 | `training-plan-coordinator.test.ts` 的 D5-D 用例；`TechPlanView.swift` 文案 |
| F7 生成事实指纹 | 生成前捕获 dataVersion+snapshot，提交前复核；latch 故障实验证明混合版本拒绝 | `training-plan-generation.ts`；`training-plan-commands.test.ts` generation latch |

## 5. S0–S7 执行状态

| 步骤 | 状态 | 产物/说明 |
|---|---|---|
| S0 基线/决策/fixture | 完成 | `evidence/baseline.json`；D20；`prepare-phase5-fixture.mts` |
| S1 入口/能力矩阵/失败用例 | 完成 | `ENTRY_MATRIX.md`；F1/F2 回归 |
| S2 事务/幂等/指纹 | 完成 | 新 generation deps；5 写点故障注入；空计划/忙测试 |
| S3 所有权/managed | 完成（代码） | `OWNERSHIP_MATRIX.md`；managed v2 读/损坏 fail-closed |
| S4 iOS DTO/Publisher | 完成（代码） | `TrainingPlanPublisher.swift`；`COMMAND_STATE_MATRIX.md` |
| S5 原生 UI/设备安全 | 完成（代码） | 命令面板；暂停/结束不授权执行；WorkoutKit 边界未改 |
| S6 夹具/自动化/原生端到端 | 自动化已覆盖当轮修复；原生端到端部分 | T26 部分；配对设备与交错升级/回滚仍缺证据 |
| S7 能力启用/发布 | 未执行 | 生产能力关闭；无部署/迁移 |

## 6. 验收矩阵（T01–T30）

| ID | 结果 | 证据/说明 |
|---|---|---|
| T01 能力组合 | 通过（单元/transport） | `TrainingPlanV2Regression.swift` 精确版本矩阵；`ModelRegression.swift` readOnly 循环；`handshake-registry.test.ts` |
| T02 unmanaged 迁移/header | 通过 | `training-plan-v2-route.test.ts`；`phase5-training-plan.test.ts` 真实路由 |
| T03 managed active/paused/ended/损坏 | 通过 | `phase5-training-plan.test.ts`；损坏 receipt 删除后 v2 GET 409 |
| T04 退役 5/7 + 404 | 通过 | `legacy-surface-retirement.test.ts`；`phase5-training-plan.test.ts` |
| T05 设置/清除目标 | 通过 | `training-plan-commands.test.ts`；`phase5-training-plan.test.ts` 的 goals/unified 投影断言 |
| T06 预览取消/草稿/TTL | 通过（API/transport） | 当轮 Publisher 响应闩锁覆盖在途取消/重新打开/草稿变化；Model 拒绝不匹配草稿；既有 TTL 回归 |
| T07 篡改/错误动作/未知版本/非法目标 | 通过 | `training-plan-commands.test.ts`；`training-plan-v2-route.test.ts` |
| T08 非 pause/pause HTTP 重试 | 通过 | `training-plan-commands.test.ts` 两个 action 的 handler 回归；`phase5-training-plan.test.ts` |
| T09 同键异载荷/跨 scope/过期 | 通过 | `training-plan-commands.test.ts` replay/expiry；`TrainingPlanPublisherRegression.swift` |
| T10 断响应后 committed 查询 | 通过 | `TrainingPlanPublisherRegression.swift` lost reply |
| T11 notFound/404/expired/scopeMismatch/未知 | 通过 | `TrainingPlanPublisherRegression.swift` |
| T12 同 revision 并发/连点 | 通过（CAS + 双进程 stress） | `plan-publication-stress.test.ts`；事务内二次幂等查询与 CAS |
| T13 五个写点故障 | 通过 | `training-plan-commands.test.ts` 触发器注入 |
| T14 生成期间事实/配置/epoch 变化 | 通过 | `training-plan-commands.test.ts` generation latch；`training-plan-generation.ts` |
| T15 生成拒绝/超时/busy/空计划 | 当轮补事实准入回归 | 生成 lane busy 与事实更新分开验证；真实 router 的 import/recompute 忙、就绪/失败释放、提交前复核及零业务写入 |
| T16 重启后已 committed/候选过期 | 通过 | `training-plan-commands.test.ts` 重启 handler；`phase5-training-plan.test.ts` |
| T17 lock/relock/pause/resume/ended | 通过（隔离 API） | 当轮 unmanaged lock→pause→today/v1/v2/workout-plan→resume、事务故障回滚；managed 生命周期及真实定时入口；设备撤回未验收 |
| T18 空窗口/部分窗口/跨日 | 通过（决策+测试） | `training-plan-coordinator.test.ts` D5-D；固定业务日测试 |
| T19 pending/确认/清账落盘失败 | 通过 | `TrainingPlanPublisherRegression.swift`；`StoreRegression.swift` |
| T20 重启/页面关闭/取消/迟到回包 | 通过（Model/transport） | 新 Publisher 在途预览取消与旧/新请求交错；提交/查询关闭保留 journal；不是 Simulator 未知提交恢复验收 |
| T21 URL/Token/serverId/athleteId/epoch 变化 | 通过（代码/既有回归） | `commandContext` 全字段比较；ModelRegression stale-scope 用例 |
| T22 committed 后重读失败/旧读 | 通过 | `committedAwaitingRead` + `finishRead` 失败；Store 的 `savedAwaitingRefresh` |
| T23 401/404/409/410/422/503/未知 | 通过 | `TrainingPlanPublisherRegression.swift`；ModelRegression 410 终局 |
| T24 旧 pending/退役 route | 通过 | ModelRegression 旧 pending/410 用例；Publisher 不把旧 payload 转 v2 |
| T25 DTO 跨 TS/Swift 编解码 | 通过 | `TrainingPlanV2Regression.swift`；Publisher 断言 contract/scope/revision/原始字节 |
| T26 Simulator 用户链路 | **部分通过** | 既有日志覆盖预览/取消/确认/冲突/普通重启重读；缺响应丢失→查询、带未知 pending 重启和能力关闭的 Simulator 证据；本轮未重跑 UI |
| T27 配对设备 | **未执行** | 本机无配对 Watch/真机验收；不声称物理可见性 |
| T28 手动课表合同扩展 | **不适用** | D20.2 明确不在本阶段开放；无新增 action |
| T29 其他 iOS/健康同步/API 回归 | 通过 | 最终 `npm test` 2548/2535/0 fail/13 skip；`test:ios`/`check:ios-gates` 记录见 §7 |
| T30 新旧 App/服务端交错/回滚 | **部分** | 能力矩阵与旧服务兼容单元通过；无旧 App 构建/生产回滚演练，不能宣称完整 |

## 7. 验证记录

最终命令、退出码、并发度与日志见 [`evidence/`](evidence/)；实施过程中的失败/中间尝试见 [`evidence/attempts/`](evidence/attempts/README.md)（不作为最终证据）。本报告写作时已完成：

- 定向 API 回归（含 phase5 真实路由、commands、v2 route、handshake、coordinator、retirement、sanitization）：**45 pass / 0 fail**，并发 1（`evidence/targeted-api.log`）。
- `npm run typecheck`：exit 0。
- `TrainingPlanPublisherRegression`：通过（含 404≠notFound、原字节重放、确认水位失败）。
- `npm run check:docs` / `check:doc-refs` / `check:scripts` / `check:acceptance-matrix` / `check:package-boundaries` / `check:training-plan-single-writer`：全部 exit 0（`evidence/*.log`）。
- `npm run check:ios-gates`：exit 0（11 支跨平台判据；2 支需模拟器/外部条件按既有规则跳过）。
- `npm run smoke:api`：exit 0（`evidence/smoke-api.log`）。
- `npm run test:ios`：**exit 0**（类型检查 99 个文件、model/publisher/Store/route 等纯逻辑回归；`evidence/test-ios.log`）。
- Simulator：`bash apps/ios/tests/run-visual-tests.sh`，合成 fixture + 真实隔离 API；`Phase5Acceptance` **通过**（151s），截图见 `evidence/visual-acceptance/screenshots/`。
- 完整 `npm test`（`RAI_TEST_CONCURRENCY=2`）：**2548 tests / 2535 pass / 0 fail / 13 skipped**，exit 0；原始日志 `evidence/full-suite.log`。
  13 个 skip 均为既有环境条件：10 个 Rust worker 二进制较旧（提示 `npm run rust:build`）、3 个仅 Windows 语义；没有阶段 5 用例被跳过，也不计入通过。

## 8. 兼容、迁移与回滚

- **无 schema 迁移**：本阶段未改主库/控制库表结构；`mobile_training_state` 为既有 v2 表。
  不运行生产迁移；fixture 的 dry-run/apply/repeat 只作用于临时库。
- **能力回退**：关闭 `RAI_TRAINING_PLAN_COMMAND_MODE` 或去掉客户端 header，服务端回到只读；
  已发出的 operationId 仍可查询，不清 pending。
- **客户端回退**：旧服务 `legacyPlanWritesSupported` 只对明确旧握手为真；新服务旧 URL 不重开。
- **数据回退**：不恢复整库；业务撤销走新的受支持命令；灾难恢复继承阶段 4 的备份/停写流程。
- **设备回退**：API 回滚不撤回手表日程；仍需前台撤回/强读回/回执。

## 9. 未执行项、残余风险与停止点

1. **T26 Simulator**：部分通过；既有合成 fixture + 真实隔离 API 日志在 `evidence/visual-acceptance/`。响应丢失查询、未知 pending 重启、能力关闭仍缺 Simulator 验收；本轮未重跑 UI。
2. **T27 配对设备**：无配对 Apple Watch/真机证据；不声称物理手表可见（Simulator 通过不等于设备层通过）。
3. **T30 旧 App/回滚演练**：无历史 App 构建与生产服务；只做了能力矩阵/旧协议单元。
4. **生产能力启用**：未宣告、未部署、未改生产配置；阶段 4 生产门未在本阶段复验。
5. **手动课表/完整偏好**：只读；恢复需 §4.2 合同扩展，不在本阶段伪装完成。
6. **F6 自动补齐**：未实现自动补齐；缺失日期只显示待刷新，避免无限生成。

**停止点：** 不进入阶段 6；不自动启用生产写能力；不重新打开任何 410 旧写面。

## 10. 签收清单

- [x] F1 用生产 handler/完整 router 重放回归修复，覆盖重启与 TTL。
- [x] F2 旧写授权与 v2 授权分离，无握手/未知版本/交错升级有行为证据。
- [x] F3 unified/goals/coach-loop/lock 所有权收口，暂停/结束/锁课/历史证据闭环。
- [x] F4 已开放动作均有正式合同；未支持功能明确只读。
- [x] F5 视觉脚本不依赖退役写面；F6 窗口语义已决策；F7 已完成 latch 实验。
- [x] 当轮修复的隔离自动化已补齐；Simulator 部分通过、设备/交错升级缺口已明确。
- [x] 兼容、持久格式与回滚边界已记录；阶段 4 生产门继承。
- [x] 保留 SQLite/单写者/现有平台与健康样本只读约束；未进入阶段 6。

**最终结论（2026-10-24 修订）：** 5A 主要修复与 5B R1–R4 修复已落地；当轮证据见审计修复记录。**生产能力与完整端到端验收未完成**，
因此不得宣称“v2 生产写可用”或“完整阶段 5 通过”。
