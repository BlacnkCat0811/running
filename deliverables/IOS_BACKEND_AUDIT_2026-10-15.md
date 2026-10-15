# RAI iOS 端后端功能审查报告 · 2026-10-15

> 审查对象：**iOS 端全部后端功能** —— 原生 iOS App（`apps/ios`，SwiftUI 生产路径）与服务端 API 的完整交互面：
> 同步/上传/导入链、全部展示型读取端点、训练计划·教练·命令写路径、连接·鉴权·安全、写路由登记与门禁可信度。
> 基线 commit：`e2344dc`（工作区含 4 个未提交文件：`apps/api/src/import-worker.ts` / `apps/api/test/worker.test.ts` /
> `packages/api-contracts/src/index.ts` / `deliverables/SYNC_DATA_PIPELINE_AUDIT_2026-10-15.md`，审查以工作区现状为准）。
> 方法：**4 路子智能体并行只读审查**（A 同步链剩余面 / B 读取契约 / C 计划教练写路径 / D 连接鉴权安全）
> ＋ 主智能体**逐条抽样复核**（全部 🔴 与重点 🟡 亲验到 `文件:行号`）＋ 门禁实跑。**全程只读，零代码改动**（仅新增本文档与索引）。
>
> 与同日既有报告的关系：`deliverables/SYNC_DATA_PIPELINE_AUDIT_2026-10-15.md`（同步管线主体）与
> `INGEST_PERSIST_CHAIN_REVIEW_2026-10-15.md`（导入落库）已覆盖的部分**不重复复述**；A 切片专门先读两份报告再找缺口，
> 本文只报**新增 / 补充 / 推翻**项。

---

## 一、总结论

**健康度：🟡 中偏上。无 P0；🔴×1、🟡×19、🔡×19。**

四路审查一致确认：iOS↔服务端的**主干契约（字段集、枚举、单位、鉴权头、路由登记、同步状态机）没有结构性错配**——
12 个展示端点三方对齐、11 条写端点全部正确归表、同步链主体（含昨今两批修复）读码正确。新发现集中在四类"接缝"：
① **终局答复的清算语义**（🔴-1：计划发布账目在 `expired`/`scopeMismatch` 下无法清除）；
② **失败态的可区分性**（解码失败被折叠成"离线"、回执终局拒绝无作废分支、截断原因不上屏）；
③ **演示/观测缺口**（share-card note 错报、全失败文案分母错、Web 手动上传无幂等头）；
④ **门禁与夹具的可信度**（地板余量 15 条、脚本锚点潜伏 bug、夹具用域外枚举值）。

| 维度 | 评级 | 一句话 |
| --- | --- | --- |
| A · 同步上传链（iOS↔imports） | 🟡 | 主体正确（与两份既有报告一致）；白名单失默、inspect 未知 400 无保险丝、P2c 可观测未落地 |
| B · 读取契约（12 个 GET 端点） | 🟡 | 字段/枚举/单位/日期逐项对齐（12/12）；但解码失败与空态/离线的区分度不足，7 端点零解码测试 |
| C · 计划·教练·命令·手表写路径 | 🔴→🟡 | **1 条 🔴（发布账目楔死）**；回执/反馈的"终局拒绝"类处置不完整；幂等主干正确 |
| D · 连接·鉴权·安全·路由登记 | 🟡 | 登记对账全对（11/11）；加固项 2 条（非常量时间比较、release 发现恒不可用）；token 无泄漏 |
| 门禁与测试可信度 | 🟡 | 本次实跑全绿；但发现 1 处地板余量、1 处潜伏锚点 bug、1 族夹具域外值（详见各条） |

---

## 二、质量门禁实跑（主智能体独立实跑，串行独占）

