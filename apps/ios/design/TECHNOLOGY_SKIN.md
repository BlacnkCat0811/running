# 原生 iOS 视觉：冰蓝科技

> **2026-09-18 起原生端只有这一套视觉。** 文件与目录名（`TECHNOLOGY_SKIN.md`、`RAI/Skins/Technology/`）
> 是历史沿用，保留是为了不打断既有文档链接与导入路径；「皮肤切换」这一层已经不存在。

## 使用与结构

没有皮肤开关：App 启动即冰蓝科技（深色底、青蓝强调色），设置里不再有「外观皮肤」一栏。
旧安装残留的 `rai.appearance.skin` 键不再被读取，无需迁移。

`RAI/Skins/Technology/TechTheme.swift` 定义视觉令牌和通用组件；`TechCharts.swift` 定义平滑折线、圆环、量程弧、周柱图与真实月度堆叠；`TechViews.swift` 定义业务页面；`TechAbilityDetailView.swift` 定义独立跑力详情页；`TechTodayMetrics.swift` / `TechTodayRecovery.swift` 定义今日页的指标卡与恢复卡；`TechSetupView.swift` 和 `TechLockSheet.swift` 定义连接和锁课流程。壳层只有 `RAI/NativeViews.swift` 的 `NativeTab` + `NativeRootView`；共享格式化在纯 Foundation 的 `RAI/NativeFormat.swift`。Xcode 使用文件夹自动同步，无需手动添加源文件。

没有把生成图片铺在界面上。数据、文本、图表、地图和控件全部由 SwiftUI / Charts / MapKit 原生渲染，可交互并使用真实 API 数据。图片仅作为视觉参考。

## 设计映射

| 设计板 | 实现 |
| --- | --- |
| 01 今日与身体 | RAI 大标题、里程大数字、周目标圆环、恢复与判定、当前跑力入口卡、周结构、最近训练、本周活动、身体指标 |
| 02 训练 | 原有类型筛选与分页、训练详情、深色路线、全部时序指标、分段条、数据质量、负荷、心率区间、覆盖信息 |
| 03 计划 | 周目标总览、横向周日程、独立编辑状态、目标与每日距离校验、锁课确认面板、原有 revision 冲突重载与错误提示 |
| 04 分析 | 统计/趋势/纪录分段入口、真实三月堆叠、12 周柱图、跑力曲线、心率环图、洞察、纪录卡 |
| 05 设置同步 | 原生轨道装饰、首次连接、服务发现、分组设置、健康只读同步及权限、本机缓存及版本 |
| 06 状态详情 | 身体配速/心率分区和预测、缓存时效、离线禁写、空数据入口、加载状态和同步错误 |

## 实现约束

- 使用现有接口字段，不把生成图中的示例数值、虚构置信区间、错误文字和百分比当作产品数据。
- 训练详情保留真实存在的速度、功率、步频、海拔、步幅、垂直振幅、触地时长等指标；不因设计图未画完而删减。
- 同步只显示真实阶段及忙碌状态，不增加百分比计算或健康写入。后台机制（background delivery / `BGProcessingTask` / background URLSession）**不引入新的展示元素**：「磁盘上还卡着一批」只通过 `TechSyncPresentation.pending` 这一档表达，不新造进度条、倒计时或速度显示。
- 目标编辑维持原有范围：每周 1–500 km、每日 0–80 km、轻松比例 0.4–0.95、质量课 0–4 次。
- 版本冲突继续由原模型处理和显示错误，不复制或替换服务端逻辑。确认/失败/版本冲突统一用独立深蓝面板（`TechConfirmationSheet` / `TechRequestFailure`），不再使用系统 alert。
- 图中长页拆成多个手机视图，应用仍为连续滚动页面。不同数据长度、字号、设备尺寸和系统地图会影响最终排版。

### 2026-09-16 今日页「当前跑力」卡

