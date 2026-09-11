# 初次编译验收记录 — 2026-09-09

> 历史记录：本页记录图片读取尚不可用时的初次检查。后续原生视觉修正与验收见 [visual-review/README.md](visual-review/README.md)。

## 结论

**编译和模型回归通过；视觉验收未完成，完全复刻不予签署。**

本次没有修改业务或皮肤实现，也没有运行 Web / 响应式测试。

## 已执行

- Xcode 26.5，Build 17F42；iOS Simulator SDK 26.5。
- Debug / generic iOS Simulator：arm64、x86_64 编译与链接成功。
- `build.log`：`BUILD SUCCEEDED`，未发现 `warning:` / `error:` 诊断。
- `model-tests.log`：10 项模型回归全部通过。该测试使用隔离替身，不等同于 UI 或真实服务器流程验收。
- 独立创建 `RAI Technology Acceptance` 模拟器，设备类型 iPhone 12 Pro Max，运行 iOS 26.5。
- 模拟器 UUID：`91C2D1F3-FB19-4843-B892-1A4F4AAF6D16`。
- 安装构建产物成功；默认启动和科技皮肤启动均返回进程 PID，科技启动截图后 `launchctl list` 仍显示应用进程。
- 保存 `pixel-launch.png` 和 `technology-launch.png`。科技风通过启动参数选择，不是设置页点击切换，也不证明持久化行为。
- 未配置业务服务器，未操作健康权限、缓存清除、目标保存或锁课。

## 视觉阻塞与未验收项目

图片读取工具在读取设计板 01 时返回：

> view_image is not allowed because you do not support image inputs

因此截图仅为启动证据，**未检查截图内容，不能确认是否有系统弹窗遮挡**。未进行逐页导航、视觉校准或图片相似度评分。

| 设计板 | 需要检查的页面 | 本次视觉结果 |
| --- | --- | --- |
| 01 | 今日上下半页、本周活动、身体指标 | 未验收 |
| 02 | 训练列表、详情、路线、时序、分段、负荷、质量 | 未验收 |
| 03 | 计划、编辑、锁课、版本冲突 | 未验收 |
| 04 | 统计、趋势、跑力、纪录 | 未验收 |
| 05 | 首次连接、发现、设置、同步、缓存 | 仅保存启动截图，未验收 |
| 06 | 身体分区与预测、离线、空数据、失败、加载 | 未验收 |

设置内皮肤切换、重启持久化、返回路径、编辑取消、越界阻止、离线禁写、同步状态、清缓存确认、动态字号及 VoiceOver 均未进行 UI 验收。真机签名、安装和 HealthKit 实机权限也未验收。

后续需要在支持图片输入的会话中，连接验收用 API 数据，操作真实页面，按六张设计板逐页截图对照修正。示例数值、失真文字和虚构进度仍应遵循设计文档约束，不复制进业务数据。

## 重现编译

从仓库根目录执行：

```sh
xcodebuild -project apps/ios/RAI.xcodeproj -scheme RAI \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/rai-tech-acceptance \
  CODE_SIGNING_ALLOWED=NO build
bash apps/ios/tests/run-model-tests.sh
```

应用产物位于 `/tmp/rai-tech-acceptance/Build/Products/Debug-iphonesimulator/RAI.app`，临时目录可能被系统清理。

2026-09-11 起高德 SDK 由 CocoaPods 引入，上面的 `-project` 命令是当日记录，现无法链接（`ld: framework 'Pods_RAI' not found`）；当前入口为 `pod install` 后的 `apps/ios/RAI.xcworkspace`（见 `apps/ios/README.md`「构建与验收」）。
