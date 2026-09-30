# 未提交改动审查（2026-09-16）

## 审查对象与方法

- **审查对象**：`/Users/ta/running` 工作区全部未提交改动（9 个已跟踪文件 + 1 个未跟踪目录），`HEAD = bd1ee25`。
- **改动主体**：iOS 科技风（technology skin）今日页新增「当前跑力」入口卡 + 重写跑步能力详情页；一批（单一主题，可在同一提交内完成）。
- **方法**：结论全部落到 `文件:行号` 或命令实测输出。编译门禁、模型回归、Swift 构建、UI 视觉回归均为**本机实跑**，不采信文档说法。
- **规则**：凡"会不一致 / 会崩溃 / 恒真"一类推断，先读实现或跑探针再下结论；本轮据此**撤回**了一条自己的怀疑（见 §4 末）。

---

## 一、结论摘要

| # | 级别 | 结论 | 关键证据 |
|---|---|---|---|
| P0-1 | 🔴 | **像素风校准状态判断恒为真**：`!= "ready"` 永不成立，已校准用户也会被显示黄色告警框 | `NativeViews.swift:281` vs 契约 `api-contracts/src/index.ts:519` |
| P1-0 | 🟡 | **验收截图与最终代码不符**（注：验收结论本身已由本机复现为真）：目录截图含代码里已删除的「能力分析」五维卡、「近期跑力评估」、「数据依据」、「周计划与训练依据」；README 引用的 `07-ability-metrics.png` 缺失；新增断言产出的 `07-ability-trend.png` 与 `07-ability-metrics.png` 哈希相同（第二次滚动无效） | 截图 mtime 14:49/15:01 < 源码 mtime 15:56–16:26；本机复现截图（17:32）无上述面板；`shasum` 两图同哈希 |
| P1-1 | 🟡 | 今日页**静默移除**「训练阶段」与「最近一次训练反馈」两个面板，文档未记载；`postRun` 在科技风已无任何入口 | diff 删除 `planPanel`/`contextPanel`；全科技风目录 grep `postRun` 零命中 |
| P1-2 | 🟡→半 | 新增字段无消费方；另一个字段的消费方被本次删除。**`NativeDashboardResponse.dimensions` 已获消费方**（恢复的五维面板）；`WorkoutDetailResponse.dimensions`（`:694`，非可选）**仍是死字段** | `APIModels.swift:361` 有读取点；`:694` 全工程零读取 |
| P1-3 | 🟡 | 量程弧缺值仍画成 0%，与本次确立的「缺值 ≠ 0」原则不一致 | `TechViews.swift:194`、`TechAbilityDetailView.swift:57` 的 `?? 0` |
| P1-4 | 🟡 | 校准文案在两处重复实现且文案不同（两皮肤标题不一致） | `TechTheme.swift:481` vs `NativeFormat.swift:334-335` |
| P1-5 | 🟡 | 未知状态在像素风直出英文原值，与新函数的「中文兜底」策略相悖 | `NativeFormat.swift:347` |
| P1-6 | 🟡 | 详情页三个面板对"数据未到"的处理不一致：两个静默消失，一个有加载态 | `TechAbilityDetailView.swift:124-129` vs `:155` / `:187` |
| P2-1 | 🟡 | **UI 验收用例不在 CI 里**：`ci.yml` 的 `ios` job 只构建 `RAI` 工程 + 跑 `run-model-tests.sh`，从不构建 `VisualAcceptance.xcodeproj` ⇒ 该文件的语法错误 CI 不会报，只有本机跑 UI 回归时才会暴露 | `.github/workflows/ci.yml:28-37` |
| — | ✅ | 编译门禁、模型回归、Swift 构建、**10 项 UI 视觉回归**全部本机实跑通过；缺值语义、同源核验、量程弧几何、无障碍 label 均正确 | §4 |

---

## 二、🔴 必修

### P0-1 像素风校准状态判断恒为真（`NativeViews.swift:281`）

```swift
// apps/ios/RAI/NativeViews.swift:281
if data.calibration.status != "ready" {
    Text(data.calibration.message) ...
```

真实取值域不含 `"ready"`：

```ts
// packages/api-contracts/src/index.ts:519
status: "not_started" | "calibrating" | "completed";
```

该字段由 `/v1/mobile/today` 直传服务端值（`apps/api/src/mobile-read.ts:232`），而 `"ready"` 只在别处作为**快照状态**存在（`NativeFormat.swift:338`）。⇒ 条件**恒为真**，黄框永远显示。

后果不止"多显示一块"：

```ts
// apps/api/src/mobile-coach.ts:172
if (status === "completed") return "校准完成，真实能力可以当作主参考。";
```

⇒ **已校准**的用户会看到一个**黄色警告框**，内容是"校准完成，真实能力可以当作主参考"。把正常状态渲染成告警。

**已实测，不是推断**。用隔离库（`var/rai.sqlite` 的备份）在本地起 API 直读接口：

```
calibration.status  = 'completed'
calibration.message = 校准完成，真实能力可以当作主参考。
```

