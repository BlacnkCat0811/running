# 训练计划 V2 闭环合同冻结（B01 / G0）

日期：2026-10-25（Asia/Shanghai）。基线：`1b6a10b4769526b2930090e79860d2f93cc50318`。
承接[实施方案](TRAINING_PLAN_V2_CLOSED_LOOP_IMPLEMENTATION_PLAN.md) S00-01–04。
本文件冻结后续实现的语义；**B01 不实现新存储、路由、编辑 UI、关联或自动发布，不宣告新增能力**。
执行证据及 G0 结果见[本批记录](../deliverables/training-plan-v2-b01-2026-10-25/B01_REPORT.md)。

2026-10-25 B02 进展：已实现 schema 1/2 兼容读取、稳定身份的受控数据升级、索引课程历史、
协商只读扩展与原生缓存，验证见[B02 记录](../deliverables/training-plan-v2-b02-2026-10-25/B02_REPORT.md)。
2026-10-25 B03 进展：S01-02/04 的唯一保护 resolver、源日抑制、预算优先、受控自动课替换/归档与
迁移偏好消费已验收，G1 已签收；验证见[B03 记录](../deliverables/training-plan-v2-b03-2026-10-25/B03_REPORT.md)。
课程编辑、执行关联和事实驱动自动发布仍按后续批次交付；新增写能力仍未宣告。

## 1. 身份、保护、生命周期

- 一个 scope 只有一个当前 `planInstanceId`；迁移、新建实例时由服务端分配并持久化不透明 ID。
  滚动刷新、改目标、改期、编辑、暂停/恢复不换实例。`sessionId` 同理，日期和处方 hash 不能替代身份。
- 每个日期最多一堂有效跑课；`cancelled`、已被 supersede 的旧课不占跑课位。
  `set_rest` 是受保护日决定，不为自动空日制造课程。实际同日多跑允许，但不自动合并。
- `sessionRevision` 从 1 起；有效处方、保护、生命周期、替换关系变化才递增。
  新增由服务端分配 ID；未执行自动课确需替换时，新课有新 ID，旧课留下 `supersededBySessionId`，不得无声复用旧 ID。
  执行评价独立用 `executionRevision`（无关联行时为 0），不因评价重算伪造处方修订。
- 生命周期精确 wire 值：`pending / completed / partial / skipped / cancelled`；保护独立为
  `automatic / user_protected`；关联独立为 `unlinked / pending_confirmation / confirmed / invalidated`。
- `completed` 表示可靠关联的一次已结束实际训练，**不是**剂量和刺激均达标。
  明确剂量不足才为 `partial`；剂量未知时仍可 completed 并展示未知。
  刺激过强/过弱独立报告，不把跑得过量当奖励，也不单凭刺激不符改成 partial。
  没有观测不能推出 skipped；skip 必须用户明确操作。
- 完成/部分完成/已跳过的课冻结原处方；不接受 move/edit/cancel/unlock。纠错走执行命令并追加历史。
  取消课不得用 unlock 复活；重建须 add 新 ID。解除保护不修改完成历史。
- move/edit/add 后整课保护；`userOverride` 存有效完整处方、动作与服务端可得时间。
  move 保留 ID，源日形成 `moved` 抑制；连续改期保留本实例相关源日抑制，重算不能在旧日期补一课。
  cancel 留 tombstone 和 `cancelled` 抑制；set_rest 留 `explicit_rest` 抑制。
  cancel/set_rest 在该日仍可能被未来生成覆盖时不隐式释放；新 add 到该日必须在预览中明确列出将释放的抑制，事务内同时释放。
  日期过去且决定已归档后，可移出当前 JSON；不能删除历史决定，也不能丢弃窗口外仍在未来的保护/抑制。
- 目标日期已有有效课或显式休息时 move 拒绝，不覆盖、不交换。set_rest 遇已有课也拒绝；先明确取消再设休息。
  unlock 预览列出可能释放的用户内容与源日抑制，确认后才交回算法；不能顺带解除其他课/日保护。
- 自动重算计入保护课程预算，保留意图；安全不允许执行时通过有效执行层关闭授权并解释。
  今日锁和设备 journal 继续约束。服务器保存不代表 Watch 已撤回或更新，不自动调用 WorkoutKit。
