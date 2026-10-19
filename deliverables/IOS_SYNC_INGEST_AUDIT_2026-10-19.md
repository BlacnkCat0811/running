# iOS 健康同步、解析入库审查与优化方案

- 日期：2026-10-19，Asia/Shanghai。
- 代码基线：`d037fc76649ad09ad92320ff369b733b136bfacc`。
- 对象：用户反馈的 **2026-10-18 晚约 6 km 跑步，需要多次同步才出现，之后再次同步才出现各项时序**。
- 本轮仅审查与本地合成复现；没有修改产品代码、生产数据、生产配置，也没有重启或部署服务。
- 结论等级：**R**＝本轮调用实际生产函数的本地复现；**C**＝源码路径交叉核对；**H**＝仓库历史记录，非本轮线上核验。

## 1. 结论与证据边界

**当前代码仍不能保证“手机 HealthKit 中已可读取的最新训练及各项详情，通过一次用户操作完整同步”。主要缺口在 iOS 的训练级读取/续批/补齐调度，以及服务端的完整性判定；不能仅归因于手表传输延迟。**

发现 **5 项 P1 和 3 项 P2**。其中 5 个边界已用生产纯逻辑函数或实际 API 读仓库合成复现，详见第 4 节。预算饿死复现使用生产预算函数与源码同形的循环模型，**不是**真机 HealthKit 查询实测。

### 生产服务器：尚未取到数据库

- 对用户提供的服务器 `101.33.202.40:22`，本轮三次 SSH 尝试均在认证前断开；第二次明确返回 `kex_exchange_identification: Connection closed by remote host`，稍后重试仍关闭。**未进入密码验证，不能认定为密码错误，也不能认定已登录。**
- HTTPS 的 `/v1/health` 可到达，但返回 `401 unauthorized`。服务器 SSH 密码不是 API Bearer Token，未将其当作 Token 尝试。
- HTTPS 地址按本机证书链验证失败；仅为无凭证连通性诊断做过一次跳过验证的请求。没有据此判定 App 的域名/TLS 配置有问题，不建议产品关闭 TLS 校验。
- 本地 `/Users/ta/running/var/rai.sqlite` 没有 2026-10-18 训练：最近 workout 为 2026-08-25，最近健康记录为 2026-09-04，manifest 最近导入为 2026-09-17。**不能把此库当作生产库解释这次事故。**
- 因此，生产部署 commit、用户手机安装版本、目标训练 UUID、各类型首次可读/上传/入库时刻、真实解析耗时，均尚待核实。

**要补上生产取证，需要可用的 SSH 端口/接入条件（例如是否非 22、源地址白名单），或者由服务器执行本报告附带的只读探针。无需再次发送密码。**

### 仓库已有一次针对同一形态的历史诊断，但不等于已上线

当前 HEAD 提交说明和测试夹具记录了：

| 项目 | 仓库历史记录中的时刻/数量 |
|---|---|
| 训练窗口 | 2026-10-18 19:46:38—20:28:46，北京时间 |
| 距离夹具 | 6.0125 km |
| workout 事实提交 | 2026-10-18 20:29:38.755 |
| 步幅记录后续批次提交 | 2026-10-18 20:30:23.070；注释记录 482 条 |
| 分析指针发布 | 2026-10-18 20:31:21.265 |
| 事实提交至分析发布间隔 | 约 102.5 秒 |

来源：`/Users/ta/running/apps/api/test/workout-visibility-freshness.test.ts:29-43` 及 `git show d037fc7`。等级 **H**。

这组记录与用户描述高度吻合，但原始 `output/diagnosis-2026-10-18-run-partial` 已不在当前工作区；**本轮没有用线上原始证据复核这组数字**。不能据此断言那条训练在本轮生产库中的当前状态，更不能把之前的“75/118 批”等历史数字写成本轮实测。

## 2. 链路审查

```text
手机 HealthKit
  ├─ workout anchored 流 / 路线发现与读取
  ├─ workout 补齐窗口（25% 份额）
  ├─ 跑步动态迟到补读（约 14.3% 份额）
  ├─ 48h 近期窗口（20% 份额）
  └─ 各记录类型的历史重放 / anchored 增量
       ↓ export.xml + GPX + manifest → ZIP
iOS 持久化任务 → 上传 → inspect → import job
       ↓
API direct-sync 接收事务
  XML/GPX 解析 → UUID 身份/墓碑/事实写入
  → 局部 canonical → 变化账本/代次 → 分析任务登记
  → 持久回执 → COMMIT
       ↓
分析 worker → 发布模型/派生结果
       ↓
列表 / 详情 / series / freshness → iOS 缓存与当前详情重取
```