⇒ 该库下像素风的 `!= "ready"` 判定为真，**此刻一定在显示这个黄色告警框**。（字段链路：`/v1/mobile/today` 直传（`mobile-read.ts:232`）；本轮 UI 截图 `07-ability.png` 的科技风标题同样显示「已校准」，两路互证。）

- 性质：**非本次引入**（`HEAD` 即如此），但**本次已在科技风侧修正三处**，像素风未同步：
  - `TechViews.swift:202`、`TechViews.swift:226`、`TechAbilityDetailView.swift:81` → `!= "completed"`
- ⇒ 属"双皮肤只改一半"，且本次自己已经写对了判据，是最该顺手闭环的一条。

**修复建议**（不只改这一个字面量）：把判据抽成一个共享函数，消除"第四处再漏"的可能：

```swift
// 建议放 NativeFormat.swift 或 TechTheme.swift，供两皮肤共用
func calibrationNeedsAttention(_ status: String?) -> Bool { status != "completed" }
```

然后四处调用点（`TechViews.swift:202`、`TechViews.swift:226`、`TechAbilityDetailView.swift:81`、`NativeViews.swift:281`）统一改用它。同时 `NativeViews.swift:265` 的 `nativeStatusName(data.calibration.status)` 会显示「已完成」，与科技风的「已校准」不同——若要有意分皮肤可保留，否则也应换用 `techCalibrationName`。

**验收标准**：DB 中 `calibration.status = 'completed'` 时，像素风今日页「当前跑力」卡**不出现**黄色面板（截图对比）；`completed/calibrating/not_started` 三态下两皮肤标题语义一致。
**回滚**：`git checkout -- apps/ios/RAI/NativeViews.swift`（该文件本次未改，回滚即回到现状）。

---

## 三、🟡 待决策

### P1-0 验收截图与最终代码不符，README 引用的文件不存在

`design/acceptance/2026-09-16-ability-card/README.md` 把这批截图当作本轮验收证据（README:71），但截图内容与最终代码互相矛盾：

| 截图 | 图中出现 | 代码现状 | 判定 |
|---|---|---|---|
| `07-ability.png` | 「能力分析」五维卡（效率/配速/心肺/稳定性/恢复） | 已删除，README:9 明确"不展示能力分析五维卡" | ✗ 不符 |
| `07-ability-trend.png` | 「近期跑力评估」列表（20 条）+「数据依据」说明卡 | 均已删除，README:9 明确"不展示" | ✗ 不符 |
| `02-today-ability-and-metrics.png` | 底部「周计划与训练依据」折叠区 | 已删除（`TechViews.swift:44-57` 现无 `DisclosureGroup`） | ✗ 不符 |
| `01-today-top.png` | 新版跑力入口卡（45.5 /100 + 量程弧） | 一致 | ✓ |

文件级事实（实测）：

- README:71 声称的 **`07-ability-metrics.png` 在磁盘上不存在**（`find` 实测只有 `01-today-top`、`02-today-ability-and-metrics`、`07-ability`、`07-ability-trend`、`07-ability-dimensions`、`07-ability-missing-dimensions` 六张）。
- 目录中另有 `07-ability-dimensions.png`、`07-ability-missing-dimensions.png` 两张 **README 未提及**，且对应的是已被删除的五维卡功能。
- 时间戳（`stat` 实测）：截图 `14:49:04`（5 张）与 `15:01:31`（1 张）；源码 `TechAbilityDetailView.swift`/`VisualAcceptance.swift` `15:56:19`、`TechCharts.swift` `16:16:43`、`TechViews.swift` `16:26:34`。⇒ **截图比最终源码早 55–97 分钟**。

⇒ 结论：目录里的截图是**中间版本**产物，与最终代码不是同一版本。

**但验收结论本身是真的**：我在本机复现了同一条用例（见 §5），得到 `** TEST SUCCEEDED **` 与 `Executed 10 tests, with 0 failures`。⇒ 问题不在"是否通过"，而在**交付的证据材料与最终代码不对应**：目录里的图无法用来复核任何结论，还会把已删除的面板当成现状（本轮先看图、再读码、最后实跑，才把这一层排除掉）。

**顺带实测到新增断言的一个实效缺陷**：`capture("07-ability")` → `swipeUp` → `capture("07-ability-metrics")` → `swipeUp` → `capture("07-ability-trend")`（`VisualAcceptance.swift:82-90`）产出的后两张图**哈希完全相同**（`328977dbe0cba7f1fd9615c7bee249ac4a7679d34517f4e294e70524520d14fb`）⇒ 第二次 `swipeUp()` 时页面已到底、没有滚动。README:71 所说的"详情页三段"实际只有**两段**有效内容，第三张是重复帧（这也解释了 acceptance 目录为何缺 `07-ability-metrics.png`——作者很可能已发现重复而丢弃其中一张）。

