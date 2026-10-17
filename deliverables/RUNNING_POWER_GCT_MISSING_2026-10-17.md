# 10-14 跑步详情缺「跑步功率 / 触地时间」时序 —— 定位报告

- **日期**：2026-10-17（京时，UTC+8）
- **对象**：`training_session_a561995e323c24753075e597e2976edb`（2026-10-14 20:54:46–21:28:01 京时，
  5.2203 km，Apple Watch 户外跑）
- **方法**：线上只读 API（云机 `127.0.0.1:8787`，带令牌 curl）＋ 云机 `rai.sqlite` 只读查询 ＋
  逐批导入账本（`import_batches.summary_json` / `import_entity_changes`）对账 ＋ iOS 导出源码逐行核对 ＋
  本机合成载荷实测（parser / storage / 读路径）。**全程未写任何线上数据，未改任何 tracked 文件。**
- **结论口径**：✅ 实测 / 🟡 读代码推断 / ⬜ 无法确认（需手机端一步判定，见 §五）

---

## 一、结论（先行）

1. **不是「读」或「渲染」的缺陷，也不是服务端把这两类记录丢了**：该次跑步窗口内这两类记录在库里
   **一条都没有**，详情页只是如实显示空。
2. **直接因果链**：序列完全来自 `health_records` 逐条样本 → 该窗口
   `RunningPower` / `RunningGroundContactTime` = **0 行**（其余类型 370–1043 行）→
   `GET /v1/workouts/{id}/series` 的 `power` / `groundContactTime` 均 `totalSamples=0` →
   详情平均值 `averagePowerWatts` / `averageGroundContactTimeMs` = `null` →
   iOS 保留「跑步功率」「触地时间」两段，但用一行「暂无…时序样本」占位、平均值显示 `--`（**不是**指标消失）。
3. **根因在手机端没有把这两类交上来**：这两类的最后一次入库是
   **2026-10-13T13:11:00Z / 13:10:50Z**（上一次跑步的收尾），此后服务端再没收到过任何一条。
   服务端导入链已实测**不会**按类型丢弃（§2.4）。
4. **为什么偏偏是这两个类型**：2026-10-16T01:35/01:36Z 两批（手机装上「近 48h 窗口」B1 后的第一批）
   确实把这次跑步的心率 / 步数 / 距离 / 卡路里 / 步幅 / 垂直振幅 / 配速全部补齐，但同一窗口查询对
   **这两类返回了空**。同一批里 `speed(775) + verticalOscillation(380)` 都写进去了，而按描述符顺序排在它们
   中间/其后的 `power`、`gct` 是 0 —— 预算、单类型上限、单位、类型顺序/轮转、服务端过滤全部已排除（§四）。
5. **这个缺口现在不会自愈**：B1 的窗口在「查回空」时也会推进 `recentWindowReadAt`（旧实现，
   `HealthKitExport.swift:1405-1412`，**已在同日晚修复，见 §七**），
   加上 6h 重叠，2026-10-16T01:36Z 之后窗口下界已越过这次跑步（10-15T19:36Z > 10-14T13:28Z）；
   正式锚点流又按**插入/变更顺序**、且这两类的游标已越过该时段 ⇒ 恢复只能靠
   「按日期定向回填」或「清这两类的游标重放」（§五，回填已落地）。
6. **手机侧的证据更新（2026-10-17 22:00 用户实测）**：手机「健康」App 里**有这两类的逐样本时序**，
   说明数据源不缺 ⇒ **B（上游没数据）排除**。剩下最合理的解释是：这两类的样本在
   10-16 用 48h 窗口查询时**还没同步到手机**（Apple Watch → iPhone 的样本传输延迟，实测 >24h），
   之后窗口越过那一天；另需顺手确认 RAI 对这两类的**读取开关**是否打开
   （HealthKit 对未授权读静默返回空、不报错 —— 本仓代码注释自己写了这一点，
   `HealthKitExport.swift:321-328`）。两者都不影响下面的恢复路径：补读在读取可用后即生效。

---

## 二、证据链

### 2.1 线上 API（✅ 实测）

`GET /v1/workouts/training_session_a561995e…/series`：

