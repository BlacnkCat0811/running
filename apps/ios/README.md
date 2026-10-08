# RAI SwiftUI iOS 应用

已有产品：SwiftUI原生界面、HealthKit只读导出/后台同步、API查询/控制、本地缓存与续传。
TypeScript评分在服务器执行；iOS不运行Node、不复制scorer、不写HealthKit，也不包含独立Watch产品。
生产iOS分支进入NativeRootView；旧Web壳兼容代码不代表原生App使用WKWebView。

## 构建

macOS、项目所需Xcode/iOS SDK、CocoaPods；最低iOS17，以[工程配置](RAI.xcodeproj/project.pbxproj)为准，不把某台机器的SDK版本/IP写成项目要求。

```bash
# 仓库根目录
npm run dev:device
cd apps/ios
cp Configs/AmapKey.xcconfig.example Configs/AmapKey.xcconfig
# 本地填写已绑定Bundle ID的地图Key，不提交Git
pod install
open RAI.xcworkspace
```

选择真实设备/开发团队，按签名与HealthKit capability要求运行。推荐使用workspace；
执行过 `pod install` 后，单独打开 `RAI.xcodeproj` 也可以构建，不会再因为
`Pods_RAI.framework` 这个空的CocoaPods聚合框架缺失而链接失败。
手机上的127.0.0.1不是API主机；填写手机可达的HTTPS/可信局域网服务与Token。

`Podfile` 的 `post_install` 会修一处高德 SDK 自带的头文件缺口：`MAMapKit.framework` 的
module map 声明 `umbrella header "MAMapKit.h"`，而随包的 `MAMapKit.h` 漏了 `Headers/` 下的头，
构建期 clang 因此报 `umbrella header for module 'MAMapKit' does not include header …`。
补丁按“umbrella 必须覆盖 `Headers/` 下每一个头”补齐，幂等，随 SDK 升级自动跟随。
`Pods/` 不入库，所以这类修改只能写在 `Podfile` 里，手改 `Pods/` 会被下次 `pod install` 冲掉。
`post_integrate` 还会从 `RAI.xcodeproj` 移除空的 `Pods_RAI.framework` 聚合链接；
这是为了让单独打开 xcodeproj 时也能链接成功，不要在 `pod install` 后用 `git restore`
恢复这部分生成改动。

## 文档职责

- [API合同](../../docs/IOS_NATIVE_API_CONTRACT.md)：身份、DTO、revision、命令终态。
- [同步协议](../../docs/IOS_NATIVE_SYNC_PROTOCOL.md)：原子任务、后台恢复、scope与路由。
- [ADR-004](../../docs/adr/ADR-004-healthkit-sync-invariants.md)：不可随意颠倒的提交/清理等规则。
- [运行与真机验收](../../docs/IOS_NATIVE_RUNBOOK.md)：权限、故障、恢复与人工清单。
- [设计资产索引](design/README.md) / [清新视觉规范](design/TECHNOLOGY_SKIN.md)：当前唯一清新视觉及历史视觉证据。

## 自动与人工验收

```bash
npm run test:ios
```

该命令类型检查全部iOS源码并执行纯逻辑回归。缺Xcode/非macOS会明确说明没有检查，不能称为通过。
模拟器UI用例的编译不等于运行；截图/交互要启动模拟器并按runbook使用独立数据库副本。
当前工程的无签名模拟器构建不能证明HealthKit真机读权限/样本可用；后台回调的系统调度时间也不可承诺。
坐标SDK对拍需Pods和启动的模拟器；新视图必须复用令牌/现有AppModel，不能复制API状态机。

## 隐私与状态

凭证保存在Keychain；cache.sqlite和sync.sqlite在App Support，按数据保护策略管理。
服务URL、serverId、athleteId、datasetEpoch共同隔离缓存和任务；未知scope不能当旧数据安全复用。
HealthKit失败、网络不可用、同步未发生、今天无恢复覆盖、训练数据陈旧分开显示。
地图SDK先有明确隐私同意才初始化。WGS-84是存储坐标，显示转换不得写回原始路线。
训练详情的路线卡片默认**锁住地图手势**：压在卡片上上下滑动是翻页，轻点地图解锁后才可缩放拖动，右下角「锁定」一键收回。