### 已有的正确保护，不应“优化”掉

1. 服务端在同一事实事务中写入原始事实、变更账本、分析任务和回执，使用提交前回读断言；分析与原始事实成功分开。
2. UUID、内容摘要、来源别名、显式删除/墓碑和 `preserveAbsent` 仍在位。重复发送不是必须产生重复事实。
3. 当前 HEAD 列表和详情改为事实驱动、分析侧 LEFT JOIN；不再要求分析发布后才看得见新训练。相关 HTTP/存储回归本轮通过。
4. 当前 HEAD 增加了未变记录轻路径、路线已交付摘要、字节驱动批容量与 VO2Max 有界脏区间。这些都是有价值的改进，但**没有构成训练级完整交付闭环**。
5. 不应通过清空所有游标、反复全量同步、扩大请求超时，或把评分核心搬到手机来解决本问题。

关键代码：

- iOS 导出：`/Users/ta/running/apps/ios/RAI/HealthKitExport.swift`
- 同步/回执提交：`/Users/ta/running/apps/ios/RAI/HealthKitSync.swift`
- 服务端接收：`/Users/ta/running/apps/api/src/direct-sync-ingest.ts:780-1040`
- 记录解析：`/Users/ta/running/packages/health-export-parser/src/apple-health-parser.ts:624-727`
- 事实可见性：`/Users/ta/running/packages/storage-sqlite/src/read/workout-read-repository.ts:323-460`

## 3. 发现

### A1 · P1：新训练刚登记的补齐窗口不参与本批读取

**证据 C**

- workout 循环将新窗口放入 `pageWindowRegistrations`，接受页面后并入 `windowRegistrations`：`HealthKitExport.swift:680-701, 903`。
- 但传给 `writeGlobalRecords` 的仍是函数入口的旧数组 `workoutBackfillWindows`：`HealthKitExport.swift:933-942`。
- 新窗口直到导出返回后才持久化：`HealthKitSync.swift:1735-1740`。

因此“新窗口 `nextCheckAt = now`，本批就会查”的注释与实际接线不一致。**新训练的定向完整读取至少推迟到下一批**；本批是否恰好有全部时序，只能依赖其它通道的额度和类型顺序。

**优化**：仅合并已接受 workout 页的新/更新窗口到本批窗口快照，在同批记录读取前运行；被拒页面的窗口不得进入快照。原始游标仍只在持久回执确认后推进。

### A2 · P1：定向窗口没有逐类型分页/进度，份额耗尽后可能永久重复前缀

**证据 R（循环模型）+ C**

位置：`HealthKitExport.swift:1512-1575`。

- 每批从固定的 quantity 顺序开始，心率、距离、能量、步数、速度、功率……。
- 单类型只执行一次 `recentSamples(limit:)`，没有保存 `(workout,type)` 分页断点，也不检查 `samples.count == pageLimit` 是否意味着仍有剩余。
- 份额用尽就 `windowCompleted = false`，整窗不记进度、跳出窗口循环；下批重新从心率开始。
- 新握手预算为 12,000 条，窗口份额为 3,000 条；合成 1,500 条心率 + 1,500 条距离连续三轮都只输出 `[1500,1500]`，后续类型仍未访问。旧保守份额只有 1,125 条，风险更明显。
- 同一窗口会占住最早到期位置，后面的窗口也可能被挡住。7 天过期判断只在 `afterPass` 内；整窗一直跑不完时，过期结算同样走不到。

**这不是“再点几次一定会好”的分批，而是缺少可收敛进度的重复读取。** 其它 anchored 通道可能最终补上，但不能用它们兜底来宣称本通道已完成。

**优化**：持久化 `(scope,workoutUUID,type)` 的分页状态、已交付页/EOF、内容摘要和调度位置；每页成功后可恢复推进，类型/训练间公平调度。分页必须处理相同时间戳的多个 UUID，不能简单“最早时刻减一秒”。过期应在选择窗口前处理，不能依赖一次整窗成功。

