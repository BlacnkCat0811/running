# B03：唯一保护 resolver、迁移偏好消费与 G1

日期：2026-10-25（Asia/Shanghai）。状态：**B03 已验收；S01-02 / S01-04 已验收；G1 已签收**；B04 尚未开始，生产未启用新增写能力。

## 范围与身份

本批按 `docs/TRAINING_PLAN_V2_CLOSED_LOOP_IMPLEMENTATION_PLAN.md` 的 B03 停止点交付 S01-02（唯一 resolver、整课保护、源日抑制、取消 tombstone、占位校验）和 S01-04（迁移偏好消费），并签收 G1。
不实现课程编辑 HTTP/原生 UI（B04/B05）、执行关联（B06/B07）、事实驱动自动发布（B08）或生产迁移/部署。
HEAD 仍为 `1b6a10b4769526b2930090e79860d2f93cc50318`，main；工作区沿用 B01/B02 及本轮 B03 的未提交改动，未 commit/push。
起始身份与 B02 冻结源码清单见 `baseline-identity.json`；最终源码/测试/script 冻结见 `verification-source-freeze.json`（1006 文件，B02 的 1002 文件 + 本轮 4 个新文件）。
未执行生产迁移、能力启用、部署或生产写；未打开用户日常健康库。

## 实现

| 任务 | 落点 | 当前证据 |
| --- | --- | --- |
| S01-02 | `training-plan-session-policy.ts`；`weekly-plan-service.ts`；`training-plan-commands.ts`；`mobile-goals.ts`；`training-plan-store.ts`；`coach-loop-runtime.ts` | 唯一生成后 resolver；保护/执行/锁/抑制优先；自动课新 ID + superseded；受控归档；预算先计入；schema 2 refresh/submit/managed coach-loop 同一路径 |
| S01-04 | `training-plan-preferences.ts`；`server.ts` 生成装配；`training-plan-routes.ts` 暂停/结束跳过候选 | runningDays/longRunDays/targetType/生命周期逐项适配，strengthTraining 仅保留证据；缺失/未知/ended fail-closed；不伪造七天可跑 |
| G1 能力 | `server.ts` handshake；`handshake-registry.ts`；API 文档 | 仅 schema 2 + owner-ready 宣告 `trainingPlanSessionContractVersion: 1`；课程写/执行/更新三键仍省略 |
| G1 序列化 | `mobile-goals.ts` 的 `preserveWeekPlan` / `reason:null` / schema 2 control read | 保护处方与 `weekPlan` 物化逐字节一致；旧 normalize/measure 不再静默丢字段 |

关键语义：

- resolver 以当前 `user_protected`/完成/部分完成/跳过课程、今日锁课、`moved`/`cancelled`/`explicit_rest` 抑制为最高优先级；生成候选只能填充无保护、无抑制的日期。保护课和其 `userOverride` 逐字段不变。
- 自动课内容变化时分配新 `sessionId`，旧课递增 `sessionRevision` 并写 `supersededBySessionId`；自动课被重算为休息或移出当前窗口时，通过显式归档移出当前 payload；冻结修订仍在 `mobile_training_session_history`，不会伪造取消/跳过/完成。
- 生成预算先扣除窗口内用户保护课的 km 与质量课名额，再分配自动完整剂量；保护日不参与完整剂量分配、预算裁剪、validator 改写或赛前激活改写。
- schema 1 继续走原 `mergePlanWindow`；只有 schema 2 进入 resolver。没有迁移的旧数据域不会被写入新实体。
- 迁移保留的 `runCoach` 证据由 `training-plan-preferences.ts` 转成生成输入：可跑步日限制实际生效、targetType 实际改写 work step alert、longRunDays 校验并保留给受管 runtime 的长距离模板；通用完整剂量生成器不新增长距离课；strengthTraining 只作为证据保留，不伪造力量课。`runningDays:null` 表示没有保存过限制，不等于七天可跑；缺失、未知字段、无效或 ended 证据以 `training_preferences_incomplete` fail-closed。
- `submit`/`refresh` 在同一个 publication transaction 写 plan、sessions、suppressions、goals 投影、history、receipt 和 operation result；任一写点失败整笔回滚。受管 `coach-loop` 的 enable/update/refresh 在 schema 2 下也走同一 resolver，pause/end 不重写当前周。
- 未新增任何课程写路由；`session` 读扩展仍是可选只读扩展，课程写/执行/更新握手能力均不宣告。

## 环境与执行记录

