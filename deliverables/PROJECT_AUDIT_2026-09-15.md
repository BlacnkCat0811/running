# RAI 项目完整审查报告 · 2026-09-15

> **范围（按小唐指令）**：后端（`packages/` + `apps/api/`）+ iOS（`apps/ios`）。Web 只跑门禁联动，不做深审。
> **基线**：工作树干净，`main` = `origin/main` = **`f588e0a`**；对比上轮 `deliverables/PROJECT_AUDIT_2026-09-12.md`（基线 `8d74a24`）与 `deliverables/FIXES_2026-09-13-REVIEW.md`，代码增量 **18 个 commit**（分段权威顺序改造、导入回滚点、WorkoutKit 上表、reasoning 截断修复等）。
> **方法**：门禁全量实跑 → 两路子代理找线索 → **主审逐条实测复核**（含 3 个探针：fallback 量控、`json_each` 行为、真实库只读副本）→ 反向纠偏。
> 探针置于 `/tmp` 并已删除；审查未改任何业务代码，真实库仅以只读副本查询。

---

## 一、总结论（先行）

**健康度：A−（本轮无 P0，上轮遗留项全部实测闭环；新发现集中在 WorkoutKit 上表链的回执一致性与分段解析的时钟漂移容差）**

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟢 绿 | typecheck / node:test 603 / vitest 84 / build / iOS 双脚本 **全绿实跑** |
| 上轮遗留闭环 | 🟢 绿 | 09-12 P0×2 + P1×2、09-13 残留 🟡×2 **全部真修**（探针级复测） |
| 分段解析链 | 🟡 黄 | 新分段权威顺序总体正确，但**负偏移步被静默丢弃**可致标签错位 |
| WorkoutKit 上表链 | 🟡 黄 | **回执集合 ⊇ 实际上表集合**；全映射失败时文案误报 |
| API 鉴权/路由 | 🟢 绿 | 17 写端点登记齐全，token 分支已有 8 个用例覆盖 |
| 数据层/SQL | 🟢 绿 | 无现实注入；一处防御性 `json_each` 隐患（当前 0 行命中） |
| 仓库卫生 | 🟢 绿 | 4~5MB 设计图已出库（最大残留 1.43MB） |

**一句话**：过去四天的修复质量是实的——我用探针逐条复测都成立；本轮最有价值的发现是 **iOS 客户端向服务端登记的「已上表回执」可能多于手表真正接收的课表**，以及上上轮验收过的「已完成标注」共享分类器在 week strip 重写时被静默降级成了两份皮肤各自复制。

---

## 二、质量门禁实跑（全部本次实测，非引用）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | ✅ EXIT=0 | pure + full 双 tsconfig |
| node:test（全量） | ✅ **603 项 / 600 pass / 3 skip / 0 fail** | 51s |
| vitest（web，联动） | ✅ **13 文件 / 84 pass** | 18.8s |
| `npm run build` | ✅ EXIT=0 | `✓ built in 9.76s`（先移 dist 绕沙箱护栏） |
| `apps/ios/tests/run-model-tests.sh` | ✅ 全绿 | 含课表映射 55+ 断言 |
| `apps/ios/tests/typecheck-ios.sh` | ✅ **EXIT=0 / 36 文件** | 与 09-13 结果一致（09-12 的失败确系环境抖动） |
| `npm run test:e2e:web` | ⚠️ **未验证** | 本机无 Chrome/Edge（环境限制，如实声明） |

---

## 三、上轮遗留项闭环核验（探针级复测，不引用旧 ✅）

