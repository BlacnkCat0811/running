# RAI 原生 iOS 应用

## 外观皮肤

在 **设置 → 外观皮肤** 中切换「清新像素」和「冰蓝科技」，选择立即生效并保存在本机，重新启动仍保留。已有安装和首次安装默认继续使用清新像素。

科技风位于 `RAI/Skins/Technology`，使用独立的颜色、卡片、图表、导航及页面布局，复用现有 `NativeAppModel` 和 API。切换不修改服务配置、健康同步、训练记录或目标。原 Pixel 主题、图标和图表文件保持不变。

科技风的实现范围、设计映射及待执行的 Xcode 验收见 `design/TECHNOLOGY_SKIN.md`。当前实现已在 Windows 上做语法与引用检查；尚未完成 iOS SDK 编译和模拟器逐页视觉比对，不能视为已通过与设计图完全一致的验收。

这是给 iPhone 使用的 SwiftUI 原生应用。手机不运行 Node.js、评分核心或服务端 SQLite；数据和模型结果仍由已配置的 RAI API 服务负责。旧 WKWebView 文件保留为开发期回退路径，不是原生页面的验收替代品。

## 一次跑通

1. 在仓库根目录启动可被手机访问的 API/Web 开发服务器：

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

8. App 的“设置”中填写第 1 步打印的服务器地址和 API Token（如服务启用了 Token）。连接成功后，今日、训练、计划、分析和设置均使用原生 SwiftUI 页面。

## 这台 VMware 虚拟机要注意

- 当前网卡是 NAT（`192.168.126.130`）。iPhone 走自己的 Wi-Fi 时，通常 **访问不到** 这个地址。
- 把 VMware 网卡改成 **Bridged（桥接）**，让虚拟机和 iPhone 在同一局域网。
- 没有签名证书时，Xcode 无法把 App 装到真机。必须登录 Apple ID。
- Xcode 26.5 的 SDK 是 iOS 26.5。连上 iOS 26.6.1 真机后，Xcode 会从手机拷设备支持文件；若提示 Developer Disk Image 失败，在 Xcode 里等它处理完再 Run。
- 这台虚拟机的 Xcode 需要先下载 iOS 26.5 平台（约 10.6 GB）。没有它，运行目标里不会出现 iPhone。

## 产品边界

- 不在手机上跑 Node.js、评分核心或服务端 SQLite，也不向 Apple 健康写入。
- 新的同步、目标修改和锁课需要联网；已加载的首页、训练和分析可在服务暂时不可用时继续查看。
- 手机不会在离线状态下生成或确认新的训练安排，也不保证固定周期后台同步。

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