| 门禁 | 结果 | 证据（日志，均在 `.workbuddy/runlogs/`） |
| --- | --- | --- |
| `npm run test:ios` | ✅ **EXIT=0**（6m46s） | `ios-audit-20261015-test-ios.log`：类型检查 **93** 文件（跳 3 个高德依赖）；`Background capability checks: 288 checks, 0 failed`；Technology presentation **200**；direct-sync 三支 **55 / 15 / 43** 全过；Export determinism 14/0；存储 101；计划调度 74；展示闭集 14 映射全命中 |
| `npm run typecheck`（双 tsconfig） | ✅ **EXIT=0** | `ios-audit-20261015-typecheck.log` |
| 定向 · 未提交改动的 worker 用例 | ✅ 1 test / 1 pass / 0 fail，**EXIT=0** | `ios-audit-20261015-worker-performance.log`（`--test-name-pattern "退役键"`） |
| 定向 · 路由登记**运行时**测试 | ✅ 1 test / 1 pass / 0 fail，**EXIT=0**（`RAI_ROUTE_DUMP` 真实挂载表对账） | `ios-audit-20261015-route-registry.log` |
| `npm test`（全量，默认并发） | ⛔ **中止（口径不可信）**：runner 自身文档（`scripts/run-tests.mjs:42-61`）以实测定性"默认并发 ⇒ 全量红、单跑绿"（5s/30s 墙钟预算被六路重文件重叠击穿），并给出验收口径 = `RAI_TEST_CONCURRENCY=2`；本次默认并发运行 24m33s 后主动终止 | `ios-audit-20261015-npm-test.log`（截断） |
| 定向 · `worker.test.ts` **全文件**（未提交改动的主要影响面，独占单跑） | ✅ **95 tests / 94 pass / 0 fail / 1 skip**（设计性 skip），**EXIT=0**（198s） | `ios-audit-20261015-worker-full.log` |

> 环境记录：以上均**串行独占**运行，未出现此前记录的资源型失真（无 SIGKILL、无 60s 启动超时）。`test:ios` 的 288 条结构判据
> 与今日早先记录（284/288）一致，可作跨轮对照。

---

## 三、分级问题清单

### 🔴-1 · 计划发布账目在"终局答复"下无法清除 ⇒ 同 scope 全部计划写与手表排期被**永久楔死**

- **位置**：客户端 `apps/ios/RAI/NativeAppModel.swift:1278-1301`（`resolvePendingPublication`）、`:1303-1340`（`resolvePlanPublication` catch）、
  `:1246-1250`（发布守卫）、`apps/ios/RAI/CacheStore.swift:269-276`（账目读写在 `app_metadata`）vs `:373-378`（`clear` 只删 `cache_entries`）；
  服务端 `apps/api/src/mobile-goals.ts:255/260`（`scopeMismatch` / `expired` 两个终局状态确实会被返回）。
- **证据（主智能体已逐行亲验）**：
  - `resolvePendingPublication` 只对 **notFound→重放后的 4xx** 清账（`:1290-1295`）；`scopeMismatch` 抛 409（`:1285-1287`）、`expired` 抛 410（`:1297-1299`）、
    未知状态抛 decoding（`:1300`）——**三者都不清账**；顶层 catch 仅返回文案（`:1339`）。
  - 全仓 `savePublication(` 的**全部**清除点只有 3 处：`:1265`（重放 4xx 分支）、`:1272-1276`（成功后 `finishPlanPublication`）、`:1292`。终局答复不经过其中任何一处。
  - 楔死机理：`publishPlan` 守卫 `:1246-1250` 在账目非空时抛 `plan_publication_pending`(409) ⇒ goals/lock/coach/confirm/coach-loop **全部发布被本地拒绝**；
    `beginPlanSync` 同样被拒 ⇒ 手表排期冻结。"清除缓存"走 `cache.clear(scope:)` 只删 `cache_entries`（`:373-378`），**碰不到 `app_metadata`** ⇒ UI 无出口
    （换服务端再换回同一 scope，账目行仍在）。
- **触发条件（已核实为真实可达）**：操作行 90 天保留期过期后用户点「确认上次发布结果」→ 服务端 `expired`（`mobile-goals.ts:280` 同语义）；或 handshake 未刷新期间触发 `scopeMismatch`；或未来服务端新增第三个终局状态（跨端裸字符串，无契约守卫）。
- **建议方向**：把「该答复是否终局 ⇒ 作废本地账目」收敛成**一个判据函数**（与 F2 的回执终局码共用），至少覆盖 `plan_operation_expired`／`plan_operation_scope_mismatch`／`plan_operation_key_conflict`；
  或给 UI 一个显式「放弃原操作」入口。**验收**：注入 `expired` 响应 ⇒ 账目被清、后续发布可通过、`hasPendingPlanPublication` 归假；并补一条把 `:1297` 分支突变到红的守卫。
  **回滚**：仅客户端分支变更，`git revert` 单提交即回原行为。
- **复核状态**：【已亲验】两侧代码路径与服务端状态产出；**未实跑**端到端（需构造 90 天过期行或 scope 漂移夹具，建议按上述验收补测试）。

### 🟡-A · 同步上传链（A 切片，7 条）

