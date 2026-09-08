# RAI 原生 iOS 运行说明

## 前置条件

- macOS、Xcode 和 iOS 17 或更新的 SDK。
- 已安装本项目使用的 iOS 平台组件。
- Apple ID/开发团队可签名；HealthKit capability 已打开。
- iPhone 与 API 服务处于同一局域网，或通过个人 VPN 访问。

## 构建与运行

从仓库根目录启动可被手机访问的服务：

```bash
npm run dev:device
```

然后打开 `apps/ios/RAI.xcodeproj`，选择 RAI scheme 和真实 iPhone，检查 Signing & Capabilities 中的 Team，执行 Build/Run。项目最低部署版本保持 iOS 17。当前文档中的命令和设备名称是运行说明，尚未在本次 Windows 环境验证。

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
| 同步中断 | 再次打开 App，任务会从本机 `sync.sqlite` 和保留的 ZIP 恢复 |
| 清缓存后内容消失 | 重新联网读取；服务端数据、凭证和同步任务不应被清除 |

## 数据位置与隐私

页面缓存位于 App Support 下的 `RAI/cache.sqlite`，同步任务位于 `RAI/sync.sqlite`，凭证只在 Keychain。文件使用 iOS 数据保护。日志和诊断不得记录 Token、完整健康样本或精确路线。

