# 未提交改动审查（2026-09-25）

> 审查对象：`/Users/ta/running` 当前工作树全部未提交改动（51 个状态项，36 个已跟踪改动文件，15 个未跟踪文件；`git diff --stat` 为 1385 insertions / 727 deletions）。
>
> 方法：`git status --porcelain=v1`、`git diff --stat`、按契约→服务端→客户端→测试分层读码，结合定向测试、完整门禁输出与实际载荷探针。结论均落到文件:行号或命令输出。未修改业务代码。

> **修复后复核（2026-09-25）**：本文件以下主体保留为修复前快照。原报告中的 Node gate、RHR provenance、手工 race policy 三项已在当前工作树修复；对应回归测试已通过。新增的接口契约、日期校验和计划调整原因修复见本次审查回复，提交前请勿再依据下方“必修”表格判断当前状态。

## 一、结论摘要

| # | 级别 | 结论 | 证据 |
|---|---|---|---|
| 1 | 🔴 P1 | 新增 `data:prediction-walk-forward` 没有 Node 版本生命周期门禁，且现有回归已经抓到该问题。 | `package.json:67` 只有脚本本体，没有 `predata:prediction-walk-forward`；`apps/api/test/node-version.test.ts:25-36` 实跑 `EXIT=1`，报 `data:prediction-walk-forward must have a Node gate`。 |
| 2 | 🔴 P1 | 预测恢复 explainability 会把“仅原始 RHR 兼容数据”误标为 canonical，掩盖实际降级来源。 | `packages/storage-sqlite/src/read/prediction-recovery-read-repository.ts:204-239` 未把 RHR 纳入 `contributesRaw`；内存 SQLite 探针（只有 recent+baseline RHR、无 canonical 表）实测 `source:'canonical'`、`coverage:'partial'`。 |
| 3 | 🟡 P1 | 完整 `npm test` 未通过，但唯一失败就是上述 Node gate 回归；node 子集为 832 tests / 828 pass / 1 fail，Web 段未因 zsh 包装变量错误得到可靠的最终合并退出码。 | `/tmp/rai-test-20260925.log:7,5387-5400`；原命令包装使用只读变量名 `status`，导致外层 shell 报 `read-only variable: status`。 |
| 4 | 🟡 P2 | 手工计划在比赛日/减量期仍按原始 `days` 送入 `validateWeeklyPlan`，没有使用 `applyRacePlanPolicy` 返回的新数组；因此策略本身会拒绝本可被安全转换为休息/轻松跑的输入。 | `apps/api/src/manual-plan-policy.ts:28-33`；实测比赛日 `2026-09-27 interval` 返回 `plan_policy_violation`，同时列出“比赛日不追加训练，已留白”，说明策略结果被丢弃。 |
| 4 | 🟢 | 预览确认机制的候选过期、版本/快照指纹校验、重复确认幂等与重启失效均有测试。 | `apps/api/src/weekly-plan-preview.ts:4-25`；`apps/api/test/weekly-plan-preview.test.ts:15-39`，定向测试全绿。 |
| 5 | 🟢 | 周计划生成路径传递上周跑量并统一经过结构测量、质量课/减量/比赛日策略；手工写入在 durable write 前校验。 | `apps/api/src/server.ts:1038-1084,1115-1143,1207-1213`；`apps/api/src/weekly-plan-service.ts:122-169`；`apps/api/src/mobile-goals.ts:188-223`。 |
| 6 | 🟢 | iOS/API 预览确认链路已接通，预览不隐式确认，revision 会随请求发送，确认后刷新依赖读面。 | `apps/ios/RAI/NativeAppModel.swift:640-739`；`apps/ios/RAI/APIClient.swift:164-170`；`apps/ios/RAI/Skins/Technology/TechPlanView.swift:308-335`。 |
| 7 | 🟢 | TypeScript 类型检查通过；预测与周计划定向测试通过 72/72。 | `npm run typecheck` 重跑 `EXIT=0`；定向测试 `EXIT=0`，`# tests 72 / # pass 72 / # fail 0`。 |
| 8 | 🟡 | iOS 门禁逻辑本身通过（类型检查 59 文件、模型回归全绿），但外层采集命令同样被 zsh 的 `status` 只读变量覆盖，不能把该次结果记为可靠的最终退出码。 | `/tmp/rai-ios-20260925.log:5-137` 显示所有检查通过；命令末尾因 `(eval):1: read-only variable: status` 失败。 |

