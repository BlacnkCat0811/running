# iOS 健康同步：生产核实与可实施优化方案

- 日期：2026-10-19，Asia/Shanghai
- 被核对象：`deliverables/IOS_SYNC_INGEST_AUDIT_2026-10-19.md`（代码基线 `d037fc7`）
- 本轮取证方式：腾讯云 Lighthouse TAT 远程命令，**只读**（`node:sqlite` `readOnly:true` + `pragma query_only`；未执行任何写操作、迁移、checkpoint、重启）
- 生产实例：`lhins-3gatdqed` / `101.33.202.40` / ap-guangzhou
- 生产库：`/var/lib/rai/var/rai.sqlite`（2.42 GB，WAL 40 MB）

> **执行状态（2026-10-19 12:00 CST 追加）**：P0-1/P0-2 已执行——生产已部署 `33f79fe`（服务端代码 = `d037fc7`）、v46 迁移完成、`/freshness` 与 `/sync/coverage` 已 200；P1（A1/A4）已随 `33f79fe` 落地；P2 的 A3/A5/A6/A8 代码与回归完成、**未部署**；P2-4（A2 分页）未做。逐条证据见 [IOS_SYNC_EXECUTION_2026-10-19.md](IOS_SYNC_EXECUTION_2026-10-19.md)；下文的"未部署/线上不存在"表述是成文时刻的事实。

---

## 0. 结论摘要

| # | 结论 | 等级 |
|---|------|------|
| 1 | 报告的**事故数字全部真实**：6.0125 km、`11:46:38Z–12:28:46Z`、事实提交 `12:29:38.755`、步幅 482 条、分析发布 `12:31:21.265`、间隔 102.5 s | ✅ 生产证实 |
| 2 | 报告的 **A1–A4、A7、A8 代码判断成立**；A3 的"第二次即收口"也对（`stabilityToComplete = 1`） | ✅ 源码证实 |
| 3 | 报告把主因归为"iOS 训练级读取/续批/完整性判定"**归因错了对象** | 🔴 需更正 |
| 4 | 用户这次遇到的"要多次同步"，主因是**线上跑的是 `8efdb99`，比报告基线落后一个提交**：读侧仍用 `INNER JOIN active_ability_assessments` 当驱动表 ⇒ 分析发布前列表无此训练、详情 404 | 🔴 需更正 |
| 5 | 102.5 s 的来源是**部署版 `dirty-range.ts:178` 对任何 VO2Max 变更置 `full = true`** ⇒ 每条跑步新增 1 条 VO2Max ⇒ 286 场全量重算（特征 43.2 s + 负荷 27.4 s + 回放 8.4 s） | 🔴 报告未识别 |
| 6 | A5 / A6 **在线上不存在**：`/v1/workouts/:id/freshness` 与 `/v1/sync/coverage` 均返 404，`health_records` 无 `available_at` 列。它们描述的是"本地 HEAD 的未来行为" | 🟡 需标注 |
| 7 | A7 是**本次提交新引入的风险**（尚未上线）。若原样发版，会把"服务端有一条样本"当成"历史已覆盖" | 🔴 发版前置 |
| 8 | 6 次同步共上传 27,000 条记录元素，只新增 1,111 条事实 ⇒ **重复率 95.9%**；线上版批容量固定 4,500 条 | 🟡 新发现 |

**一句话**：报告对"代码还有什么缺口"的判断基本正确，对"用户这次为什么难受"的判断不成立。当前首要动作不是改 iOS，而是**把已修好的 `d037fc7` 发上去，并在发版前处理它自带的一个新风险（A7）**。

---

## 1. 取证通道与边界