**修复建议**：
1. 删掉 `07-ability-dimensions.png`、`07-ability-missing-dimensions.png`（功能已不存在）；
2. 重拍 `07-ability*` 与 `02-*`，或把 README:71 改为与实际文件一致的清单；
3. 建议把 `run-visual-tests.sh` 产出的截图**整目录**纳入验收目录（脚本已按附件名自动落盘，见 `run-visual-tests.sh:74-83`），避免"手工挑图"导致的版本错配；
4. 断言里的"三段"不应假定每次 `swipeUp()` 都会滚动——要么把三次截图名与真实内容对齐（如"首屏 / 页尾"），要么改用 `scrollTo` 定位到目标元素后再截图（本用例已在别处用 `scrollTo`，见 `VisualAcceptance.swift:35-50`）；
5. 最根本的一层：在 acceptance README 里记录**截图对应的 commit**（或 `git diff` 摘要），让"图 ↔ 代码"有可核验的锚点。

**验收标准**：`find .../screenshots -name '*.png'` 的输出与 README 列举**逐一对应**；每张图内容与 `git stash` 前的工作区代码一致（抽查「能力分析」不出现）。
**回滚**：该目录未跟踪，`rm -rf apps/ios/design/acceptance/2026-09-16-ability-card` 即可，无代码影响。

---

### P1-1 今日页移除的两个面板没有替代入口（`postRun` 彻底失去展示位）

本次删除的不只是 `abilityPanel`：`git diff` 显示 `planPanel`（`-  private func planPanel`）与 `contextPanel`（`-  private func contextPanel`）一并被删，而 README:30 只记"删除 `abilityPanel` 与其在折叠区的引用"。

逐项核查"内容是否还有入口"（全科技风目录 grep + 实读）：

| 被删内容 | 科技风替代入口 | 证据 |
|---|---|---|
| 本周计划逐日 | ✅ 「本周活动」页 | `TechViews.swift:456` |
| 伤病提示 `injuryFlags` | ✅ 「身体指标」页 | `TechViews.swift:546` |
| 本周剩余距离 | ✅ 「本周活动」页 | `TechViews.swift:445` |
| 比赛目标配速 | ✅ 「训练计划」页 | `TechViews.swift:1827` |
| **最近一次训练反馈 `postRun`** | ❌ **无任何入口** | grep `postRun` → 仅 `NativeViews.swift:524`（像素风） |
| **训练阶段 `data.phase`** | ❌ **无** | grep `.phase` → 仅 `NativeViews.swift:495`（像素风） |
| **比赛说明 `race.note` / 体型分 `raceShapeScore` / 减量 `race.taper`** | ❌ **无** | 三个标识符在科技风目录零命中 |

⇒ 像素风今日页仍完整保留这些（`NativeViews.swift:495/517/524`），科技风已无。**这不是"精简"，是信息丢失**，且文档未记录。

**待决策**：是有意把"训练阶段 / 赛后反馈"收敛进别的页面（如训练详情/本周活动），还是应在详情页或今日页补回入口？若确认是精简，README 与 `TECHNOLOGY_SKIN.md` 必须写明"`postRun`、`phase`、`race.note`、`raceShapeScore`、`taper` 在科技风不再展示"，否则下次审查会当成回归。

**验收标准**：`MobileTodayResponse` 的每个字段，在科技风要么有展示位、要么在文档中被显式声明为不展示。

---

### P1-2 新增字段无消费方

```swift
// apps/ios/RAI/APIModels.swift:359-361（本次新增）
struct NativeDashboardResponse: Codable {
    let latestWorkout: WorkoutListItem?
    let dimensions: AbilityMetricSet?      // ← 新增
```

- 全 iOS 工程 grep `.dimensions`：**零读取点**（只有 `ModelRegression.swift:118` 的 mock JSON 字符串与本次新增的声明）。
- 同时 `WorkoutDetailResponse.dimensions`（`APIModels.swift:694`）的**唯一**消费方是本次被删掉的 `TechTodayMetrics`「关键指标」面板 ⇒ 该字段现在也无读取点。
- 契约侧两者都存在（`api-contracts/src/index.ts:172`、`:251`），所以**不是**契约缺字段，纯属 iOS 侧补了不用。
- **实测确认服务端确实有值**（同一隔离 API）：`/v1/dashboard` → `dimensions = {"efficiency": 40.74, "pace": 47.84, "cardio": 58.99, "stability": 46.22, "recovery": 50.15}`。⇒ 不是"服务端没给"，而是"给了但 App 里没有展示位"。
- 连带影响：本次删除详情页「能力分析」五维卡之后，**这五维数据在 App 内已完全不可见**（只在服务端计算并返回）。这一项 README:9 有声明（"不展示能力分析五维卡"），属有意精简；但 `NativeDashboardResponse.dimensions` 这个新增字段的存在容易让人以为"某处要用"，建议加注释说明用途，否则下次审查会再判一次死字段。

**待决策**：若意图是"为将来五维展示预留"，建议加注释说明；若无意保留，删掉 `APIModels.swift:361` 可减少一个需要随契约同步的字段。注意：**保留声明本身无害**（可选字段用 `decodeIfPresent`，缺失键不会解码失败，注释也已说明这一点——这一点是写对的）。

---

### P1-3 量程弧缺值仍画成 0%

本次已经在两处建立了"缺值不能长得像真实 0"的原则（`TechProgressBar.fraction` 改 `Double?`、新增 `techValue` 不给 `--` 加单位），但量程弧没跟上：