## 二、🔴 必修

### P1-1：补齐 walk-forward 命令的 Node gate

**事实**：新增 `packages/application/src/prediction-walk-forward-cli.ts`（29 行）并在 `package.json:67` 暴露为 `data:prediction-walk-forward`，但 `package.json` 没有对应的 `predata:prediction-walk-forward`。回归测试动态枚举所有 `data:*` / `ml:*` 命令，因此在 `apps/api/test/node-version.test.ts:30-36` 直接失败：

```text
not ok 3 - every public runtime command executes the Node gate through npm lifecycle hooks
data:prediction-walk-forward must have a Node gate
+ actual - expected
+ undefined
- npm run check:node
EXIT=1
```

**修复**：在 `package.json` 增加：

```json
"predata:prediction-walk-forward": "npm run check:node"
```

**验收**：
1. `node --import tsx --test apps/api/test/node-version.test.ts` 为 `EXIT=0`；
2. `npm run typecheck` 保持 `EXIT=0`；
3. `npm test` 的 node 段不再出现 test 269，且 Web 段单独有明确结果。

**回滚**：只撤回 `package.json` 中新增的 pre-hook；不涉及迁移、数据库或破坏性契约。

### P1-2：修正 recovery provenance 的 raw RHR 归属

`packages/storage-sqlite/src/read/prediction-recovery-read-repository.ts:110-115` 始终从 `health_records` 读取 RHR；但 `:214-217` 只把 HRV（无 canonical HRV 时）计为 `contributesRaw`，完全漏掉 RHR。于是仅有 RHR、没有 canonical 表时，`availableComponents === 1`，`contributesCanonical === false`、`contributesRaw === false`，`:232-239` 却落到 `source: "canonical"`。专项内存 SQLite 探针已复现：只有 recent+baseline RHR 时输出 `source:'canonical'`、`coverage:'partial'`，而实际应标记 raw 兼容（或新增组件级来源后标记 mixed）。

这会直接进入 `packages/application/src/prediction-report.ts:622-637` 的用户/审计 explainability，造成“兼容回退被标成 canonical”的证据误导，定为 P1。

**修复**：增加 `contributesRawRhr = recentRestingHeartRate !== null && baselineRestingHeartRate !== null`，纳入 `source` 的 raw/mixed 判定；更稳妥的是在 `PredictionRecoveryProvenance` 增加 `rhrSource`，并补“仅 RHR”“canonical HRV + raw RHR”两组回归。

**验收**：同一内存 SQLite 探针输出 `raw_compat`；canonical HRV/睡眠与 raw RHR 混合时输出 `mixed`；`npm run typecheck` 与 prediction 定向测试通过。**回滚**：撤回 `packages/storage-sqlite/src/read/prediction-recovery-read-repository.ts`、契约映射及新增测试；无迁移。

## 三、🟡 待决策/待修

### P2-1：手工计划策略应使用 race policy 的返回值

`applyRacePlanPolicy` 是纯函数，返回被改写后的数组；但 `apps/api/src/manual-plan-policy.ts:29` 只调用它并丢弃返回值，随后 `:30` 仍将原 `days` 传给 `validateWeeklyPlan`。这会把“比赛日置 rest”“taper 期重建 easy/必要时置 rest”的安全变换变成写入拒绝。

实测载荷：周目标 40 km、比赛日 2026-09-27、该日 interval 8 km；探针输出：

```text
plan_policy_violation 课表未保存：轻松时段占比低于下限，已降级 2026-09-27 的质量课；2026-09-27 比赛日不追加训练，已留白。
```

这不是数据损坏（拒绝保存是保守的），但与“手工编辑遵循同一 race/taper policy”不一致，用户不能保存本应安全归一化的课表。建议：`const safeDays = applyRacePlanPolicy(...)`，用 `safeDays` 参与校验；同时补“比赛日输入最终能保存为 rest”的回归。

