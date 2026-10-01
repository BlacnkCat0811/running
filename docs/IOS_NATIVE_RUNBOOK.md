# RAI 原生 iOS 运行说明

## 前置条件

- macOS、Xcode 和 iOS 17 或更新的 SDK。
- 已安装本项目使用的 iOS 平台组件。
- CocoaPods（高德 SDK 由 `apps/ios/Podfile` 引入）。
- Apple ID/开发团队可签名；HealthKit capability 已打开。
- iPhone 与 API 服务处于同一局域网，或通过个人 VPN 访问。

## 构建与运行

从仓库根目录启动可被手机访问的服务：

```bash
npm run dev:device
```

安装依赖后打开 `apps/ios/RAI.xcworkspace`（**不是** `RAI.xcodeproj`），选择 RAI scheme 和真实 iPhone，检查 Signing & Capabilities 中的 Team，执行 Build/Run。项目最低部署版本保持 iOS 17。

高德 SDK 以 pod 形式链接，只打开 `RAI.xcodeproj` 会构建失败（`ld: framework 'Pods_RAI' not found`）；`Podfile` / `Podfile.lock` 变更后需重新安装依赖：

```bash
cd apps/ios && pod install
```

高德 Key 不明文入库：本地放在 `apps/ios/Configs/AmapKey.xcconfig`（由 `.gitignore` 忽略，模板为同目录 `AmapKey.xcconfig.example`），`Podfile` 的 `post_install` 把它注入 CocoaPods 生成的 `Pods-RAI.*.xcconfig`；`RAI/Info.plist` 只留 `$(RAI_AMAP_API_KEY)` 占位符。新建工作副本后：

```bash
cd apps/ios
cp Configs/AmapKey.xcconfig.example Configs/AmapKey.xcconfig   # 填入已绑定本 App Bundle ID 的 iOS Key
pod install                                                    # 输出「已注入高德 Key 到 2 个 xcconfig」即生效
```

没有 Key 时构建依旧成功，但高德底图不加载。`Pods/` 与 `AmapKey.xcconfig` 都不入库，workspace 由 CocoaPods 生成，不手工编辑。

高德底图还有隐私门控：首次打开 App 先要选择是否同意。只有同意后才初始化 SDK 并创建 `MAMapView`；未同意时训练详情显示离线轨迹，设置页可随时开启或关闭。

无签名模拟器构建可用于快速验证 SwiftUI/API 层编译：

```bash
xcodebuild -workspace apps/ios/RAI.xcworkspace \
  -scheme RAI \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug \
  -derivedDataPath /tmp/rai-derived \
  CODE_SIGNING_ALLOWED=NO build
```

以上仅验证当前环境的模拟器编译，不沿用历史机器的SDK、设备UDID或旧“已通过”记录。
真实iPhone安装、签名、HealthKit权限和路线能力仍需按下方步骤验收。

### 验证入口

改完原生端源码，先跑**自动门禁**，再谈截图：

```bash
npm run test:ios
```

它等价于 `apps/ios/tests/run-ios-gates.sh`：`typecheck-ios.sh`（除 3 个高德依赖文件外的全部
`RAI/**` 源码做真实类型检查）+ `run-model-tests.sh`（纯逻辑回归聚合：模型/DTO、Keychain、
坐标转换、课表映射、会话探测、健康同步取消、缓存与续传日志、Tech 展示层与对比度、
今日页版式）。非 macOS 或没装 Xcode 时它会**显式跳过并打印"本次没有检查任何 iOS 源码"**，
不假装通过。`.githooks/pre-commit` 在 `apps/ios/` 有改动时自动跑它。

下面两条**不在**自动门禁里，需要模拟器或 Pods，属手工验收：

| 脚本 | 额外前置 | 用途 |
|---|---|---|
| `run-visual-tests.sh` | 已启动的模拟器 + `var/rai.sqlite`（`var/` 不入库） | 模拟器交互/截图验收，不替代真机观感（`-only-testing:…` 可只跑单个用例） |
| `run-coordinate-sdk-check.sh` | `apps/ios/Pods`（先 `pod install`）+ 已启动模拟器 | 用高德 SDK 对拍本地 GCJ02 转换 |

在**会拒绝嵌套沙箱**的外层环境（如加固沙箱）里跑 `run-visual-tests.sh`，要额外传
`RAI_XCODEBUILD_SWIFT_FLAGS=-disable-sandbox`，否则宏插件起不来、每个 `@Observable` 都报
`produced malformed response`，看起来像一屏源码错误。

### 模拟器验收不到健康同步

上面的命令产出的是**无签名模拟器包**，因此**没有 HealthKit 能力**：项目只在 device SDK 上挂
`CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*] = RAI/RAI.entitlements`，模拟器包 `codesign -d --entitlements` 为空。
此时 HealthKit 调用直接返回
`Error Domain=com.apple.healthkit Code=4 "Missing com.apple.developer.healthkit entitlement."`，
`HealthKitSync` 在授权检查处按设计 fail closed（`RAI/HealthKitSync.swift` 的
`readAuthorizationState()` 四分支，文案见 `RAI/HealthKitExport.swift` 的 `HealthKitExportError`），
首页与设置页显示「同步未完成」。

模拟器是否有样本/授权取决于该实例，不能沿用旧机器“Health库为空”的结论。
本项目上述无签名构建主要验证失败态UI、离线缓存和界面流程，不认证HealthKit真机读取或后台调度。
不要用手工补签名绕过工程能力配置；真实读取、权限和生命周期验收使用受支持签名的真机构建。

## 首次连接

