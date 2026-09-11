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

高德底图还有隐私门控：首次打开 App 先要选择是否同意（见 `apps/ios/README.md` 的「隐私门控」）。只有同意后才初始化 SDK 并创建 `MAMapView`；未同意时训练详情显示离线轨迹，设置页可随时开启或关闭。

无签名模拟器构建可用于快速验证 SwiftUI/API 层编译：

```bash
xcodebuild -workspace apps/ios/RAI.xcworkspace \
  -scheme RAI \
  -destination 'platform=iOS Simulator,id=7A65F02F-2F9B-412B-899A-EDA4DE20B68E' \
  -configuration Debug \
  -derivedDataPath /tmp/rai-derived \
  CODE_SIGNING_ALLOWED=NO build
```

2026-09-08 已在本机 Xcode 26.5 / iOS Simulator 26.5 通过该构建；2026-09-11 接入高德 pod 后，构建入口从 `RAI.xcodeproj` 改为 `RAI.xcworkspace`（`pod install` 后同样通过）。真实 iPhone
安装、签名、HealthKit 权限和路线能力仍需按下方步骤验收。

## 首次连接

在原生 App 的“设置”填写 API 服务地址和 Token。连接成功后应能看到 `serverId`、`athleteId`、`datasetEpoch` 和协议版本。不要填写手机上的 `127.0.0.1`；服务端应绑定手机可达地址，并按现有策略配置 HTTPS/局域网访问。

在“设置”点“同步健康数据”，只申请读取权限。App 通过现有 ZIP/XML 导入接口上传，不向 Apple 健康写入，也不承诺固定周期后台同步。

## 排障

| 现象 | 处理 |
| --- | --- |
| 401 | 更新 Token；不要反复自动重试 |
| 无法连接 | 确认桥接网络、服务监听地址、手机与主机路由和证书 |
| 页面可见但数据过期 | 查看“健康数据截至”和“结果生成于”，重新同步 HealthKit |
| 目标保存冲突 | 重新读取服务端目标，确认后再保存 |
| 训练详情没有底图 | 先确认已同意隐私说明（设置 → 地图底图）；再确认 `pod install` 打印了「已注入高德 Key」，Key 已绑本 App Bundle ID |
| 同步中断 | 再次打开 App，任务会从本机 `sync.sqlite` 和保留的 ZIP 恢复 |
| 清缓存后内容消失 | 重新联网读取；服务端数据、凭证和同步任务不应被清除 |
| `ld: framework 'Pods_RAI' not found` | 用 `RAI.xcworkspace` 构建；先 `cd apps/ios && pod install` |
| `pod: command not found` | CocoaPods 已装但不在 PATH：`export PATH="$(gem environment | awk -F': ' '/EXECUTABLE DIRECTORY/{print $2}'):$PATH"`，或 `gem install cocoapods` |
| `unable to find utility "simctl"` | 命令行工具指向了 CommandLineTools：`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 或 `sudo xcode-select -s /Applications/Xcode.app` |
| 构建后地图卡片仍是默认城市视野 | 高德渲染器就绪前会忽略 fit，`RouteMapContainer` 会在 0.2 s 后重试；若持续出现，先确认 `pod install` 打印了「已注入高德 Key」，再检查 `Configs/AmapKey.xcconfig` 的 Key 是否绑定了本 App 的 Bundle ID |

## 数据位置与隐私

页面缓存位于 App Support 下的 `RAI/cache.sqlite`，同步任务位于 `RAI/sync.sqlite`，凭证只在 Keychain。文件使用 iOS 数据保护。日志和诊断不得记录 Token、完整健康样本或精确路线。
