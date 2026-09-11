# RAI 原生 iOS 应用

## 外观皮肤

在 **设置 → 外观皮肤** 中切换「清新像素」和「冰蓝科技」，选择立即生效并保存在本机，重新启动仍保留。已有安装和首次安装默认继续使用清新像素。

科技风位于 `RAI/Skins/Technology`，使用独立的颜色、卡片、图表、导航及页面布局，复用现有 `NativeAppModel` 和 API。切换不修改服务配置、健康同步、训练记录或目标。原 Pixel 主题、图标和图表文件保持不变。

科技风的实现范围、设计映射及验收进度见 `design/TECHNOLOGY_SKIN.md`。2026-09-10 已完成 Xcode 模拟器及真机 SDK 编译、科技皮肤视觉修正、51 张原生截图复查和 10 项 UI 回归；构建、UI 回归结果及与设计图的必要差异见 [`验收记录`](design/acceptance/2026-09-09/visual-review/README.md)。不将 AI 设计图中的示例数字、失真文字或虚构图表当作产品数据。

完整六张 4K 设计图、浏览页及生成提示词已提交在 [`design/technology-v1`](design/technology-v1/index.html)。

这是给 iPhone 使用的 SwiftUI 原生应用。手机不运行 Node.js、评分核心或服务端 SQLite；数据和模型结果仍由已配置的 RAI API 服务负责。旧 WKWebView 文件保留为开发期回退路径，不是原生页面的验收替代品。

## 一次跑通

1. 在仓库根目录启动可被手机访问的 API/Web 开发服务器：

   ```bash
   npm run dev:device
   ```

   终端会打印类似 `http://192.168.x.x:5173` 的地址。

2. 安装高德依赖、配置 Key 并打开 CocoaPods workspace：

   ```bash
   cd apps/ios
   cp Configs/AmapKey.xcconfig.example Configs/AmapKey.xcconfig   # 填入自己的高德 iOS Key
   pod install
   cd ../..
   npm run open:ios
   ```

   高德 SDK 由 CocoaPods 引入，**构建入口是 `RAI.xcworkspace`**：直接打开 `RAI.xcodeproj` 会在链接阶段失败（`ld: framework 'Pods_RAI' not found`）。`Podfile` / `Podfile.lock` 变更后需要重新 `pod install`。高德 Key 见下方「高德 Key 配置」——仓库不含明文 Key。

3. 这台虚拟机的 Xcode 还缺 iOS 平台组件（现在会提示 *iOS 26.5 is not installed*）。先装：

   ```bash
   xcodebuild -downloadPlatform iOS
   ```

   或 Xcode → Settings → Components → iOS 26.5。没有这一步就不能编真机。

4. Xcode → Settings → Accounts，登录你的 Apple ID。  
   选中 RAI target → Signing & Capabilities → Team 选 Personal Team。

5. 用 USB 把 iPhone 12 Pro Max 直连到这台虚拟机（VMware：虚拟机 → 可移动设备 → iPhone → 连接到虚拟机），手机上点「信任」。

6. 运行目标选 **iPhone 12 Pro Max**，Cmd+R。

7. 首次安装后，到 iPhone **设置 → 通用 → VPN 与设备管理**，信任这台电脑的开发者证书。

8. App 的“设置”中填写第 1 步打印的服务器地址和 API Token（如服务启用了 Token）。连接成功后，今日、训练、计划、分析和设置均使用原生 SwiftUI 页面。

## 构建与验收

命令行统一走 workspace（`pod install` 见「一次跑通」第 2 步）：

```bash
# 无签名模拟器编译
xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/rai-derived CODE_SIGNING_ALLOWED=NO build

# 模型/Keychain/坐标转换回归（纯 Swift，不需要模拟器和 iOS SDK）
bash apps/ios/tests/run-model-tests.sh

# 坐标转换权威对拍：用高德 SDK 自带的 AMapCoordinateConvert 校验本地 GCJ02
# （需要 Pods + 一个已启动的模拟器；不需要 Key，是纯函数）
bash apps/ios/tests/run-coordinate-sdk-check.sh

# 原生 UI 与视觉验收：复制独立数据库副本 + 专用模拟器，截图导出到 $RAI_VISUAL_OUTPUT
bash apps/ios/tests/run-visual-tests.sh
```

