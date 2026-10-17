# HealthKit 非 Workout 记录同步 v2

2026-10-09

后续目标设计（尚未实施）：[SQLite直接增量同步，无项目备份/全库校验/临时主库/换库](SQLITE_DIRECT_SYNC_DESIGN.md)。
下文描述当前实现，不能据该设计认定线上已覆盖所有混合增量。

## 协议与兼容性

- `/v1/handshake` 新增可选能力 `healthKitRecordSyncVersion: 2`；原有
  `syncProtocolVersion` **仍为 1**，不改变 scope，也不丢弃升级前的待上传任务。
  新客户端在导出前检查此能力，旧服务端不会被误判为已接收记录删除。
- ZIP 保持 `export.xml` / GPX 入口；`sync-manifest.json` 的 `version: 2`、
  `sourceScope: "healthkit"` 增加 `deletedRecords: [{ type, uuid }]`。
  Workout 删除仍使用原有 `deletedSourceIds`。v1 / 普通 XML 保持兼容。
- 数量与睡眠记录均导出 `RAIHealthKitSampleUUID` MetadataEntry，以及原始 metadata
  （包含原有 sync identifier）。UUID 在映射/删除协议中统一小写。
  未知版本、损坏的 v2 manifest、缺少合法 UUID 的 v2 Record 拒绝导入。
- HealthKit 包始终 `preserveAbsent: true`。权限丢失、空查询、窗口/类型缺席不代表删除。
  内容摘要包含按类型、UUID 去重排序后的删除事件，删除-only 批次不会命中空批次的摘要。

## 客户端变更游标

所有已有授权范围内的数量类型和睡眠类型使用独立 `HKAnchoredObjectQuery`，
固定 `predicate: nil`，每页 1000，直到新增和删除都为空。包含原先按 Workout
查询的心率、步数、跑步指标等；不再由 Workout 到达/事件日期决定记录能否送达。
已有 HKObserverQuery / hourly background delivery 同时覆盖这些记录类型，
历史数量记录变化不再必须等待另一条 Workout 通知才触发同步。
新增类型/首次升级从 nil 读取全部可见历史，历史补录直接通过变更游标到达。

普通同步（按钮、快捷指令、自动/后台）均续接记录游标，不强制补读全部历史。
2026-10-12 起取消七天周期性全历史重读：已建立的类型游标在普通按钮、快捷指令、
自动/后台同步中始终续接，不因闲置时间重置。
首次同步或首次加入的类型仍需建立历史基线；这不属于日常重复全量同步。

🔴 **2026-10-17：全量重导入口（「重新导入全部」）已删除。** 现在不存在任何"从零重读
全部历史"的用户入口，也不再提供 `force` 通道 —— 历史重放只能由**上一轮被预算截断**
（`historyReplayPhase != nil`）继续。原因：那个入口会 `forgetState` 删整行 `sync_state`
并清空全部游标，与"永不自动清空游标、不做全量同步"的边界冲突。
HealthKit 无法可靠检测读取权限扩大；扩大权限后，**新可见的历史会通过变更游标自然到达**，
不再有"补读全部"的动作。
损坏的已有 anchor 在普通同步中报错，不静默降级成 nil 全历史查询；恢复只有一个入口：
设置页的「修复增量游标」——它只清**解不开的那一个类型**（或跑步锚），保留 `export_end`
与其它类型。清理之后该类型从 nil 重读，因此**那一段期间的删除事件无法上报**
（无锚点查询看不到 `deletedObjects`）；这是损坏本身的代价，不是新增回归。
授权/no-data 错误保留该类型旧游标；锁屏、取消、分页失败、中途失败的导出不提交新游标。

完整候选游标序列化到 `SyncTaskState.pendingRecordCursors`，随保存的 ZIP 跨进程恢复。
服务端导入成功（或确认内容未变）后，`SyncTaskStore.commitSuccess` 在一个 SQLite
事务中写 Workout 水位、记录游标并删除任务行；回读校验失败/删除任务失败整批回滚。
旧任务缺少新字段时保留现有记录游标。手动清 Workout 水位不清记录游标，因为补读仍需
先读取此前未送达的删除事件。

## 跑步动态迟到样本补读（2026-10-17）

