# 冰蓝科技皮肤

## 使用与结构

设置 → 外观皮肤 → 冰蓝科技 / 清新像素。

皮肤选择通过 `@AppStorage("rai.appearance.skin")` 持久化。未设置或未知值回退到像素风。顶层通过 `EnvironmentValues.appSkin` 注入选择，保持 `AppModel.shared`、当前五入口 Tab 状态和服务对象身份不变。所有修改服务、同步、保存目标、锁定课程和清除缓存的操作仍调用原业务模型。

`RAI/Skins/AppSkin.swift` 定义选择及预览卡；`Technology/TechTheme.swift` 定义独立视觉令牌和通用组件；`TechCharts.swift` 定义平滑折线、圆环、量程弧、周柱图与真实月度堆叠；`TechViews.swift` 定义业务页面；`TechAbilityDetailView.swift` 定义独立跑力详情页；`TechTodayMetrics.swift` 定义今日页最近训练的生理与机械指标卡；`TechSetupView.swift` 和 `TechLockSheet.swift` 定义连接和锁课流程。Xcode 使用文件夹自动同步，无需手动添加源文件。

没有把生成图片铺在界面上。数据、文本、图表、地图和控件全部由 SwiftUI / Charts / MapKit 原生渲染，可交互并使用真实 API 数据。图片仅作为视觉参考。

## 设计映射

| 设计板 | 实现 |
| --- | --- |
| 01 今日与身体 | RAI 大标题、里程大数字、周目标圆环、恢复与判定、当前跑力入口卡、周结构、最近训练、本周活动、身体指标 |
| 02 训练 | 原有类型筛选与分页、训练详情、深色路线、全部时序指标、分段条、数据质量、负荷、心率区间、覆盖信息 |
| 03 计划 | 周目标总览、横向周日程、独立编辑状态、目标与每日距离校验、锁课确认面板、原有 revision 冲突重载与错误提示 |
| 04 分析 | 统计/趋势/纪录分段入口、真实三月堆叠、12 周柱图、跑力曲线、心率环图、洞察、纪录卡 |
| 05 设置同步 | 原生轨道装饰、首次连接、服务发现、分组设置、外观选择、健康只读同步及权限、本机缓存及版本 |
| 06 状态详情 | 身体配速/心率分区和预测、缓存时效、离线禁写、空数据入口、加载状态和同步错误 |

## 实现约束

- 使用现有接口字段，不把生成图中的示例数值、虚构置信区间、错误文字和百分比当作产品数据。
- 训练详情保留真实存在的速度、功率、步频、海拔、步幅、垂直振幅、触地时长等指标；不因设计图未画完而删减。
- 同步只显示真实阶段及忙碌状态，不增加百分比计算、健康写入或后台任务。
- 目标编辑维持原有范围：每周 1–500 km、每日 0–80 km、轻松比例 0.4–0.95、质量课 0–4 次。
- 版本冲突继续由原模型处理和显示错误，不复制或替换服务端逻辑。科技风确认/错误采用独立深蓝面板，像素风继续使用原系统弹窗。
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

改版今日页时移除了旧的「训练阶段 / 比赛目标 / 最近一次训练反馈」上下文面板（`HEAD:bd1ee25` 的 `TechViews.swift:382-434`），下列 5 个载荷字段因此一度**在科技风没有任何展示位**（像素风完整保留），且当时连声明都没有。2026-09-17 全部补回。这类缺陷的形态是"契约在给值、服务端在算、像素风在显示，只有科技风不渲染，而所有门禁全绿"，靠人复查看不住 —— 因此同日在 `run-tech-presentation-tests.sh` 里加了一组字段覆盖断言。该断言**不手写字段清单**（初版只守这 5 个，等于"门禁宽度 < 结论宽度"：删掉 `injuryFlags` 整块照样全绿），而是从 `packages/api-contracts` 解析 `MobileTodayResponse` 的字段全集，强制「展示锚点 ∪ 显式例外 == 契约全集」：契约将来新增字段而无人给展示位时会自动变红。当前为 **19/22 有锚点，3 个元数据例外**（`timezone` / `lastSyncedAt` / `recommendationRevision`，逐条在脚本里写明了理由）。

