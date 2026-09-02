# RAI iOS 调试壳

这是给 **iPhone 12 Pro Max / iOS 26** 用的 Xcode 调试宿主，不是独立的 HealthKit 产品。手机只显示现有 Web 界面；数据、评分和 SQLite 仍在 Mac 虚拟机里的 Node API 上运行。

## 一次跑通

1. 在仓库根目录启动可被手机访问的开发服务器：

   ```bash
   npm run dev:device
   ```

   终端会打印类似 `http://192.168.x.x:5173` 的地址。

2. 打开 Xcode 工程：

   ```bash
   npm run open:ios
   ```

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

8. App 里填入第 1 步打印的服务器地址。

## 这台 VMware 虚拟机要注意

- 当前网卡是 NAT（`192.168.126.130`）。iPhone 走自己的 Wi-Fi 时，通常 **访问不到** 这个地址。
- 把 VMware 网卡改成 **Bridged（桥接）**，让虚拟机和 iPhone 在同一局域网。
- 没有签名证书时，Xcode 无法把 App 装到真机。必须登录 Apple ID。
- Xcode 26.5 的 SDK 是 iOS 26.5。连上 iOS 26.6.1 真机后，Xcode 会从手机拷设备支持文件；若提示 Developer Disk Image 失败，在 Xcode 里等它处理完再 Run。
- 这台虚拟机的 Xcode 需要先下载 iOS 26.5 平台（约 10.6 GB）。没有它，运行目标里不会出现 iPhone。

## 它做不到的事

- 不在手机上跑 Node / SQLite，也不向 Apple 健康写入。
- 不能离线独立使用。Mac 上的 `npm run dev:device` 停了，手机页面也就停了。
- 原生 SwiftUI / React Native 产品需要单独立项。

## 像素风 UI 与移动端 API 映射

设计稿 `apps/ios/design/ios-app-design.html`（清新像素风 v3）五个页面对应的后端聚合端点，全部实现于 `apps/api`（契约类型在 `packages/api-contracts`，OpenAPI 已登记）：

| 设计稿页面 | 端点 | 数据说明 |
| --- | --- | --- |
| 首页（今日卡/活动圆环/周柱图/最近训练） | `GET /v1/mobile/today` | 今日距离/时长/配速/卡路里/次数；本周跑量 + 目标进度（goal 来自 `/v1/mobile/goals`）；周内逐日柱（周一..周日，零填充）；最近 5 条训练；`latestDataDate` 为数据最新日期（滞后时 UI 显示"数据截至"提示） |
| 训练（列表/分段器） | 复用既有 `/v1/workouts` 列表接口 | 无新增端点 |
| 统计（月度柱/指标格/心率区间） | `GET /v1/mobile/statistics` | 近 3 自然月（oldest first）按跑步/骑行/其他拆分；28 天滚动汇总 + 环比；近 28 天心率区间占比（coverage ≥ 0.3） |
| 趋势（阶梯折线/洞察/纪录） | `GET /v1/mobile/trends` | 12 个连续 ISO 周（周一对齐，按数据最新日锚定，空周零填充）、4 周增幅（前 4 周为 0 时为 `null`，UI 显示"数据不足"占位）、个人纪录（最快 5km/10km、最长距离、最大月）、正/警告洞察 |
| 设置（周目标编辑） | `GET/PUT /v1/mobile/goals` | 周跑量目标，文件持久化（`var/mobile-goals.json`），1–500km 校验 |

所有聚合窗口按 **数据最新日期（`MAX(local_date)`）** 锚定而非墙钟——Apple Health 导入滞后时，统计/趋势仍渲染完整窗口（含 28 天滚动汇总与环比）。

真实库冒烟：`bash scripts/mobile-smoke.sh`（自动起 API → 校验四端点 → goals 往返与越界校验）。