```swift
// apps/ios/RAI/Skins/Technology/TechViews.swift:194
progress: data.ability.trueAbility.map { min(max($0 / 100, 0), 1) } ?? 0,

// apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift:57
progress: abilityFraction ?? 0,
```

`TechAbilityGauge.progress` 是**非可选** `Double`，缺值时弧照常画出 0% 的填充空缺，只靠文本 `--` 区分。⇒ 与本次原则不一致。

**建议**：把 `progress` 也改为 `Double?`（`filled` 已有 `isFinite` 守卫，改动面很小），缺值时只画轨道不画填充——与 `TechProgressBar` 同一套语义。

---

### P1-4 / P1-5 状态文案：重复实现 + 策略不一致

```swift
// apps/ios/RAI/Skins/Technology/TechTheme.swift:481
func techCalibrationName(_ value: String?) -> String {
    case "completed": return "已校准"
    case "calibrating": return "校准中"
    case "not_started": return "尚未开始"
    default: return "暂无数据"
}

// apps/ios/RAI/NativeFormat.swift:334-335（本次新增，服务像素风）
case "not_started": return "尚未开始"
case "calibrating": return "校准中"
```

- `"calibrating"`、`"not_started"` 的映射**在两处各写一遍**；`"completed"` 文案还不同（「已校准」vs「已完成」）⇒ 两皮肤卡标题不一致（`TechViews.swift:188` vs `NativeViews.swift:265`）。像素风加这两个 case 本身是**对的**（否则英文上屏，注释理由成立），问题在于同一映射存在两个副本。
- 附带策略不一致：`nativeStatusName` 的 `default: return value ?? "--"`（`NativeFormat.swift:347`）会**直出英文原值**，而新的 `techCalibrationName`、`techPaceZoneName` 都返回中文兜底。后者更符合本次"未知值不直出英文"的注释意图。

**建议**：保留一个真源（如 `calibrationLabel(status)`），两皮肤只在"是否需要不同措辞"上分叉；`nativeStatusName` 的 default 也考虑收敛为中文兜底（既有行为，改动需评估影响面）。

---

### P1-6 详情页三个面板对"数据未到"的处理不一致

```swift
// TechAbilityDetailView.swift:124-129  —— 有加载态
if native.predictions == nil && native.isLoadingBodyMetrics {
    ProgressView()...
} else if native.predictions == nil {
    Text("预测快照暂不可用，下拉刷新后重试。")
}

// :155   预测面板：if let races = native.predictions?.snapshot.races, !races.isEmpty { ... }  → 否则整块不渲染
// :187   趋势面板：if let data = native.trends { ... }                                        → 否则整块不渲染
```

⇒ 同一页里，基础指标有明确的"加载中/不可用"提示，而成绩预测与评估趋势在 `predictions`/`trends` 为 `nil` 时**静默消失**。用户无法区分"还在加载"与"服务端没有这项"。

**建议**：沿用 `baseMetricsPanel` 的写法（`isLoadingBodyMetrics` → `ProgressView`；否则给 `TechEmptyState`）。注意 `trends` 为 `nil` 时 `.task` 会触发 `refreshAll()`（`TechAbilityDetailView.swift:41`），所以"永远空着"只在刷新失败时出现，属边缘但可复现。

---

## 四、✅ 通过项（做得对的地方）

1. **编译门禁全部本机实跑通过**（非引用文档）：
   - `bash apps/ios/tests/typecheck-ios.sh` → `EXIT=0`，`类型检查 37 个文件` / `iOS 类型检查通过`。
   - `bash apps/ios/tests/run-model-tests.sh` → 全绿，末尾 `All model patch checks passed.` / `All workout plan mapper checks passed.` / `All coordinate conversion checks passed.`
   - `xcodebuild ... build` → **`** BUILD SUCCEEDED **`**、`EXIT=0`（详见 §5，含本机沙箱绕法）。
   - `run-visual-tests.sh`（等价临时副本）→ **`** TEST SUCCEEDED **`**，`Executed 10 tests, with 0 failures`。
   ⇒ 本次改动在**类型层、真实构建层与端到端 UI 层**都是干净的。