#### 🟡-A1 · `schemas.ts` 响应描述与公开白名单漂移：缺 `lane`、`stagesMs` 枚举缺 `directSyncApply`
- **位置**：`apps/api/src/schemas.ts:687-705`（`importJobResponseSchema.performance`，`additionalProperties: false`）。
- **证据**：属性表只有 `validationMode/totalMs/computeStagesMs/stagesMs`（`:691-704`）——**没有 `lane`**，而 `lane` 是白名单显式保留的公开键
  （`import-worker.ts:1794`，未提交改动）；`:699-700` 的阶段枚举列 11 个，缺 `ImportStage` 里的 `directSyncApply`（`packages/api-contracts/src/index.ts:617`）。
- **影响**：纯文档/契约层漂移，**当前无运行时影响**（该 schema 只在 OpenAPI 组件里被引用；运行时无 response 校验层）。一旦有人按 OpenAPI 生成客户端或开校验，`lane` 会被判非法。
- **建议**：补齐两处，并加一条「枚举全集 == `ImportStage`」断言。**复核**：【已亲验】。

#### 🟡-A2 · `publicPerformance` 白名单是"失默型"契约：新增公开键会静默丢失
- **位置**：`apps/api/src/import-worker.ts:1788-1796`；测试 `apps/api/test/worker.test.ts:2345-2393`（未提交）。
- **证据**：白名单逐键显式列（`validationMode/totalMs/stagesMs/computeStagesMs?/lane?`），函数 doc 自述"新增公开键必须显式加进来"，
  但**没有任何测试/门禁**阻止"加了公开键却忘加白名单"——本轮新测试只覆盖"剥退役键 + 保留在用键"。
- **影响**：未来新增观测键（例如"本批被截断原因"落进 performance）时响应静默缺键、测试全绿。
- **建议**：加一条断言「白名单键集 == `ImportJobPerformance` 键集（含可选键）」；落地前此条保持待办。**复核**：【已亲验】（含 grep 消费面：`computeProcessMaxRssKiB` 全仓仅注释/测试命中，iOS 不解析 `performance`）。**未提交改动主体正确**。

#### 🟡-A3 · inspect 的"未知 400"仍落 `.keepTask`——第三次同构活锁的保险丝缺失
- **位置**：`apps/ios/RAI/HealthSyncCancellation.swift:73-81`（`disposition` 默认 `.keepTask`）；回归把「裸 400 → keepTask」钉成期望（`HealthSyncResumeRegression.swift:97-100`）。
- **证据**：当前服务端 inspect 的 400 出口只有 `direct_sync_payload_exceeds_bounds`（`import-routes.ts:110` → `laneRefusalFailure`）与 `direct_sync_input_not_allowed` 两族，**均已被处置** ⇒ 现状不可复现；
  但 code 是跨端裸字符串——服务端**新增第三个确定性 400 code 或改名**时，客户端会与 2026-09-22（404）、2026-10-14（400）**同构地再次活锁**（`sourceId` 留存 ⇒ `nextStep` 恒 `.inspect`）。
- **建议**：`disposition` 增补「其余确定性 4xx（非收敛类）⇒ abandon」或将「服务端 inspect 400 code 全集 ⊆ iOS 已处置集合」写进 parity 门禁。**复核**：【已亲验】（两侧代码 + 出口穷举）。

#### 🟡-A4 · `check-direct-sync-status-copy.py` 的 `settled` 锚点存在"相对/绝对坐标混用"潜伏 bug
- **位置**：`apps/ios/tests/check-direct-sync-status-copy.py:304-315`。
- **证据**：`settled_at = mark_success.find("let settled")`（相对偏移），命中后却用 `sync_code[settled_at : settled_at+300]`（绝对坐标）切片。
  当前 `let settled` 在 `HealthKitSync.swift:1588`、`markSuccess` 从 `:1697` 起 ⇒ `find` 返回 -1、走 `:306` 回退，**判据当前正确**；一旦 `markSuccess` 纳入该串即假红/假绿。
- **建议**：命中后改用同一基串的偏移切片。**复核**：【已亲验】（含单点 grep `let settled` 唯一命中 :1588）。

#### 🟡-A5 · 结构门禁地板 `MIN_CHECKS=273` vs 实测打印 **288**——余量 15 条，与自述"零容忍"矛盾
- **位置**：`apps/ios/tests/check-background-capabilities.py:1989`；自述 `:1769-1777`（"按打印总数 − 1 重设"）。
- **证据**：本轮实跑打印 **288 checks / 0 failed**（门禁日志）；273 = 2026-10-11 时的"打印 − 1"，此后判据增长但地板未跟 ⇒ 静默删掉 ≤15 条判据不会触发地板。
- **建议**：按当前打印总数重设地板（打印 − 1），并在每次新增判据时同批上调。**复核**：【已亲验】（以本轮实跑值修正子智能体"284–288"的估数）。