| 上轮项 | 现状 | 复测证据 |
|---|---|---|
| **09-12 P0-1** fallback 小目标超 3.6~5.8 倍 | ✅ **真修** | 探针实测（`buildFallbackWeekPlan`，7 天窗口，qualitySessionCap=2）：goal=5 → stored 4.90 / measured 4.94（0.98×）；goal=8 → 7.70（0.96×）；goal=15 → 14.80（0.99×）；goal=30/40 → 0.98~0.99×。**全部 ≤ ceiling** |
| **09-12 P0-2** token 分支零测试 | ✅ **真修** | `local-request-security.test.ts:137-215`：Bearer 正确→200、缺 token→401、错 token→401、`?token=` query 不算凭据、`/v1read` 仿冒路径、远程 Origin 拒绝——路径全部 `/v1/` 前缀 |
| **09-12 P1-1** fallback 不接 ramp | ✅ **真修** | `weekly-plan-service.ts:155` 传入 `previousWeekDistanceKm`；探针：prev=8km 时 goal=15 → 钳到 10.30（ceiling 10.40）|
| **09-12 P1-3** health 契约无注解 | ✅ **真修** | `server.ts:609` `Promise<HealthResponse>`、`:622` `Promise<HandshakeResponse>` |
| **09-12 P2-2** 4~5MB 设计图入库 | ✅ **已收敛** | `git ls-tree design/`：最大 1.43MB，6 张大图已不在 HEAD |
| **09-13 🟡2** LLM 50s > iOS 45s 超时竞态 | ✅ **真修** | `APIClient.swift:68` `generateTimeoutInterval = 60` > `weekly-plan-llm.ts:54` `DEFAULT_TOTAL_BUDGET_MS = 50_000` |
| **09-13 🟡3** 回退模板可超 ceiling 0.1~0.2km | ✅ 未复现 | 探针 10 组（5/8/15/30/40 × prev null/8）stored 全部 ≤ ceiling |
| **09-13 iOS 已完成标注** | ⚠️ **部分回退**（见 🔴→🟡 项 I-1） | 披露 UI 两皮肤都在，但共享分类器死了 |

---

## 四、分级问题清单

### 🟡 P1 级

**I-1　「已完成标注」共享分类器被静默降级为两份皮肤复制 + 死代码 + 注释谎言**

- `git show 4f7a645` diff 实证：`planRow(day, completedDates:)` 与 `WorkoutPlanMapper.inactiveLabel` 的调用被**删除**（`-` 行 58/124/128）。
- 现状：`WorkoutPlanMapper.swift:192` 的 `inactiveLabel` 与 `NativeAppModel.swift:60` 的 `completedWeekDates` **生产代码零调用**（仅测试引用）；同一规则被复制到 `NativeViews.swift:1957`（PlanDaySheet.statusText）与 `TechViews.swift:1926`。
- 这违反 FIXES_2026-09-13 自己定下的原则「皮肤不该各自决定这条规则」，且 `inactiveLabel` 的 doc 注释仍声称 "The week panel dims the rows…"——被描述的共享机制不存在。
- **判级说明**：披露功能本身没丢（子代理「死代码、UI 不存在」的说法经反向复核为部分错误），所以 🟡 不是 🔴；但这是**上轮验收过的修复在后续 commit 中被静默削弱**的第一个实锤，值得警惕。

**I-2　实测步负偏移被静默丢弃 → 分段标签整体错位**

- `workout-segments.ts:197`：`if (startMs < startedAtMs || startMs >= endedAtMs) continue;` —— offset 为负的第一个步被丢弃而非钳到 0。
- iOS 侧 `HealthKitExport.swift:339` 的 offset 是 `(timeIntervalSince * 1000).rounded()`，`HKWorkoutActivity.startDate` 早于 `HKWorkout.startDate` 毫秒级漂移即产生负 offset。
- 后果：`resolveSegmentation`（`:610-633`）按 `planned[index]` 对位，头一步被丢后**全部标签串位**，还可能触发误导性的「手表记录的步骤少于课表步骤」note。与 `:166-168` 注释宣称的 "drifts a fraction … still lines up" 相反——注释只对**正**漂移成立。
- 建议：`startMs = Math.max(startedAtMs, startedAtMs + offsetMs)`，或负偏移整体返回 `[]` 走回放链。

**I-3　回执集合 ⊇ 实际上表集合（Bridge 二次过滤后不回传）**