| 项 | 结果 |
|---|---|
| SSH `101.33.202.40:22` | 报告记录三次在认证前断开。**本轮未使用 SSH** |
| Lighthouse TAT | ✅ 可用；`execute_command` 执行只读命令 |
| 数据库读取 | `node:sqlite` `readOnly:true`（宿主机无 `sqlite3` CLI） |
| 写入 / 迁移 / 重启 | ❌ 全程未执行 |
| 已知限制 | TAT 的 `execute_command` 存在服务端命令过滤，部分命令返回 `AccessDeny`（重试或换写法可绕过）。**这是通道限制，不是服务器故障** |

> 流程更正：报告第 7 节把"生产取证"卡在 SSH 上。Lighthouse 有 TAT 通道，不需要 SSH、不需要密码、不需要源地址白名单。

---

## 2. 生产事实：这一次事故的完整时间线（CST）

**训练实体**

| 字段 | 值 |
|---|---|
| workout | `workout_68c3ccd2fa742897ff06f4e83a0cb200` |
| training_session | `training_session_2aac5780f95010e0e0af1be6966f0c1b` |
| 窗口 | `2026-10-18T11:46:38Z` → `12:28:46Z`（19:46:38–20:28:46） |
| 距离 | **6.0125 km**（`training_sessions.anchor_distance_km`） |
| 路线 | 2,527 点，`file_status=imported` |

**同步与分析时间线**

| 时刻 | 事件 | 证据 |
|---|---|---|
| 20:29:18 | 同步 #1：4,500 条载荷，**新增 1 条**，无 workout | `import_batches` gen 40 |
| 20:29:30 | 同步 #2：workout + 622 条 + 路线；提交 `20:29:38.755` | gen 41，`summary.xml.insertedWorkoutCount=1` |
| 20:29:38.763 | 分析任务创建 | `recompute_jobs` |
| 20:29:42 | 列表请求 200 —— **不含该训练** | nginx `rai-access.log` |
| 20:29:44 | 分析任务被 worker 领取（排队 6.2 s） | `recompute_job_events` |
| 20:29:57 | 输入计划被调整为 `route_evidence_unmerged` | 同上 |
| 20:30:14 | 同步 #3：4,500 条，新增 **482**（步幅）；提交 `20:30:23.066` | gen 42 |
| 20:30:40 | 特征提取完成：**286 场 / 43.2 s** | `performance` 事件 |
| 20:31:08 | 训练负荷完成：**27.4 s** | 同上 |
| 20:31:09 | 能力时间线回放完成：**8.4 s** | 同上 |
| **20:31:21.265** | **分析指针激活**（`active_model_run`） | 距事实提交 **102.51 s** |
| 20:31:30 | 同步 #5：新增 **1** 条 | gen 44 |
| 20:31:43 | 同步 #6：新增 **0** 条 | gen 45 |
| 20:31:54 | 列表 200 —— 这次开始带上该训练 | nginx |
| 20:31:56 → 20:31:57 | 详情首次请求（499）→ **首次 200** | nginx |
| 20:32:13 起 | 详情 + series 反复刷新 | nginx |

**关键对照**：该 session 的详情请求在 `20:31:56` **之前一次都没有出现过**（nginx 里只有旧 session 的请求）。也就是说，用户不是"点进去发现 404"，而是**列表里根本没有这条训练，连点都点不进去**。

---

## 3. 报告的逐条核实

等级：**P** = 生产证实；**S** = 源码证实（生产未直接观测）；**X** = 线上不存在；**N** = 需更正。