#### 🟡-A6 · P2c（截断/收敛可观测）未落地；"P2a 留待下一批"口径已过期
- **位置**：`deliverables/DIRECT_SYNC_TAIL_PAGE_ROOT_FIX_PLAN_2026-10-14.md:139/141/407`；实现侧 `HealthKitExport.swift:50/75/559`（`budgetStopReason` 无任何 UI/日志消费点，仅折算进 continuation 语义）。
- **证据**：P2a 的 `Action.convergeBudget` + 持久化收敛档**已在**（`HealthSyncCancellation.swift:62/75`、`HealthKitSync.swift:1141-1142/1566`）——文档口径过期；P2c 要求的"这批为什么被截断"仍只能看到"同步继续转"。
- **建议**：耗尽/截断路径补一行 `report(...)`（携带 `budgetStopReason`），并把文档"留待下一批"改为已完成/已缩窄口径。**复核**：【已亲验】。

#### 🟡-A7 · Web 手动上传不带 `X-RAI-Sync-Batch` ⇒ 无幂等（非 iOS，但同属该链路能力缺口）
- **位置**：`apps/web/src/pages/DataModelPage.tsx:119-171`（只设 `authorization`，缺批次头）；全仓该头的生产写入点只有 iOS 一处（`HealthKitSync.swift:2275`）。
- **证据**：服务端缺头时 `syncBatchId=null` ⇒ 不查幂等（`import-routes.ts:47` → `import-sources.ts:341`）⇒ 同一文件重传新建多份来源。
- **建议**：Web 按文件内容算 sha256 作批次头，或明确记录"Web 手动上传不做幂等"为设计边界。**复核**：【已亲验】。

### 🟡-B · 读取契约（B 切片，6 条）

#### 🟡-B1 · `/v1/mobile/today` 四个必填字段无解码兜底（版本偏斜"炸点"）
- **位置**：`apps/ios/RAI/APIModels.swift:613-622`（`sync/coverage/recoveryAssessment/recommendation` 均非 Optional，合成解码器缺键即整份丢弃）。
- **影响**：新 App + 旧自建服务端（或未来被回滚的服务端）⇒ 整个"今日"结构解码失败 ⇒ 面板落到缓存/离线，而非「缺的新卡隐藏」。与既有"服务端与 iOS 同批进退"纪律**一致**（本仓服务端恒发这四键），风险只在纪律被违反时。
- **建议**：要么维持既定纪律并在 handshake 加"today 契约版本"能力位，要么给四键 `decodeIfPresent` + 显式 `init(from:)`。**复核**：【已亲验】字段集；「旧服务端是否真会缺」【待复核】。补充事实：iOS 主路径现由 `/v1/mobile/training-plan-state` 承载（`TrainingPlanRepository.swift:39-43`，需服务端未宣告 `planSnapshotContractVersion` 才走 today 三件套）。

#### 🟡-B2 · 解码失败被折叠成"离线"——契约漂移不可诊断
- **位置**：`apps/ios/RAI/NativeAppModel.swift:289-311`（`try?` ⇒ `anySucceeded` ⇒ `isOffline = !anySucceeded`）。
- **影响**：服务端改名/改型 ⇒ 各面板 `try?` 变 nil ⇒ 横幅显示"离线缓存"（`TechViews.swift:1086/1112`）⇒ 用户的网络明明好着。仅 plan 面板能区分（`TrainingPlanRepository.swift:64` 把 `.decoding`→`contractMismatch`）。
- **建议**：把 `RaiAPIClientError.decoding` 与网络错误分开计数，文案区分「数据版本不兼容」与「连接失败」。**复核**：【已亲验】。

#### 🟡-B3 · `failedPanels == 4` 是死分支 ⇒ 全失败时文案与事实相反
- **位置**：`apps/ios/RAI/NativeAppModel.swift:292-320`；`failedPanels` 最大值为 3（plan/statistics/trends；`workoutsSucceeded` 未计入），`:317` 却比较 `== 4`。
- **影响**：四面板全失败（含 B2 的契约漂移场景）时显示"有 3 项数据未能更新，其余已刷新"——**与事实相反**。
- **建议**：把 workouts 计入分母或改判据；补一条钉住分母的断言。**复核**：【已亲验】。