| 字段 | 像素风展示位 | 科技风现状（2026-09-17 起） |
|---|---|---|
| `MobileTodayResponse.phase` | 「训练阶段」面板标题右侧 | 「今日推荐训练」标题右侧（`techPhaseName`） |
| `race.note` | 「训练阶段」面板正文 | 比赛目标卡副标题 |
| `race.shapeScore`（体型分） | 「比赛目标」三格之一 | 比赛目标卡指标格，按百分比渲染 |
| `race.taper`（减量） | 「比赛目标」三格之一 | 比赛目标卡指标格 |
| `postRun`（最近一次训练反馈） | 独立珊瑚色面板 | 训练判定卡下方的独立面板 |

同一面板里其余的 `race.target`（比赛目标卡）与 `weekStructure.remainingDistanceKm` / `easyHonesty` 在科技风一直另有入口，**不在**缺口内。

实现取舍：

- **比赛目标卡改为无条件渲染。** 服务端在没有目标时仍返回 `race.note` 引导文案（`mobile-coach.ts` 的 `buildRaceCard` 无目标分支），整卡写在 `if let target` 里会连这句引导一起吞掉。
- **`postRun` 放今日页，不放训练详情页。** 它只在"今天已经练过"时有值（`buildPostRun` 对非今日训练返回 `null`），本来就是今日页的即时信息；放详情页反而要用户先找到那次训练。位置对齐像素风的上下文面板：紧接训练判定之后。
- **`race.note` 与日期不再重复。** 服务端 note 已含"距 X 还有 N 天"与专项形态建议，所以卡片标题行回到"距离 · 日期"，不再单列 `daysUntil`（旧版把它拼成"（-3天）"，目标过期时会漏出负数）。
- **闭集枚举不直出机器码。** `techPhaseName` / `techStimulusMatchName` / `techRaceDistanceName` 住在纯 Foundation 的 `TechEnumPresentation.swift`（无 SwiftUI、无 `#if os(iOS)`），因此能被展示逻辑门禁编译并逐值断言；像素风对应的 `nativeDayPhaseName` / `nativeStimulusMatchName` / `nativeRaceDistanceName` 在 `NativeFormat.swift`。三者对应的契约类型都是闭集联合类型，域外值落中文兜底而不是把 `need_sync` / `half_marathon` 漏到界面上。

判定方式（可复核，现在应返回命中而不是空）：

```bash
grep -rn "data\.phase\|race\.note\|shapeScore\|taper\|postRun" apps/ios/RAI/Skins/Technology/
bash apps/ios/tests/run-tech-presentation-tests.sh   # 末尾 "Field coverage:" 一行
```

## 验证记录与待办

已执行：新增科技风和改动入口的 iOS 分支语法解析、科技风类型引用检查、`git diff --check`。确认 PixelTheme、PixelIcons、PixelCharts、PixelTabBar、NativeAppModel、APIClient、HealthKitSync 与改动前一致。未修改 Web 或评分逻辑，因此未运行 Web/响应式测试。

2026-09-09 在 Mac 上完成 Xcode 26.5（17F42）/ iOS Simulator 26.5 Debug 编译，arm64 与 x86_64 均通过；`run-model-tests.sh` 的 10 项模型回归全部通过。构建日志未发现 `warning:` / `error:` 诊断。

2026-09-10 已完成六张设计板对照、原生页面修正与 51 张截图复核；最终模拟器双架构和 iPhoneOS 未签名编译通过，10 项模型回归及 10 项原生 UI 测试全部通过。完整记录、逐页截图及验收边界见 [`visual-review/README.md`](acceptance/2026-09-09/visual-review/README.md)。不以构建成功或截图数量宣称与 AI 概念图逐像素一致。