2. **`TechProgressBar.fraction: Double?` 是编译期安全的正确改法**：把"缺值"编码进类型，而不是靠调用方自律。3 处调用点已全部更新（`TechTheme.swift:303`、`TechViews.swift:108`、`TechViews.swift:1274`），编译器兜住了遗漏。
3. **缺值语义正确**：`nativeNumber`/`nativeSigned`/`nativePercent`/`nativeKilometers` 对 `nil` 一律返回 `--`（`NativeFormat.swift:5/10/15/34/42/47`），因此 `abilityCard` 的「近 7 天」缺值显示 `--` 而非 `0.0`；`abilityDeltaColor(nil)` 也返回 muted 而非当作下跌（`TechViews.swift:233-238`）。这是"不给缺值编造符号语义"的正确做法。
4. **新增 `techValue(_:digits:unit:)` 解决了真实缺陷**：`nativeNumber(nil) + "/周"` 会渲染成 `--/周`，看起来像一个存在的速率；新函数缺值时不加单位（`TechTheme.swift:492-495`，注释写明了理由）。
5. **量程弧几何自洽**：`inset = lineWidth/2`、`radius = (size - lineWidth)/2`、`bottomOverflow = inset + glowRadius`、`arcHeight = size/2 + bottomOverflow` 四者的推导一致——`radius + lineWidth/2 == size/2` 恰好贴边，裁剪高度多留的 12pt 正好容纳圆帽（6）+ 发光（6）（`TechCharts.swift:89-125`）。注释也解释了"为什么只翻弧不翻刻度"。
6. **无障碍处理**：`abilityCard` 用覆盖式 label，并把会被盖掉的变化、校准状态、校准说明都补回 label（`TechViews.swift:219-231`），这与 README:55 的 VoiceOver 说明一致；详情页 `TechAbilityGauge` 内部 `accessibilityHidden(true)` + 外层 `accessibilityElement(children: .ignore)` 也不会重复朗读。
7. **同源核验通过（本条曾是我的怀疑，实测后撤回）**：详情页 `abilityPanel` 与 `trendPanel` 同屏各显示一份「增长速度/衰减」，我怀疑是两个来源会打架。实测两条链路**读的是同一张表的同一行**：
   - `ability` ← `/v1/mobile/today` ← `dashboard.latestSnapshot`（`mobile-read.ts:174-175`）← `SqliteDashboardReadRepository.latestAbilitySnapshot()` = `SELECT ... FROM active_daily_ability_snapshots ORDER BY local_date DESC LIMIT 1`（`dashboard-read-repository.ts:48-58`）
   - `trends` ← `/v1/mobile/trends` ← `abilitySeries.daily.at(-1)`（`data.ts:679`）← `SqliteTrendsReadRepository.load()` 同一张表（`trends-read-repository.ts:57-69`）
   ⇒ 数值一致，无需改。
8. **刷新职责不重叠**：`refreshAll` 拉 today/statistics/trends/goals（`NativeAppModel.swift:170-173`），`refreshBodyMetrics` 拉 predictions/dashboard/zones/statistics（`:382-385`）。详情页 `.refreshable` 两个都调是**必要**的（详情页依赖 predictions 与 trainingZones），不是重复请求。
9. **未触碰 Web/TS**：`git status` 显示改动全在 `apps/ios`，故未跑 Web 门禁的判断正确（符合 AGENTS.md 的"按改动比例选择检查"）。
10. **代码卫生**：`git diff --check` 无空白错误；8 个改动源文件 ESC 字符计数全为 0（`git diff` 管道渲染会显示 `[32m` 伪影，实读源文件确认无污染）；新增符号 `techPaceZoneCode`/`techPaceRange`/`techPace` 均已存在于 `HEAD`（`TechTheme.swift:504/526/544`），非本次遗漏。
11. **无破坏性契约变更**：iOS 侧只新增可选字段 `dimensions`，无必填字段新增、无 `Codable` 破坏；不需要迁移。

---

## 五、本机实跑：视觉回归为何跑不通，以及怎样跑通

`apps/ios/tests/run-visual-tests.sh` 在本机**按原样不可运行**，三条独立障碍（均为实测）：

| # | 障碍 | 实测证据 | 绕法 |
|---|---|---|---|
| 1 | 脚本内 `curl` 走沙箱 HTTP 代理（`http_proxy=http://127.0.0.1:52106`），health 判定失败 | `HTTP=502 upstream connect failed` | `NO_PROXY=127.0.0.1,localhost` |
| 2 | 脚本等待 **40s**（`seq 1 80` × 0.5），而隔离 API 冷启动实测 **43s** | `READY after 43s`（轮询 health 至 200） | 等待窗口放宽到 120s（`seq 1 240`） |
| 3 | **决定性**：`xcodebuild` 构建失败 —— swift-driver 把宏插件宿主包进 `sandbox-exec`，本环境拒绝嵌套沙箱 | `sandbox-exec: sandbox_apply: Operation not permitted` → `external macro implementation type 'ObservationMacros.ObservableMacro' could not be found` → `** BUILD FAILED **`（`EXIT=65`） | `OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox'` |

障碍 3 与代码无关（报错文件 `NativeAppModel.swift`/`ServerSession.swift`/`ServerDiscovery.swift` **本次均未改动**）；`typecheck-ios.sh` 之所以能过，是因为它已内置 `-disable-sandbox`。加上该开关后构建**成功**（`** BUILD SUCCEEDED **`）。

> 这与本仓库已有的经验一致：iOS 的两条通道覆盖不同失败模式，`typecheck` 通过**不能**推出 `xcodebuild` 能过。

### 视觉回归实跑结果

**结果：`** TEST SUCCEEDED **`、`Executed 10 tests, with 0 failures (0 unexpected) in 577.703 (577.714) seconds`、脚本 `EXIT=0`。**