- 暂停/结束保留历史、覆盖、取消和设备撤回账目。结束实例不可 resume。
  首版不新增“替换整个实例”命令；现有 start/目标变更不得隐式释放既存覆盖。
  真正的新实例替换必须先具有完整保留/释放清单的独立预览确认合同，否则拒绝；不得借旧 start 绕过。

## 2. 处方、单位与时间

沿用 `MobileSessionStructure` 的 warmup / blocks / cooldown。结构目标使用整米、整秒；配速为整数秒/km，
心率为整数 bpm。步数、循环次数及范围遵守现有 session-structure 限额；单日最多 80km，仍须通过周预算/赛前/恢复政策。
新增命令严格拒绝非法值，不能依赖旧宽松 normalize 把错误字段删除/截断后当成功。
pace 范围为 120–1200 秒/km，heart_rate 为 1–240 bpm；每个非空 alert 至少一端非空，两端都有值时 lower ≤ upper。
新处方必须有可测定剂量，不能用 open 工作步骤规避预算校验；旧 open/无结构处方仍按兼容合同读取。

`edit.patch` 未提供的字段保留，`reason:null` 明确清空说明，空字符串不是 null。
`kind:null`、`structure:null` 非法；清除目标用完整结构内的 `alert:null`。
配速/强度修改必须修改真实 work 步骤的 alert；每步最多一个 pace 或 heart_rate 目标。
配速 lower 为数值较小的秒/km、upper 为较大值，拒绝颠倒范围；清空 warmup/cooldown 用其 null，不能丢弃 blocks。
距离通过结构测量，`distanceKm` 为兼容展示值；距离结构与显示距离须一致（整米比较，不做静默缩放）。
纯时间结构没有可靠距离时可显式 `distanceKm:null`；距离步骤仍存在时 null 非法。
修改距离必须同时提交一致结构；旧无结构课可读，编辑剂量/类型/目标或 add 时须提供合法结构。
新 add 不接受 rest，休息走 set_rest；空 patch 拒绝。日期变更仅走 move，不能夹在 edit 中。
明确改期可以保留与可跑日偏好冲突的用户意图，不能绕过伤病/恢复/容量等有效执行限制；冲突必须在预览解释。
用户明确缩短课程不套用自动生成的完整剂量保证；不能自动加长回算法默认剂量。