可重复的原生 UI 验收入口为 `bash apps/ios/tests/run-visual-tests.sh`：复制独立数据库、使用专用模拟器，检查页面导航、编辑取消/越界、revision 冲突、缓存确认、皮肤持久化及故障状态。所有写操作仅针对独立副本；只读故障代理用于状态截图，不转发业务写入。

在已安装 iOS SDK 的 Mac 上执行（高德 SDK 由 CocoaPods 引入，构建入口是 workspace；`Podfile` 变更后先 `cd apps/ios && pod install`）：

```sh
xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
bash apps/ios/tests/run-model-tests.sh
```

高德底图受隐私门控：未同意时科技皮肤只显示离线轨迹，不创建 `MAMapView`；同意入口在首启说明页与两套皮肤设置的「地图底图」一栏。该说明页使用系统配色而非任一皮肤配色，属刻意的跨皮肤共享组件设计。

模拟器/真机验收：

1. 新安装默认像素风；设置切换科技风后仍在设置，重启保持科技风；切回像素后原导航和组件恢复。
2. 在两种皮肤中访问今日、训练列表及详情、本周活动、身体指标、计划、统计、趋势、纪录、设置和首次连接。
3. 科技风设置子页面返回路径正常；计划取消不保存；目标越界无法保存；锁定成功显示服务端确认；离线禁止保存与锁课。
4. 分别检查同步进行中/失败/成功、健康权限入口、清缓存取消/确认和服务连接失败。皮肤切换不能清除 Keychain、修改服务器、自动提交计划或写健康数据。
5. 与 `apps/ios/design/technology-v1/01-*.png` 至 `06-*.png` 逐页截图比对，校准圆角、间距、字重及深色层级；检查普通和大字体下的数据标签、触控区域和 VoiceOver。

设计图片及提示词已纳入仓库 `apps/ios/design/technology-v1`，打开该目录的 `index.html` 可浏览全部六张 4K 原图。这些文件仅用于设计评审，不打包进 iOS 应用。

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
- `bash apps/ios/tests/run-tech-presentation-tests.sh`：41 条展示逻辑断言 + 24 组颜色对比度检查 + 两组源码级覆盖检查通过。第一组是**契约驱动**的字段覆盖（从 `MobileTodayResponse` 解析全集，要求「锚点 ∪ 显式例外 == 全集」，当前 19/22 有锚点、3 个元数据例外；手写清单会随契约增长而静默变窄，实测删掉 `injuryFlags` 整块在新断言下 `EXIT=1`），第二组是「6 个闭集枚举映射覆盖全部契约值且展示层确实调用过它们」。两组都从源码取事实，取不到就报错而不是跳过。该脚本已挂在 `run-model-tests.sh` 里（不再需要手工发现），并刻意不加 `-O`——`-O` 下 `precondition` 仍会失败但断言名被吞成 `Illegal instruction: 4`，排障时无法定位。
- `bash apps/ios/tests/run-model-tests.sh`：七组纯逻辑回归全过 —— 模型、Keychain、坐标转换、课表映射与回执匹配、ServerSession、健康同步取消、科技风展示逻辑（含上面两组源码级覆盖检查）。
- `bash apps/ios/tests/run-visual-tests.sh`：**补完 5 个字段展示位后重跑，14/14 全部通过（0 failures / 0 unexpected，25m18s）**，证据归档在 [字段覆盖验收记录](acceptance/2026-09-17-field-coverage/README.md) —— 其中 `01-today-links.png` 直接拍到无目标态下的新比赛目标卡。此前一轮（同日 08:58）为 13/14，`test06Setup` 因测试运行器 `unexpected exit`（非断言失败）单独复跑通过；iPhone SE 3 与 iPhone 17 Pro Max 专项批次全部通过。像素皮肤用例（`pixel-settings-before-switch`、`pixel-restored`）继续通过，确认切换回归无色差/布局回归。

真机 Instruments、VoiceOver 实际朗读、真机“减少动态效果”与高德底图加载仍未验收，不作为已完成项。逐项证据、失败修复经过与性能数字见 [整体优化验收记录](acceptance/2026-09-16-tech-polish/README.md)。