### A3 · P1：总条数两次不变就关闭窗口，部分数据会被误判为齐全

**证据 R + C**

位置：`RouteSyncState.swift:626-645`；重新登记分支 `:564-568`。

`afterPass` 只接收一个总数：前次观察过、当前总数大于 0 且相同，就累计稳定；第二次即可关闭。

本轮实调生产函数：

```text
第 1 次：只有心率 500 条，其余类型全部 0
15 分钟后第 2 次：仍只有心率 500 条
结果：completed = true
稍后相同起止时间的 workout 再登记：仍保持 completed
```

两次相同的**部分样本**既不证明缺失类型已提供，也不证明已有样本内容/覆盖没有变化。HealthKit 新增 quantity 样本又不一定改变 workout 的起止时间。

**优化**：按类型记录可读状态、已见 UUID/内容摘要、页是否读尽、覆盖时段。缺失类型维持未知/待补，不靠其它类型的正数“代为完成”。稳定可以用于降频，不能直接等同“完整”；新类型事件/内容变化应能有界重开相应类型。

### A4 · P1：补齐窗口没有接入统一待办探针，登记了重试时间却不保证有人执行

**证据 C**

- `probePendingWork` 只组合任务、通知、恢复请求和 `sync_continuation`：`HealthKitSync.swift:823-869`。
- `needsAnotherRound` 也只有这四类：`HealthSyncBackgroundRecovery.swift:105-116`。
- `AppDelegate` 根据该快照决定前台补跑与后台重排：`:114-153, 288-302`。
- 补齐窗口独立存在 `sync_pending_workout_windows`，但没有成为上述待办条件；窗口份额耗尽也不写独立续批原因。

当普通 anchor 已读尽、旧通知已确认、没有在途批次时，即使刚登记了窗口或窗口已到期，探针也可以返回“没有下一轮”。**定时字段不等于已经注册可执行的任务**；需要用户再点或等另一条通知。

**优化**：待办快照加入 `dueWorkoutTypes`、`nextWorkoutCheckAt`、预算截断的窗口页；前台把“当前已可读、尚未交付的页”自动读完，未来的补查时间通过既有 BGProcessingTask 重排，不新增后台机制、不把未来待办变成即时死循环。

### A5 · P2：`complete` 只看 24h 安静和分析已发布，不代表时序完整

**证据 R + C**

位置：`/Users/ta/running/apps/api/src/data.ts:1940-1960`。

实调 `RaiReadStore.workoutFreshness` 的合成结果：

```json
{
  "completeness": "complete",
  "power": {"samples": 0, "state": "not_seen_yet"}
}
```

服务端没有手机本次读取的类型/分页证明；“没有新批次”也可能是没有再同步、无权限或 A4。反过来，所有当前可读数据已交付的最新训练仍强制 `partial` 24h，与用户理解的“同步完成”不一致。

此外 `SyncPresentationPolicy.swift:163-165` 把服务端 0 条直接解释为“Apple Watch 仍在传输”，证据不足：数据也可能已在手机但尚未导出、被预算跳过或没有读取授权。

**优化**：分离 `deliveryState`（本次已读取数据是否全部交付）、`analysisState`（是否覆盖最新依赖代次）、`stabilityState`（观测是否稳定）、逐类型覆盖/未知原因。24h 安静可叫“稳定观测”，不能叫完整；未知原因不要直接归咎 Watch。

### A6 · P2：旧分析存在时，较新分析任务仍排队/失败也会显示 published

**证据 R + C**

位置：`workout-read-repository.ts:558-572`。

当前逻辑只要找到 active model 的评估行，就优先返回 `published`，不检查它覆盖了哪次训练事实变化。

实调合成场景：旧评估已发布，再插入该训练窗口的新事实账本和较新的 queued 分析任务。结果：

```text
jobId = audit_new_job（这条确实 queued）
analysis.status = published
publishedAt = 旧模型激活时刻
```

**优化**：以最新影响该训练的依赖代次/输入指纹，对比已发布结果覆盖范围；允许展示旧分析，但标记“旧分析可用，新分析排队/运行/失败”。不能以历史评估行是否存在代替新鲜度。

### A7 · P1（独立的数据安全风险）：按 MAX 时间推断历史完整，可能永久跳过空洞