| 条目 | 报告判断 | 核实结果 | 依据 |
|---|---|---|---|
| A1 新窗口不入本批 | P1 | **成立（S）** | `HealthKitExport.swift:942` 传的是入口参数 `workoutBackfillWindows`；新登记进 `windowRegistrations`（`:531`、`:902`），只在 `:1047` 返回 |
| A2 无逐类型分页 | P1 | **成立（S）** | `:1519-1576`：单类型一次 `recentSamples(limit:)`，份额不足 `break`，整窗不记账；下批从 `descriptors` 首位重来 |
| A3 总数稳定即收口 | P1 | **成立（S）**，且"第二次即关闭"正确 | `RouteSyncState.swift:531` `stabilityToComplete = 1`；第 2 次相同正数即 `completed` |
| A4 窗口未接入待办探针 | P1 | **成立（S）**，生产有间接强证据 | `HealthKitSync.swift:853-869`、`HealthSyncBackgroundRecovery.swift:111-113`；生产最后两次同步只带回 1 条和 0 条，说明确实是"手点" |
| A5 `complete` 只看 24h 静默 | P2 | **逻辑成立（S），线上不存在（X）** | `data.ts:1960`；线上 `/freshness` **404**，`health_records` 15 列无 `available_at` |
| A6 旧分析掩盖新 queued | P2 | **逻辑成立（S），线上不存在（X）** | `workout-read-repository.ts:558-572`；线上无该端点 |
| A7 MAX 推历史完整 | P1 | **成立（S），但定级错**：它不是历史缺陷，是 `d037fc7` **新引入**的 | `HealthKitRecordCursor.swift:473-488`（`sampleCount > 0` 即可，`overlap=24h`、`maximumUsefulLag=90d`） |
| A8 completion 早于持久化 | P2 | **成立（S）** | `HealthKitSync.swift:601-612`：`completion()` 在 `Task {}` 之前，且丢弃 error |

### 3.1 报告正确但没有点透的一处

A3 的收口判据读代码容易读成"三次"（注释写"连续两次一致"），实际常量是 `1`，**第二次就收口**。报告的复现结论是对的；建议同时把 `RouteSyncState.swift:616` 的注释改成"第二次观测到相同正数即收口"，否则下一个人还会读错。

### 3.2 数字层面的唯一偏差

报告写"步幅记录批次提交 `20:30:23.070`"，生产实际 `20:30:23.066`（差 4 ms）。原因是该值来自测试夹具常量（`apps/api/test/workout-visibility-freshness.test.ts:45`），不是生产读数。不影响结论，但说明报告 H 级数字确实是"仓库记录"，不是"线上读数"——报告对此的标注是诚实的。

---

## 4. 报告需要更正的四处

### 4.1 🔴 最重要：没有核实线上跑的是哪个提交

| 项 | 值 |
|---|---|
| 线上 HEAD | **`8efdb99`**（2026-10-18 19:58:48） |
| 服务启动 | 2026-10-18 **19:59:41**（跑前 13 分钟，正好在跑步过程中完成了一次部署） |
| 报告基线 | `d037fc7`（2026-10-19 **06:59:08**）——事故之后 10 小时才提交 |

线上读侧（`8efdb99`）：

```
workout-read-repository.ts:127  FROM active_ability_assessments a
                          :193  FROM active_ability_assessments a
                          :232  FROM active_ability_assessments a
                          :285  FROM training_sessions ts
                          :286  JOIN active_ability_assessments a ON ...
```

本地 `d037fc7` 已改成 `FROM training_sessions ts ... LEFT JOIN active_ability_assessments`（`:327-329`、`:366-368`、`:440-442`）。

**含义**：报告 §2 "已有的正确保护 3：列表和详情改为事实驱动"——**线上没有这条保护**。报告把它当成既有能力，于是把剩下的缺口当成了主因。

生产接口也直接证实：`GET /v1/workouts?limit=1` 的 item 字段里有 `assessmentStatus`，**没有 `analysisPublishStatus`**；顶层是 `currentFacts/publishedAnalysis`，不是新结构。

### 4.2 🔴 102.5 s 的真实来源，报告只说"分析侧"

生产 `import_batches.analysis_dirty_plan_json`（触发分析的那一批）：

```json
{"version":1,"full":true,"dirtyFromAt":null,
 "domains":{"features":null,"fitness":null,"readiness":null},
 "routeDirtyTimes":["2026-10-18T11:46:38.000Z"], ...}
```

`full: true` 来自部署版：