- `NativeAppModel.swift:566` `recordPlanSync` 只做一层过滤 `plannedWorkout(from:) != nil`，注释声称 "the receipt set is exactly the set the watch was offered"。
- 但 `WorkoutKitBridge.swift:138-141` 还有第二层：`scheduleComponents == nil`（localDate 非法）、`customWorkout(from:) == nil`（`supportsGoal/supportsAlert` 拒绝，`:225`）继续丢天，外加 `prefix(maxScheduledWorkoutCount)` 截断（`maxScheduledWorkoutCount` = `WorkoutScheduler.maxAllowedScheduledWorkoutCount`，`WorkoutKitBridge.swift:72`）。
- 后果：被丢的天也拿到 `PlanSyncReceipt` → 详情页「课表分段」可能按一份手表上不存在的课表去还原分段。
- 建议：把 Bridge 实际构建出的 `pending` 集合传回 `recordPlanSync`，而不是各算各的。

**I-4　全部映射失败时文案误报「本周没有可同步的训练」**

- `WorkoutKitBridge.swift:63-64`：`attempted == 0` → "本周没有可同步的训练（休息日与无效课表不会上表）"。
- 当 `executable > 0` 但全部死在 `scheduleComponents`/`customWorkout`（例如 goal 全被 `supportsGoal` 拒绝）时，`:141-143` 提前返回 `attempted == 0, verified = false`，走第一个分支——**课表映射失败被说成「本来就没有」**，且 `verified=false` 的提示永远到不了。

**I-5　提交后 rollback 文件删除失败被静默吞掉**

- `worker.ts:1750-1752`：`await this.removeDatabaseFileWithRetry(rollbackPath).catch(() => {});`
- `var/backups/rai.import-rollback.<uuid>.sqlite` 删除失败（EBUSY 等）无任何日志；残骸会被 `enforceBackupPolicy` 计入 count/bytes 预算——要么挤掉真备份，要么长期滞留。与 `492907f` 要解决的「无界增长」同族。
- 建议：至少 `errors.push`，最好失败时降级为重命名隔离。

**I-6　CLI 内层 staging 库是 `492907f` 之外的泄漏路径**

- `cli.ts:90`：`${target}.importing.${randomUUID()}`（整库副本，含 incremental 时的全量 clone）只在 `finally`（`cli.ts:358`）清理。
- `maintenance.ts:93` 的 24h sweep 正则 `\.replaced\.[uuid]$` 与 worker 的回收都**不认这个命名**。CLI 进程 SIGKILL/OOM/断电 ⇒ 文件永久残留且无任何机制回收。

**I-7　LLM 响应不检查 `finish_reason === "length"`**

- `weekly-plan-llm.ts:150-154`：`extractContent` 只看有没有内容。截断恰好落在完整 JSON 对象之后时，残缺响应照常进 `validateWeeklyPlan` 被当完整周计划接受；`max_tokens = 8192` 硬编码（`00c0ccb` 只是缓解），换 reasoning 更长的模型会复现竞争。

### 🔡 P2 / 低级