**证据 R + C；不是本次最新训练缺失的已证实原因。**

- 服务端覆盖表只返回 `MIN(start_at),MAX(end_at),COUNT(*)`，源码明确说明“不证明区间无空洞”：`workout-read-repository.ts:685-723`。
- iOS 只要 `sampleCount > 0`，就把历史起点抬到 `knownUntil−24h`：`HealthKitRecordCursor.swift:473-487`；该下界随后粘在正常增量查询上。
- 生产纯函数复现：服务端只有一条今日功率样本，也足以得出“昨日”下界；手机中漏传的 10 天前功率样本被排除。未来补录/更正、权限扩大的旧样本也有同类风险。

代码注释已承认跳过区间删除事件的代价，但问题**不止删除**：MAX 点不证明旧区间的记录曾经交付。不能用此优化给“历史已覆盖”背书。

**优化**：最新训练快车道与历史纠错车道分离；覆盖点仅用于优先级，不直接当跳过授权。若要真正跳过历史，需设备/类型/数据集作用域的交付账本、可核对区间或分块 UUID/内容摘要。已有带谓词 anchor 不能直接去掉谓词后继续用；迁移方案需独立无日期过滤的变更流/受控重建与删除测试。

### A8 · P2：observer 在持久登记前完成确认，存在丢失唤醒窗口

**证据 C + Apple 官方完成回调合同**

位置：`HealthKitSync.swift:602-613`。

当前先 `completion()`，再通过异步 MainActor Task 进入 `recordBackgroundIntent`。若系统在两者之间挂起/结束进程，HealthKit 已收到完成确认，本地却没有该次变化的持久待办。这里还丢弃了 observer 的 error。

Apple 官方说明是在处理新数据后调用 completion，而不是要求 completion 必须早于任何 Task。没有必要在回调里等待整套导出上传，但需要先完成可靠的短交接。

**优化**：每次回调在短时限内先写入可恢复的意图/代次，再恰好调用一次 completion；错误分支记录分类并保持可恢复性。不要让 completion 等几十秒导出，也不要以“永远第一个调用”掩盖持久化窗口。

另：当前后台订阅为 `.hourly`（`:625-629`），加上 BGProcessingTask 的系统调度，设计本身不是实时后台承诺。手动前台同步应立即运行；后台改成更及时的频率只能改善机会，不能保证系统立即唤醒，需真机测量耗电与投递行为。

## 4. 本轮验证

日志与探针位于 `/Users/ta/running/output/ios-sync-audit-2026-10-19/`，未向产品代码添加临时测试。

| 检查 | 结果 |
|---|---|
| API 可见性/导入诊断/分析故障隔离定向套件，`--test-concurrency=2` | 11 通过，0 失败 |
| direct-sync 入库/分析登记/对账 + 解析身份/未变轻路径/调用方事务，`--test-concurrency=2` | 63 通过，0 失败 |
| Swift 三个审查探针 | 3 个边界复现：部分稳定收口、窗口前缀饿死模型、稀疏覆盖下界 |
| API 两个审查探针，`--test-concurrency=1` | 2 个边界复现：缺指标仍 complete、旧分析掩盖新 queued |
| `npm run test:ios` | 通过：95 个 iOS 文件类型检查 + 纯逻辑/结构回归；3 个仅依赖高德 SDK 的文件按脚本跳过 |
| `npm run typecheck` | 通过 |
| `npm run check:docs` | 通过，0 问题 |
| `npm run check:doc-refs` | 143 处，0 越界/无法解析；无基线，内容漂移未核对；2 处空行锚告警 |
| `git diff --check` | 通过 |
| 真机 HealthKit、锁屏与后台恢复 | 未执行 |
| 生产 DB / nginx / journal / 发布版本核验 | SSH 认证前断开，未执行 |
| 全量 `npm test` / Simulator 视觉 | 未执行；本轮为审查，不作发布验收 |

探针说明：复现测试断言的是**当前错误/危险输出确实存在**；测试通过不等于该行为正确。没有将合成样本数量写成用户真实记录数量。

复现命令（在 `/Users/ta/running` 运行）：