```
8efdb99:packages/health-export-parser/src/dirty-range.ts:178-180
  if (side.type === healthTypes.vo2Max) { full = true; reasons.add("vo2_evidence_changed"); }
```

每次跑步结束，Apple 都会写 1 条 VO2Max（本次 `12:28:46Z`，1 条）。于是**每一次跑步同步都触发 286 场全量重算**。这就是 43.2 s 特征 + 27.4 s 负荷 + 8.4 s 回放的来源。

本地 `d037fc7` 已修（P0-2），注释里写的正是「1 条 VO2Max 样本 ⇒ 286 条历史训练全量重算 103 s」——与生产实测 96.7 s 同量级。

### 4.3 🟡 A5 / A6 不是"当前缺陷"，是"尚未上线的行为"

| 检查 | 线上结果 |
|---|---|
| `GET /v1/workouts/:id/freshness` | **404** |
| `GET /v1/workouts/<session>/freshness` | **404** |
| `GET /v1/sync/coverage?types=...` | **404** |
| `health_records` 列 | 15 列，**无 `available_at`** |

所以报告第 4 节那两个"实调 `RaiReadStore.workoutFreshness`"的复现，是**在本地 HEAD 上跑生产函数**（报告标 R 是准确的），但它证明不了线上行为。报告 §1 说"仅归因于手表延迟"不成立——正确；但它举的 A5 证据在线上根本没有这段代码。

**建议改法**：给这三条加一行"线上不存在（`d037fc7` 引入）"，否则读者会把"已上线但语义错"和"未上线的新合同"混为一谈。

### 4.4 🔴 A7 的定级要改：这是"发版会引入的新风险"

报告把 A7 列为 P1 数据安全风险，但它同时把 `d037fc7` 的覆盖探测当成已有保护（§2 第 4 条）。实际关系是：

- 线上：没有 `/v1/sync/coverage`，客户端不会跳历史 ⇒ **无风险，也没有收益**
- 发版后：服务端只要某类型 `sampleCount > 0`，客户端就把历史下界抬到 `knownUntil − 24h`（`HealthKitRecordCursor.swift:478-487`）

危险形态：某类型在服务端只有 1 条今日样本（比如本次 PhysicalEffort 只有 120 条、VO2Max 只有 1 条），客户端就可能据此跳过 90 天内的全部历史重放。`knownUntil−24h` 这个下界还会**粘住**（`historyCoverageFloor` 一旦落盘就继续用）。

⇒ **在修 A7 之前，覆盖跳过不该随本次发版启用。**

---

## 5. 根因分层（我的判断）

| 层 | 机制 | 对"要多次同步"的贡献 | 状态 |
|---|---|---|---|
| **P0-a 读侧门禁** | 分析发布前 `INNER JOIN active_ability_assessments` ⇒ 列表无行、详情 404 | **决定性**：102.5 s 内无论点几次都看不到 | 已修（`d037fc7`），**未部署** |
| **P0-b 全量重算** | VO2Max 变更 ⇒ `full = true` ⇒ 286 场重算 96.7 s | **决定性**：把 102.5 s 拉长到分钟级 | 已修（`d037fc7`），**未部署** |
| P1-c 无自动续批 | 探针不含窗口待办（A4）；新窗口不入本批（A1） | 中等：把"自动补齐"退化成"再点一次" | 未修 |
| P2-d 过早收口 | 总数稳定即完成（A3）；无逐类型状态 | 低（本次）：影响后续迟到类型的补齐 | 未修 |
| P2-e 语义误导 | `complete` = 已发布 + 24h 静默（A5） | 低（本次）：影响信任，不影响数据 | 未上线 |
| — | 手表渐进可读 | 真实存在：482 条步幅在跑完 1 分 37 秒后才到 | 不可消除，只能如实呈现 |

**报告说"不能仅归因于手表传输延迟"——完全正确。** 需要补一句：**也不能主要归因于 iOS 读取预算**。生产显示 6 批里有 4 批带回了新数据（622 / 482 / 5 / 1），iOS 侧其实是在工作的；真正让用户"看不见"的是服务端读侧。