- 今日页移除原「关键指标」面板（效率/心肺/稳定性三格），改为可点开的「当前跑力」入口卡，点击进入 `TechAbilityDetailView` 跑步能力详情页。
- 「荣耀指标」（心率/训练负荷/步频/触地时间）保留，它回答的是最近一次训练的生理与机械事实。
- 详情页按参考图组织为：跑步能力量程弧 → 能力分析（五维）→ 基础指标（VO₂ Max / 乳酸阈配速 / 乳酸阈心率）→ 成绩预测 → 评估趋势 → 配速区间。不展示近期跑力评估列表与数据依据说明卡。
- 能力分析五维取自 `/v1/dashboard` 的 `dimensions`，按效率 / 配速 / 心肺 / 稳定性 / 恢复呈现。标题右侧的日期取同一响应的 `latestWorkout.startedAt` —— 服务端用**同一条**记录（`assessment_status = 'eligible'` 里最近的一条）既产出 `dimensions` 又填充 `latestWorkout`（`data.ts`），所以它指的是五维对应的那次训练，不是"今天"也不是"最新一条训练"。
- 缺值不补零：分数渲染 `--`，`TechStatLine` 只画轨道不画填充，与真实的 0 分区分开（`07-ability-missing-dimensions` 即此形态）。
- 五行共用一个 tint：五维是同一分数的分解，色相不承载含义，配五种颜色会被读成五个独立指标（与「配速区间」那种"颜色即区间"的地方不同）。心肺带「诊断」徽标并在副标题说明它不进入当前跑力权重。
- 量程弧只把服务端 0–100 的真实跑力画成进度，刻度是等分量程装饰，不当作额外观测值。
- 借鉴参考图的相对刻度条，但配色统一到科技风令牌（青蓝主色、`TechColor.energy` 渐变、深蓝卡片），没有照搬参考图的橙色。

### 曾静默丢失的 5 个字段（2026-09-17 已补入口 + 进门禁）

改版今日页时移除了旧的「训练阶段 / 比赛目标 / 最近一次训练反馈」上下文面板（`HEAD:bd1ee25` 的 `TechViews.swift:382-434`），下列 5 个载荷字段因此一度**在界面上没有任何展示位**（当时像素风还在显示，所以更难被发现），且连声明都没有。2026-09-17 全部补回。这类缺陷的形态是"契约在给值、服务端在算、就是没人渲染，而所有门禁全绿"，靠人复查看不住 —— 因此同日在 `run-tech-presentation-tests.sh` 里加了一组字段覆盖断言。该断言**不手写字段清单**（初版只守这 5 个，等于"门禁宽度 < 结论宽度"：删掉 `injuryFlags` 整块照样全绿），而是从 `packages/api-contracts` 解析 `MobileTodayResponse` 的字段全集，强制「展示锚点 ∪ 显式例外 == 契约全集」：契约将来新增字段而无人给展示位时会自动变红。

🟢 **该缺口已于 2026-09-28 闭合**（历史记录保留如下）：契约在 `7427d7d feat(api): surface recent plan execution to today and the coach` 里新增了 `recentPlanExecution`，一度没有任何展示位，该提交也没有同步门禁清单；当时是**既有缺口、不是删除像素皮肤引入的**（`HEAD` 版本复算同样只剩 `recentPlanExecution` 未覆盖），门禁没有被绕过，也没有被塞进 `metadata_only` 蒙混。后续补上了展示位：`TechPlanView.swift:57-59` 渲染 `TechPlanExecutionPanel`（定义在 `TechPlanPreviewSheet.swift:64-85`），门禁把它列为 `field_anchors`（`run-tech-presentation-tests.sh:187`）。

当前计数（2026-09-28 实跑，`EXIT=0`）：**23/27 有锚点，4 个元数据例外**（`freshness` / `lastSyncedAt` / `recommendationRevision` / `timezone`，逐条在脚本里写明了理由），无未覆盖字段。

| 字段 | 现状展示位 |
|---|---|
| `MobileTodayResponse.phase` | 「今日推荐训练」标题右侧（`techPhaseName`） |
| `race.note` | 比赛目标卡副标题 |
| `race.shapeScore`（赛事准备度；原误标体型分） | 比赛目标卡指标格，按百分比渲染 |
| `race.taper`（减量） | 比赛目标卡指标格 |
| `postRun`（最近一次训练反馈） | 训练判定卡下方的独立面板 |