**问题（线上实测）**：Apple Watch → iPhone 的样本传输有延迟。2026-10-14 的一次跑步，
10-16 用近 48h 窗口查询时手机里**还没有**那两类样本（查询返回空），10-17 样本才出现在健康
App 里；而那时窗口下界已经越过那天，锚点流又排在历史重放队尾 —— 两条通道都够不着，
服务端的 `RunningPower` / `RunningGroundContactTime` 永远是 0 条，训练详情的两条时序
只能显示「暂无样本」（详见 `deliverables/RUNNING_POWER_GCT_MISSING_2026-10-17.md`）。

三项修正（`apps/ios/RAI/HealthKitExport.swift` + `HealthKitRecordCursor.swift`）：

1. **按日期的跑步动态补读**（`LateDynamicsBackfill`）：对跑步动态四类（功率 / 触地时间 /
   步幅 / 垂直振幅），在**已建立游标**时按近 14 天做**有界**查询（单类型单批 `limit 1500`、
   最新优先），写前判定整页放得下才写。三条状态纪律：
   - **分页**：命中上限 ⇒ 记 `lateBackfillBefore = 本页最早样本`，下一批只读
     `[windowStart, before)` 那段（14 天里跑步很多时不会因为"最新 1500 条"漏掉更老的那次）；
     分页到窗口下界就收手（同一时刻的样本不会来回打转）。
   - **空页不记账**：未授权读 / 样本还没从手表同步到手机时，HealthKit 都只返回空、不报错。
     把一次空查询当"补过了"会把这条唯一通道关死 —— 所以空页保持原记账、下批重试
     （空查询不写字节，成本只是一次 `HKSampleQuery`）。
   - **完成后再补一次**：整窗覆盖后记 `lateBackfillAt = now`；`retryInterval`（30 天）之后
     允许再补一次 —— 权限后开、或又一次样本迟到，都还有下一次机会。
   补读**不推进正式 anchor、不发删除事件**；与历史重放可能重复的样本由服务端按
   `RAIHealthKitSampleUUID` 幂等吸收。
2. **窗口水位语义**：空窗 / 装不下的页**不再**推进 `recentWindowReadAt`（`RecentWindowAccounting`；
   空结果只说明"此刻没有数据"，不等于该段已交付；下批用同一窗口再查，成本只是一次空查询）。
   **注意它的作用范围**：窗口下界 = `max(now−48h, 水位−6h)`，所以水位修正只能救
   **迟到 ≤ 约 48h** 的样本；本次事故（迟到 > 24h 且窗口随后整体滑过那天）只有第 1 条能修复。
   截断（命中 `recentWindowLimit`）仍推进并写 warning，更早部分交锚点流补齐（O05 步骤 6）。
3. **窗口 pass 公平调度**：从持久化的 `typeRotationStart` 环绕（O05 步骤 4）。**这不是**本次
   事故的成因（那次是 HealthKit 查回空，批内余量充足），而是一条独立的防饿死修正；
   同时新增一条可见 warning —— 同一窗口里「配速/步幅/垂直振幅**查回数据**、功率/触地时间
   **查回空**」时直接说出来，不再零痕迹（判据用"查过且为空"，不会把 20% 份额的预算跳过
   误报成权限问题）。

## 导入失败诊断（2026-10-10）

- 重算 CLI 在非成功终态输出业务 `error`（stdout 结果及 stderr 诊断），父进程持续消费
  stdout/stderr，仅各保留末尾 16,384 字符，并记录退出码与 signal；SQLite 告警不再是唯一线索。
- 子进程在暂存库清理前传出实际业务错误，父进程立即写服务日志，收尾时再持久化到内部
  `runtime.sqlite.import_jobs.error`。
  对外任务 DTO 与移动端同步状态继续脱敏，不返回原始路径、子进程输出或健康记录。
- 失败上传保留来源记录和包体，供受保护的 inspect/重试入口使用；不标记成功。
  沿用从上传时间算起的 24 小时未使用上传回收、总上传容量限制及活跃任务保护，
  不无限保留；取消任务仍立即清理。