---

## 6. 优化方案

### P0 · 今天：把已修好的东西发上去（并堵住 A7）

#### P0-1 发版前加一道闸：A7 默认关闭

**改动**（`apps/ios/RAI/HealthKitRecordCursor.swift:473-488`）：

```swift
// 在覆盖表能给出"连续段"之前，不下界。
// 判据不是"有没有样本"，而是"这段区间是否被证明连续交付"。
guard entry.segments != nil else { return nil }
```

或最小改动：让 `historyFloor` 直接 `return nil`，并把 `shouldRestartHistory` 一并降级为 no-op；覆盖率仍用于**优先级**（先读最近 24h），不用于**跳过**。

- 验收：构造"服务端今日仅 1 条功率样本 + 手机有 10 天前功率样本" ⇒ 不得产生早于今日的下界；历史重放仍覆盖 10 天前。
- 回滚：这就是回滚点，`git revert` 该 commit 即可。
- 理由：省下的是手机读取时间，赔的是数据完整性；在 534,807 条既有数据上不划算。

#### P0-2 部署 `d037fc7`

```bash
# 1) 取代码
sudo -u rai git -C /opt/rai fetch --all
sudo -u rai git -C /opt/rai checkout d037fc7        # 或 main
# 2) 迁移闸门（API 有 pending 会 exit 78，必须先迁移）
sudo -u rai npm --prefix /opt/rai run data:migrate -- --database /var/lib/rai/var/rai.sqlite
#    必须看到 "pending": []
# 3) 重启
sudo systemctl restart rai-api
# 4) 复核
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer …" \
  http://127.0.0.1:$RAI_API_PORT/v1/workouts/<session>/freshness     # 期望 200
```

**依赖**：`git diff --name-only 8efdb99..d037fc7` 显示**无 `package.json` / `package-lock.json` / Cargo 变更** ⇒ 不需要 `npm ci`、不需要重编 Rust。

**迁移风险**：v46 只是 `ALTER TABLE health_records ADD COLUMN available_at TEXT`（534,807 行，SQLite 加可空列是 O(1) 元数据操作）。但**历史迁移不可逆**：

- 回滚方案 = `git checkout 8efdb99` + restart，**列保留**（可空、旧代码不读）；**不要**写 down migration。
- 前置：`systemctl stop rai-api` 后再迁移更稳（避免 `BEGIN IMMEDIATE` 抢锁）；迁移完再 start。
- 磁盘：`/` 50 G，已用 35 G，余 13 G；DB 2.4 G + WAL 40 M，够。

**部署后必须验的三件事**：

| # | 断言 | 方法 |
|---|---|---|
| 1 | 读侧已解耦 | `GET /v1/workouts` item 含 `analysisPublishStatus`；顶层结构变化 |
| 2 | 新合同在 | `/freshness` 200、`/sync/coverage` 200 |
| 3 | VO2Max 不再全量 | 跑一次新训练后：`select analysis_dirty_plan_json from import_batches order by created_at desc limit 1` ⇒ **`full:false`** |

第 3 条是本次最有价值的验收断言：它直接证明 43.2 s 的全量重算是否真的消失。

#### P0-3 手机端版本

- 线上 API 与旧 App（`8efdb99` 构建）**兼容**：详情模型的 `assessmentStatus` 在旧版已是 `String?`（`8efdb99:APIModels.swift:290`），新服务端返回 `null` 不会解码失败；列表新增字段是增量。
- 但**旧 App 拿不到 freshness / 续批 / 按字节批容量**。所以 P1 的收益必须发版才有。

### P1 · 1–2 天：让"一次操作"真的能跑完（A1 + A4）

#### P1-1 A1：本批新登记的窗口并入本批读取

`apps/ios/RAI/HealthKitExport.swift`，三处：