macOS 26.6.2 / x86_64，6 个逻辑 CPU、16 GiB；Node 22.23.2 / SQLite 3.51.3，Xcode 26.5（17F42）。
所有数据库、runtime、主库/控制库、epoch 和 HTTP 端口均由测试 fixture 在独立临时目录创建；新增 fixture 全部 synthetic。
迁移与故障实验只针对临时控制库；未使用生产或用户日常健康数据。

- `npm run typecheck` → `typecheck.log`，退出 0。
- `policy-tests.log`：B03 resolver/preferences 定向测试 13 tests / 13 pass / 0 fail。
- `runtime-protection.log`：受管 runtime 保护与 legacy coach-loop 命令路径 1 test / 1 pass / 0 fail。
- `session-tests.log`：B02 课程状态/迁移回归 9 tests / 9 pass / 0 fail。
- `api-tests.log`：真实路由、命令、v2 读与 B02 课程迁移定向回归 48 tests / 48 pass / 0 fail。
- `full-tests.log`：最终 `RAI_TEST_CONCURRENCY=2 npm test` 完整退出 0；2654 tests / 2651 pass / 0 fail / 3 skipped，1070.228 秒。
  `full-tests-attempt1.log` 保留同代码首轮的一次 `recompute-worker` `cancelledByParent`（当时另有定向测试并发占用 worker）；该条单独复跑 6/6 通过，随后不并发地完整重跑得到上面的最终结果。`full-tests-preliminary.log` 是冻结前预跑，不作为最终证据。
- `ios-tests.log`：`npm run test:ios` 完整聚合退出 0；未执行 Simulator UI、真机、物理 Watch。
- `smoke-api.log`：`npm run smoke:api` 退出 0；临时 fixture，不是生产部署。
- `gates.log`：single-writer、iOS gates、acceptance matrix、package boundaries、scripts 与 `git diff --check` 通过。
- `docs-check.log`：文档/链接/锚点检查通过；`plan-line-refs.log` 记录方案源码行号引用检查。
- `verification-source-freeze.json`：1006 个源码/测试/script 的 SHA256；与 B02 基线比较的变更清单见 `batch-change-manifest.json`。
- `verification-index.json`：命令、日志创建/最后写入时间、退出码、并发、统计与日志 SHA256。

## G1 验收

| G1 条目 | 证据 |
| --- | --- |
| 所有运行期生成入口使用同一保护解析，无遗漏 legacy 内部自动路径 | `training-plan-session-policy.test.ts`；`training-plan-session-protection-runtime.test.ts`；`planDeps.generate` 的 unmanaged 与管理路径；`coach-loop` command resolver |
| managed/unmanaged、锁课、反馈、配置和 refresh 不能绕开新 owner | managed runtime 保护测试；schema 2 refresh 测试；锁课 resolver 测试；暂停/结束不发布新周；B02 owner 回归 |
| 用户覆盖即使无 UI 也能证明重算保留 | `B03` 保护 fixture；`user_protected` 逐字段断言；`superseded`/归档历史断言 |
| JSON 字段不被旧 normalize/measure/copy 静默丢失 | `preserveWeekPlan` + `reason:null` 测试；schema 2 control read 保留原始周 |
| 旧计划、旧 receipt、已结束 programme、未知 schema 的读取/拒绝 | B02 `training-plan-session-state`/`training-plan-migration` 回归；B03 G1 复跑 |
| 迁移、持久化、保护、历史长修订回归；新编辑能力关闭 | B02 1001 修订/1000 次后续修订回归；B03 resolver/预算/故障回归；无课程写路由/能力 |
| 迁移偏好实际消费、缺失/未知 fail-closed | `training-plan-preferences` 定向测试；迁移前后可用日/target/phase 对照；未知字段与 ended 拒绝 |

## 边界与未完成

- G1 只证明研发层的数据/生成/保护/偏好边界；不签 G2–G7。课程编辑、执行关联、分析后自动发布、Linux/2C2G、Simulator UI、iPhone 12 Pro Max、Watch、跨构建回滚未执行。
- H05 的 pre-unified 无 scope 历史仍不猜测归属；H05 不整体关闭。C01 的生成侧保护已按 G1 关闭，编辑/关联侧仍按后续门。
- 自动课归档只针对 `automatic + pending`；用户保护课与完成/部分完成/跳过课不从当前 payload 静默移除。归档不删除 `mobile_training_session_history`。
- 关闭新写仍可读取 schema 2、查询已提交 operation 和处理设备撤回；写 schema 2 后只回滚到能读 schema 2 的兼容二进制。
- 未执行生产迁移/启用、未推送、未触发 GitHub CI；生产结果未验证。