| # | 问题 | 证据 | 说明 |
|---|---|---|---|
| L-1 | `json_each` 对 `raw_attributes_json` 裸字符串抛 malformed JSON | `database.ts:2356-2365`；**探针实测 THROWS: malformed JSON** | 触发面 = raw_attributes 带这两个 metadata 键；**真实库只读副本实测 0 行命中 → 当前不可达**，防御性缺陷。修法：`json_each(COALESCE(json_quote(json_extract(...)), '[]'))` 或先 `json_type` 判别 |
| L-2 | 标识符 guard 只加了一处 | `maintenance.ts:19`、`worker.ts:991` 与 `554f5a3` 加 guard 的 `hasColumn` 同型无 guard | 当前调用点均内部字面量；建议提为共享工具统一套用 |
| L-3 | 无 Origin + `allowAuthenticatedRemote` 直接放行 | `local-request-security.ts:67-68` | 只作用于非 `/v1/` 路径；当前无非 `/v1/` 写路由（grep 证实）→ 理论面。未来加非 `/v1/` 写端点即开公网 |
| L-4 | 跨源去重 120s 窗偏紧 | `canonicalize.ts:80-86` | 已知家族（P0-2 未修：id 掺 sourceName）；两设备起点差 >2min 即双计 |
| L-5 | 两实测步之间的空隙静默归入前段 | `workout-segments.ts:203-206` 只拒重叠不处理空隙 | 停表区间距离≈0、时长计入 → 分段配速被稀释；与 I-2 同属第一级权威链的容差缺口 |
| L-6 | iOS 强制解包散点 | `HealthKitExport.swift:678` `raw!`、31 处 `quantityType(forIdentifier:)!` | 均为文档保证非 nil；`:678` 的 `!` 与跨行条件耦合，建议 `if let` 化；两套风格并存 |
| L-7 | metadata 序列化 `String(describing:)` 兜底 | `HealthKitExport.swift:781-804` | 数组/字典型 metadata 会产出 Swift debug 格式；当前导出的 `RAIWorkoutStructureDiagV1` 走 String 分支安全 |
| L-8 | 周条与手表课表面板数据源不同步 | `NativeViews.swift:1584`（today 缓存）vs `:1655`（workout-plan 缓存） | `workoutPlan` 刷新失败 `try?` 静默留旧值（`NativeAppModel.swift:175-179`）→ 同屏可能矛盾 |
| L-9 | `skipped` 计数混入休息日 | `WorkoutKitBridge.swift:130-131,160-166` | 休息日+映射失败+未确认合成一个「跳过 N 项」，用户无法区分正常与异常 |
| L-10 | `timezone ?? .current` 兜底 | `WorkoutKitBridge.swift:129` | 契约固定 `"Asia/Shanghai"`（`api-contracts:298`）→ 当前死分支；防的是未来换成非 IANA 格式 |
| L-11 | iOS 同步编排两皮肤复制 | `NativeViews.swift:1736-1751` ≈ `TechViews.swift:1712-1727` | 与 I-1 同根：共享逻辑该上移到 bridge/model |

---

## 五、反向复核（纠正了子代理的 4 条结论）

1. **「lateFloor 会把本周任何已过去的日子推到 now+60s」（iOS 线索 3）—— ❌ 证伪。** `assembleMobileWorkoutPlan` 的循环只取 `day.localDate > today`（`mobile-read.ts:336`），过去的日子**根本不进** `/v1/mobile/workout-plan` 响应。lateFloor 实际只会作用于今天这天。doc 注释 "today's session" 是准确的。
2. **「已完成的日期不会重复下发」是空承诺（iOS 线索 4）—— ❌ 证伪。** 同上：completed 的过去日不在响应里，结构上保证不下发。UI 文案（`NativeViews.swift:1673`）属实。
3. **「已完成标注是死代码、UI 从未接入」（iOS 线索 1）—— ⚠️ 部分错误。** 披露 UI 两皮肤都存在（`NativeViews.swift:1957` + `TechViews.swift:1926` + checkmark 行）；死的只是共享分类器 `inactiveLabel`/`completedWeekDates`。已降级为 I-1 的复制问题。
4. **「fallback 单堂质量课可超预算 6%」（后端线索 13）—— ❌ 未现。** 探针 10 组：goal=5/8/15/30/40 的 kinds 全部不出现超 ceiling 的一堂（15km 才出现 interval，stored 14.80 ≤ 15）。

---

## 六、绿区（已核实无问题）