日期统一 `YYYY-MM-DD` 的 Asia/Shanghai 自然日；可得时间为服务端 UTC ISO instant。
执行关联选取 **开跑前已发布、已可得且生效** 的课程修订及执行许可；事后编辑的课不能冒充当时处方。
旧 `rai-plan-adherence-v3` 每日本地午夜冻结/当日首建 fallback 保持不变，见
[算法 §20](ALGORITHM.md#20-赛事倒推的周期骨架与依从性2026-10-02)。依从性与执行关联允许引用不同修订，不能互相覆盖。

## 3. 能力与兼容

精确值和路由在 [TS 合同](../packages/api-contracts/src/training-plan-closed-loop.ts)；
字段注册在 [handshake registry](../packages/api-contracts/src/handshake-registry.ts)，Swift 镜像在
[APIModels](../apps/ios/RAI/APIModels.swift)。`number` 接受未知版本用于拒绝，不用大于等于比较。

| 能力键（冻结值 1） | 同请求协商头（冻结值 `1`） | 用途及依赖 |
| --- | --- | --- |
| `trainingPlanSessionContractVersion` | `X-RAI-Training-Sessions` | unified read 2 顶层可选 `sessions`，含实例、课程、抑制、publishedInputKey；依赖 sync 1/API v1/read 2 |
| `trainingPlanSessionCommandContractVersion` | `X-RAI-Client-Training-Session-Commands` | 课程 preview/submit；依赖精确课程读 1 + publication 1 |
| `trainingPlanExecutionCommandContractVersion` | `X-RAI-Client-Training-Execution-Commands` | 候选查询/确认/纠错/撤回/跳过；写依赖课程读 1 + publication 1 |
| `trainingPlanUpdateContractVersion` | `X-RAI-Training-Updates` | unified read 2 顶层可选 `update`，四阶段；依赖课程读 1，不授权服务器自动发布 |

配置命令 2 与新命令 1 独立，不能推导彼此。课程写/关联写各有独立服务器开关，自动发布另有开关。
当前写模式可显式选择 `validation` 或 `production`，默认关闭；生产部署和启用仍须独立记录，不能冒充 G5/G6 已验收。
2026-10-25 用户明确要求部署最新版本时再启用，本轮只准备生产模式，不修改运行服务。B01/B02 中 production/validation 均省略全部四键为历史状态。
B03/G1 起仅在已完成受控身份迁移（schema 2）且 owner-ready 的 scope 宣告课程只读扩展；
B04 起课程命令使用独立开关及精确请求协商；B06/B08 已实现关联写和更新读。`validation` 的临时隔离检查保留，
`production` 必须配置非空令牌和明确的 runtime/主库/控制库路径；课程写和关联写仍需 schema 2/owner-ready/publication。
课程能力在受控数据迁移完成且 owner-ready 后才能宣告；当前 legacy read 能力不能证明课程 ID 已存在。

缺位/未知某能力只关闭对应新增路径；缺课程读时其全部依赖关闭。未知新增能力永不授权 legacy URL。
旧服务器仍按已登记旧协议读取；新客户端遇新路由 404 应提示升级，不当 operation notFound，也不改发旧 URL。
410 保持退役语义。旧客户端可忽略可选扩展；只有精确协商才返回扩展，并增加对应 Vary；不改变 v1 字节/必填语义。
新客户端在实际解码扩展时还须检查其 `contractVersion:1`、scope 和水位，不能只检查 handshake。
课程扩展的可选 `executions` 在 B06 后提供当前关联/评价；缺位表示执行视图未知，不能当空历史或全部未完成。
扩展头缺位不返回对应扩展；未知/未支持的课程读头返回 409 training_session_contract_unsupported，
更新读头返回 409 training_update_contract_unsupported。更新扩展要求同请求精确课程读头；不静默降级。
关写能力仍须能读新数据、查询已提交 operation 和处理既有设备撤回；未知提交保留原请求 journal。

## 4. 命令和关联

| method / path（B01 不挂载；B04 已接课程 preview/submit，执行关联仍待 B06） | 请求 |
| --- | --- |
| POST `/v1/mobile/training-plan/session-commands/preview` | contractVersion 1、operationScope、expectedStateRevision、planInstanceId、draft |
| POST `/v1/mobile/training-plan/session-commands` | 原预览同一请求 + operationId + candidateId |
| GET `/v1/mobile/training-plan/sessions/:sessionId/execution-candidates` | query: planInstanceId；可选 rangeStart/rangeEnd/cursor，按 scope 读取 |
| POST `/v1/mobile/training-plan/execution-commands` | contractVersion 1、operationId、operationScope、expectedStateRevision、planInstanceId、sessionId、sessionRevision、executionRevision、draft |

课程 draft 精确为 move / edit / add / cancel / set_rest / unlock。已有课程动作带 sessionId/sessionRevision；
add 和 set_rest 不发送伪造 ID。preview 不需要 operationId、零持久写；submit 必须带持久 UUID。
候选 TTL 120 秒，绑定精确 draft、scope、state/session revision、实例、业务日、事实/分析/保护/关联版本、政策、影响清单和到期时间。
submit 不得重新生成另一份课表再宣称是原候选；新 add 的 ID 必须在预览绑定，重放保持同一 ID。
响应用独立 state/goals/session/execution 水位；outcome 为 changed/no_change；关联成功的 planUpdate 可为 pending，不能冒充计划已更新。

关联 draft 为 confirm / correct（目标 trainingSessionId/sourceFactDigest）、retract（原 ID/摘要）、skip（明确 reason）。
correct 在同一事务验证并释放原唯一占位后认领目标；executionRevision 的 CAS 绑定原关联，目标摘要绑定新事实。
源删除后 retract 可用当前保存摘要撤回失效关联，不要求删除的主库行仍存在；确认/纠正必须重新核验实时源事实。
confirm 仅认领未关联/待确认课；已确认的替换用 correct，不容许另一 confirm 抢占。
retract/事实失效使当前有效完成结论撤回，追加当前 pending 修订并保留原完成处方/评价历史；不是抹掉旧完成记录。
存在执行当前行的课程在自动重算中继续保留身份与处方，并先计入生成预算；撤回或失效不使课程被自动归档或替换。
这不改变其 automatic/user_protected 标记，也不授予执行许可，确保统一读取与人工纠错入口始终可达。
skip 仅用于尚未执行且未确认关联的 pending 课；不能用 skip 覆盖一次真实完成。
仅同日、近距离、同结构或排期对象 workoutID 不构成实际身份凭据；缺可验证来源映射时一律 needs_confirmation。
第一版不做概率自动确认，不合并同日跑步；一条实际跑步最多确认一堂课。

默认候选窗口为课程日 **前 2 日至后 2 日（含两端）**，以实际 startedAt 对应上海日期筛选；跨午夜不按 endedAt 重归日。
用户可扩大查询，单次最多 31 个自然日；分页每页最多 50，稳定按 startedAt/trainingSessionId 排序，cursor 绑定 scope/范围/事实摘要。
无数据返回空候选和明确范围，不能搜索全历史猜测。扩大范围不豁免执行前处方有效性。
原始信号/步骤不足时沿用既有 unknown/not_assessable；不用重建段落证明刺激。
更正/删除/canonical 合并后当前关联失效并追加评价修订，旧处方与当时证据历史仍可读。

## 5. 新路由错误语义

冻结 code/status 在 `TRAINING_PLAN_CLOSED_LOOP_ERRORS`，不改旧配置命令错误含义。

| HTTP | code | 含义 |
| --- | --- | --- |
| 409 | `training_session_contract_unsupported` / `training_update_contract_unsupported` | 对应读扩展头版本未知/不支持或依赖未满足 |
| 422 | `training_session_contract_required` | 新合同版本不为 1 |
| 409 | `training_session_commands_disabled` / `training_execution_commands_disabled` | 对应开关关闭、能力/头缺失或未知 |
| 422 | `training_session_command_invalid` | 缺字段、错误动作/null/单位/结构 |
| 409 | `training_scope_mismatch` / `training_plan_instance_mismatch` | 数据域或当前实例改变 |
| 409 | `training_state_revision_conflict` / `training_session_revision_conflict` / `training_execution_revision_conflict` | 对应 CAS 冲突，保留草稿并重读预览 |
| 409 | `training_session_candidate_expired` / `training_session_candidate_mismatch` | 过期或非原候选 |
| 409 | `training_session_date_occupied` | 目标跑课或受保护休息占位冲突 |
| 409 | `training_session_not_editable` | 完成/部分完成/跳过/取消/已替换课不可直接编辑 |
| 404 | `training_session_not_found` | 当前 scope/实例内课程不存在，不等同路由不支持 |
| 409 | `training_execution_source_changed` / `training_execution_link_conflict` | 源事实摘要改变或实际跑步已认领 |
| 422 | `training_session_safety_rejected` | 新增/加量/结构不能通过现有安全约束 |
| 503 | `training_session_storage_unavailable` | 存储/恢复不可用，保留未知提交账目 |

已有 publication 的幂等键异摘要、plan_operation_expired、coach_sync_pending、coach_policy_changed 和 recovery 错误继续复用。
持久同键查询/重放早于能力门、TTL、当前 revision、昂贵读取；同键异摘要拒绝，保留期过期不能作为新操作重执行。
新写须重新核验 scope/输入并 CAS；未验证提交结果不换 UUID 重试。

## 6. 控制库与迁移冻结

当前控制库 DDL 为 2，payload 为 1；B01 不占新 DDL 编号、不修改历史 checksum、不写新 payload。
B02 追加迁移时重查空闲编号。新 payload 版本冻结为 2：保留现有配置/来源证据字段，新增
planInstanceId、sessions、suppressions、publishedInputKey；weekPlan 仅由唯一 resolver 物化，无独立编辑权。
schema 1/2 都须有显式严格读取器；未知版本拒绝，不能经 schema 1 normalize 丢掉新字段后写回。

| 新结构/阶段 | 必需列与约束 |
| --- | --- |
| mobile_training_session_history / B02 | scope、plan_instance_id、session_id、session_revision、state_revision、local_date、available_at、payload_json；主键(scope,plan_instance_id,session_id,session_revision)，索引(scope,local_date,available_at)及(scope,plan_instance_id,session_id,available_at) |
| mobile_training_execution / B06 | scope、plan_instance_id、session_id、execution_revision、association_status、training_session_id、prescription_session_revision、source_fact_digest、payload_json、available_at；主键(scope,session_id)；confirmed 的(scope,training_session_id)部分唯一索引；confirmed 时 ID/摘要非空 |
| mobile_training_execution_history / B06 | scope、session_id、execution_revision、reason、available_at、payload_json；主键(scope,session_id,execution_revision)，含旧新关联/评价，不建跨主库 FK |
| mobile_training_plan_evaluation / B08 | scope 主键、input_key、state_revision、business_date、policy_hash、execution_digest、operation_id；每 scope 一行，不是任务队列 |

JSON 有效性、非负/正修订和枚举以 CHECK 约束；日期唯一占位由 resolver + 同 CAS 事务校验，不能宣称 JSON 已有逐日唯一索引。
所有新增业务行和兼容 goals、历史、receipt、operation 在现有 publication transaction 内提交；生成/主库搜索在事务外。
每个 SQL 写点失败须全回滚。主库与控制库继续 detect + retry，不宣称跨文件原子。

首次迁移先冻结 sourceDigest 和身份映射；apply 才分配持久 ID（或消费预览绑定映射），重复 apply 返回原映射，不能在 GET 生成 ID。
来源证明为算法且未被用户修改的课可 automatic；手工/llm/未知来源的既存非空处方全部 user_protected，保留内容和 null 结构。
自动明确休息可保持普通旧意图；用户/未知来源的明确休息迁移为受保护日决定。重复日期/来源冲突拒绝并报告，不猜测丢弃。
保留全部既有历史 JSON，不重写旧 receipt；课程历史补建按旧修订可得时间，不能只从最近 200 条推断。
历史中无法证明身份连续性的课程分开建映射，不以同日/hash 合并；执行关联不得靠猜测迁移。
移出窗口但仍有效的保护/抑制继续保留；结束实例归档不把完整训练历史塞进当前 payload。

迁移偏好逐字段保留并验证生成消费：runningDays、longRunDays、availabilityMinutesByWeekday（存在时）、targetType、
目标/周期、状态、strengthTraining。未知/无效偏好需要重新确认，不默认七天可跑；ended 不激活，paused 不发布。
当前 un-managed 生成显式清掉 runCoach，故“已保存旧偏好”尚不等于“已消费”，该缺口属于 B03，不在 B01 偷改算法。
dry-run 零写；apply 复用控制库 publication lock + sourceDigest/CAS + 维护窗口；不得碰用户日常库。
先兼容读再写；关闭新写保留新数据；写 schema 2 后只回滚到识别 2 的二进制。

### B02 已实现的迁移边界

- 控制库新 DDL 编号为 3，仅增加课程历史表、匹配索引与约束；API 启动不执行身份数据迁移。
  原 `--apply` 仍保留旧 unified 数据迁移语义；新增 `--session-identities` 专用于已迁移的 schema 1。
  首次身份升级要求 version 1 来源审计与当前 sourceDigest 一致，并处于 control schema 2/3，拒绝未知/占用版本。
- dry-run 不分配 ID、不建表、不改行；apply 仍须 publication lock、精确 sourceDigest 和 CAS。
  输入摘要覆盖本 scope 的当前状态、完整 unified 历史、当前 goals/receipt 和原迁移审计，不含墙钟或新随机 ID。
- apply 为当前实例及课程分配 UUID。每个无法证明连续性的旧 unified 修订单独建立历史实例/课程映射，
  不凭相同日期/内容合并；旧来源缺少逐课所有权证据，保守将所有既存跑课保护，既存 rest 保存为日决定。
  不伪造用户编辑或完成状态（`userOverride=null`、lifecycle pending）。
- 历史可得时间来自原 `changed_at`，统一为可排序的 UTC 毫秒格式；新增 ID 与旧来源修订的映射、摘要存入追加审计。
  课程历史按 scope/日期/时间或实例/课程/时间直接索引查询，分页最多 200 行；不读取最近 200 份整计划代替课程查询。
- **更早的 `mobile_goals_history` 没有 scope/epoch**，本批原样保留其字节，不猜测属于哪个数据域。
  已补建的是全部旧 scoped unified 历史；未建立 scope 归属的 pre-unified 历史不冒充已完成身份迁移，H05 不在 B02 宣告整体关闭。
- 任意新写点或 COMMIT 失败，表/索引、ledger、状态、课程历史、身份映射及追加审计一起回滚。
  重复 apply 验证原映射后零变更，未认识的新 schema 拒绝；GET 和普通同步均不做补建或隐式修复。
- B02 只提供只读兼容：显式 `X-RAI-Training-Contract: 2` + `X-RAI-Training-Sessions: 1` 才返回扩展。
  未升级的 schema 1 / 未知扩展版本返回 `409 training_session_contract_unsupported`；未带扩展头的 v1/v2 形状保持。
  B02 不宣告该扩展；B03/G1 起按 §3 条件宣告只读课程扩展，课程写/执行/更新三键仍省略。
  新状态不得降级、回退课程修订、覆盖同一课程历史版本或静默删除课程 ID；
  B03 再接入生成与受控归档，B02 的旧生成路径若破坏实体/物化一致性会原子拒绝。
- iOS 仅在精确能力协商下请求扩展，身份/日期/版本/保护/抑制校验后写入现有 SQLite 缓存。
  重启缓存仍只供参考，不授 WorkoutKit 执行；B06 前若收到无法保留的 executions 子视图，拒绝解码而不静默丢字段。B07 起按兼容解码保存可选 executions，缺位仍表示未知。

### B03 已实现的保护/生成边界

- `training-plan-session-policy.ts` 是生成后唯一的课程物化入口：用户保护课、完成/部分完成/跳过课、
  今日锁课、改期源日、取消/明确休息抑制优先于生成候选；保护课逐字段保留，源日不复活。
- `generateWeeklyPlan` 先计入用户保护课的 km 与质量课名额，再分配自动完整剂量；保护日不进入
  `buildCompleteCoachWeekPlan`、`fitCompleteSessionsToBudget`、最终 validator 或赛前激活改写。
- schema 2 的自动课内容变化分配**新** `sessionId`，旧课以递增 `sessionRevision` + `supersededBySessionId`
  留痕；自动课被重算为休息/移出当前窗口时通过显式归档移出当前 payload，冻结修订仍在
  `mobile_training_session_history`，不伪造取消/跳过/完成。
- 统一 `refresh`/`submit`、受管 `coach-loop` 的既有 enable/update/refresh 命令和 unmanaged 生成都消费
  同一保护集合；schema 1 的旧 `mergePlanWindow` 路径保留，不把新实体写入未迁移数据域。
- `training-plan-preferences.ts` 把迁移保留的 `runCoach`（runningDays、longRunDays、targetType、
  strengthTraining、生命周期）翻译成生成输入；缺失、未知或 ended 证据 fail-closed，
  `runningDays:null` 表示“没有保存过限制”，不伪造七天可跑。可跑步日与 targetType 实际作用于生成；
  long-run 模板仍只由既有受管 runtime 消费，通用完整剂量生成器不新增长距离课；
  `strengthTraining` 只作为偏好证据保留，通用生成器不伪造力量课。
- `MobileGoalsStore.write({preserveWeekPlan:true})` 仅供该 resolver 的内部物化使用，避免旧
  normalize/measure 丢掉 `reason:null` 或重新缩放保护处方；公开 goals 写面仍为 410。
- schema 2 课程读扩展在 handshake 中仅在迁移完成且 owner-ready 时宣告；课程命令、执行命令和更新
  扩展仍不宣告。新编辑能力仍关闭，B03 不挂载任何课程写路由。

## 7. 当前可达入口及后续复用边界

| 当前入口 | owner / scope / 事务 / 能力 / 重放 |
| --- | --- |
| training-plan-state v2 GET | canonical scope 只读 unified；不迁移、不生成、零写，不授执行许可 |
| today / v1 聚合 / workout-plan / coach-loop / coach-execution GET | 只读事实和当前有效处方，guard/稳定快照或只读 memo；managed legacy 聚合仍受门限制；不因计算候选写库 |
| plan-operations/:id GET | 当前服务器数据域的持久控制库操作查询；零业务写，notFound/scopeMismatch/expired/committed 按既有合同返回 |
| execution-candidates GET | 当前 scope/实例的只读候选；按 startedAt 上海日期窗口、分页 50、最多 31 天；不自动确认、不写库 |
| execution-commands POST | 唯一 owner；publication transaction + CAS + 源事实摘要；课程生命周期、执行当前行/历史、operation result 原子提交；重放先于能力门 |
| unified update read | 只读四阶段投影；由持久评估游标与 publishedInputKey 派生，不触发发布 |
| commands preview | 四配置动作、精确 scope、零写；validation + 请求协商；候选 120s |
| commands submit / refresh | unified 唯一 owner；operation 查询早于 admit；主库 lease/指纹 + 控制 publication/CAS；同事务 goals/history/result |
| 自动 coordinator | canonical scope；启动/小时 single-flight；共用 refresh，不以客户端能力门授权；目前只看配置/窗口，未实现事实输入闭环 |
| coach-loop enable/refresh/update/pause/resume/end POST | receipt 不变历史 + unified 指针；当前 scope/acceptedPolicyHash；既有 publication/operation，owner reconciliation 汇合；schema 2 的活动计划经同一 session resolver 物化，pause/end 不重写当前周；当前事实就绪检查先于 publish/replay，并非所有旧入口都已重放优先 |
| coach-feedback save/retract POST | 写主库 coach facts repository；scope=[athleteId,datasetEpoch]，先核对完整 operationScope；repository.operation 内 CAS/幂等；不直接写 unified，也不与控制库跨文件原子 |
| coach-prediction-refresh POST | 完整 scope 核对后主库构建预测 companion；不是计划写者，没有新的 plan operation/replay 合同；不由 GET 触发 |
| mobile lock/relock | 当前 scope；既有 publication/operation/当天锁；reconciliation 同步 unified，不是另一计划 |
| workout-plan/synced、coach-loop/synced 及设备 journal | 当前 scope 的排期证据、控制库事务/幂等 receipt；不是 HealthKit 实际完成身份；不绕过执行快照 |
| legacy ensureWeeklyPlan | 仅无 unified owner 时生效；有 owner 不生成第二份计划。无 unified owner 的旧数据域没有课程实体，B03 resolver 不适用于该路径 |
| 离线 migrate-training-planner | 默认 dry-run；apply 用 publication lock、摘要/CAS，非 HTTP 能力；不会由 GET 或同步触发 |
| retired goals/run-coach/preview/confirm/generate | 410 legacy_surface_retired；无写者，不作为任何新合同后备 |

现有政策接受入口是 coach-loop enable/update 的 acceptedPolicyHash；生成使用 prepareUnified 的政策核验，
不代替用户接受新政策。反馈、lock、receipt 的有效既有合同不被新增能力关闭。
主要落点：[server](../apps/api/src/server.ts)、[commands](../apps/api/src/training-plan-commands.ts)、
[MobileGoalsStore](../apps/api/src/mobile-goals.ts)、[runtime](../apps/api/src/coach-loop-runtime.ts)、
[Publisher](../apps/ios/RAI/TrainingPlanPublisher.swift)。

四阶段输入键/no-change/评估游标按实施方案 §3.4–3.5；不把当前墙钟、输出 state/goals revision 纳入输入键。
资源目标暂冻结为实施方案 §10.3 的发布判据，仍未实测；B09 必须在隔离 2C2G Linux 重验，不能用本机通过替代。


### B04/B05 课程编辑进展

B04 已实现六动作、零写签名预览与原子提交，B05 已实现原生表单和现有 journal 的合同 1 扩展；G2 已签收，
普通字号与 Accessibility XXXL 两轮真实点击链均通过。状态与原始证据见
[B04](../deliverables/training-plan-v2-b04-2026-10-25/B04_REPORT.md) 及
[B05](../deliverables/training-plan-v2-b05-2026-10-25/B05_REPORT.md)。

- `RAI_TRAINING_PLAN_SESSION_COMMAND_MODE` 是独立开关，可为 `validation` 或 `production`；validation 的临时真实路径/两库/loopback 校验沿用配置命令的隔离要求，production 保留令牌及显式库路径要求。
  默认关闭，仅迁移且 owner-ready、支持 publication 的 scope 加精确请求头才准入；关闭后仍可查询/重放已提交结果。
- 候选绑定草稿、scope、实例、state/session、完整保护/抑制、业务日、事实指纹和当前 scope 的有效设备排期；
  add 的 ID 在预览分配并绑定。签名密钥不持久化，服务重启后未提交预览须重新预览；已提交操作先从持久表重放。
- 不重排另一份课表来冒充编辑。唯一当前 session 集合物化兼容 weekPlan；课程、投影、冻结历史与 operation 同事务。
  任何 SQL/COMMIT 失败回滚；同键异摘要拒绝；当前输入/CAS 改变即丢弃旧候选。
- 距离与结构必须一致；整米/整秒和目标范围以既有 normalizer/validator 为准。复用自然周预算、已跑量、保护课、分区及赛前安全限制，
  不静默改写用户结构。必要撤销可 metadata-only，新增/改期/解除保护不可绕过事实就绪门。
- 编辑保留 `weekPlanReplanRequired` 围栏，`planUpdate=pending`，不代表计划已完成重评或设备更新；任何有效排期风险保持可见。
  API 不调用 WorkoutKit。课程写仍未生产启用；执行关联、更新阶段和事实自动发布已由 B06/B08 按独立开关接入。

### B06 执行关联进展

- 控制库 DDL 4：`mobile_training_execution`（每 scope/session 一行当前关联；confirmed 的 `(scope, training_session_id)` 部分唯一索引）与不可变 `mobile_training_execution_history`。课程生命周期、冻结历史、执行修订和 operation result 同一 publication COMMIT。
- 候选读 `GET /v1/mobile/training-plan/sessions/:sessionId/execution-candidates`：默认课程日 ±2 个上海自然日、最多 31 天、50 条/页；按 startedAt 归日，不按 endedAt；候选一律 `needs_confirmation`，只有已 confirmed 且事实摘要相同才 `verified_identity`，不自动确认。
- 执行命令 `POST /v1/mobile/training-plan/execution-commands`：confirm/correct/retract/skip；confirm/correct 重新验证实时事实摘要并使用**开跑前已发布生效**的课程修订做评价；retract 用保存摘要，源删除/更正后仍可撤回；skip 仅 pending 且未确认。
- completed = 可靠关联的已结束实际训练；只有明确 dose partial/not_met 才 partial；剂量与刺激未知仍 completed + unknown；`executionRevision` 独立递增，不伪造课程修订。源变化由后台 reconcile 转 invalidated 并保留旧完成历史。
- 统一读 `sessions.executions` 可选；缺位=未知，空数组=已知无关联。执行命令仅在 `RAI_TRAINING_PLAN_EXECUTION_COMMAND_MODE` 为 `validation` 或 `production` + schema 2/owner-ready + publication + 精确请求头下宣告/准入；重放先于能力门，关写仍可查询。

### B08 事实驱动发布进展

- 输入键由 `training-plan-input-identity.ts` 单点生成：scope、业务日、最近 28 天至未来 7 天跑步事实、已发布分析身份、配置、用户保护/抑制、执行关联和 policy hash；墙钟、输出 revision、自动 pending 课程内容不进入键。
- 控制库 DDL 5：`mobile_training_plan_evaluation` 每 scope 一行评估游标；与 operation result、`publishedInputKey` 同事务提交。游标不是第二个计划 owner。
- refresh 在内容/授权/保护/关联/goals 投影相同的情况下返回 `outcome:"no_change"`：不增加 state/goals revision、不追课程或计划历史，只推进游标；内容或授权变化才更新 `publishedInputKey` 和游标，任一失败整笔回滚。
- 自动发布仅在 `RAI_TRAINING_PLAN_AUTO_PUBLISH_MODE` 显式为 `validation` 或 `production` 时打开：启动/60 秒持久输入差异巡检、分析完成回调加速、单飞与有界退避；分析未发布保留旧计划并在更新读标注 `analysis_pending`。
- 统一读在 `X-RAI-Training-Contract: 2` + `X-RAI-Training-Sessions: 1` + `X-RAI-Training-Updates: 1` 时返回可选 `update` 四阶段；GET 零写，不授权自动发布；未知/缺课程头 409。

### B07 iOS 执行关联进展

- iOS 按 `trainingPlanExecutionCommandContractVersion: 1`（且 sessions 1 + publication 1）接入候选读与执行命令；
  能力缺失/未知只关闭写路径，已有 `sessions.executions` 仍可只读展示。服务端是否宣告仍由 B06 独立开关决定。
- 候选查询严格绑定 `contractVersion`、scope、`planInstanceId`、`sessionId`、session/execution/state revision；
  同日多跑保留候选歧义，`verified_identity` 也不会自动确认。默认窗口 ±2 天，用户可扩大到 31 天。
- 确认/纠错/撤回/跳过复用唯一 pending row/journal：编码一次后持久化原 operationId 与字节，重启先查原操作，
  已知 committed 不重提，只有业务 notFound 才重放；能力关闭仍可查询。确认水位只含 state/goals，不含 session/execution 水位。
- 成功后完整重读统一状态与执行快照；失败保留草稿。HTTP 404 与 `training_session_not_found` 分开：前者提示升级，
  不当 `plan_operation_notFound`。UI 在现有课程详情/编辑页展示计划 vs 实际、关联、剂量与刺激，并区分 partial/unknown。
- B06 服务端与真实 HTTP 已实现；B07 Simulator `testExecutionConfirmRetract` 通过，G3 已签收。生产执行写仍未启用。