同一面板里其余的 `race.target`（比赛目标卡）与 `weekStructure.remainingDistanceKm` / `easyHonesty` 一直另有入口，**不在**缺口内。

实现取舍：

- **比赛目标卡改为无条件渲染。** 服务端在没有目标时仍返回 `race.note` 引导文案（`mobile-coach.ts` 的 `buildRaceCard` 无目标分支），整卡写在 `if let target` 里会连这句引导一起吞掉。
- **`postRun` 放今日页，不放训练详情页。** 它只在"今天已经练过"时有值（`buildPostRun` 对非今日训练返回 `null`），本来就是今日页的即时信息；放详情页反而要用户先找到那次训练。位置紧接训练判定之后（2026-09-16 定的排列，理由与皮肤无关：判定讲"今天能不能练"，赛后反馈讲"刚那次练成什么样"）。
- **`race.note` 与日期不再重复。** 服务端 note 已含"距 X 还有 N 天"与专项形态建议，所以卡片标题行回到"距离 · 日期"，不再单列 `daysUntil`（旧版把它拼成"（-3天）"，目标过期时会漏出负数）。
- **闭集枚举不直出机器码。** `techPhaseName` / `techStimulusMatchName` / `techRaceDistanceName` 住在纯 Foundation 的 `TechEnumPresentation.swift`（无 SwiftUI、无 `#if os(iOS)`），因此能被展示逻辑门禁编译并逐值断言。三者对应的契约类型都是闭集联合类型，域外值落中文兜底而不是把 `need_sync` / `half_marathon` 漏到界面上。（2026-09-18 删除像素皮肤后这里是唯一的展示映射，`run-tech-presentation-tests.sh` 里的穷举断言也只剩这一套；曾经存在、走"default 直出原值"策略的 `nativeDayPhaseName` / `nativeStimulusMatchName` / `nativeRaceDistanceName` 已随皮肤删除。）

判定方式（可复核，现在应返回命中而不是空）：

```bash
grep -rn "data\.phase\|race\.note\|shapeScore\|taper\|postRun" apps/ios/RAI/Skins/Technology/
bash apps/ios/tests/run-tech-presentation-tests.sh   # 末尾 "Field coverage:" 一行
```

## 验证记录与待办

已执行（2026-09-09/10，历史记录）：新增科技风和改动入口的 iOS 分支语法解析、科技风类型引用检查、`git diff --check`。当时确认 PixelTheme、PixelIcons、PixelCharts、PixelTabBar、NativeAppModel、APIClient、HealthKitSync 与改动前一致 —— 前四个文件已于 2026-09-18 整体删除，这条记录只说明当时的边界，不再代表当前代码。未修改 Web 或评分逻辑，因此未运行 Web/响应式测试。

2026-09-09 在 Mac 上完成 Xcode 26.5（17F42）/ iOS Simulator 26.5 Debug 编译，arm64 与 x86_64 均通过；`run-model-tests.sh` 的 10 项模型回归全部通过。构建日志未发现 `warning:` / `error:` 诊断。

2026-09-10 已完成六张设计板对照、原生页面修正与 51 张截图复核；最终模拟器双架构和 iPhoneOS 未签名编译通过，10 项模型回归及 10 项原生 UI 测试全部通过。完整记录、逐页截图及验收边界见 [`visual-review/README.md`](acceptance/2026-09-09/visual-review/README.md)。不以构建成功或截图数量宣称与 AI 概念图逐像素一致。

可重复的原生 UI 验收入口为 `bash apps/ios/tests/run-visual-tests.sh`：复制独立数据库、使用专用模拟器，检查页面导航、编辑取消/越界、revision 冲突、缓存确认及故障状态。所有写操作仅针对独立副本；只读故障代理用于状态截图，不转发业务写入。