```swift
// ① :531 之后 —— 快照与登记表分离
var windowSnapshot: [String: WorkoutBackfillWindow] = workoutWindowByUUID

// ② :902 —— 页交付后同时并入快照
for (uuid, window) in pageWindowRegistrations {
    windowRegistrations[uuid] = window
    windowSnapshot[uuid] = window          // ← 新增
}

// ③ :942 —— 读记录时用快照
workoutWindows: Array(windowSnapshot.values),
```

**为什么安全**：`pageWindowRegistrations` 只在页被接受后并入 `windowRegistrations`（`:902` 的位置本身就是"页已交付"的判据），被拒页的窗口不会进快照；原始游标仍只在回执确认后推进（`HealthKitSync.swift:1735-1740` 不变）。

**代价**：同一场训练可能在"窗口通道"和"anchor 通道"各读一次 → 载荷重复。服务端按 UUID 幂等，不产生重复事实；但在 P2 做批内去重之前，单批字节会涨。

- 验收（回归）：构造一批，首个 workout 页即发现新训练 ⇒ 断言本批 `writeGlobalRecords` 收到的 `workoutWindows` 含该 UUID；被拒页 ⇒ 不含。
- 回滚：三行反向改。

#### P1-2 A4：到期窗口进入统一待办探针

```swift
// HealthSyncBackgroundRecovery.PendingWork
let hasDueWorkoutWindow: Bool

var needsAnotherRound: Bool {
    hasUnfinishedWork || hasIntent || hasRecoveryRequest
        || hasPendingContinuation || hasDueWorkoutWindow
}
```

```swift
// HealthKitSync.probePendingWork(:853) —— 只读、无副作用
let scope = authoritativeScope ?? urlScope
let now = Date()
let windows = taskStore.loadWorkoutBackfillWindows(scope: scope)   // 已有接口 :1544
hasDueWorkoutWindow: windows.values.contains {
    !$0.isCompleted && $0.nextCheckAt <= now && !$0.isExpired(now: now)
}
```

🔴 **必须同时加 `isExpired`**，否则会造出死循环：整窗永远跑不完 ⇒ `afterPass` 从不执行 ⇒ `nextCheckAt` 永远 <= now ⇒ 探针永远说"还有活"。

```swift
// RouteSyncState.WorkoutBackfillScheduler
static func isExpired(_ w: WorkoutBackfillWindow, now: Date) -> Bool {
    now.timeIntervalSince(w.createdAt) >= completionWindow      // 7 天
}
// due() 改为先结算过期：把过期窗口标记 completed(reason=expired)，再取未过期的
```

- 验收（纯函数，秒级）：
  1. 任务/意图/恢复/续批全 false + 1 个到期窗口 ⇒ `needsAnotherRound == true`
  2. 窗口 `nextCheckAt` 在未来 ⇒ `false`（不得因此每 15 分钟自旋）
  3. 窗口已过期 ⇒ `false`，且被结算为 `completed(expired)`
- 回滚：字段默认 `false`，删掉即可。

#### P1-3 只做 A1+A4 能得到什么

用户视角：跑完点一次同步 ⇒ 同批带上新训练 + 窗口内全部可读类型 ⇒ 分析发布后页面自动刷新（P0-6 的自动重取已在 HEAD）⇒ **不需要第二次点击**。

达不到的部分（要 P2）：单类型 > 1,500 条、迟到 20 分钟后才到的类型、历史空洞。

### P2 · 3–5 天：让"补齐"可收敛（A2 + A3 + A6 + A5）

#### P2-1 A3：逐类型状态替代总数

数据结构（`WorkoutBackfillWindow`）：

```swift
struct TypeProgress: Codable {
    var observed: Int          // 本窗口已观测条数
    var delivered: Int         // 已交付条数
    var stablePasses: Int
    var pageComplete: Bool     // 该类型已读到 EOF
    var lastObservedAt: Date?
}
var types: [String: TypeProgress]        // 替代 lastSampleCount: Int
```