| 用例 | 耗时 | 结果 |
|---|---|---|
| `test01TodayAndBody`（含新增跑力入口与详情页断言） | 79.07s | passed |
| `test02Workouts` | 102.39s | passed |
| `test03Plan` | 46.50s | passed |
| `test04Analysis` | 46.17s | passed |
| `test05Settings` | 38.19s | passed |
| `test06Setup` | 27.46s | passed |
| `test07LargeText` | 41.22s | passed |
| `test08FaultStates` | 123.44s | passed |
| `test09AppearancePersistence` | 43.20s | passed |
| `test10RevisionConflict` | 30.08s | passed |

⇒ README §验证 中"审查修正后的最终代码上 10 项原生 UI 回归全部通过"**成立**，由本机独立复现。

**新产出截图对证**（`/tmp/rai-visual-out3/screenshots/`，产出时间 17:32）：

- `07-ability.png`：跑步能力量程弧（45.5）→ 基础指标 → 成绩预测 → 评估趋势。**无**「能力分析」五维卡。
- `07-ability-metrics.png`：成绩预测 → 评估趋势（折线 + 增长速度/衰减）→ 配速区间（E/M/T/I/R 徽章）。**无**「近期跑力评估」列表、**无**「数据依据」说明卡。

⇒ 与 §3 P1-0 的判定一致：`design/acceptance/2026-09-16-ability-card/screenshots/` 里的同名图（哈希全部不同于本轮产出）是旧版本。

**复现命令**（等价于仓库脚本，仅改三处：`cd` 固定、等待 40s→120s、health 检查加 `--noproxy '*'`、两条 `xcodebuild` 加 `OTHER_SWIFT_FLAGS`）：

```sh
cd /Users/ta/running
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
RAI_VISUAL_OUTPUT=/tmp/rai-visual-out3 bash /tmp/rai-visual-verify.sh   # 临时副本，未改动仓库内脚本
```

### 建议写入文档的环境前提

README §两个环境注意点 已记了高德隐私门控与 40s/43s 超时，建议补第 3 条（构建开关），否则下一个人在**任何**沙箱/CI 里都会先撞上 `BUILD FAILED`：

```sh
OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox'   # 沙箱拒绝嵌套 sandbox-exec 时必需
NO_PROXY=127.0.0.1,localhost                        # 沙箱 HTTP 代理会让脚本内 curl 判 502
```

---

## 六、修复顺序与验收标准

| 顺序 | 项 | 动作 | 验收标准 | 回滚 |
|---|---|---|---|---|
| 1 | P0-1 | 抽 `calibrationNeedsAttention(_:)`，四处调用点统一（含 `NativeViews.swift:281`） | `status='completed'` 时像素风无黄框；三态两皮肤语义一致 | `git checkout -- apps/ios/RAI/NativeViews.swift` |
| 2 | P1-0 | 清 2 张过期截图、补/改 README 引用、重拍；`07-ability-trend` 改为定位到元素再截 | `find` 文件清单与 README 逐一对应；每张图内容与当前代码一致；三张详情图不再重复 | `rm -rf apps/ios/design/acceptance/2026-09-16-ability-card` |
| 3 | P1-1 | 决策 `postRun`/`phase`/`race.note`/`shapeScore`/`taper` 是补入口还是写进文档 | 每个字段"有展示位或有显式声明" | 纯文档，`git checkout --` 对应 md |
| 4 | P1-3 | `TechAbilityGauge.progress` 改 `Double?` | 缺值时弧无填充，与 `TechProgressBar` 行为一致 | 恢复 `?? 0` 两处 |
| 5 | P1-4/5 | 收敛状态文案真源 | 两皮肤同状态文案可解释 | — |
| 6 | P1-2 | 保留 `dimensions` 并加注释，或删除 | 无未说明的死字段 | `git checkout -- apps/ios/RAI/APIModels.swift` |

**通用门禁**（每步之后）：`bash apps/ios/tests/typecheck-ios.sh`（37 文件）→ `bash apps/ios/tests/run-model-tests.sh`，两者之间**不要改 Swift 源**；改动涉及 `@Observable` 视图时另需 `xcodebuild ... OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox' build`。

**迁移与破坏性变更**：**无**。本次改动不涉及数据库 schema、不涉及 Web/TS、无必填契约字段新增 ⇒ 回滚只需 `git checkout --` 对应文件 + 删除未跟踪的 acceptance 目录。

---

## 七、清理项

1. `apps/ios/design/acceptance/2026-09-16-ability-card/screenshots/07-ability-dimensions.png`、`07-ability-missing-dimensions.png`：对应功能已删除，应移除或改注释说明。
2. README:71 的 `07-ability-metrics.png` 引用与实际文件名不符（该文件不存在）。
3. `VisualAcceptance.swift:82-90`：第三次截图 `07-ability-trend` 因页面已到底而与第二次哈希相同，建议改用 `scrollTo` 定位后截图，或明确合并为两张。
4. 临时探针与本轮验证产物均在工作区外（`/tmp/rai-*`），**未污染仓库**；`git status` 与审查开始时一致（可用 `git status --porcelain=v1` 复核）。

---

## 八、第二轮闭环（P0-1 修复 + 五维展示恢复）

### 8.1 改了什么