| series | unit | totalSamples | points |
|---|---|---|---|
| heartRate | count/min | 398 | 398 |
| speed | m/s | 774 | 389 |
| cadence | spm | 775 | 389 |
| strideLength | m | 370 | 370 |
| verticalOscillation | cm | 380 | 380 |
| elevation | m | 1995 | 500 |
| **power** | W | **0** | **0** |
| **groundContactTime** | ms | **0** | **0** |

`GET /v1/workouts/{id}`：`averagePowerWatts=null`、`averageGroundContactTimeMs=null`，
其余平均值正常；`missingReasons=[]`、`eligibilityStatus/assessmentStatus=eligible`、
`heartRateSampleCount=398`（心率已于 10-16 补齐，评估已转正）。

### 2.2 服务端库（✅ 实测）

- 该次跑步窗口 `[2026-10-14T12:54:46Z, 13:28:01Z]` 按类型计数：StepCount 775、Distance 774、
  RunningSpeed 774、HeartRate 398、VerticalOscillation 380、StrideLength 370 …
  **RunningPower 0、RunningGroundContactTime 0**（来源均为 `唐攀的Apple Watch`）。
- 全库这两类的 `MAX(start_at)` = **2026-10-13T13:11:00Z / 13:10:50Z**（上一次跑步结束时刻）。
- **近 20 次跑步对照**（每次课在该窗口内按类型计数）：2026-09-09 … 10-13 的每一次跑步
  `power ≈ speed`、`gct ≈ osc`（如 10-13：speed 791 / power 790 / stride 390 / osc 390 / gct 389），
  **只有 10-14 这一次是 speed 774 / stride 370 / osc 380 而 power、gct = 0**。
  ⇒ 数据源侧（手表记录 + 历史入库）一贯正常，这次是唯一例外。

### 2.3 逐批对账：窗口把别的类型补齐了，唯独这两类查回空（✅ 实测 + 🟡 算术复现）

自 10-14 起每批载荷都是 `recordCount = 4500`（单批预算满），插入集中在两批：

| 批次（UTC） | 插入记录 | 说明 |
|---|---|---|
| 10-14 10:29 … 10-15 09:47（6 批） | **0** | 重放旧数据，全部判「已存在」 |
| **10-16T01:35:25Z** | **4252** | HR 802 / Distance 955 / ActiveEnergy 974 / StepCount 1043 / StrideLength 370 / HRV 105 / VO2Max 1 / RestingHR 1 / HRRecovery 1 |
| **10-16T01:36:28Z** | **1155** | RunningSpeed 775 + VerticalOscillation 380 |
| 10-16T01:37:34Z / 01:41:24Z | 0 | 窗口下界已推进到 10-15T19:36Z，不含这次跑步 |
| 10-17（7 批） | 322/0/0/0/0/15/0 | 已是 10-16/17 的新数据，与 10-14 无关 |

- 4252 与「描述符顺序 + 整批预算」逐条对上：HR 802 + Distance 955 + ActiveEnergy 974 + StepCount 1043
  = 3774；speed 775 / power ~790 塞不进；stride 370 塞得进（4144）；osc/gct 380 塞不进；
  再 + HRV 105 + VO2Max 1 + RestingHR 1 + HRRecovery 1 = **4252**（余 248 由正式流补满 4500）。
  ⇒ 01:35 这两类属于**预算跳过、下批重试**（B1 的设计），不是缺陷。
- 01:36 重试：`speed`(775)、`osc`(380) 重试成功写入，**唯独**夹在两者之间/之后的 `power`、`gct` 仍为空；
  当时批内剩余额度 ≥3300 条、字节也远未触顶 ⇒ **只能是这两类的窗口查询返回了空**。
- 手机实际安装的构建：B1 `0a6f502` 提交于 10-16T00:36Z、O05 `96f480b` 于 04:32Z，而这两批发生在
  01:35/01:36Z ⇒ 装的是 **B1 之后、O05 之前**的版本（窗口 pass 无 20% 独立份额、按描述符固定顺序、
  共用一个整批预算 —— 与 4252 条窗口数据一次写入吻合）。🟡

### 2.4 服务端不是原因（✅ 实测）

- **同一条直连接收链在 10-13T13:16Z 写入过 790 条 RunningPower + 389 条 RunningGroundContactTime**
  （带 `RAIHealthKitSampleUUID` 身份，±5 分钟即那次跑步收尾）⇒ 报文格式、单位（W / ms）、parser、
  storage 都对这两类工作正常。