```bash
node --import tsx --test --test-concurrency=2 apps/api/test/workout-visibility-freshness.test.ts apps/api/test/native-import-worker.test.ts apps/api/test/import-worker-diagnostics.test.ts apps/api/test/analysis-failure-isolation.test.ts
node --import tsx --test --test-concurrency=2 apps/api/test/direct-sync-ingest.test.ts apps/api/test/direct-sync-analysis-registration.test.ts apps/api/test/direct-sync-analysis-reconcile.test.ts packages/health-export-parser/test/healthkit-record-sync.test.ts packages/health-export-parser/test/record-unchanged-fast-path.test.ts packages/health-export-parser/test/caller-owned-transaction.test.ts
xcrun swiftc -parse-as-library -disable-sandbox apps/ios/RAI/APIModels.swift apps/ios/RAI/DirectSyncBatchBudget.swift apps/ios/RAI/RouteSyncState.swift apps/ios/RAI/HealthKitRecordCursor.swift output/ios-sync-audit-2026-10-19/SyncAuditProbes.swift -o /tmp/rai-sync-audit-probes
/tmp/rai-sync-audit-probes
node --import tsx --test --test-concurrency=1 --test-name-pattern='AUDIT REPRO' output/ios-sync-audit-2026-10-19/freshness-probes.test.ts
```

审查探针和日志为本机 `output/` 中的临时证据，不是正式产品回归或已提交的发布工件。

## 5. 优化方案：从“单批成功”变成“训练级一次操作交付”

### 第一步：先修交付闭环（优先实施）

1. **最新训练快车道**：发现新的/变更 workout 后，本批合并其窗口并优先读取全部相关类型及路线。优先关联 workout 的样本查询；对未显式关联的样本保留有来源约束的时间窗兜底，不能因只用关联谓词漏读。
2. **可收敛分片**：按 `(workoutUUID,type,page)` 持久化进度，预算不足只暂停当前页，不重读已确认的前缀。新训练优先但保留历史最低份额；不要仅把所有预算调大。
3. **一次用户操作自动续批**：允许一次操作有多次上传/事务，内部自动接续，直到本次目标训练所有当前可读页均有持久交付回执。不要把用户再次点击当作分页触发器。
4. **补齐待办接入统一调度**：当前可读未交付与未来迟到检查分开；前者自动续批，后者走已有后台机制，明确系统调度不可保证的边界。
5. **逐类型状态替代总数收口**：样本数相同仅用于降频；缺失类型、截断页、权限未知、过期退出均有可见原因。新样本事件能重开相关类型，保留首次登记的绝对期限。

### 第二步：补齐回执与读取合同

建议兼容扩展 manifest/receipt（设计建议，不是当前已实现字段）：

```text
workoutUUID + datasetEpoch + clientBatchId
各类型：
  queryWindow / readAttempted / readErrorCategory
  observedCount / sentUniqueCount / pageComplete
  pageToken / contentDigest / queriedAt
服务端：
  committedCounts / acknowledgedPages
  rawGeneration / dependencyGeneration
  analysisTarget / publishedCoverage
```

- 服务器只确认确实收到并持久提交的页，不替手机猜“HealthKit 全部到了”。
- 不把 `readAttempted && 0` 解释为已授权或设备不支持；只读授权状态具有不确定性。
- 详情区分：**本次已读取数据已交付**、**仍有未交付页**、**尚未观察到某指标**、**分析更新中/失败**。
- 分析覆盖最新依赖代次后，重取当前详情、series、freshness；后台算完而没有新 iOS 同步代次时，也应有有界的分析状态对账/前台恢复刷新。
- `available_at` 只证明服务端可得时刻，不能证明手机首次可读时刻。需补 `queriedAt`、按类型计数和跳过原因，才能区分“未读到/读到没发/发了没存/存了没刷”。

### 第三步：性能与历史安全

1. 保留未变记录轻路径和路线交付摘要；批内按 `(type,UUID)` 去重，减少窗口/迟到补读/anchor 同批重复占额度。
2. 分段测量 HealthKit 查询、渲染/ZIP、上传、排队、解析、身份查写、canonical、ledger、COMMIT、分析和页面刷新；服务端已有阶段账本可以接着用。
3. 对当前训练即时可读数据制定**前台端到端延迟目标**，目标值先按生产/真机基准确定，不把未经实测的 5 秒/30 秒写成承诺。
4. 历史补齐走可校验交付账本，不再用 MAX 样本时刻代替完整覆盖。先解决 A7，再继续扩大覆盖跳过优化。
5. 遵守 ADR-004：回执前不提交游标、提交前回读、保留既定产物清理顺序、配额超限不标 invalid、不改批次身份语义。