| 文件 | 改动 | 目的 |
|---|---|---|
| `apps/ios/RAI/CalibrationState.swift`（新增） | `calibrationNeedsAttention(_:)`，**纯 Foundation** | 判据只此一份；见 8.2 为何必须单独成文件 |
| `apps/ios/RAI/NativeFormat.swift` | 删掉原来的同名函数，留一行指向新文件的注释 | 消除重复定义 |
| `apps/ios/RAI/NativeViews.swift:281`、`Skins/Technology/TechViews.swift:202/226`、`Skins/Technology/TechAbilityDetailView.swift:82` | 四处统一改调 `calibrationNeedsAttention(...)` | 修 P0-1，且让"只改一半"不再可能 |
| `apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift` | 新增 `dimensionsPanel`（插在 `abilityPanel` 与 `baseMetricsPanel` 之间）+ `dimensionLine(_:_:note:)` | 恢复五维展示（P1-2 的 `NativeDashboardResponse.dimensions` 由此获得消费方） |
| `apps/ios/RAI/Skins/Technology/TechTheme.swift` | `TechStatLine` 增加可选 `note`（标签后的小徽标） | 「心肺」需要「诊断」标记；调用点仅 4 处，且新参数带默认值 |
| `apps/ios/tests/run-model-tests.sh` | 把 `CalibrationState.swift` 加入首个编译单元 | 让判据进 macOS 快闸门 |
| `apps/ios/tests/ModelRegression.swift` | 新增 6 条校准判据断言 | 钉住取值域 |
| `apps/ios/tests/VisualAcceptance.swift` | 断言「能力分析」标题 + 「效率」行（`waitForExistence(timeout: 20)`） | 抓"面板在、数据没接线" |
| `apps/ios/design/TECHNOLOGY_SKIN.md` | 写明五维来源、日期出处、缺值语义、五行同 tint 的理由 | 对齐文档 |

### 8.2 为什么 `CalibrationState.swift` 要单独成文件

不是因为判据短，而是因为**闸门结构**：`run-model-tests.sh` 能在 macOS 上秒级编译并真跑纯逻辑，但 `NativeFormat.swift` 整个文件导入 SwiftUI 且用到 `PixelColor`（`PixelTheme.swift` 被 `#if os(iOS)` 包住）⇒ 判据住在那里就**永远进不了这扇闸门**。

实测证据：把 `NativeFormat.swift` 加进模型回归的编译列表，报 6 处 `cannot find 'PixelColor' in scope`；把 `PixelTheme.swift` 一起加进去仍然报错（该文件整体被 iOS 条件编译挡掉）。

**⇒ 这就是 P0-1 能一路溜到真机的结构性原因**：它是"契约取值域"级错误，而当时**没有任何一条通道**能对它报警 —— `typecheck` 只查类型（`String` 比较永远合法）、UI 回归没覆盖像素风、模型回归够不着这个文件。抽出来之后它有了秒级守卫。

### 8.3 突变验证（不是"跑绿了"，是"错了会红"）

| 突变 | 载荷 | 结果 |
|---|---|---|
| 判据改回 `status != "ready"` | `bash apps/ios/tests/run-model-tests.sh` | **`Precondition failed: calibration 'completed' needs attention == false`**，`Illegal instruction: 4`，EXIT **132**（红） |
| 五维数据源改 `let dimensions: AbilityMetricSet? = nil`（面板在、数据没接线） | `xcodebuild ... -only-testing:...test01TodayAndBody` | `BUILD SUCCEEDED`（是行为突变不是编译错误），测试在 **`VisualAcceptance.swift:91`**（`staticTexts["效率"]`）失败，EXIT **65**；同时 `:90`（标题）**通过** ⇒ 证明第二条断言不可省 |
| 两者均恢复 | 同上 | `run-model-tests.sh` EXIT **0**（6 条校准断言全 PASS）；定向 UI 回归 EXIT **0** |

**并且验证了断言不是"恒红"**：`TechStatLine` 带 `.accessibilityElement(children: .combine)`，必须确认子 `StaticText` 仍可查询，否则 `["效率"]` 会永远失败、把真绿也判红。查无障碍树导出（`07-ability-accessibility`）实测：

```
Other,      label: '效率, 41', value: 41%
StaticText, label: '效率'          ← 子元素仍在树里，断言匹配得到
Other,      label: '心肺, 诊断, 59', value: 59%
StaticText, label: '诊断'
```

### 8.4 最终源码上的门禁实跑

`HEAD=bd1ee25`，`git diff HEAD -- apps/ios` 的 sha256 前缀 `f39b36c9`（**冻结源码后重跑**，避免"改动与构建交错"导致的证据失效）：

| 门禁 | 结果 |
|---|---|
| `bash apps/ios/tests/typecheck-ios.sh` | **EXIT 0** —— `类型检查 38 个文件`（新文件被 glob 自动纳入，原 37） |
| `bash apps/ios/tests/run-model-tests.sh` | **EXIT 0** —— 69 条 PASS（原 63 + 校准 6） |
| `xcodebuild ... test01TodayAndBody` | **EXIT 0**，`/tmp/rai-visual-final/` |