- 候选 HealthKit 游标仍只在服务端成功后提交；不以提前推进游标来绕过失败。
  上线修复后若旧批次仍失败，需要用新的诊断确定重算拒绝原因，不能仅凭包体变大认定根因。

## 数据库迁移与修正

显式执行 schema v30 / v31 迁移（停止 API 后使用现有迁移 CLI；已迁移 v30 的库仅补 v31）：

```sh
npm run data:migrate -- --database var/rai.sqlite --apply
```

- 新增 `(sample_type, sample_uuid) -> record_id` 映射表，不重写任何已有记录 ID。
  第一次见到 UUID 时匹配旧 XML 身份；旧 iOS 不导出 sync identifier 的记录也可桥接。
  同一 UUID 的后续修正复用已映射 ID，而非根据变化后的值/日期另造旧公式 ID。
- v31 保留 v30 的冻结校验和与既有 canonical ID，新增原始 sync identifier / 值日期身份到
  UUID 的别名。普通 XML 也解析这些别名，不另建副本；删除后别名保留，防止旧 XML 复活记录。
  显式 UUID 删除还会移除此前已分叉的、无其他 UUID 映射且已无存活别名来源的已知 XML 副本，
  为每个被删除的副本写入 tombstone 和重算变更；不会删除仍被其他来源持有的身份。
- 原有 source tombstones 表以事务迁移放宽为 Workout + Record，保留全部旧 Workout
  tombstone。记录删除使用类型作用域的 UUID tombstone，删除早于新增也能阻止复活。
- 同一旧身份可能映射多个 UUID；只在所有映射源都明确删除后移除 canonical record。
  新 UUID 替换旧 UUID 且沿用原 sync identifier 时，新事实不会被旧 UUID 的删除误删。
- v31 持久保存每个 UUID 最后一次被接受的完整事实。删除当前 canonical 行的来源时，
  重选最后接受的存活来源，恢复它的值、日期与 metadata，并写入 `updated` 触发现有重算。
  仅属于已删除 UUID 的 XML 别名不能覆盖存活来源。别名、来源事实与删除在同一导入事务中提交。
  普通 XML 的别名若唯一指向一个存活 UUID，也更新该来源事实；多来源歧义不猜测 UUID。
- 删除写入现有 `import_entity_changes` 的 `removed` 和原事件时间，现有 health change
  planner 读取删除前/修正前后事实决定重算边界。不新增独立的评分实现。
- Rust XML 解析可继续使用；v2 与已建立别名的普通 XML 写入走共享 TypeScript 映射/tombstone 路径，
  不交给尚不理解源 UUID 的 native v1 热写入协议。

## 升级边界与验收

在 v2 建立 UUID 映射**之前已经被删除**、且旧导出中没有 UUID 的遗留行，无法从一个
只有 UUID 的 HealthKit 删除事件反推出旧记录。不得猜测删除或改写旧身份。需要清理此类
既有污染时，使用经验证的 Apple Health 权威完整 XML 快照及现有移除保护/备份流程。

v30 没有保存每个共享 UUID 被覆盖前的值。v31 只回填 canonical 行可确认的来源事实，
不把当前来源的值复制给其他 UUID；若删除后仅余未记录事实的来源，拒绝该导入、不确认游标，
要求用服务器侧的权威完整快照重新导入后重试（不再经由手机的「重新导入全部」——
该入口已于 2026-10-17 删除）。迁移不会猜测历史数据，也不会自动清理已经产生的未知身份副本。

自动回归覆盖历史新增、数量/睡眠删除、删除先于新增、值/日期修正、替换、共享旧 ID、
旧 XML 别名重放、共享来源恢复及重算边界、v31 回填/回滚、Rust 解析、删除-only 摘要、
旧任务解码、游标跨重启/失败回滚和纯分页逻辑。
真机 HealthKit 历史补录、权限扩大、删除通知和后台时限仍需人工验收；
本地回归不模拟 HealthKit 存储本身。

## 日常同步性能修复（2026-10-12）

- 有界近期/历史路线检查只用于发现迟到轨迹和重试待导入 GPX，不扫描全部跑步历史；
  没有 Workout 变更和 GPX 补传时不重传该 Workout XML。清单与计数只包含实际导出的批次。
  本地路线 hash 不是服务端已导入回执，因此不据此跳过可能仍处于 pending 的 GPX。