在已安装 iOS SDK 的 Mac 上执行（高德 SDK 由 CocoaPods 引入，构建入口是 workspace；`Podfile` 变更后先 `cd apps/ios && pod install`）：

```sh
xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
bash apps/ios/tests/run-model-tests.sh
```

高德底图受隐私门控：未同意时训练详情只显示离线轨迹，不创建 `MAMapView`；同意入口在首启说明页与设置里的「地图底图」一栏。该说明页使用系统配色而非页面配色，属刻意的解耦设计（它挂在 App 根部，改版页面时不应该被迫同步改它）。

模拟器/真机验收：

1. 冷启动（无任何皮肤相关启动参数）直接进入冰蓝科技；终止后重启仍在同一界面，不出现皮肤选择入口。
2. 访问今日、训练列表及详情、本周活动、身体指标、计划、统计、趋势、纪录、设置和首次连接。
3. 设置子页面返回路径正常；计划取消不保存；目标越界无法保存；锁定成功显示服务端确认；离线禁止保存与锁课。
4. 分别检查同步进行中/失败/成功、健康权限入口、清缓存取消/确认和服务连接失败。上述操作都不能清除 Keychain、修改服务器、自动提交计划或写健康数据。
5. 与六张设计板原图（3840 × 2160；2026-09-24 起移出仓库，位置见 `technology-v1/README.md` 的「仓库体积」）逐页截图比对，校准圆角、间距、字重及深色层级；检查普通和大字体下的数据标签、触控区域和 VoiceOver。

设计图的生成提示词与设计规范已纳入仓库 `apps/ios/design/technology-v1`；六张 4K 原图本身已于 2026-09-24 移出仓库（原因与位置见该目录 README 的「仓库体积」）。这些文件仅用于设计评审，不打包进 iOS 应用。

2026-09-10 继续补齐首页训练指标、真实睡眠历史、月度微曲线与科技风确认面板，详情见 [本轮校准记录](acceptance/2026-09-10-replica/README.md)。

2026-09-16 今日页「当前跑力」入口卡与跑步能力详情页：`bash apps/ios/tests/typecheck-ios.sh` 37 文件通过；`run-model-tests.sh` 模型回归通过；模拟器 Debug 编译通过；`run-visual-tests.sh` 10 项原生 UI 回归全部通过（含新增的跑力入口与详情页断言与 `07-ability*` 截图）。改动文件、数据来源、截图与验收边界见 [`acceptance/2026-09-16-ability-card`](acceptance/2026-09-16-ability-card/README.md)。

UI 验收在全新模拟器上需要先回答高德首启隐私门控，否则该面板会拦截手势；本轮用 `xcrun simctl spawn <device> defaults write app.rai.running.debug rai.privacy.amap.state -string declined` 预置后再跑，未修改 App 行为。

## 整体体验优化（2026-09-16 起）

科技皮肤进一步统一色彩层级、间距、可缩放字体和按压反馈；首页优先展示判定与建议，健康同步提供独立阶段反馈、原因展开与重试。大字号通过指标网格/纵向布局重排，计划日程不再挤压成七个小触控列，表单支持完成输入与编辑状态切换后回顶。

科技根布局现在为底栏保留真实空间，替代页面固定 90pt 避让；导航内容裁切在视口内。返回使用可见图标与局部系统边缘返回手势桥接，像素皮肤的组件与业务服务保持不变。

新 `TechSeriesChart` / `TechPlotData` 将科技图表的显示数据整理、峰谷抽样和逐点查看独立出来；路线预计算/更新去重、地图按需加载、布局测量复用及分段统计预计算减少重复渲染。原始数据、服务器评分和健康权限范围没有改变。

实施清单、失败修复经过、跨机型截图和验证边界见 [整体优化验收记录](acceptance/2026-09-16-tech-polish/README.md)。模拟器与主机算法测量不替代真机帧率、耗电或 VoiceOver 验收。

### 2026-09-17 整体优化验收结论

科技皮肤整体优化（视觉令牌、自适应重排、同步反馈、返回手势、图表抽样与交互、路线与布局渲染）已完成实现与模拟器验收：