#### 🟡-B4 · share-card：无轨迹跑步被报成"未配置隐私区：卡片显示完整轨迹"
- **位置**：`apps/api/src/data.ts:1918-1924`（先判 `zonesApplied === 0`）+ `share-card.ts:146-148`（无点早退，`zonesApplied = usableZones.length`）；iOS `TechShareCardView.swift:113-115`（无 ≥2 点折线时直接采用 `note` 作为错误文案）。
- **影响**：室内跑/无 GPS 且未配隐私区 ⇒ note 声称"卡片显示完整轨迹"，而 iOS 兜底文案"本次训练暂无可分享的 GPS 路线"**永不生效**。
- **建议**：`polylines.isEmpty` 的判定提前；note 由"为什么没有路线"决定。**复核**：【已亲验】两侧。

#### 🟡-B5 · `zonesApplied` 语义 = "已配置且合法的隐私区个数"，非法配置被过滤后宣称"未配置"
- **位置**：`share-card.ts:236`（`usableZones.length`）、`:140-145`（过滤非法区）；`data.ts:1933`（`unfiltered: zonesApplied === 0`）。
- **影响**：用户配置过隐私区但全被过滤（半径≤0、坐标越界）⇒ note/`unfiltered` 一致地宣称"未配置"——用户会以为隐私功能"关着"，且无任何 reason code。
- **建议**：区分「未配置」与「配置了但全部无效」，后者给可行动提示。**复核**：【已亲验】（线上是否存在非法区【待复核】）。

#### 🟡-B6 · `/v1/recovery-trends` 失败与"无记录"同文案，且绕过统一读取路径
- **位置**：`Skins/Technology/TechSleepHistory.swift:25/32`（`try?` 吞错 ⇒ `days` 空 ⇒ "暂无睡眠趋势"；直接 `RaiAPIClient()`，不经 `NativeAppModel` 的错误/作用域管理）。
- **建议**：区分空态与错误态，或纳入统一读取路径。**复核**：【已亲验】。

### 🟡-C · 计划·教练写路径（C 切片，4 条；🔴-1 另列）

#### 🟡-C1 · 回执"终局拒绝码"没有作废分支 ⇒ 永久"待登记"，并连带锁死教练模式启用
- **位置**：`NativeAppModel.swift:1414-1432`（catch 仅特判 `plan_receipt_scope_mismatch`，其余只记诊断）；连带守卫 `:421-424`。
- **证据**：`plan_receipt_evidence_mismatch` / `plan_receipt_contract_mismatch` / `plan_receipt_date_invalid` / `plan_receipt_key_conflict` 等均为**内容级终局**——同一份字节永远不可能通过；客户端既不作废也不告知，只提示"可前台重试"。
  `hasPendingPlanReceipts`（`:1342-1345`）恒真 ⇒ `changeCoachLoop(enable)` 永久拒绝。人工出口只剩"撤回全部排期"（语义很重且提示未写）。
- **建议**：与 🔴-1 共用"终局 ⇒ 作废并如实告知"判据；把丢弃动作落进 `plan_receipt_journal` 持久语义。**复核**：【已亲验】客户端分支；服务端各码触发构造【待复核】。

#### 🟡-C2 · 替身 `CacheStore.clear` 与真实现语义**相反**，且"发布账目不可清除"在真实现上零守卫
- **位置**：替身 `apps/ios/tests/ModelRegression.swift:58`（`clear` 会把 `publication` 一起删）vs 真实 `apps/ios/RAI/CacheStore.swift:373-378`（只删 `cache_entries`）；真实侧仅 `StoreRegression.swift:325-328` 断言"能写能读"，**没有**"clear 后仍在"。
- **影响**：发布/回执/台账**整条链路的行为回归跑在替身上**——替身给出与生产相反的绿灯；🔴-1 的"clearCache 解不开"因此**没有任何断言会变红**。
- **建议**：`StoreRegression`（真实 `CacheStore` 段）补「`savePublication` 后 `clear(scope:)` ⇒ 仍可读」；替身 `clear` 与真实语义对齐。**复核**：【已亲验】。

#### 🟡-C3 · 未登记回执在服务端不可见 ⇒ 教练层可能对"设备上已有课"再排一次
- **位置**：客户端 `PlanWatchSyncCoordinator.swift:36-41`（账本先提交、POST 最后）⇒ `NativeAppModel.swift:1397`；服务端消费点 `coach-loop-runtime.ts:202-221`（只有**已登记**的 push 才变设备预留）。
- **影响**：回执未登记（断链/被拒）期间，教练决策看不到设备占用，同日期可能重复排课；`coach_schedule_reconciliation_required` 也只看已登记 push。
- **建议**：给"设备副作用已发生但回执未登记"更硬的语义（或教练页显式声明占用未计入）。**复核**：【待复核】——两侧代码已核；"是否真的重复排课"需实跑一次教练决策才能定性，**未实跑**。

