# 让 iOS 模拟器具备 HealthKit 能力（模拟器 ≈ 真机）

日期：2026-09-23 · 环境：Xcode 26.6 / iOS 26.5 模拟器 `RAI Technology Acceptance` (`A2320B93-3FFE-4AF9-A480-616511395C53`)

## 结论先行

**"模拟器和真机一样"这件事，HealthKit 这一层能做，而且已经做通了；只剩一次人工点击。**

三个缺口逐个查实：

| 缺口 | 状态 | 结论 |
|---|---|---|
| ① App 能否构建进模拟器 | 🟢 已解决 | 必须走 `-workspace`；CocoaPods 沙箱只需对齐 gitignored 的 `Manifest.lock`。实测 **BUILD SUCCEEDED 并成功启动** |
| ② 模拟器里的 HealthKit 权限 | 🟢 已解决 | 不是"不能用"，是**缺 entitlement**。用 Xcode 自己的 `-sectcreate` 手法复刻后，权限错误消失、授权框能弹出（已截图） |
| ③ HealthKit 授权 + 数据 | 🔴 **需要你手点一次** | 授权是安全边界，不可脚本化（三条路全被实测堵死） |
| ④ 后台投递 / BGProcessingTask | ⛔ **补不了** | 模拟器上不会真触发，这一块**永远只能真机验** |

**⇒ 本轮唯一要你做的事：在模拟器的健康授权框上点「全部打开」。**

---

## ① 构建：两个坑，都不是代码问题

### 坑 1：用 `-project` 链接必失败

```
ld: framework 'Pods_RAI' not found
```

AMap SDK 以 pod 形式 vendored，`Pods_RAI.framework` 只存在于 workspace 的构建产物里。
**必须** `-workspace apps/ios/RAI.xcworkspace`。仓库自带的
`apps/ios/tests/run-visual-tests.sh` 本来就是对的（`:92`），是我一开始用错了。

### 坑 2：CocoaPods 沙箱版本行对不齐

```
error: The sandbox is not in sync with the Podfile.lock. Run 'pod install'
```

实测 `Podfile.lock` 与 `Pods/Manifest.lock` **内容完全相同**（PODS / DEPENDENCIES /
SPEC REPOS / SPEC CHECKSUMS / PODFILE CHECKSUM 逐项一致），**只差一行版本号**：

```
COCOAPODS: 1.17.0   ← Podfile.lock（被跟踪，来自你另一台机器）
COCOAPODS: 1.13.0   ← Pods/Manifest.lock（本机 2026-09-20 装出来的）
```

本机 `pod` 命令不在 PATH（实际在 `~/.gem/ruby/2.6.0/bin/pod`，1.13.0）。
处理：把 `Podfile.lock` 复制成 `Pods/Manifest.lock`（**只动 gitignored 文件，被跟踪的
`Podfile.lock` 零改动**）。备份留在 `/tmp/Manifest.lock.bak-*`。

> 若你想用正规做法：装上 CocoaPods 1.17.0 后跑 `pod install`。代价是
> `Podfile.lock` 里那行版本号会被 1.17.0 重写（本来就是 1.17.0，所以其实不变）。

### 坑 3：命令行覆盖会波及 Pods 目标

`CODE_SIGN_ENTITLEMENTS=RAI/RAI.entitlements` 是**相对路径**，会同时解析到
`Pods-RAI` 目标 → `Pods/RAI/RAI.entitlements` 不存在 → 构建失败：

```
error: Build input file cannot be found: '.../Pods/RAI/RAI.entitlements'
```

处理：在 gitignored 的 `Pods/RAI/` 放一个空 plist 占位。

可用命令（实证通过）：

```sh
xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -configuration Debug \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath /tmp/rai-sim-dd \
  CODE_SIGN_ENTITLEMENTS=RAI/RAI.entitlements build
```

产物：`/tmp/rai-sim-dd/Build/Products/Debug-iphonesimulator/RAI.app`
实测 `simctl install` 成功，控制台打出 `[RAI] BGTaskScheduler.register ok for app.rai.running.health-sync`。

---