- `bash apps/ios/tests/typecheck-ios.sh`：47 文件类型检查通过（`VerdictPresentation.swift` 由 45 增至 46，`TechEnumPresentation.swift` 再增至 47；该脚本按 glob 自动纳入新文件，无需手工登记）。
- `bash apps/ios/tests/run-tech-presentation-tests.sh`：41 条展示逻辑断言 + 24 组颜色对比度检查 + 两组源码级覆盖检查通过（**展示断言条数随代码增长，不是常量**：2026-09-28 实跑为 **52** 条；24 组颜色对与两组覆盖检查不变）。第一组是**契约驱动**的字段覆盖（从 `MobileTodayResponse` 解析全集，要求「锚点 ∪ 显式例外 == 全集」，当前 23/27 有锚点、4 个元数据例外；手写清单会随契约增长而静默变窄，实测删掉 `injuryFlags` 整块在新断言下 `EXIT=1`），第二组是「6 个闭集枚举映射覆盖全部契约值且展示层确实调用过它们」。两组都从源码取事实，取不到就报错而不是跳过。该脚本已挂在 `run-model-tests.sh` 里（不再需要手工发现），并刻意不加 `-O`——`-O` 下 `precondition` 仍会失败但断言名被吞成 `Illegal instruction: 4`，排障时无法定位。
- `bash apps/ios/tests/run-model-tests.sh`：七组纯逻辑回归全过 —— 模型、Keychain、坐标转换、课表映射与回执匹配、ServerSession、健康同步取消、科技风展示逻辑（含上面两组源码级覆盖检查）。
- `bash apps/ios/tests/run-visual-tests.sh`：**补完 5 个字段展示位后重跑，14/14 全部通过（0 failures / 0 unexpected，25m18s）**，证据归档在 [字段覆盖验收记录](acceptance/2026-09-17-field-coverage/README.md) —— 其中 `01-today-links.png` 直接拍到无目标态下的新比赛目标卡。此前一轮（同日 08:58）为 13/14，`test06Setup` 因测试运行器 `unexpected exit`（非断言失败）单独复跑通过；iPhone SE 3 与 iPhone 17 Pro Max 专项批次全部通过。像素皮肤用例（`pixel-settings-before-switch`、`pixel-restored`）当时继续通过，确认切换回归无色差/布局回归（这两个用例已于 2026-09-18 随像素皮肤删除，见下节）。

真机 Instruments、VoiceOver 实际朗读、真机“减少动态效果”与高德底图加载仍未验收，不作为已完成项。逐项证据、失败修复经过与性能数字见 [整体优化验收记录](acceptance/2026-09-16-tech-polish/README.md)。

### 2026-09-18 今日页紧凑恢复卡与跑力刻度

- 按今日页第二版设计收紧恢复卡：标题同行保留恢复状态，下方并排展示睡眠时间、静息心率、HRV；去掉首页的基线比较及长说明，不新增分数或历史曲线。原始恢复数据及身体指标详情不变。
- 恢复不足使用琥珀色，需要休息使用珊瑚色；缺值显示「无记录」，辅助功能大字号切为纵向布局。
- 当前跑力使用 0–100 横向刻度及当前值定位点，替换首页半圆仪表；右侧改为 `chart.bar.xaxis` 小型分析图标，不复用今日训练的跑步圆环。跑力详情页半圆图、入口、校准提示及近七天变化保持不变。
- 新组件：`RAI/Skins/Technology/TechTodayRecovery.swift`。仅修改今日页；像素皮肤于同日被整体删除（见下节），Web 不变。
- 验证：iOS 48 文件类型检查通过（删除像素皮肤前；删除后为 43 文件通过）；新增紧凑恢复/横向跑力源码展示检查通过；当时现有 41 项展示逻辑检查通过（2026-09-28 实跑为 52 项）。整体展示及模型回归脚本当时仍受 `recentPlanExecution` 契约展示覆盖缺口影响（该缺口已于 2026-09-28 闭合），未绕过门禁。
- Xcode Debug Simulator 完整构建通过（含 arm64 / x86_64）；当前无已启动模拟器，本轮未执行 UI 截图验收。