- 当前 HEAD 合成载荷实测：parser(`apple-health-parser.ts:205-245,445,537-639`) → storage
  (`database.ts:2109-2122`，`INSERT … ON CONFLICT(id) DO UPDATE`) → 读路径全通，两类均落库并取回
  （power `totalSamples=8 unit="W"`、gct `8 unit="ms"`）。写入链**没有任何按类型的分支**；
  `record-delta-policy.ts:6-13` 反而把这两类显式列入 data-only 白名单。
- `fast_path_rejected` 是快通路拒收后**回落直连车道**，实测无损（同 job 内两车道、单事务，无按类型部分提交）。

### 2.5 读 / 渲染不是原因（✅ 实测）

- 8 条序列走**同一个** `metricSeries()`（`apps/api/src/data.ts:1699-1772`；
  power 1718-1726、groundContactTime 1763-1771），只有 `type` 与回退单位不同；
  过滤条件是 `type / source_name / start_at窗口 / value_numeric NOT NULL`
  （`packages/storage-sqlite/src/read/series-read-repository.ts:149-195`），**不含任何类型黑名单**；
  `unit` 只作空序列的展示回退标签，不参与过滤（实测把行存成 `"watts"` 序列仍非空）。
- 详情平均值：HR 读 `workout_features`，power / stride / VO / GCT 先在 `workout_statistics` 找、
  找不到回落 raw `health_records` 时间加权平均（`workout-read-repository.ts:352-438`）；
  两处都没有行 ⇒ 两个读法同时为空 —— 这解释了「序列空 + 平均 null」同源。
- iOS：8 个指标**无条件**渲染（`TechViews.swift:1620-1631`），只有 `points.isEmpty` 时把 190pt 折线图
  换成一行「暂无\(metric.title)时序样本」（`TechSeriesChart.swift:43-67`），平均值 null 只显示 `--`；
  契约里 `series` 8 键为必填（`packages/api-contracts/src/index.ts:906-918`），缺键会整包解码失败、
  8 段全不出现 —— 用户能看到 8 段，证明两键存在且解码正常。

### 2.6 关键技术事实：空窗口也会推进水位（🟡 读代码推断，行号已核）

`HealthKitExport.swift:1351-1420`（B1 版 `0a6f502` 同构）：窗口查询返回空时走 `else if let previousWindow`
分支，把 `recentWindowReadAt = now`；下一批窗口下界 = `max(now − 48h, recentWindowReadAt − 6h)`。
于是 10-16T01:36Z 一旦被标记，下界变成 **10-15T19:36Z**，比这次跑步的结束时刻（10-14T13:28Z）晚 30 小时
⇒ 窗口通道**永久**不再覆盖 10-14。这正是 `docs/IOS_SYNC_PERFORMANCE_REVIEW.md:229-253`（O05 步骤 4/6）
预警的两个相邻缺陷：固定顺序 + 共用预算会让低频类型被高频类型挤掉；「空/截断」不能当作整窗已完整。

---

## 三、事件时间线（京时）

1. **10-13 20:37–21:11** 上一次跑步；21:16 该批（5947 条）入库，其中含 power 790 / gct 389。
2. **10-13 21:16 之后** 同步链进入回执卡住状态，记录侧断供（详见 `LATEST_WORKOUT_MISSING_DATA_2026-10-15.md`）。
3. **10-14 17:35–18:29** iOS 上传「全量回填批」（状态复位指纹）；记录全史重放开始爬。
4. **10-14 20:54–21:28** 本次跑步（5.22 km）——手机侧此后从未上交这两类。
5. **10-16 09:35/09:36** 装 B1 后第一批：窗口 pass 把 10-14→10-16 的近端数据批量补齐（4252 + 1155 条），
   **这两类查回空**；随后两批窗口下界已越过 10-14，永久失联。
6. **10-17 21:15–21:30** 7 批共 31500 条（几乎全是重放重复），只新增 337 条 10-16/17 数据；这两类依旧 0。

---

## 四、已证伪 / 未排除