#### 🟡-C4 · `coach_scope_mismatch` 不在反馈的终局白名单 ⇒ 反馈永久卡在"重试原反馈"
- **位置**：`NativeAppModel.swift:487-499`（白名单 `:489-490` 不含该码）；服务端 `coach-loop-routes.ts:41`。
- **影响**：账目已持久化 + coachLoop 已被新 scope 覆盖的窗口内，提示用户"重试原反馈"而重试永远失败（`:470` 前置守卫只能拦住大部分情形）。
- **建议**：并入终局白名单（与 C1/🔴-1 同一判据函数）。**复核**：【已亲验】。

### 🟡-D · 连接·鉴权·安全（D 切片，2 条；路由登记对账**全绿**见 §五）

#### 🟡-D1 · token 比较非常量时间（5 处 `===`/`!==`）
- **位置**：`apps/api/src/local-request-security.ts:147`、`server.ts:1037/1046/1111/1121`（主智能体 5/5 处亲验）。
- **影响**：JS 字符串比较首字节短路 ⇒ 理论上的逐字符计时预言机；公网有 nginx 抖动 + `limit_req 300r/m` 掩盖。**这是加固项，不是可利用缺陷**。
- **建议**：收敛为单一 `authorized(request)` 帮助函数并改用 `crypto.timingSafeEqual`。**复核**：【已亲验】。

#### 🟡-D2 · `ServerDiscovery` 产出 `http://`，而 release 强制 `https` ⇒ 发现功能在发布构建恒不可用
- **位置**：`ServerDiscovery.swift:82-88`（`components.scheme = "http"`）vs `ServerSession.swift:106-108`（`#if !DEBUG` 下 `guard scheme == "https"`）。
- **影响**：release 下点选"发现的服务"**无任何反应**（候选被 `serverURL` 静默拒绝）；且 `resolve` 对任意 `_rai._tcp` 广告者开连接（同网段可伪装候选，仍需用户点选且 release 选不了）。
- **建议**：发现与服务端方案对齐（`_https._tcp` 或对候选试 https），或 UI 显式标注"仅开发可用"。**复核**：【已亲验】（真机 release 未实测）。

### 🔡 低风险 / 清理项（19 条，合并简表）