## ② HealthKit 权限：本轮最重要的发现

### 事实链（全部实测）

**(a) 模拟器里 HealthKit 是"查权限"，不是"不能用"。** 无 entitlement 时报：

```
Code=4 "Missing com.apple.developer.healthkit entitlement."
```

`isHealthDataAvailable()` 在同一进程里是 `true` —— 所以**"模拟器不支持 HealthKit"这个说法是错的**。

**(b) 真机的 entitlements 对模拟器构建不生效。** `project.pbxproj:348/395`：

```
"CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]" = RAI/RAI.entitlements;
```

`sdk=iphoneos*` ⇒ 模拟器构建**不带**。而且仓库自己的模拟器验收 `run-visual-tests.sh:95`
用 `CODE_SIGNING_ALLOWED=NO`（**完全不签名**）⇒ **仓库自带的模拟器验收从来没有碰过 HealthKit**。
这解释了为什么这个坑一直没被发现。

**(c) 手签做不到，Xcode 可以。** 实测四种手签组合：

| 手签的 entitlements | 结果 |
|---|---|
| 只 `application-identifier` | ❌ 被拒启动 |
| `application-identifier` + `healthkit` | ❌ 被拒启动 |
| 真机那套完整集合 | ❌ 被拒启动 |
| 完全空 | ✅ 启动成功 |

报错都是 `denied by service delegate (SBMainWorkspace)`。**只要带任何自定义 entitlement，
模拟器就拒绝启动手签的 App。**

**(d) Xcode 走的是另一条路：把 entitlements 塞进二进制段。** 实测构建产物：

```
otool -l RAI.app/RAI  →  sectname __entitlements / sectname __ents_der

otool -s __TEXT __entitlements 解出来：
  com.apple.developer.healthkit                       = true
  com.apple.developer.healthkit.access                = []
  com.apple.developer.healthkit.background-delivery   = true
```

而真正用于签名的 `RAI.app.xcent` 是**空字典**。也就是说：**模拟器读的是二进制段，不是签名。**
（`Entitlements-Simulated.plist` 里也带着同一份内容，可作为旁证。）

### 复刻结果：通

照 `-sectcreate __TEXT __entitlements <plist>` 重新链接 + 用空 plist 签名后：

```
之前： requestAuthorization=THREW Code=4  "Missing com.apple.developer.healthkit entitlement."
现在： requestAuthorization=THREW Code=100 "Failed to create authorization presentation controller"
      save=THREW  Code=5 "Authorization is not determined"
```

**entitlement 那个错消失了**，换成"没有窗口可以弹授权框"——说明权限这层已经过去。

补上一个带窗口的宿主 App 后，**系统授权框真的弹出来了**（截图：`/tmp/hk-seed/prompt.png`）：
「访问健康数据 · SeedProbe 想要访问并更新你的健康数据」，写入/读取各自的开关都在。

---

## ③ 剩下的那一步：授权只能手点

三条自动化路径全被实测堵死，且都属于安全边界：

| 尝试 | 结果 |
|---|---|
| `xcrun simctl health ...` | **无此子命令**（`simctl help` 全量列出，只有 privacy / spawn / addmedia 等） |
| `xcrun simctl privacy <dev> grant health` | **privacy 的服务列表里没有 health**（只有 calendar/contacts/location/photos/mic/motion/reminders/siri） |
| `osascript` 点模拟器 | **`osascript` 不允许辅助访问**（-25211）；且无头 boot 时 `Simulator` 进程根本不存在 |

**所以：打开 Simulator.app，在授权框上点一次「全部打开」。** 这是一次性动作，之后模拟器里
的 HealthKit 就长期可用（授权按 App 记，重启模拟器不丢）。

需要两次点击（授权按 App 隔离）：
1. **灌数据 App**（`app.rai.seedprobe`，我已建好，授权框此刻就在屏幕上）→ 写入合成跑步数据
2. **真 App**（`app.rai.running.debug`）→ 读权限，它自己的同步流程会弹

---

## ④ 补不了的部分（要认）