- `run-visual-tests.sh` 自己构建 workspace 并把 App 装到 `RAI Technology Acceptance` 模拟器；临时验收服务只监听 8792–8794，且只写数据库副本。追加 `-only-testing:VisualAcceptance/VisualAcceptance/test02Workouts` 之类的参数可以只跑单个用例（注意 `-only-testing` 要用 `target/class/method` 三段式，写错会「Executed 0 tests」并假通过）。
- `run-model-tests.sh` 现在跑三组：模型/API/DTO、Keychain、坐标转换（WGS-84→GCJ-02）。坐标一项的锚点值来自高德官方 SDK 实测，纯数学、零依赖，CI 也会跑。
- `run-coordinate-sdk-check.sh` 用高德 SDK 的 `AMapCoordinateConvert(_, .GPS)` 现场对拍本地实现（实测境内差 0.02–0.6 m、境外原样），是坐标逻辑的权威复核；因为要链接 iOS 静态框架，只能在 macOS + 模拟器上跑，不进 CI。
- 本机 CocoaPods 1.17.0 已装在 gem 目录但没有加入 PATH（`pod: command not found`）：`export PATH="$(gem environment | awk -F': ' '/EXECUTABLE DIRECTORY/{print $2}'):$PATH"`，或 `gem install cocoapods`。`Pods/` 不入库（`.gitignore` 已忽略，`pod install` 按 `Podfile.lock` 还原）；只有 `Podfile` / `Podfile.lock` 变动时才需要重新 `pod install`。
- 若 `xcrun` 报 `unable to find utility "simctl"`，说明命令行工具指向 CommandLineTools：`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`（或 `sudo xcode-select -s /Applications/Xcode.app`）。
- `.github/workflows/ci.yml` 的 `ios` job 与本机命令一致：先 `pod install`，再用 workspace 构建模拟器 target，最后跑 `run-model-tests.sh`。

## 这台 VMware 虚拟机要注意

- 当前网卡是 NAT（`192.168.126.130`）。iPhone 走自己的 Wi-Fi 时，通常 **访问不到** 这个地址。
- 把 VMware 网卡改成 **Bridged（桥接）**，让虚拟机和 iPhone 在同一局域网。
- 没有签名证书时，Xcode 无法把 App 装到真机。必须登录 Apple ID。
- Xcode 26.5 的 SDK 是 iOS 26.5。连上 iOS 26.6.1 真机后，Xcode 会从手机拷设备支持文件；若提示 Developer Disk Image 失败，在 Xcode 里等它处理完再 Run。
- 这台虚拟机的 Xcode 需要先下载 iOS 26.5 平台（约 10.6 GB）。没有它，运行目标里不会出现 iPhone。

## 产品边界

- 不在手机上跑 Node.js、评分核心或服务端 SQLite，也不向 Apple 健康写入。
- 新的同步、目标修改和锁课需要联网；已加载的首页、训练和分析可在服务暂时不可用时继续查看。
- 手机不会在离线状态下生成或确认新的训练安排。健康同步仅在前台执行，不注册或调度后台同步任务。

## 原生页面与移动端 API 映射

## 清新像素风原生 UI

原生页面现已使用统一的清新像素视觉系统，代码位于：

- `RAI/PixelTheme.swift`：纸白、墨绿、主绿、薄荷、青色、珊瑚和黄色令牌，以及点阵背景、卡片、指标格、按钮和分段器。
- `RAI/PixelIcons.swift`：像素跑者和训练类型图标。
- `RAI/PixelCharts.swift`：活动圆环、周柱图、月度柱图、阶梯趋势图。
- `RAI/PixelTabBar.swift`：今日、训练、计划、分析、设置五入口底部导航。
- `RAI/NativeViews.swift`：原生页面和所有业务状态的像素化呈现。

页面功能保持由现有 `NativeAppModel`、`RaiAPIClient`、`CacheStore` 和
`HealthKitSync` 提供：在线时 API 优先，离线时展示缓存；所有新增写操作仍要求
联网，手机端不复制服务端评分或聚合逻辑。

视觉改造覆盖：