### 2026-09-18 移除像素皮肤（原生端收敛为单皮肤）

原生端像素皮肤（「清新像素」）整体删除，App 收敛为冰蓝科技一套视觉。删除范围与迁移说明：

- **删除的源文件**：`RAI/PixelTheme.swift`（`PixelColor` / `PixelMetrics` 与全部 `Pixel*` 组件）、`RAI/PixelCharts.swift`、`RAI/PixelIcons.swift`、`RAI/PixelTabBar.swift`、`RAI/Skins/AppSkin.swift`（皮肤枚举、`EnvironmentValues.appSkin`、`AppSkinPicker`）、`RAI/NativeHeartRateChart.swift`（引用 `PixelColor` 且已无调用方）。
- **重写的文件**：`RAI/NativeViews.swift` 从 ~2600 行收缩为壳层（`NativeTab` 五入口 + `NativeRootView`，原来它同时承载像素页面）；`RootView.swift` 的 `SetupView` 删掉 `pixelBody` / `serverPlaceholder` 与两个没人再读的草稿状态，固定走 `TechSetupView`；`RAIApp.swift` 去掉 `@AppStorage(AppSkin.storageKey)`，固定 `.preferredColorScheme(.dark)` + `.tint(TechColor.cyan)`。
- **迁移到保留文件的两个符号**：`NativeTab`（原在 `PixelTabBar.swift`，但 `TechTabBar` 依赖它）进 `NativeViews.swift`；`nativeSessionSymbol`（原在 `PixelIcons.swift`，纯符号名映射、与皮肤无关，`TechViews.swift` 三处在用）进 `NativeFormat.swift`。
- **共享层清理**：`NativeFormat.swift` 删掉只服务像素页的 5 个函数（`nativeHeartRateZoneColor` / `nativeToneColor` / `nativeDayPhaseName` / `nativeStimulusMatchName` / `nativeRaceDistanceName`）。删完后它不再 `import SwiftUI`、不再引用 `PixelColor`，**成为纯 Foundation**，因此被 `run-model-tests.sh` 纳入编译列表 —— 此前它正因为拖进 `PixelColor` 而进不了那扇秒级闸门（`CalibrationState.swift` 的注释记录了这段历史）。
- **UI 入口变化（用户可见）**：设置页与首次连接页的「外观皮肤」一栏、皮肤选择器、以及皮肤切换用的系统 alert 全部移除。旧安装残留的 `rai.appearance.skin` 键不再被读取，**不需要迁移**；曾经选过冰蓝科技的安装行为不变。启动外观从"跟随系统"变为固定深色。
- **刻意没动的东西**：Web 的 iOS 壳像素界面（`apps/web/src/ios/*`、`ios-pixel.css`）与 `apps/ios/design/ios-app-design.html` 设计稿仍在用，不属本次范围；`MapPrivacy` 隐私门控页仍走系统配色。
- 验证：`bash apps/ios/tests/typecheck-ios.sh` 43 文件通过（删除 6 个文件后，glob 自动收敛）；`bash apps/ios/tests/run-model-tests.sh` 七组通过（当时 `recentPlanExecution` 字段覆盖断点仍在，该断点先于本次改动存在、已于 2026-09-28 闭合，见上文字段小节），其余断言全绿；`MapPrivacyConsentView.swift` 用户可见文案曾引用像素皮肤，一并改写后**同时纳入** typecheck 覆盖（它本不依赖高德 SDK，原先被排除）。`run-tech-presentation-tests.sh` 的闭集枚举断言改为单皮肤（3 个 `tech*` 映射 + 视图调用点），像素侧副本与对应断言随皮肤删除。
- UI 截图回归未在本轮执行（需要已启动的模拟器 + 验收库）：`VisualAcceptance` 删除了 `test09AppearancePersistence`，`test05Settings` 去掉外观入口步骤，启动参数不再传 `-rai.appearance.skin`。