**已证伪（不必再查）**：✅ 服务端按类型丢数据（10-13 实测 + 当前 HEAD 实测）；✅ 读/渲染/契约丢键；
✅ 单类型 1500 上限截断（降序取最新，会留 ≤1500 条而不是 0，且实测窗口各类型样本数都 <1500）；
✅ 单位/数值过滤（渲染层无任何过滤；单位不匹配会崩溃或整批失败，而不是跳过）；✅ 类型顺序/轮转/预算
在 01:36 那批解释了 power/gct 为空（前后相邻类型都写进去了，且额度充足）；✅ 服务端 tombstone
（全库仅 5 条，均为 RestingHeartRate，与这两类无关）；✅ 版本/契约不符（handshake、8 键必填均正常）。

**未排除**：⬜ HealthKit 读权限在 10-14 复位后未覆盖这两个类型（当前最可能）；
⬜ 手表这次确实没记 / 没同步进手机（步幅+垂直振幅有值使其偏弱）；
⬜ 某次窗口查询抛出被静默吞掉的授权/无数据错误（`HealthKitExport.swift:1413-1419`、`1546-1552`
只吞不报，服务端零痕迹；但这类错误不会推进水位，理论上应该每批重试 —— 观测上 01:37/01:41 是 0，
更支持 A 而非此条）。

---

## 五、手机上 30 秒判定 + 恢复路径

**判定（决定性，二选一）**：

| 检查 | 结论 |
|---|---|
| iPhone「健康」App → 浏览 → 活动 → **跑步功率** / **触地时间** → 看 2026-10-14 20:54–21:28 | 有样本 ⇒ **A（App 读不到）**；无样本 ⇒ **B（上游没数据）**，本次缺失无法用代码补回 |
| 「设置 → 健康 → 数据访问与设备 → RAI」→ 这两类的**读取**开关 | 关着 ⇒ 直接印证 A（复位后未重新授权） |

**恢复（若判定为 A）**：**只重开权限还不够** —— 这两类的游标已越过 10-14，正式锚点流按插入/变更顺序
也不会再回头，窗口又已过期。可行路径按代价排序：

1. **定向回填（推荐，最小代码）**：对「最近 N 次跑步中 power/gct 为空」的训练，用**按 workout 时间窗**的
   有界 `HKSampleQuery`（与窗口 pass 同形，但锚定训练日期而非 now−48h）补读一次，服务端按 UUID 幂等。
2. **只清这两类的游标**（临时解锁）：现有 `repairSyncCursor()` 只清**不可读**的锚点
   （`HealthKitSync.swift:581+`），不会清「可读但已越过缺口」的游标，需要新增一个只按类型清游标的入口；
   清掉后这两类会走一次历史重放（25.4k / 12.4k 条，约 8 批），能一并补齐其它缺口。
3. 不推荐「重新导入全部 / 重装」：全量重放代价 52 万条，且入口已于 10-17 删除。

**若判定为 B**：服务端与 App 都不用改；在详情页把「暂无时序样本」区分为
「手机未提供该指标」并给出手表/权限指引即可。

---

## 六、建议（分级）

- **P0（可观测）**：窗口查询返回空时**不要静默**——尤其当同一窗口内相邻 running 类型有数据时，写一条
  可见 warning（现在窗口 pass 的空结果零日志、零回执痕迹，用户和服务端都无从发现）。**→ 已落地（§七 #4）**
- **P0（水位语义）**：重放期内的空窗口不应把 `recentWindowReadAt` 推进到 `now`（可只推进到
  `windowStart`，或对「从未取到过数据」的类型保留完整 48h 覆盖）；这是 `IOS_SYNC_PERFORMANCE_REVIEW.md`
  O05 步骤 6 的同一条纪律，当前实现仍留有该缺口。**→ 已落地（§七 #2；截断仍推进并写 warning，
  更早部分明确交锚点流）**
- **P1（公平性）**：O05 步骤 4 的「窗口 pass 类型公平调度」需要落地（固定顺序 + 共用预算下，
  低频类型 power/gct 在唯一机会的那批里被高频类型挤掉）。**→ 已落地（§七 #3）**
- **P1（缺口检测）**：详情页对 `power/groundContactTime` 为空且同窗口兄弟类型有样本的训练，标注
  「手机端未提供」而非只显示占位文字；服务端可复用 `data-audit` 的 per-type 覆盖口径给出可告警字段。
  **→ 未做（另外一批）**；本批先在同步侧把"该有却没有"说出来。