### 能承诺什么

- **应达到**：当手机 HealthKit 中数据已存在、对本 App 可读且网络/服务正常，一次前台操作自动交付最新训练的当前可读详情；大于单包上限时自动分批，不要求手工多点。
- **不能绝对承诺**：只要手表或健康 App 显示 workout，所有类型和路线已经对第三方 App 同时可读；或 App 在任意后台状态都能立即被系统唤醒。
- 对后来才变得可读的数据，应自动补齐，并如实显示未知/等待状态，而不是重复报“全部同步完成”。

## 6. 验收标准

1. 有大量历史积压时，最新 6 km 训练所有**已可读**指标不排在历史队尾。
2. 新训练首次发现就在同批读取其窗口；不依赖第二次点击。
3. 单训练超过 3,000 条、单类型超过 1,500 条仍可分页收敛；相同时间戳的多 UUID 不漏。
4. 心率先到、功率/步频/触地时间 20 分钟后才到：不提前“完整”，新样本自动重开相应类型。
5. 窗口份额连续耗尽，后续类型和其它训练仍有进展；到期退出有明确原因。
6. anchor 已追平但窗口待补时，探针仍能发现并安排后续检查。
7. COMMIT 前/后断网、上传中杀进程、锁屏中断：续接原批次，不丢页、不重复业务事实、不提前推进锚。
8. 原始事实已入库、分析延迟：列表详情可见，原始时序可读，分析状态正确。
9. 旧评估 + 新 queued/failed 分析：不能直接显示“分析已是最新”；无新同步代次也能接回分析终态。
10. `complete` 必须有本次交付/类型证据；不能因 24h 未同步而变完整。
11. 覆盖区间中间有洞、迟到旧样本、旧样本更正/删除、权限扩大：不因 MAX 时间下界永久跳过。
12. 真实 iPhone 对齐每类型“首次可读→导出→上传→提交→series→当前页面”的时间线。Simulator/纯逻辑门禁不能代替此项。

## 7. 生产取证待办与只读探针

脚本：`/Users/ta/running/output/ios-sync-audit-2026-10-19/production-readonly-probe.py`。

在核对真实数据库路径后执行：

```bash
python3 production-readonly-probe.py --database /实际路径/rai.sqlite --day 2026-10-18
```

脚本使用 SQLite `mode=ro` + `query_only`，每条 SQL 五秒执行预算；只输出目标日期训练概况、每类型条数/时段、批次和分析状态，不输出健康样本值、metadata、精确 GPS 或凭证。不做迁移、checkpoint、完整性扫描或整库备份。历史 schema 不兼容会明确报不可查询，不应临时对生产库迁移来让探针通过。

接通后还需核实：

- 服务实际 `WorkingDirectory`、运行 commit 与 iOS 安装构建版本；当前本地修复不代表线上/手机已更新。
- 2026-10-18 20:20—20:45（UTC 12:20—12:45）及后续同步的 nginx 请求、API journal、runtime import job 的 `performance_json`。
- 目标训练的 `import_entity_changes`、`import_batches`、`health_records.available_at`、`import_generations`、`recompute_jobs` 和 active 模型覆盖。
- iPhone 的 ExportChannelCounts、各类型查询计数/错误、同步 SQLite 的窗口/任务/游标/续批状态。服务器单独不能证明手机 HealthKit 当时的可读性。
- 若上传目录已清理，明确记为证据缺失，不把“找不到旧 XML”解释为当时没有导出。

## 8. 官方合同核对

已读取 Apple 官方文档。关键点：observer 通知不是变更内容，需要再查询；后台频率是投递上限，系统不保证立即执行；完成回调应在新数据处理/可靠交接之后；workout 与路线可能分阶段出现、路线还会更新。

官方来源（原始地址）：

```text
https://developer.apple.com/documentation/healthkit/executing-observer-queries
https://developer.apple.com/documentation/healthkit/hkobserverquerycompletionhandler
https://developer.apple.com/documentation/healthkit/reading-route-data
```

这些合同不能替代用户手机的真实 HealthKit 查询证据，也没有承诺 workout 和所有时序类型原子可见。