- **HKObserverQuery 后台投递 / BGProcessingTask**：模拟器上不会真触发。
  `BGTaskScheduler.register` 会"成功"，但不会真跑。**这一块永远只能真机验。**
- **entitlement 在模拟器上不强制执行**：所以"少了某个 entitlement 但代码不报错"这类差异，
  模拟器**测不出来**。
- 模拟器共享宿主机网络栈，`127.0.0.1` 指宿主机 —— 这点对"打到本地 API"是**有利**的。

---

## 顺带核实：`payloadHash` 那条不需要修

排查中发现 `HealthKitSync.swift:758` 是 `payloadHash = fileHash(zipURL)`（**原始 ZIP 字节**的
sha256），而 `HealthKitExport.swift:267` 的 `<ExportDate value="appleDate(Date())"/>` 是墙钟
⇒ 每次导出 ZIP 字节都不同 ⇒ 幂等键不同。

**但这是已知且有意的**，不是缺陷 —— `BackgroundSyncPolicy.swift:120-123` 自己写着：

> 新的 HealthKit 导出会写新的 `ExportDate`，于是 `payloadHash` 变了、batchId 变了…

配套的两道设计使其代价可控：
- `import-sources.ts:238-283` 的 `hashXmlWithoutExportDate` 会**剥掉 ExportDate** 再算内容摘要，
  所以 `sourceSha256` 稳定 ⇒ 服务端仍能判出"这份内容见过"；
- 客户端策略保证"盘上有未走完的批次就不重新导出"。

**结论：`<ExportDate>` 保持现状。** 需要重导时本来就有新数据，走全套导入是正确的。

---

## 本轮对仓库的影响

**被跟踪的文件：零改动。** 只动了两个 gitignored 文件：

| 文件 | 改动 | 回滚 |
|---|---|---|
| `apps/ios/Pods/Manifest.lock` | 版本行对齐（内容与 `Podfile.lock` 逐字相同） | `cp /tmp/Manifest.lock.bak-* apps/ios/Pods/Manifest.lock` |
| `apps/ios/Pods/RAI/RAI.entitlements` | 新建空 plist 占位 | 删掉即可 |

模拟器侧新增：`app.rai.seedprobe`（灌数据 App），卸载 `xcrun simctl uninstall $UDID app.rai.seedprobe`。

---

## 待你定的一件事：要不要把模拟器构建也纳入 entitlement

`project.pbxproj:348/395` 的 `[sdk=iphoneos*]` 是这次一切的根源。两个选项：

**A. 不改仓库（当前做法）**：构建时用命令行 `CODE_SIGN_ENTITLEMENTS=...` 覆盖。
零风险、不影响任何人；代价是每次都要带上这个参数，且 `run-visual-tests.sh` 仍需另外改。

**B. 去掉 `[sdk=iphoneos*]` 条件**：模拟器构建默认带 entitlements。
一劳永逸，但这是**被跟踪文件的改动**，影响所有人/CI 的构建配置，且需要连带确认
`run-visual-tests.sh:95` 的 `CODE_SIGNING_ALLOWED=NO` 要不要跟着改（不改的话那里仍然拿不到权限）。

我没有擅自动它——这属于"改别人的东西之前先问"。

---

## 验收标准（本轮）

1. `xcodebuild -workspace ... build` → `BUILD SUCCEEDED`，且
   `otool -l RAI.app/RAI | grep -c __entitlements` ≥ 1 ✔
2. `simctl install` + `launch` 成功，控制台出现 `BGTaskScheduler.register ok` ✔
3. 带 HealthKit 的宿主 App 能弹出系统授权框 ✔（截图 `/tmp/hk-seed/prompt.png`）
4. `git status --short` 中不出现任何本轮新引入的被跟踪文件改动 ✔

## 回滚

1. Pods 侧：恢复 `/tmp/Manifest.lock.bak-*`，删 `apps/ios/Pods/RAI/`
2. 模拟器侧：`xcrun simctl uninstall $UDID app.rai.seedprobe`
3. 构建产物在 `/tmp/rai-sim-dd`、`/tmp/hk-seed`，直接删
4. **无需回滚仓库代码**——本轮没改任何被跟踪文件