**收口条件**（替换 `afterPass`）：

- 每个"已见类型"：`pageComplete == true` 且 `stablePasses >= 1`
- 且**不存在**"已登记但从未观测到"的类型被当作完成 —— 它们记 `unseen`，只有 7 天到期才退出
- 结算原因：`completed / expired / blocked(pageBudget) / unauthorized`

- 验收：两趟只有 HR 500 ⇒ 不完成；第三趟加入 power ⇒ 该类型重开、整体回到 pending。
- 迁移：`sync_pending_workout_windows` 加 `types_json` 列；老行按"全部 unknown"读，**不得**按完成处理。

#### P2-2 A6：发布状态要带覆盖范围

`workout-read-repository.ts:558-572` 现在只要存在评估行就 `published`。改为：

```
published  ⟺ 评估行的 model_run 覆盖代次 >= 该 session 最近影响批次的 dependency_generation
```

短期实现（低风险）：若存在 `created_at > active.activated_at` 且关联本 session 的 `queued|running` 作业 ⇒ `pending`，并保留"旧分析可用"标记。

- 验收：旧评估已发布 + 新 queued ⇒ `analysis.status = pending`，**且详情仍 200**（不是 404）。
- 回滚：只改状态派生，不改数据。

#### P2-3 A5：把 `complete` 拆成三态

```
deliveryState:  delivered | partial | unknown
analysisState:  published | pending | failed
stabilityState: stable(≥24h 无新批) | settling
```

`completeness=complete` 只在 `deliveryState=delivered && analysisState=published` 时成立；24h 静默只抬 `stabilityState`。

**兼容策略**：先**只加字段**，`completeness` 语义下一版再改；否则 iOS 同批必须同步改文案（`SyncPresentationPolicy.swift:163-165` 的"Apple Watch 仍在传输"也要按 `deliveryState=unknown` 才显示，不能对 `readAttempted && 0` 直接归咎手表）。

#### P2-4 A2：分页游标（最重的一块，单独排）

键：`(scope, workoutUUID, type)`；值：`pageToken`。

🔴 **同时间戳多 UUID 是这里唯一的坑**：`HKSampleQuery` 的 `sortDescriptors` 只保证按 `startDate` 排序，**同一 startDate 内的顺序未定义**。所以不能"最早时刻减一秒"。

可用做法：

1. 谓词用 `start >= lastStart`（**含**），`limit = pageLimit + margin`
2. 本地按 `(startAt, uuid)` 排序，跳过"已交付 UUID 集合"里的样本
3. 断点 = 本页最大 `(startAt)`；同一 `startAt` 的 UUID 集合**只保留当前时刻桶**（有界），进下一批后清空
4. 若整页都是已交付 ⇒ 记 `pageStalled` 并降频，**不允许**原地重试

- 验收：单类型 3,000 条 ⇒ 两批收敛；同一 startAt 两个 UUID 跨页 ⇒ 不漏。
- 注意：这是**新增持久化结构**，必须先做本地 schema 迁移 + 回滚路径。

### P3 · 观测与收尾

1. **纯重复载荷**（本轮新发现）：6 批上传 27,000 条，新增 1,111 条 ⇒ 95.9% 重复。P1-2 之后按 `(type,UUID)` + 内容摘要做批内/跨批去重（服务端已有 `content_hash`，可复用），把窗口通道和 48h 窗口的重复读压掉。
2. **批容量**：线上固定 4,500 条（`8efdb99:DirectSyncBatchBudget.swift:45`、`:56`）；`d037fc7` 改为按字节 `min(12_000, max(4_500, bytes/480))`。发版后核对 `summary.xml.recordCount` 是否从 4500 变为按字节。
3. **端到端时间线**：建议固定四个时刻并落日志——`factsCommittedAt / analysisPublishedAt / clientDetailRenderedAt / seriesRenderedAt`。目标值先测基线再定，不写死秒数。
4. **A8**：`completion()` 前先落一个持久意图（同步写、短时限），错误分类记录。验收：在 completion 与 intent 之间注入进程终止，重启后意图仍在。