在原生 App 的“设置”填写 API 服务地址和 Token。连接成功后应能看到 `serverId`、`athleteId`、`datasetEpoch` 和协议版本。不要填写手机上的 `127.0.0.1`；服务端应绑定手机可达地址，并按现有策略配置 HTTPS/局域网访问。

在“设置”点“同步健康数据”，只申请读取权限。App 通过现有 ZIP/XML 导入接口上传，不向 Apple 健康写入。后台同步由三个机制承担：HealthKit background delivery 负责“知道有变化”，`BGProcessingTask`（`app.rai.running.health-sync`）负责“给几分钟 CPU 做完导出与导入提交”，带 identifier 的 background URLSession 负责“把字节搬完”。**系统调度不可承诺具体时刻**；能承诺的只有两件事：一是已上传/已导入的进度一定落盘、下次唤醒能续接，二是前台打开时按权限、网络和服务状态重试补齐。真机验收清单见 `docs/IOS_NATIVE_SYNC_PROTOCOL.md`。

## 排障

| 现象 | 处理 |
| --- | --- |
| 401 | 更新 Token；不要反复自动重试 |
| 无法连接 | 确认桥接网络、服务监听地址、手机与主机路由和证书 |
| 页面可见但数据过期 | 展开首页「数据状态」横幅的「数据覆盖明细」，分别看三件事：**同步状态**（`sync.status`：`正常`/`尚未同步`/`同步失败`）、**训练数据截至**（`latestDataDate`）、**最近健康样本**（`coverage.latestHealthSampleAt`）。只有 `同步失败` 才需要重新同步 HealthKit；「尚未同步」表示这台设备还没跑成过一次刷新 |
| 横幅写「今天没有恢复监测记录」 | 预期结果，不是故障：没戴表的夜晚属于**覆盖缺口**，只减少一份判断依据，不构成负面判断，也不再阻断锁定安排。要让今天纳入恢复数据，同步一次含昨夜记录的 Apple Health 导出即可 |
| 目标保存冲突 | 重新读取服务端目标，确认后再保存 |
| 训练详情没有底图 | 先确认已同意隐私说明（设置 → 地图底图）；再确认 `pod install` 打印了「已注入高德 Key」，Key 已绑本 App Bundle ID |
| 同步中断 | 再次打开 App，任务会从本机 `sync.sqlite` 和保留的 ZIP 恢复 |
| 模拟器上「同步未完成」 | 预期结果：模拟器包没有 HealthKit entitlement、Health 库也没有样本（见上文「模拟器验收不到健康同步」）；到真机按「首次连接」授权后验收 |
| 清缓存后内容消失 | 重新联网读取；服务端数据、凭证和同步任务不应被清除 |
| `ld: framework 'Pods_RAI' not found` | 用 `RAI.xcworkspace` 构建；先 `cd apps/ios && pod install` |
| `pod: command not found` | CocoaPods 已装但不在 PATH：`export PATH="$(gem environment | awk -F': ' '/EXECUTABLE DIRECTORY/{print $2}'):$PATH"`，或 `gem install cocoapods` |
| `unable to find utility "simctl"` | 命令行工具指向了 CommandLineTools：`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 或 `sudo xcode-select -s /Applications/Xcode.app` |
| 构建后地图卡片仍是默认城市视野 | 高德渲染器就绪前会忽略 fit，`RouteMapContainer` 会在 0.2 s 后重试；若持续出现，先确认 `pod install` 打印了「已注入高德 Key」，再检查 `Configs/AmapKey.xcconfig` 的 Key 是否绑定了本 App 的 Bundle ID |
| 训练详情里往下滑，页面不动而地图被划走 | 不该发生：路线卡片默认锁定手势（`mapInteractive = false`），`RouteMapContainer` 只在点按解锁后才接管平移。逐条核对 `apps/ios/tests/check-today-layout.py` 的「地图手势锁定」判据：SwiftUI 默认值、屏蔽层的 `allowsHitTesting`、`map.isScrollEnabled/isZoomEnabled` |

## 数据位置与隐私

页面缓存位于 App Support 下的 `RAI/cache.sqlite`，同步任务位于 `RAI/sync.sqlite`，凭证只在 Keychain。文件使用 iOS 数据保护。日志和诊断不得记录 Token、完整健康样本或精确路线。

## 真机人工验收清单

以下不由模拟器构建或纯逻辑测试替代；尚未现场执行时标记未验证。

- 首次、拒绝、部分或撤销HealthKit读权限；未授权类型保持未知，不出现写权限。
- 前台首次导出、同批重传、获jobId后的断网/杀进程/重启续接；anchor只在导入成功后前移。
- 锁屏、系统后台唤醒/过期、background URLSession回调与前台主动同步竞争，不丢新意图、不重复提交。
- 服务URL、serverId、athleteId、datasetEpoch改变时，旧任务/缓存不串目标；未知身份不当成确认空。
- Route迟到、更正或配额限制时继续补齐/pending，不永久invalid或丢掉已导入兄弟路线。
- 恢复备份、服务重启、401/409/超时后保留草稿与反馈，分清同步、导入、分析三个阶段。
- 地图同意前不初始化SDK；坐标SDK对拍、VoiceOver、大字体、减少动态效果和耗电需真机观察。
- 训练详情里压着路线卡片上下滑动是**翻页**而不是拖动地图；轻点地图解锁后才可缩放拖动，右下角「锁定」一键收回，且解锁/锁定都不影响右上角「显示完整路线」的 fit。

记录设备、OS/App版本、数据scope、步骤/结果和脱敏证据；不得上传真实健康导出或凭证。