**验收**：race day / taper day 的手工输入要么明确保存安全转换结果，要么产品文案明确要求用户手动改成安全形态；不能一边产生转换 warning、一边把原始危险输入送审。

**回滚**：`git checkout -- apps/api/src/manual-plan-policy.ts`，删除对应新增回归即可；无迁移。

### P2-2：完整测试命令必须修正采集脚本的 zsh 变量名

本次不是产品代码失败，但审查命令使用 `status=$?`；在 zsh 中 `status` 是只读特殊变量，最终只留下：

```text
(eval):1: read-only variable: status
```

因此 `npm test` 与 `npm run test:ios` 的外层退出码不可采信。后续应使用 `rc=$?`（本次 `npm run typecheck` 和定向测试已用该方式）。

## 四、✅ 通过项

- `git diff --check`：`EXIT=0`。
- 新增源码控制字符扫描：无命中；新增 TS/Swift 文件均可读。
- `npm run typecheck`：`EXIT=0`，pure 与完整 tsconfig 均通过。
- 预测/周计划定向测试：72/72 通过；覆盖缺失 readiness、as-of 证据、fallback、race day、预算、预览幂等。
- `metadataOnlyMutationRoutes` 已登记 `/v1/mobile/workout-plan/preview` 与 `/confirm`（`apps/api/src/server.ts:274-289`），避免异步生成/确认持有数据库写锁；新路由 schema 也已登记（`apps/api/src/schemas.ts:726-743`）。
- `MobileGoalsStore.write` 在实际持久化前调用 `options.validate`（`apps/api/src/mobile-goals.ts:196-223`），拒绝时不会落库。
- iOS 预览 UI 有实际入口（`apps/ios/RAI/Skins/Technology/TechPlanView.swift:308-335`），并通过 `MobileWeeklyPlanPreview` 解码候选、确认请求携带 `candidateId + expectedRevision`。
- `run-tech-presentation-tests.sh` 已挂入聚合门禁（`apps/ios/tests/run-model-tests.sh:64-69`），不是孤儿脚本。

## 五、修复顺序

1. **先修 P1-1**：补 `predata:prediction-walk-forward`，重跑 node-version 回归。
2. **再修 P1-2**：修正 RHR raw provenance，并补仅 RHR/混合来源回归。
3. **再修 P2-1**：决定手工保存的产品语义；推荐使用 policy 返回数组并补回归，确保比赛日/减量安全策略真正生效。
4. **最后重跑真实门禁**：使用 `rc=$?` 采集 `npm run typecheck`、`npm test`、`npm run test:ios`；Web E2E 因本机没有 Chrome/Edge 仍不纳入本次通过结论。

## 六、清理项

- 当前工作树包含两份同名审查文档（`deliverables/IOS_MODEL_AUDIT_2026-09-25.md` 与带“副本”文件）以及大量审查/走查产物。它们本身不是业务缺陷，但提交前应按主题用 `git add -p` 分组，避免把审查材料、模型代码、iOS 计划 UI 混成一个提交。
- `deliverables/PROJECT_AUDIT_2026-09-24.md` 的头部声明当时工作树干净；本轮它是未跟踪文件，不应被误当成本次代码变更的证明。
- `MobileRecoveryBreakdown.stateLabel` 的 `case .some`（`apps/ios/RAI/APIModels.swift:190-199`）会兜住所有非 nil 未知字符串；合法 recovered/reduced/depleted 在前置分支已正确命中，契约 unknown 的新文案已有回归覆盖（`apps/ios/tests/ModelRegression.swift:165-169`），本轮不定缺陷；若要区分契约内 unknown 与域外值，建议后续显式增加 `case "unknown"`。

## 七、验证边界

- 未执行 `npm run build`：本轮重点是 API/模型/iOS 逻辑，且本机 build 可能触发 dist safe-delete 护栏；如修复 P1 后提交前仍需按项目纪律运行。
- 未执行浏览器 E2E：项目约定本机无 Chrome/Edge 时该通道不可运行，不应伪报通过。
- 未修改任何业务代码；本报告是本轮新增审查交付物。
