# HealthKit 非 Workout 记录同步 v2

2026-10-09

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
只有显式「重新导入全部」强制补读；任一同步距上次补读满 7 天时也再次补读，
覆盖无法检测的读取权限扩大。此行为于 2026-10-10 修正，避免每次点同步都重传全量记录。
补读前先排空旧 anchor 的新增/删除，再从 nil 重读，避免重置时丢删除事件。
从 nil 补读不是权威快照，绝不据缺席删除。授权/no-data 错误保留该类型旧游标；
锁屏、取消、分页失败、中途失败的导出不提交新游标。

完整候选游标序列化到 `SyncTaskState.pendingRecordCursors`，随保存的 ZIP 跨进程恢复。
服务端导入成功（或确认内容未变）后，`SyncTaskStore.commitSuccess` 在一个 SQLite
事务中写 Workout 水位、记录游标并删除任务行；回读校验失败/删除任务失败整批回滚。
旧任务缺少新字段时保留现有记录游标。手动清 Workout 水位不清记录游标，因为补读仍需
先读取此前未送达的删除事件。

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
要求显式「重新导入全部」补读历史后重试。迁移不会猜测历史数据，也不会自动清理已经产生的未知身份副本。

自动回归覆盖历史新增、数量/睡眠删除、删除先于新增、值/日期修正、替换、共享旧 ID、
旧 XML 别名重放、共享来源恢复及重算边界、v31 回填/回滚、Rust 解析、删除-only 摘要、
旧任务解码、游标跨重启/失败回滚和纯分页逻辑。
真机 HealthKit 历史补录、权限扩大、删除通知和后台时限仍需人工验收；
本地回归不模拟 HealthKit 存储本身。