---

## 7. 执行顺序与依赖

```
今天     P0-1 (关 A7)  ──┐
         P0-2 (部署)     ├─→ 同一次发版
         P0-3 (iOS 发版) ─┘
                          ↓
         P1-1 (A1) ─ P1-2 (A4) ─→ 一次 App 更新，解决"要点两次"
                          ↓
         P2-1 (A3) ─ P2-2 (A6) ─ P2-3 (A5) ─→ 服务端 + iOS 同批
                          ↓
         P2-4 (A2 分页) 单独排期（有本地迁移）
                          ↓
         P3 (去重 / 埋点 / A8)
```

硬约束：

- **A2/A3 改的是端上持久化结构** ⇒ 必须带迁移与"老数据按 unknown 读"的兼容分支。
- **A5/A6 是 API 契约变更** ⇒ 服务端与 iOS 同批进退，`/v1` 旧字段不删。
- **A7 不修就不能发覆盖跳过**；这条比任何性能收益都优先。
- 部署前先备份（`/var/lib/rai/var/backups` 已有机制），迁移前停服务。

---

## 8. 验收清单（对应报告第 6 节）

| # | 报告验收项 | 本轮判定 | 何时能过 |
|---|---|---|---|
| 1 | 最新训练不排历史队尾 | 生产未见排队问题（本次只有 6 批） | P0 后复测 |
| 2 | 首次发现即同批读取窗口 | ❌ 当前不满足（A1） | P1-1 |
| 3 | >3,000 条 / 单类型 >1,500 条可分页 | ❌ 当前不满足（A2） | P2-4 |
| 4 | 迟到类型自动重开 | ❌ 当前不满足（A3） | P2-1 |
| 5 | 份额耗尽后仍有进展、到期有原因 | 部分（有 7 天期限，无原因记录） | P2-1 |
| 6 | anchor 追平但窗口待补，探针仍能发现 | ❌ 当前不满足（A4） | P1-2 |
| 7 | 断网/杀进程续接原批次 | 未见破坏（锚与回执机制在位） | 需真机 |
| 8 | 事实已入库、分析延迟仍可见 | ✅ **发版后成立**（线上当前不成立） | P0-2 |
| 9 | 旧评估 + 新 queued 不显示"最新" | ❌ 当前不满足（A6） | P2-2 |
| 10 | `complete` 有交付证据 | ❌ 未上线；上线也不满足（A5） | P2-3 |
| 11 | MAX 下界不永久跳过 | ⚠️ 发版会引入（A7） | P0-1 |
| 12 | 真机时间线对齐 | 未做 | 发版后 |

---

## 9. 仍然未知（不要当成已验证）

| 项 | 为什么未知 | 怎么补 |
|---|---|---|
| 手机安装的 App 构建号 | 服务端不可见 | 用户在 App 内查看，或下次发版时记录 |
| HealthKit 各类型"首次可读"时刻 | 只有设备侧知道 | 真机跑一次，导出 `ExportChannelCounts` |
| 482 条步幅为何晚 44 s | 是手表投递还是 app 没读到，服务端无法区分 | 同上；服务端只能证明"什么时候到" |
| `route_evidence_unmerged` 是否在发版后仍触发 | 需发版后跑一次 | P0-2 的第 3 条断言 |

---

## 10. 一句话给决策

**先发版，再改端。** `d037fc7` 已经把这次事故的两个决定性问题（读侧 404 门禁、VO2Max 全量重算）都修了，只是没上线；而 iOS 侧的 A1/A4 决定的是"用户要不要点第二次"，属于体验缺口，不是这次"看不见"的原因。唯一不能跟着一起发的，是 A7——那是一条会悄悄吞掉历史数据的优化，修好之前应当关掉。