- 首次连接和服务发现页
- 今日 Hero 卡、活动圆环、跑力、判断、恢复、周计划、比赛目标和最近训练
- 训练筛选、分页、训练详情、路线、全部时序指标、分段、负荷和区间暴露
- 周目标编辑、课程锁定、revision 冲突回退
- 统计、12 周趋势、跑力评估、洞察和个人纪录
- 服务连接、HealthKit 只读同步、缓存管理和版本信息

像素组件同时提供文本状态和 VoiceOver 描述，不依赖颜色单独表达完成、
过期、错误或离线状态；底部导航在开启 Reduce Motion 时关闭切换动画。

设计稿 `apps/ios/design/ios-app-design.html`（清新像素风 v3）与原生 SwiftUI 五个入口共用以下后端端点（契约类型在 `packages/api-contracts`，OpenAPI 已登记）：

| 设计稿页面 | 端点 | 数据说明 |
| --- | --- | --- |
| 首页（今日卡/活动圆环/周柱图/最近训练） | `GET /v1/mobile/today` | 今日距离/时长/配速/卡路里/次数；本周跑量 + 目标进度（goal 来自 `/v1/mobile/goals`）；周内逐日柱（周一..周日，零填充）；最近 5 条训练；`latestDataDate` 为数据最新日期（滞后时 UI 显示"数据截至"提示） |
| 训练（列表/分段器） | 复用既有 `/v1/workouts` 列表接口 | 无新增端点 |
| 统计（月度柱/指标格/心率区间） | `GET /v1/mobile/statistics` | 近 3 自然月（oldest first）按跑步/骑行/其他拆分；28 天滚动汇总 + 环比；近 28 天心率区间占比（coverage ≥ 0.3） |
| 趋势（阶梯折线/洞察/纪录） | `GET /v1/mobile/trends` | 12 个连续 ISO 周（周一对齐，按数据最新日锚定，空周零填充）、4 周增幅（前 4 周为 0 时为 `null`，UI 显示"数据不足"占位）、个人纪录（最快 5km/10km、最长距离、最大月）、正/警告洞察 |
| 设置（周目标编辑） | `GET/PUT /v1/mobile/goals` | 周跑量目标，文件持久化（`var/mobile-goals.json`），1–500km 校验 |

所有聚合窗口按 **数据最新日期（`MAX(local_date)`）** 锚定而非墙钟——Apple Health 导入滞后时，统计/趋势仍渲染完整窗口（含 28 天滚动汇总与环比）。

真实库冒烟：`bash scripts/mobile-smoke.sh`（自动起 API → 校验四端点 → goals 往返与越界校验）。

原生实现的契约、同步状态机、验收记录和排障说明分别见：

- `docs/IOS_NATIVE_API_CONTRACT.md`
- `docs/IOS_NATIVE_SYNC_PROTOCOL.md`
- `docs/IOS_NATIVE_ACCEPTANCE.md`
- `docs/IOS_NATIVE_RUNBOOK.md`

### 今日判定、恢复与训练详情（2026-09-10）

- 训练判定根据可用负荷、恢复信号及训练结构生成，不再仅因导入日期早于今天而显示过期或替换判定。缺少恢复样本或个人基线时仍给出保守建议。
- 恢复卡读取最近一次主睡眠所在日期的睡眠、HRV、静息心率，并使用该日期之前的个人基线；说明中保留证据日期。`recovered`、`reduced`、`depleted` 分别显示恢复良好、恢复不足、需要休息，不生成不存在的恢复分数。
- 两套皮肤的路线中，科技皮肤显示高德底图 + 轨迹及起终点（见下节），像素皮肤为无底图的纯 Canvas 轨迹。两者均支持恢复完整路线视野（fit-to-route）和切换离线轨迹。
- 心率时序采用深色卡片、青色曲线与渐变填充，显示训练平均心率、样本最大心率及分钟/秒时间轴。API 抽样保留峰值，平均心率继续使用训练汇总值。

以上变更需要同时更新 API 服务和 iOS 应用；离线缓存会在下次成功刷新后更新。

### 高德原生地图（CocoaPods）

在 `apps/ios` 执行：

```bash
pod install
open RAI.xcworkspace
```

请使用 CocoaPods 生成的 workspace 构建，不要直接打开 `RAI.xcodeproj`。