| # | 位置 | 内容 | 复核 |
| --- | --- | --- | --- |
| A-🔡1 | `HealthKitExport.swift:1357-1363` | `fileExists` 兜底假时单条轨迹静默不进 `entries/warnings` | 已亲验 |
| A-🔡2 | `import-worker.ts:120-131` 等 4 处 | 输入族注释少列 `payload_identity_unavailable`（折成同一 code，功能无差） | 已亲验 |
| A-🔡3 | `NOTES-ios.md:210` | 507 的 code 名记错（真值 `import_upload_capacity_exceeded`，`import-sources.ts:86-89`） | 已亲验 |
| A-🔡4 | `import-worker.ts:1790-1794` | 白名单返回浅拷贝共享引用（当前无调用方原地改） | 已亲验 |
| A-🔡5 | `HealthKitSync.swift:2846-2854` | iOS 不解析导入 job 的 `performance`（剥键对 iOS 零影响，属事实澄清） | 已亲验 |
| A-🔡6 | `SyncPhase.swift:232` vs `HealthSyncCancellation.swift:80` | upload/inspect 两套 4xx 分类表对同码异判（服务不同端点，现状无冲突，易误读） | 已亲验 |
| B-🔡1 | `apps/ios/tests/PlanTestFixtures.swift:24/25/31/34` | **夹具用契约域外取值**（`state:"missing"`、`coverage:"missing"`、`assessment:"unavailable"`、`status:"pending"`；契约闭集见 `api-contracts:1327/1352/1353/937`）；`weekStructure.remainingDistanceKm` 不在契约且被展示门禁列为 retired（`run-tech-presentation-tests.sh:199`）——回归跑在域外值上，无门禁校验夹具 | 已亲验 |
| B-🔡2 | `TechViews.swift:1126` | `nativeDate(...).isEmpty` 恒假（`nativeDate` 缺值返回 `"--"`），"暂无"死分支 | 已亲验 |
| B-🔡3 | `CacheStore.swift:97-101` vs `NativeAppModel.swift:1038-1054` | 缓存读解码失败写 `lastReadIssue` 但消费端不读 ⇒ 静默空态 | 已亲验 |
| B-🔡4 | 全端点 | 版本偏斜两方向判定：反向（旧 App+新服务端）静默降级不炸；正向仅 today 四键炸（见 B1） | 已亲验 |
| C-🔡1 | `APIClient.swift:128-130/171-173/276-282/284-290` | 四个无 operationId 的直发写方法（`runCoachCommand`/`confirmWeeklyPlan`/`updateGoals`/`lockSession`）**零调用方**——与被替换的持久发布路径并存，误用会丢幂等 | 已亲验 |
| C-🔡2 | `APIModels.swift:1280-1283` vs `server.ts:1255` | `/synced` 响应的 `informationLevel`（`legacy`/`verifiedClient`）客户端不消费，UI 文案不区分核验等级 | 已亲验 |
| C-🔡3 | `server.ts:2069` / `NativeAppModel.swift:1677-1684` / `TechWorkoutExportView.swift:69` | `command_queue_full`(429)+`Retry-After` 未使用（按可修正拒绝处理）；导出页静默丢弃过期响应 | 已亲验 |
| D-🔡1 | `server.ts:954` | `factsAnalysisViewContractVersion` 宣告但 iOS 无消费者（与设计一致，防误读） | 已亲验 |
| D-🔡2 | `APIModels.swift:7` 等 | `syncProtocolVersion` 只用于任务同一性，无"拒绝不兼容服务端"闸门 | 已亲验 |
| D-🔡3 | `AppWebView.swift:438-482` | `window.__raiToken` JS 注入仅 macOS 路径（iOS 不可达；同源限定） | 已亲验 |
| D-🔡4 | `RootView.swift:47-49` | iOS 上 `AppWebView` 编译但**从不实例化**；web ios 壳 `postNative` 已按 `hasNativeBridge()` 正确降级（**无修复动作**，防误报） | 已亲验 |
| D-🔡5 | `server.ts:1037/1111/1121` | 未配置 token 的部署下 3 端点恒 401（fail-closed，有意设计） | 已亲验 |
| D-🔡6 | `server.ts:236` vs `local-request-security.ts:3` | `unsafeMethods` 两份独立定义，当前一致但无门禁钉相等 | 已亲验 |

---

## 四、复核记录（对子智能体结论的采纳、限定与纠正）

- **全部 🔴/🟡 均已亲验**：本轮 20 条 🔴/🟡 中，19 条由主智能体逐行复核到源码（🔴-1、C1-C4、B1-B6、A1-A7、D1-D2），
  唯一未定性的 **C3** 明确标为【待复核】（需实跑教练决策，本文不采信为缺陷结论）。
- **数值性修正 1 处**：A-5 的地板余量——子智能体按历史记录估"284–288 打印、余量 11–15"；**本轮实测打印 288、余量 15**，已按实测值定稿。
- **口径性限定 3 处**：① B1（today 四键）与既有"同批进退"纪律一致，风险仅在纪律被违反时；② A3 的"未知 400"当前**不可复现**（服务端 inspect 400 出口已穷举），故降为"保险丝缺失"而非即时缺陷；
  ③ D 的"423 全仓 0 命中"经其双写法核验，本文未发现写端点被 423 拒绝的处置缺口。
- **证伪 0 条**：本轮未出现子智能体结论被推翻的情形（对照：09-12 那轮曾出现"结论反了"）。所有引文行号抽查一致。
- **反向复核 1 处**：C 切片按"终局答复"给 🔴，主智能体复核时**额外确认服务端确实会返回这两个终局状态**（`mobile-goals.ts:255/260`），并将触发条件写实（90 天过期 / scope 漂移窗口 / 未来新增状态）——结论成立，但严重度依赖触发频率，修复性价比高（单分支判据收敛）。

---

## 五、绿区（本轮读码/实跑确认无问题）

- **路由登记对账**：iOS 全部 **11 条写端点 + 4 条 ingest 裸 URLRequest 写**逐条对照 `server.ts:323-377` 三张表，**无漏登记/重复/错表**；
  `server-runtime.test.ts:1922` 的运行时对账（`RAI_ROUTE_DUMP` 真实挂载表）**实跑通过**。已知缺口：三张表只钉"成员关系"，不钉"分类语义"（无门禁，本轮人工抽查可疑项未见误分类）。