- **P2**：`needsHistoryRead()` 门（O05）会进一步关闭窗口通道（重放已完成的类型不再补窗），
  与「空窗口推进」叠加时需要一条「按训练日期回填」的兜底通道，否则同类缺口会再次静默发生。
  **→ 兜底通道已落地（§七 #1）**

---

## 七、修复落地（2026-10-17 晚，已实现并通过门禁）

只动 `apps/ios` 导出侧 + 其纯逻辑回归与结构门禁，**不涉及服务端与契约**：

| # | 改动 | 位置 | 作用 |
|---|---|---|---|
| 1 | **跑步动态迟到样本按日期补读**（`LateDynamicsBackfill`）：新游标字段 `lateBackfillAt` / `lateBackfillBefore`。已建立游标的类型按**近 14 天、最新优先、单类型单批 ≤1500 条**查询；写前判定通过才整页落盘 | `HealthKitRecordCursor.swift`（字段 + 纯逻辑）；`HealthKitExport.swift`（补读 pass） | 这一次就是靠它把 10-14 的两类补回来 |
| 1a | **分页**：命中上限 ⇒ 记 `lateBackfillBefore = 本页最早样本`，下一批只读更老的一段；分页到窗口下界收手 | `LateDynamicsBackfill.pageOutcome` | 14 天里跑步很多时，不会因为"最新 1500 条"漏掉更老的那次跑步 |
| 1b | **空页不记账**：未授权读/样本未到都只返回空、不报错 ⇒ 空页保持原记账、下批重试 | 同上 `.retry` | 不会因为升级后第一次同步碰上空结果就把唯一恢复通道关死 |
| 1c | **30 天再补一次**：整窗覆盖后记 `lateBackfillAt = now`，超过 `retryInterval` 允许再补 | `LateDynamicsBackfill.needs(cursor:now:)` | 权限后开、或又一次样本迟到，都还有下一次机会 |
| 2 | **空窗/未写页不再推进 `recentWindowReadAt`**：判据收进 `RecentWindowAccounting.nextMark`（`written: 0` ⇒ 不推进） | `HealthKitRecordCursor.swift`；`HealthKitExport.swift` | 把"一次空查询"从"永久盲区"降级为"下批再查一次"（**只覆盖迟到 ≤ 约 48h**，见下） |
| 3 | **窗口 pass 公平调度**：与正式段共用持久化轮转起点；本批刚被补读覆盖的类型跳过窗口 | `HealthKitExport.swift` | 独立防饿死修正（**不是**本次事故成因，见 §二.3/§四） |
| 4 | **"该有却没有"可见告警**：同一窗口里兄弟类型**查回数据**、功率/触地时间**查回空**时写 warning | `HealthKitExport.swift`（`windowReturnedEmpty`） | 同类缺口手机端就能说出来；不会把 20% 份额的预算跳过误报成权限问题 |

**验证（本机实跑）**：
- `bash apps/ios/tests/run-ios-gates.sh`（= `npm run test:ios`）：类型检查 94 个文件通过；
  `HealthKit record cursor regression: 45 checks passed`；`HealthKit record sync wiring: 78 checks, 0 failed`
  （新增 5 条接线判据，`MIN_CHECKS` 70 → 77）；`Export determinism checks: 14 checks, 0 failed`；
  `Background capability checks: 297 checks, 0 failed`；末行 `iOS 门禁通过（类型检查 + 纯逻辑回归）`。
- **突变验证**（本机实做 9 条，逐条转红后恢复文件 sha 逐字节一致）：旧空窗推进分支回填 / 未写页也记账 /
  去掉"查回空"集合 / 去掉分页上界透传 / 绕过 `pageOutcome` / 去掉 `needs()` 门 / 删整段补读 —— 全部被
  判据抓住；纯逻辑侧 `pageOutcome` 的五个分支与 `needs()` 的时间再武装各有断言。
- `check:docs` 74 文件/555 链接 0 问题、`check:doc-refs` 越界 0（改后复跑）。

**对抗评审结论**（独立 reviewer 逐行审 diff + 9 条突变扫描）：两条 🔴 已修（空结果不记账、
截断分页）；🟡 修了告警判据、门禁强度、文档口径；**保留并记录**的一项：补读 pass 首次运行会用满整批
记录预算（1–2 批），期间正式锚点流停一轮 —— 属有界的一次性恢复代价，未加 20% 份额（会拖成 5+ 批）。