截图（`/tmp/rai-visual-final/screenshots/07-ability.png`）与参考图 `design/acceptance/.../07-ability.png` **逐项对上**：标题右侧日期 **`8月15日`完全相同**（即"被评估的那次训练"，不是今天 9月16日、也不是最新一条训练）、副标题、`效率 41 / 配速 48 / 心肺 59+诊断 / 稳定性 46 / 恢复 50` 与 `/v1/dashboard` 的 `40.74 / 47.84 / 58.99 / 46.22 / 50.15` 四舍五入一致。同时**无黄色校准告警框**（`calibration.status = 'completed'`）⇒ P0-1 与五维恢复各有一张图作证。

### 8.5 同类扫描（回答"还有没有别的"）

把 P0-1 的 bug 类（**拿契约里不存在的字面量做比较**）在整个 iOS 侧扫了一遍，共 31 处状态字面量比较，逐个对回契约取值域：

| 比较点 | 契约取值域 | 判定 |
|---|---|---|
| `freshness.state == "stale"`（两皮肤各 2 处） | `"unknown" \| "valid" \| "stale"`（`api-contracts:756`） | ✅ 在域内 |
| `freshness.state != "valid"`（`TechViews.swift:45`） | 同上 | ✅ 把 `unknown` 归"要提示"，方向正确 |
| `finished.status == "succeeded"` | `JobStatus` 含 `"succeeded"`（`:91`） | ✅ |
| `inspection.status == "unchanged"`（4 处） | `"ready" \| "unchanged"`（`apps/api/src/import-sources.ts:33/566`） | ✅ |
| `day.kind == "rest"` / `== "tempo"` / `== "interval"` | `MOBILE_SESSION_KINDS`（`packages/contracts:678-685`） | ✅ |
| `insight.kind == "positive"` | `"positive" \| "warning"`（`:840`） | ✅ |
| `segment.alertKind` 的 `"pace"`、心率区间 key | `api-contracts:550` 等 | ✅ |

**结论：P0-1 是孤例，没有第二处**。顺带记一个反直觉点免得下次误报：`"ready"` 在 `/v1/imports/inspect` 是**合法值**，只在 `MobileCalibrationCard.status` 里不合法 —— 同一个字面量在不同契约里有效性不同，判据必须绑到具体字段。

### 8.6 遗留（第二轮未动，等拍板）

- `WorkoutDetailResponse.dimensions`（`APIModels.swift:694`，**非可选**）全工程仍零读取 —— P1-2 只解决了一半（`NativeDashboardResponse.dimensions` 有消费方了）。服务端确实返回它（`data.ts:827`），所以解码不会失败，但字段是死的。
- ⚠️ `apps/ios/tests/VisualAcceptance*.swift` **不在 CI 里**：`.github/workflows/ci.yml` 的 `ios` job 只跑 `pod install` → `xcodebuild build RAI` → `run-model-tests.sh`，从不构建 `VisualAcceptance.xcodeproj`。⇒ 本次新增的两条 UI 断言**只有本机通道验证过**；该文件写错语法时 CI 不会报。这是一条独立的小风险（P2），要不要把 UI 回归纳入 CI 请拍板。
- 其余 P1-0 / P1-1 / P1-3 / P1-4-5 / P1-6 见 §3，本轮未动。

---

## 九、审查过程记录（跨会话可复用）

- 本轮**撤回**了一条自己的怀疑：曾判定详情页「增长速度/衰减」同屏两个来源会不一致，读 `dashboard-read-repository.ts:48-58` 与 `trends-read-repository.ts:57-69` 后确认同表同行，改判为 ✅（§4.7）。
- 通用判据补充：**`typecheck 通过` ≠ `能构建`**。本机 `typecheck-ios.sh` 全绿的同时 `xcodebuild` 报 `BUILD FAILED`，根因是宏插件宿主的嵌套沙箱；`swiftc -disable-sandbox` 与 `OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox'` 分别是两条通道的开关。
- 通用判据补充：**验收截图必须带可复核的时间/版本锚点**。本轮截图 mtime 早于源码 mtime，且图中含代码已删除的面板 ⇒ 证据链断裂（与"commit 说做了 X ≠ X 还在"同类）。
- 通用判据补充：**脚本内的网络与超时假设会随环境失效**，且**逐条定位前不要把"跑不通"写成"代码有问题"**。`run-visual-tests.sh` 在本机三重障碍（代理 502 / 40s < 实测 43s / 嵌套沙箱拒宏插件）都不是本次代码缺陷；三条各自解决后才拿到 `TEST SUCCEEDED`。
- 通用判据补充：**"删掉展示位" ≠ "删掉数据"**。移除 UI 前应对每个受影响字段做一次全目录 grep，确认是否还有入口——本轮 `postRun` / `phase` / `race.note` / `raceShapeScore` / `taper` 就没有，属静默丢失。
- 小技巧：`pgrep -f "a\|b"` 在本机（ERE）不生效，会把运行中的进程误判为"已结束"（本轮据此误判一次）；改用 `grep -c "[x]codebuild"` 或直接看输出文件大小。`ps` 在沙箱内不可用。
- 本轮所有临时产物（`/tmp/rai-*`、探针、临时脚本副本）都在仓库外，工作区保持干净。