#### 隐私门控（未同意不初始化地图 SDK）

高德要求 App 在用户同意隐私政策后才能初始化 SDK（`updatePrivacyAgree(.didAgree)` 表示"用户已授权"）。因此：

- 首次打开 App 会先显示一页说明（含高德隐私政策链接），可选择「同意并启用地图」或「仅使用离线轨迹」；选择记在 `UserDefaults` 的 `rai.privacy.amap.state`。
- 只有同意后才设置 Key 并调用 `MAMapView.updatePrivacyShow/Agree`，而且必须在任何 `MAMapView` 实例化之前完成（`MapPrivacy.configureIfAgreed()` 在 `AppModel.init` 中执行）。
- 未同意时科技皮肤的训练详情只显示离线轨迹，**不会创建 `MAMapView`**；菜单里改为「启用高德底图」入口。
- 两套皮肤的「设置」里都有「地图底图」一栏，可随时开启或关闭（关闭后不影响离线轨迹）。
- 说明页刻意使用系统配色，不做皮肤化：它同时服务两套皮肤。

#### 高德 Key 配置（不明文入库）

Key 存在本地 `Configs/AmapKey.xcconfig`（`.gitignore` 已忽略），由 `Podfile` 的 `post_install` 注入 CocoaPods 生成的 `Pods-RAI.*.xcconfig`；`RAI/Info.plist` 只写 `$(RAI_AMAP_API_KEY)`，Swift 侧从 Info.plist 读取。

```bash
cd apps/ios
cp Configs/AmapKey.xcconfig.example Configs/AmapKey.xcconfig   # 编辑并填入 iOS 平台 Key
pod install                                                    # 打印「已注入高德 Key 到 N 个 xcconfig」即成功
```

- 也可用环境变量覆盖（优先级更高）：`RAI_AMAP_API_KEY=xxx pod install`。
- 没有 Key 时 `pod install` 只打印提示、构建照常成功，但高德地图不加载（瓦片空白）。
- Key 必须绑本 App 的 Bundle ID；换 Key 或改 Bundle ID 后需重新 `pod install`。
- 不再需要改 `Info.plist`：那里只有变量占位符。

默认视野：首次加载与切换训练时，使用整条路线的边界自动 fit，并以边界中心对齐地图卡片正中心；高德会根据轨迹范围自动调整缩放级别，长距离跑步会自动缩小到能完整显示整条轨迹。菜单中的“显示完整路线”会再次执行同样的 fit。

注意：`MAMapView` 实例化时 frame 为空，高德渲染器就绪前 `setVisibleMapRect` 会被静默忽略（实测停留在地图默认的市级视野，轨迹缩成几十 pt 的小团，实测截图里整张卡片只有北京全市底图）。渲染器启动期间主线程被阻塞约 1.3 s，瓦片加载回调在联网时约 2.5–4.4 s、离线时可能不来，因此 `RouteMapContainer` 以 0.2 s 间隔重试 fit，并把 `mapViewDidFinishLoadingMap` / `mapInitComplete` 作为兜底；只有 `visibleMapRect` 真正覆盖路线边界才算完成（最多 12 次）。

#### 坐标系约定（WGS-84 存储 / GCJ-02 显示）

- 数据库、API、离线轨迹画布全部保留 **WGS-84** 原始 GPS 坐标（Apple Watch 记录坐标系），不做任何转换。
- 仅科技皮肤的高德底图（`TechRouteView` 的 `RouteMapContainer`）在渲染前经 `GCJ02.fromWGS84`（`RAI/CoordinateConversion.swift`）转 GCJ-02：高德底图与 `convert(_:toPointTo:)` 均以 GCJ-02 为准，直接绘制 WGS-84 会整体偏移约 300–600 m。
- 境外坐标（中国大陆范围外）原样通过，不做转换。
- 该算法已与 coordtransform 公开参考值锚定（差异 < 0.1 m）并抽样验证北上广深四城偏移量（479–625 m，方向与量级符合 GCJ-02 特征）。
- 不使用高德 `MATraceManager` 轨迹纠偏：绑路会吸附/歪曲真实 GPS，与"真实轨迹"的产品定位冲突。