- 服务端 parser 直接写 API 拥有的可丢弃候选，取消内部第二次 clone/候选发布，
  完整审计只在最终候选上生成一次。独立 CLI 的安全暂存/发布合同保持不变。
- 导入中的完整性校验及最终审计查询在受控 Worker 线程执行，不阻塞 HTTP 主线程；
  原有强校验、单写者、回滚、持久回执和客户端成功后提交游标的顺序保留。
- 含评分/训练/路线变化的批次仍保留在线备份、一个候选和最终换库；
  不能为了“增量同步”跳过必要重算或把旧结果冒充最新结果。

## `data-only` 事务快通路（2026-10-12）

在既有单写者接纳范围内，由 Worker 执行一个 `synchronous=FULL` 的 SQLite 事务：
原始 Record、UUID 映射/别名/来源事实、显式删除与 tombstone、当前批次账本、
dataset version、完成时间及 `rai.applied-import.<jobId>` 成功回执一起提交。
任何失败整批回滚；静默忽略/改写的事实或回执也由提交前回读断言拒绝。
客户端仍只在服务器确认成功后推进游标。进程在提交前被杀不留下半批；
提交后丢回复由持久回执恢复成功，重启后不重复入库。

### 接纳范围

- 已建立基线、schema 与解析合同/身份指纹匹配；v2 `healthkit`、preserve-absent。
  ⚠️ **2026-10-15 订正（P1-1）**：本节原文另有"完整候选管线已登记 `data_only_baseline_contract`
  （包含 canonical 恢复算法、时区和评分类型政策）"一句 —— 该门槛已按设计 §4.3 退役
  （`SQLITE_DIRECT_SYNC_DESIGN.md:166`：「不再作为普通原始接收能否进入直接路径的门槛」）。
  单独跑 raw parser 不构成派生基线资格。
- 当前先支持 TypeScript 执行身份、XML 与 manifest 各不超过 2 MiB、
  最多 5000 条 Record 和 5000 条删除事件的记录-only 包。
- 封闭类型集合包括步数、体重、能量、步行/跑步距离、跑姿/功率、
  一分钟心率恢复、physical effort、呼吸频率和睡眠腕温；与既有非评分变化政策一致。
- 心率、跑速、睡眠、HRV、静息心率、VO2Max、未知类型，训练/路线/活动汇总、
  Workout 删除、资料变化、旧记录 hash 尚未初始化等均回退原候选流程。
- SQL TEMP 闸门还检查被映射/恢复的**原有**记录类型，禁止评分事实及所有非原始事实表
  的写入；不会只相信上传声明的类型。

这条通路不做整库复制、全库校验、全量代次补种、全库 canonical 或审计重建，
也不调用换库闸门。只处理当前批次的删除及其别名，不顺带扫描/修复全部历史 tombstone。
静态审计报告保留原生成时刻/版本；manifest 的 `audit_report_pending_version` 标记它待刷新，
实时审计 API 仍按新 `data_version` 从当前事实构建，不把旧文件伪装成新报告。

### 发布与回退

- 先有回退基线 `3f50a4b`，再发布本通路。
- **新增 schema v33 索引迁移**：`idx_healthkit_record_aliases_source`
  对 `(sample_type, sample_uuid, alias_id)` 建索引，避免 UUID 别名删除修复扫描整表。
  不改任何历史迁移、记录 ID 或事实；必须按既有停服/备份/显式迁移流程实施。
- 首次升级后的真实变化批次可能仍走原流程，建立解析指纹及派生基线资格；
  未建立资格时不猜测快通路安全。
- `RAI_IMPORT_DATA_ONLY_FAST_PATH=0` 并重启 API 可恢复原候选路径；
  不清空客户端 anchor、batch 或 datasetEpoch，不删除已成功接收的事实。
- v33 后的源码回退应至少保留兼容 v33 的迁移定义；不能直接用只认识 v32 的旧应用打开 v33。
  需要完整退到基线源码时，在维护窗口恢复迁移前备份并处理恢复后的 datasetEpoch；
  优先使用开关回退，避免撤销已接收的增量。