| 维度 | 关键证据 |
|---|---|
| 路由登记 | 17 个写端点恰好落三个互斥集合（子代理核 + `schemas.test.ts` 强制测试） |
| metadata 形状 | `structurePayloadOf`（`workout-segments.ts:146-161`）同时接受 `string[]`（取末位）与裸字符串，空/坏 JSON 安全回落 |
| SQL 注入 | storage 全部 `${}` 插值点当前均为内部字面量；guard 在其作用域内有效 |
| clamp→measure 顺序 | validate（`:487→502`）与 fallback（`:788→790`）均保持 |
| iOS 分层红线 | 无 `try!`/`as!`；无 CTL/ATL/TSB/TRIMP 公式；`CoordinateConversion` 正确 `nonisolated` 且仅 AMap 渲染层调用；`MapPrivacy` 未同意不建 `MAMapView`；WorkoutKitBridge `@available(iOS 17.0,*)` 与 target 匹配 |
| 依赖方向 | 双 tsconfig 全量 typecheck 绿 ⇒ 纯核心无逃逸 |

---

## 七、行动建议（按优先级，附验收标准与回滚）

| 序 | 项 | 改动 | 验收标准 | 回滚 |
|---|---|---|---|---|
| 1 | **I-2** | `measuredStepsOf` 对负 offset 钳到 `startedAtMs`（或返回 `[]` 走回放） | 新增单测：`startMs: -200` 的 activity ⇒ 首步不丢、标签不错位；`npm test` 全绿 | 单函数，`git checkout -- apps/api/src/workout-segments.ts` |
| 2 | **I-3+I-4** | Bridge 把实际 `pending` 集合回传给 `recordPlanSync`；`executable>0 && attempted==0` 的 summary 单列「映射失败」文案 | 构造 `supportsGoal` 全拒的课表 ⇒ 回执数 == 实际上表数；文案不再出现「没有可同步的训练」 | `git checkout -- apps/ios/RAI/WorkoutKitBridge.swift apps/ios/RAI/NativeAppModel.swift` |
| 3 | **I-5+I-6** | rollback 删除失败进 `errors`；24h sweep 扩正则覆盖 `\.importing\.[uuid]$`（或 CLI 改用同一命名） | 人为 kill 一次 import CLI ⇒ sweep 能回收残留 | 恢复正则/`catch` 原样 |
| 4 | **I-7** | `extractContent` 后断言 `finish_reason !== "length"` | mock length 截断 payload ⇒ 抛 `LlmRequestError` | 去掉断言 |
| 5 | **I-1** | 恢复共享分类器：两皮肤 `statusText` 改调 `WorkoutPlanMapper.inactiveLabel(day:, completedLocalDates: native.completedWeekDates)`；删除误导 doc 注释 | 两皮肤文案单测经同一函数；`grep inactiveLabel apps/ios/RAI --include=*.swift` 生产代码 ≥2 调用 | `git checkout -- NativeViews.swift TechViews.swift` |
| 6 | **L-1/L-2** | `json_each` 分支加 `json_type` 判别；标识符 guard 提共享工具 | 裸字符串行不再令语句抛错；新增防御测试 | 独立小改 |

---

## 八、未覆盖范围（如实声明）

- **真机/模拟器行为**：`xcodebuild` 不可用（无 CocoaPods）→ WorkoutKit 实际上表、`CustomWorkout` 全等回读（线索 8，未定性）、系统授权弹窗文案、AMap 底图均**未做运行时验证**。I-3/I-4 的触发面依赖真机 `supportsGoal` 行为。
- **浏览器 E2E**：本机无 Chrome/Edge，未执行；Web 侧结论仅来自 vitest 84 项。
- **canonicalize 增量 session 抢占**（后端线索 5）：代码路径已读、机理成立，但**未构造复现样例**，维持线索级不判级。
- **线上环境**：未接触 `tpandmr.xyz`；`research/` Python 层、Web 深审不在本轮范围。
- **推送 receipt 36h 窗边界**（后端线索 11）：抽样未测，低危记录在案。

---

*报告时点：2026-09-15 19:40（Asia/Shanghai）｜基线 `f588e0a`，工作树干净*
*审查过程未修改任何业务代码、未触碰用户数据；探针置于 /tmp 并已删除（fallback 探针、json_each 探针、只读库副本）。*