- **展示端点三方对齐**：12 个 GET 端点逐字段核对（服务端产出 ↔ Swift Codable ↔ TS 契约）**12/12 基本对齐**；单位换算（配速/步长/触地时间等）服务端实际发出的全部命中；日期/时区语义与 NOTES 判据一致（`UserDataNoticePolicy.isCurrentDay` 用服务端 timezone）。
- **同步链主体**：尾页"写前判定 + 先判后取 + route 预算闸门"读码正确且门禁有效（`check-healthkit-record-sync.py:146-153`、`check-background-capabilities.py:1581-1598`）；未提交的 performance 白名单修复**主体正确**（键集 = `ImportJobPerformance`；退役键零消费方）。
- **鉴权面无泄漏**：token 仅在 `Authorization` 头（`APIClient.swift:352-354` 等）与 macOS 专用 JS 注入（同源限定）出现；无 URL/日志/缓存泄漏；上传通道 `RaiSameOrigin` 单一判据（`APIClient.swift:12-59`）覆盖前台上传 + 后台上传。
- **幂等主干**：`X-RAI-Sync-Batch` 在 iOS 全部上传路径携带（含后台续传重建路径）；服务端幂等命中语义有验收测试（`direct-sync-http-acceptance.test.ts:688`）。

---

## 六、行动建议（按优先级）

| 优先级 | 动作 | 验收标准 | 回滚 |
| --- | --- | --- | --- |
| P1 | 🔴-1 + C1 + C4 合并修复：终局答复/终局拒绝码统一"作废本地账目/回执"判据 | 注入 `expired`/`scopeMismatch`/`*_mismatch` 各一次 ⇒ 账目清、后续发布放行；对应断言可突变到红 | 单提交 `git revert` |
| P2 | C2：`StoreRegression` 补真实现「clear 后 publication 仍在」+ 替身语义对齐 | 新断言在"替身式 clear"突变下变红 | 测试文件 revert |
| P2 | A5：门禁地板重设为 288−1；A4：锚点切片修正 | 删任一条判据 ⇒ 地板转红；锚点 bug 用假想重组单测 | 单文件 revert |
| P2 | B2/B3：解码失败与离线分流、全失败文案分母修正 | 4 端点返回 200+坏结构 ⇒ 文案为"数据版本不兼容"；全失败文案为 4 项 | 客户端单提交 revert |
| P3 | A1/A2：补 `schemas.ts` 两处 + 键集断言；A6：截断原因落一行日志 | 枚举全集断言可突变红；日志含 `budgetStopReason` | 单提交 revert |
| P3 | B4/B5：share-card note 优先判"无轨迹"；区分"未配置/配置无效"；B6/D2 文案与发现方案 | 三个场景各一条用例 | revert |
| P3 | A3：未知 400 保险丝（或 parity 门禁钉 code 全集） | 注入未知 code ⇒ 清任务重导 | revert |

> 未提交改动（performance 白名单）建议**补上 A1/A2 两处**后再提交，避免"公开键与响应描述"继续漂移。

---

## 七、未覆盖范围声明

- **真机终审**：BGTask 后台同步、后台 URLSession 续传、锁屏/被系统回收、`budgetWatchdog` 两个相反失败模式（`NOTES-ios.md` ⏸ 条目）、冷启动后台一轮——均需真机，**本机沙箱无法验证**；`handleEnterBackground:295` 的冷启动 `restoreBackgroundContext` 遗留仍未接入。
- **线上环境未查**：本轮未连线上库/nginx 日志（只读代码与本地门禁）；A7/D2 的线上实况、C3 的"重复排课"需线上或实跑验证。
- **未跑**：`npm run test:e2e:web`（本轮范围不需要）；全量突变 harness（`test:ios:mutation`，约 10–12 min、会改写源码，属"验收时跑一次"）；`npm test` 全量未按**可验收口径**跑（默认并发被 runner 文档定性为假失败高发；如需全量验收，用 `RAI_TEST_CONCURRENCY=2 npm test` 独占跑）；web vitest 未单跑（不在本范围，已随中止的全量运行一并跳过）。
- **未逐一覆盖**：C 切片对服务端 14 条写路由的**分类语义**只做了可疑项人工抽查（成员关系已全量对账）；Web/桌面路径仅在与 iOS 交互面相关时被查看。

---

_方法注明：4 路子智能体（Agent A/B/C/D）全程只读；主智能体对全部 🔴/🟡 逐条亲验并修正数值与口径；探针与日志只写 `.workbuddy/runlogs/` 与 `/tmp`，仓库业务代码零改动。_