**怎么用上**：需要真机重装（Xcode 构建）。升级后**第一次同步**就跑补读：四类装不进一批时下一批继续
（分页/装不下都不记账）；服务端按 `RAIHealthKitSampleUUID` 幂等，重复样本无副作用。
预期：`RunningPower` / `RunningGroundContactTime` 一到库，详情页两条时序**自动出现**（序列是读时装配的，
不需要重算）。**前提仍是读取权限**：若 RAI 对这两类的读取开关是关的，补读查回空**但不会记账** ——
打开开关后的下一批自动补上。

**怎么用上**：需要真机重装（Xcode 构建）。升级后**第一次同步**就跑补读：四类装不进一批时下一批继续
（每类只在成功后记 `now`）；服务端按 `RAIHealthKitSampleUUID` 幂等，重复样本无副作用。
预期：`RunningPower` / `RunningGroundContactTime` 一到库，详情页两条时序**自动出现**（序列是读时装配的，
不需要重算）。**前提仍是读取权限**：若 RAI 对这两类的读取开关是关的，补读同样查回空 —— 先打开，
下一批补读即生效。

---

## 八、证据索引

| 位置 | 内容 |
|---|---|
| `GET /v1/workouts/training_session_a561995e…/series`（线上） | power/gct `totalSamples=0`，其余 370–1995 |
| `GET /v1/workouts/training_session_a561995e…`（线上） | `averagePowerWatts/averageGroundContactTimeMs=null`，`missingReasons=[]`、eligible |
| 云机 `health_records` 分类计数 | 该窗口 power/gct = 0；全库 MAX(start_at)=10-13T13:11:00Z / 13:10:50Z |
| 云机 `import_batches.summary_json` | 10-14 起每批 `recordCount=4500`；10-16T01:35 插入 4252、01:36 插入 1155 |
| 云机 `import_entity_changes` | 10-13T13:16 批插入 power 790 + gct 389 → 证明同链可写这两类 |
| `apps/api/src/data.ts:1699-1772` | 8 条序列同一 `metricSeries()`，power/ gct 的 type 与回退单位 |
| `packages/storage-sqlite/src/read/series-read-repository.ts:149-195` | 序列过滤条件（无类型黑名单） |
| `packages/storage-sqlite/src/read/workout-read-repository.ts:352-438` | 平均值：statistics 优先、raw 记录兜底 |
| `apps/ios/RAI/HealthKitExport.swift:1291-1301` | 描述符：power=W、gct=ms（与 speed/stride/osc 同一循环） |
| `apps/ios/RAI/HealthKitExport.swift:1346-1403` | 2026-10-17 新增：跑步动态迟到样本一次性补读 |
| `apps/ios/RAI/HealthKitExport.swift:1406-1519` | B1 窗口 pass（轮转 + 空窗不推进 + 截断 warning）+ "该有却没有"可见告警 |
| `apps/ios/RAI/HealthKitExport.swift:1520-1550,1640-1650` | 正式段轮转 / 游标构造（`lateBackfillAt` 透传） |
| `apps/ios/RAI/HealthKitExport.swift:321-328,2235-2265` | HealthKit「拒绝也不报错、查询只返回空」的事实与错误分类 |
| `apps/ios/RAI/HealthKitRecordCursor.swift:48-50,94-128` | `needsHistoryRead()` 与 `drain` 的「空页 = 到底」语义 |
| `apps/ios/RAI/HealthKitRecordCursor.swift:51,206-241` | 新增：`lateBackfillAt` 字段、窗口水位判定、补读计划 |
| `apps/ios/RAI/Skins/Technology/TechSeriesChart.swift:43-67` | 空序列 → 「暂无…时序样本」占位、平均值 `--` |
| `apps/ios/RAI/Skins/Technology/TechViews.swift:1620-1631,1713-1752` | 8 指标无条件渲染；跑姿面板对 unavailable 的展示 |
| `docs/IOS_SYNC_PERFORMANCE_REVIEW.md:229-253` | O05 已预警的「固定顺序 + 共用预算」「空/截断不得标记整窗完整」 |
| `packages/health-export-parser/src/record-delta-policy.ts:6-13` | 这两类在 data-only 白名单内（不是被过滤的类） |
