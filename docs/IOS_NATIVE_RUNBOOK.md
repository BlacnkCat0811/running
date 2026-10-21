# RAI 原生 iOS 运行说明

## 跨平台命令矩阵

本仓库在 Windows 上开发、在 macOS 上构建 iOS，**同一条命令在三端逐字相同**：

| 命令 | Windows（cmd / PowerShell） | macOS |
|---|---|---|
| `npm run typecheck` | 真跑 | 真跑 |
| `npm test` | 真跑（Node 套件） | 真跑 |
| `npm run test:ios` | **显式跳过**：打印「本次没有检查任何 iOS 源码」，退出 0 | 真跑（类型检查 + 纯逻辑回归） |

三条硬规则由 `npm run check:scripts` 执行（`scripts/check-npm-scripts-portable.mjs`），不是口头约定：

1. **npm script 正文只用双方言都认的语法**：`&&`、纯命令、`node xxx.mjs`。
   禁用 `;`、`$?`、`$VAR`、`VAR=x cmd`、`test`、`[ ]`、`uname`、依赖 shell 展开的 `*`。
2. **平台判定只在脚本内部**：Node 用 `process.platform`，bash 用 `uname -s`。
3. **`.mjs` 优先**，`.sh` 只留"必须在 macOS 跑"的部分；`.sh` 一律用 `bash <path>` 调用，
   不写 `./x.sh`（Windows 的 git 默认不记录 +x 位）。

⛔ **不要用 WSL / Git Bash 去"模拟"Mac**：`xcodebuild`、CocoaPods、模拟器只在 macOS 上真跑。
Windows 侧的职责只是让**跨平台可验证**的部分（typecheck、纯逻辑回归、文档与脚本门禁）与 Mac 一致；
iOS 真编译与模拟器验收在 Windows 上拿到的是**显式跳过**，既不是失败，也不是假通过。

为什么这三条要写死（2026-10-13 本机实测，改前全是红的）：`npm run test:ios` 当时是裸
`bash apps/ios/tests/run-ios-gates.sh`，而 Windows 的 `bash` 解析到 `C:\Windows\System32\bash.exe`
——那是 **WSL 启动器**，不是 Git Bash，没装分发版时它 exit 1；`npm run test:ios:mutation:scope`
当时是 `RAI_MUTATION_FOR=git python3 …`，cmd 报 `'RAI_MUTATION_FOR' is not recognized`；
`npm run open:ios` 报 `'open' is not recognized`。现在它们是 `node scripts/run-ios.mjs <目标>` 与
`node scripts/open-ios.mjs`，解释器选择与平台判定都在脚本内部。

行尾也是同一类坑：`.gitattributes` 把 `*.sh` / `*.py` / `*.swift` / `*.pbxproj` 钉成 `eol=lf`，
否则 Windows 上编辑过的 `apps/ios/tests/*.sh` 到了 Mac 会变成 `bad interpreter: /bin/bash^M`。
判据是 `git ls-files --eol`（`i/lf w/lf`），不是"我记得它应该是 LF"。

## 前置条件

> 下面这些前置**只对"必须在 macOS 上执行"的步骤成立**。仓库根目录的
> `typecheck` / `test` / `check:*` 在 Windows 上同样真跑，不需要它们。

- macOS、Xcode 和 iOS 17 或更新的 SDK。
- 已安装本项目使用的 iOS 平台组件。
- CocoaPods（高德 SDK 由 `apps/ios/Podfile` 引入）。
- Apple ID/开发团队可签名；HealthKit capability 已打开（含背景投递；排期课表还需要体能训练写授权）。
- iPhone 与 API 服务处于同一局域网，或通过个人 VPN 访问。

## 构建与运行

从仓库根目录启动可被手机访问的服务（跨平台，Node 入口；**只启动 API**）：

```bash
npm run dev:device
```

它会打印局域网地址与开发用 `RAI_API_TOKEN`（默认 `rai-local-dev`）。Web 前端已退役，
不再有 vite 代理端口 5173；App 里直接填 `http://<LAN-IP>:8787` 与该 Token。

在 macOS 上打开工作副本；`darwin` 调 `open`，Windows/Linux 上**显式跳过**并说明"本次没有打开任何东西"，
不会用 `start` 假装打开（`.xcworkspace` 在 Windows 上没有关联程序，只会弹一个对话框然后照样退出 0）：

```bash
npm run open:ios
```

打开的是 `apps/ios/RAI.xcworkspace`（推荐入口），选择 RAI scheme 和真实 iPhone，
检查 Signing & Capabilities 中的 Team，执行 Build/Run。项目最低部署版本保持 iOS 17。

`Podfile` 的 `post_integrate` 会从 `RAI.xcodeproj` 移除空的 `Pods_RAI.framework` 聚合链接，
所以**执行过 `pod install` 之后**，单独打开 `RAI.xcodeproj` 也可以构建（不会再报
`ld: framework 'Pods_RAI' not found`）。未执行 `pod install` 时两种打开方式都缺 Pods/高德框架；
不要对生成的那处改动做 `git restore`。

> **macOS 专属（前置：macOS + 已装 CocoaPods）** —— Windows 上没有 CocoaPods，
> 这步不存在"跳过"以外的选项，所以只作为 macOS 片段保留，不进 npm script。
> `Podfile` / `Podfile.lock` 变更后重新安装依赖：

```bash
cd apps/ios && pod install
```

高德 Key 不明文入库：本地放在 `apps/ios/Configs/AmapKey.xcconfig`（由 `.gitignore` 忽略，模板为同目录 `AmapKey.xcconfig.example`），`Podfile` 的 `post_install` 把它注入 CocoaPods 生成的 `Pods-RAI.*.xcconfig`；`RAI/Info.plist` 只留 `$(RAI_AMAP_API_KEY)` 占位符。

> **macOS 专属（前置：macOS + 已装 CocoaPods）** —— 新建工作副本后准备 Key 并安装依赖：

```bash
cd apps/ios
cp Configs/AmapKey.xcconfig.example Configs/AmapKey.xcconfig   # 填入已绑定本 App Bundle ID 的 iOS Key
pod install                                                    # 输出「已注入高德 Key 到 2 个 xcconfig」即生效
```

没有 Key 时构建依旧成功，但高德底图不加载。`Pods/` 与 `AmapKey.xcconfig` 都不入库，workspace 由 CocoaPods 生成，不手工编辑。

高德底图还有隐私门控：首次打开 App 先要选择是否同意。只有同意后才初始化 SDK 并创建 `MAMapView`；未同意时训练详情显示离线轨迹，设置页可随时开启或关闭。

> **macOS 专属（前置：macOS + Xcode + 已 `pod install`）** —— 无签名模拟器构建，
> 用于快速验证 SwiftUI/API 层编译。这是 bash 片段（含 `\` 续行），只能在 macOS 的 bash 里逐字执行：
> 不要把它塞进 `package.json`（npm script 正文只允许 `&&`、纯命令、`node xxx.mjs`）。

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

它等价于 `node scripts/run-ios.mjs gates` → `bash apps/ios/tests/run-ios-gates.sh`：
`typecheck-ios.sh`（除 3 个高德依赖文件外的全部 `RAI/**` 源码做真实类型检查）+
`run-model-tests.sh`（纯逻辑回归聚合：模型/DTO、Keychain、坐标转换、课表映射、会话探测、
健康同步取消、缓存与续传日志、Tech 展示层与对比度、今日页版式，以及 **10 支跨平台
`check-*.py` 结构门禁**）。非 macOS 或没装 Xcode 时它会
**显式跳过并打印"本次没有检查任何 iOS 源码"**，不假装通过；`.githooks/pre-commit` 在
`apps/ios/`（或门禁读的 `packages/api-contracts`、`packages/contracts`）有改动时自动跑
`npm run test:ios` 与 `npm run check:ios-gates`。

iOS 家族统一走同一个 Node 包装，四条命令都是"非 macOS ⇒ 显式跳过 + 退出 0"：

| 命令 | 实际执行 | 何时跑 |
|---|---|---|
| `npm run test:ios` | `apps/ios/tests/run-ios-gates.sh`（含 10 支 python 结构门禁） | 每次改动（pre-commit 自动） |
| `npm run check:ios-gates` | `apps/ios/tests/check-*.py` **全部跨平台结构门禁**（不需要 Xcode；含 `check-pr5-facts-analysis.py`） | 每次改动（pre-commit 自动；非 macOS 上它是唯一会跑的 iOS 判据） |
| `npm run test:ios:live` | `check-export-determinism-live.py`（探针装进模拟器，跨进程比对导出字节） | 手工验收 |
| `npm run test:ios:mutation` | `check-background-mutations.py`（逐条改坏源码再跑门禁，十几分钟） | 判据本身被改动时 |
| `npm run test:ios:mutation:scope` | 同上，`RAI_MUTATION_FOR=git` 按改动范围裁剪 | 日常 |

`check:ios-gates` 在自动发现之外还有一条**执行者自检**：每支非排除门禁必须出现在某个
`apps/ios/tests/run-*.sh` 里，否则整支入口直接红 —— 2026-10-13 引入的
`check-pr5-facts-analysis.py` 曾只挂在这个入口、而入口不在 pre-commit/CI，连续 6 天一条判据
都没执行，还因为基线放在 gitignored 的 `var/` 里被误记成"预存在失败"。它的 C9 基线现在入库在
`apps/ios/tests/fixtures/pr5-c9-baseline-keys.json`，重建用
`python3 apps/ios/tests/check-pr5-facts-analysis.py --write-baseline`（要求工作树的契约文件是干净的，
基线会记录来源 commit）。

`check:ios-gates` 的解释器下限是 **Python 3.9**（与 `run-ios-gates.sh` 的 `3.[0-8]` 拒绝口径一致；
探测逻辑里两处必须同时改）。**找不到合格解释器时它按失败处理，不是跳过** —— 这台机器本该能跑
文本判据却没跑成，静默放行会把"没有执行者"重新制造出来。用 `RAI_PYTHON=<解释器路径>` 指定版本。

`RAI_MUTATION_FOR` 由 Node 通过 `spawnSync` 的 `env` 传给子进程（原来写在 npm script 正文里的
`RAI_MUTATION_FOR=git …` 是 POSIX 专属，cmd 会把 `RAI_MUTATION_FOR=git` 当成程序名）。
要按别的范围裁剪，在 **macOS 的 bash** 里直接跑
`RAI_MUTATION_FOR=<路径> python3 apps/ios/tests/check-background-mutations.py`，
或往 `scripts/run-ios.mjs` 的目标表里加一个目标（平台判定与 env 都只写在那一个文件里）。

Windows 上如果装了 Git for Windows，`npm run test:ios` 会把判定交给 `run-ios-gates.sh` 自己打印
（平台判据只写一份：bash 用 `uname -s`，Node 用 `process.platform`）；没装就由 Node 打印同一句话。

`apps/ios/tests/*.py` 读 Swift/TS 源码时**一律显式 `encoding="utf-8"`**（那些文件含中文，
裸 `read_text()` 会用本机默认编码：Windows = cp936/GBK ⇒ 直接 `UnicodeDecodeError` 崩溃，
而这条链只在 macOS 上跑、那边默认 UTF-8，于是缺口在两边都看不见）。要在 Windows 上跑这些
脚本不需要额外环境变量：**判据依赖的是显式 `encoding`**，不是 `PYTHONUTF8=1`。该变量只影响
脚本自己 `print` 的中文在控制台上的呈现（本机实测：加不加它，退出码与判据结论都一样）——
若终端里中文显示成乱码，再考虑用 `PYTHONUTF8=1 python apps/ios/tests/<script>.py` 或先
`chcp 65001`，那属于显示问题，不是门禁问题。

下面两条**不在**自动门禁里，需要模拟器或 Pods，属手工验收（**macOS 专属**，用 `bash <path>` 调用）：

| 脚本 | 额外前置 | 用途 |
|---|---|---|
| `bash apps/ios/tests/run-visual-tests.sh` | 已启动的模拟器 + `var/rai.sqlite`（`var/` 不入库） | 模拟器交互/截图验收，不替代真机观感（`-only-testing:…` 可只跑单个用例） |
| `bash apps/ios/tests/run-coordinate-sdk-check.sh` | `apps/ios/Pods`（先 `pod install`）+ 已启动模拟器 | 用高德 SDK 对拍本地 GCJ02 转换 |

在**会拒绝嵌套沙箱**的外层环境（如加固沙箱）里跑 `run-visual-tests.sh`，要额外传
`RAI_XCODEBUILD_SWIFT_FLAGS=-disable-sandbox`，否则宏插件起不来、每个 `@Observable` 都报
`produced malformed response`，看起来像一屏源码错误。

### 模拟器验收不到健康同步

上面的命令产出的是**无签名模拟器包**（`CODE_SIGNING_ALLOWED=NO`），不签名也就不嵌入
entitlements，因此**没有 HealthKit 能力**。工程配置本身对 device 与 simulator 都挂着
`CODE_SIGN_ENTITLEMENTS = RAI/RAI.entitlements`（Debug/Release 均无条件）；缺能力的原因是这次构建
跳过了签名，不是「只在 device SDK 上挂 entitlements」。此时 HealthKit 调用直接返回
`Error Domain=com.apple.healthkit Code=4 "Missing com.apple.developer.healthkit entitlement."`，
`HealthKitExport.readAuthorizationState()` 按设计 fail closed（`HealthKitReadAuthorization` 四值：
`unavailable` / `notDetermined` / `decided` / `unknown`，失败文案见 `HealthKitExportError`），
首页与设置页显示「同步未完成」。

模拟器是否有样本/授权取决于该实例，不能沿用旧机器“Health库为空”的结论。
本项目上述无签名构建主要验证失败态UI、离线缓存和界面流程，不认证HealthKit真机读取或后台调度。
不要用手工补签名绕过工程能力配置；真实读取、权限和生命周期验收使用受支持签名的真机构建。

## 首次连接

在原生 App 的“设置”填写 API 服务地址和 Token。连接成功后应能看到 `serverId`、`athleteId`、`datasetEpoch` 和协议版本。不要填写手机上的 `127.0.0.1`；服务端应绑定手机可达地址，并按现有策略配置 HTTPS/局域网访问。

在“设置”点“同步健康数据”，申请 **HealthKit 读权限**（健康样本/记录只读）。排期 Apple Watch 课表另需
**WorkoutKit 的体能训练写授权**（`NSHealthUpdateUsageDescription`，见 `WorkoutKitBridge` 的
`WorkoutScheduler.requestAuthorization()`）；该授权只覆盖训练排期，App 不写、不改健康样本与记录。
App 通过现有 ZIP/XML 导入接口上传。后台同步由三个机制承担：HealthKit background delivery 负责“知道有变化”，`BGProcessingTask`（`app.rai.running.health-sync`）负责“给几分钟 CPU 做完导出与导入提交”，带 identifier 的 background URLSession 负责“把字节搬完”。**系统调度不可承诺具体时刻**；能承诺的只有两件事：一是已上传/已导入的进度一定落盘、下次唤醒能续接，二是前台打开时按权限、网络和服务状态重试补齐。真机验收清单见 `docs/IOS_NATIVE_SYNC_PROTOCOL.md`。

## 排障

### 训练计划与排课

训练页是**统一入口**（`TechUnifiedTrainingView`）：模式、准入、七日意图都在这里显示，配置与
暂停/继续/结束走教练闭环命令；设备侧排期不变量（写前日志、强读回、先撤回再下发）见
[IOS_NATIVE_PLAN_SCHEDULING](IOS_NATIVE_PLAN_SCHEDULING.md)。旧「跑步教练」独立编辑器已随
`/v1/mobile/run-coach` 退役（410），不要再按旧流程排查。

⚠️ 训练页仍保留「手动课表与本周安排」入口，但它的保存/预览/确认调用的是**已退役的旧写路由**
（`PUT /v1/mobile/goals`、`POST /v1/mobile/workout-plan/preview`、`POST /v1/mobile/workout-plan/confirm`），
在当前构建上会收到 `410 legacy_surface_retired`。这是**已知缺口 AR-1**（[PROJECT_REVIEW](PROJECT_REVIEW.md)），
不是用户操作错误；需要调整周计划时以训练页的 v2 配置命令为准，修复前不要重试旧保存。

暂停或结束后，应显式点“撤回 RAI 系统旧排期”并检查同步结果，不能把服务端状态变更当成设备已清空。模拟器用例 15/16 覆盖教练生命周期、大字体和目标时间计划；运行时可设 `RAI_VISUAL_DATABASE` 指向隔离验收数据库，不使用真实健康数据也能验证创建流程。

| 现象 | 处理 |
| --- | --- |
| 401 | 更新 Token；不要反复自动重试 |
| 无法连接 | 确认桥接网络、服务监听地址、手机与主机路由和证书 |
| 页面可见但数据过期 | 展开首页「数据状态」横幅的「数据覆盖明细」，分别看三件事：**同步状态**（`sync.status`：`正常`/`尚未同步`/`同步失败`）、**训练数据截至**（`latestDataDate`）、**最近健康样本**（`coverage.latestHealthSampleAt`）。只有 `同步失败` 才需要重新同步 HealthKit；「尚未同步」表示这台设备还没跑成过一次刷新 |
| 横幅写「今天没有恢复监测记录」 | 预期结果，不是故障：没戴表的夜晚属于**覆盖缺口**，只减少一份判断依据，不构成负面判断，也不再阻断锁定安排。要让今天纳入恢复数据，同步一次含昨夜记录的 Apple Health 导出即可 |
| 手动课表保存/预览/确认返回 `410 legacy_surface_retired` | 已知缺口（AR-1）：当前构建的手动课表入口仍调用已退役的旧写路由。这不是数据损坏；改用训练页的 v2 配置（模式/比赛目标），不要重试旧保存 |
| 训练详情没有底图 | 先确认已同意隐私说明（设置 → 地图底图）；再确认 `pod install` 打印了「已注入高德 Key」，Key 已绑本 App Bundle ID |
| 同步中断 | 再次打开 App，任务会从本机 `sync.sqlite` 和保留的 ZIP 恢复 |
| 模拟器上「同步未完成」 | 预期结果：模拟器包没有 HealthKit entitlement、Health 库也没有样本（见上文「模拟器验收不到健康同步」）；到真机按「首次连接」授权后验收 |
| 清缓存后内容消失 | 重新联网读取；服务端数据、凭证和同步任务不应被清除 |
| `ld: framework 'Pods_RAI' not found` | 先 `cd apps/ios && pod install`。`post_integrate` 会在安装后移除空的聚合框架链接；没跑过 `pod install` 才会出现这个链接错误 |
| `bad interpreter: /bin/bash^M` | 脚本被 CRLF 污染了。`.gitattributes` 已把 `*.sh`/`*.py`/`*.swift`/`*.pbxproj` 钉成 `eol=lf`，核对用 `git ls-files --eol <path>`（要达到 `i/lf w/lf`）；经 zip/共享目录（而不是 git）拷过来的树不享受这条保护，先确认行尾再跑 |
| `pod: command not found` | CocoaPods 已装但不在 PATH：`export PATH="$(gem environment | awk -F': ' '/EXECUTABLE DIRECTORY/{print $2}'):$PATH"`，或 `gem install cocoapods` |
| `unable to find utility "simctl"` | 命令行工具指向了 CommandLineTools：`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 或 `sudo xcode-select -s /Applications/Xcode.app` |
| 构建后地图卡片仍是默认城市视野 | 高德渲染器就绪前会忽略 fit，`RouteMapContainer` 会在 0.2 s 后重试；若持续出现，先确认 `pod install` 打印了「已注入高德 Key」，再检查 `Configs/AmapKey.xcconfig` 的 Key 是否绑定了本 App 的 Bundle ID |
| 训练详情里往下滑，页面不动而地图被划走 | 不该发生：路线卡片默认锁定手势（`mapInteractive = false`），`RouteMapContainer` 只在点按解锁后才接管平移。逐条核对 `apps/ios/tests/check-today-layout.py` 的「地图手势锁定」判据：SwiftUI 默认值、屏蔽层的 `allowsHitTesting`、`map.isScrollEnabled/isZoomEnabled` |

## 数据位置与隐私

页面缓存位于 App Support 下的 `RAI/cache.sqlite`，同步任务位于 `RAI/sync.sqlite`，凭证只在 Keychain。文件使用 iOS 数据保护。日志和诊断不得记录 Token、完整健康样本或精确路线。

## 真机人工验收清单

以下不由模拟器构建或纯逻辑测试替代；尚未现场执行时标记未验证。

- 首次、拒绝、部分或撤销 HealthKit **读**权限；未授权类型保持未知。**不**请求健康样本/记录的写权限；
  WorkoutKit 的体能训练写授权只用于排期，不得写入或修改健康样本。
- 前台首次导出、同批重传、获jobId后的断网/杀进程/重启续接；anchor只在导入成功后前移。
- 锁屏、系统后台唤醒/过期、background URLSession回调与前台主动同步竞争，不丢新意图、不重复提交。
- 服务URL、serverId、athleteId、datasetEpoch改变时，旧任务/缓存不串目标；未知身份不当成确认空。
- Route迟到、更正或配额限制时继续补齐/pending，不永久invalid或丢掉已导入兄弟路线。
- 恢复备份、服务重启、401/409/超时后保留草稿与反馈，分清同步、导入、分析三个阶段。
- 地图同意前不初始化SDK；坐标SDK对拍、VoiceOver、大字体、减少动态效果和耗电需真机观察。
- 训练详情里压着路线卡片上下滑动是**翻页**而不是拖动地图；轻点地图解锁后才可缩放拖动，右下角「锁定」一键收回，且解锁/锁定都不影响右上角「显示完整路线」的 fit。

记录设备、OS/App版本、数据scope、步骤/结果和脱敏证据；不得上传真实健康导出或凭证。

### 直连增量同步的真机验收（人工清单，2026-10-20 内联）

上位设计见 [SQLite 直接增量同步设计](SQLITE_DIRECT_SYNC_DESIGN.md) 的真机验收一节；本清单自包含
（原「PR6 真机验收清单」交付快照已并入本文并从仓库删除，不要再去 deliverables 找它）。

**先抄记录字段**（缺一项这次验收就不算数）：设备型号 / iOS 版本 ｜ App 版本 + build + commit ｜
API 地址 / `serverId` / `athleteId` / `datasetEpoch` ｜ 服务端是否宣告 `factsAnalysisContractVersion`
（新服务端 = 1 / 老服务端 = 缺失）｜ 数据 scope ｜ 起始游标与水位 ｜ 数据来源：**只允许合成或脱敏样本**。

**D1 有效游标保持**

1. 完整同步到成功，记录游标与水位。
2. **不新增任何数据**再触发一轮：不得重导全历史；服务端回答「已是最新」；**游标与水位不得回退**。
   若这一轮反复失败，按 receipt-less 成功路径的接线问题排查，**不要**当成「UI 文案没生效」。
3. 新增一条合成跑步记录再同步：只上传新增；文案依次为「读取增量」→「上传本批数据」→「保存新增与更正记录」；
   不得出现旧语义（`备份并校验现有数据` / `临时数据库增量同步` / `验证完成正在切换本地数据库`）。
4. 对照服务端实际收到的批次数与条数（`/v1/import-jobs` 或 worker 日志）。

**D2 后台中断后续传**

1. 制造较大增量（几百条合成样本）并开始同步。
2. 上传/导入中途切后台或锁屏 ~30 s 再回前台：必须可续接，**不得显示「同步已取消」**（切后台不是用户取消）。
   留证：`sync_tasks` 行的 `phase` / `jobId` / `payloadHash` / `needsContinuation` + 同一 `jobId` 的终态。
3. 强杀 App 后重开再同步：从持久状态恢复，**不重复导入已确认批**；同 scope 重试返回**同一份回执**。
4. 必留字段（脱敏）：`receiptId`、`ingestStatus`、`analysisStatus`、`dependencyGeneration`、
   `publishedReleaseId`、`parentBatchId`，以及游标 blob **是否**推进。

**D3 文案两阶段**

- raw COMMIT 之后：预期「健康数据已保存，分析更新中」（`ingestStatus: committed` + `analysisStatus: queued`）；
  `queued ≠ published`，此时**不得**说「分析已更新」。
- 分析终态由一次**有界 `GET /v1/jobs/:id` 对账**取得：`succeeded` ⇒「分析已更新」；
  `failed` ⇒「健康数据已保存，分析更新失败，可重试分析」。对账只在某次同步收尾时触发，
  **冷启动不会主动对账** ⇒ 别把「重启后没立刻看到终态文案」记成文案失效。
- 回执是**写入时刻**的凭证，不随分析推进而变；「回执没变」不等于「分析没跑」，
  也不得把「分析状态推进」实现成改写凭证。

**D4 老服务端不被新客户端卡死**

把 App 指向**未宣告** `factsAnalysisContractVersion` 的服务端：必须仍是旧行为（游标正常推进、同步能成功），
**不得**每轮 hold、更不得永远同步不完。失败判据：任一轮以「缺回执/契约缺失」结尾且游标不推进 ⇒ 本次验收失败。

**失败判据（任一命中即失败，不得用「性能改善了」替代）**

1. 正常批次期间出现任何禁止操作的可见痕迹；
2. 无新增数据的一轮**反复失败**或游标回退；
3. 切后台被说成「用户取消」；
4. COMMIT 后重启/丢回复导致重复导入，或重试拿到**不同**回执；
5. 用户看到旧语义中的任何一句；
6. `analysisStatus: queued` 被显示成「分析已更新」。

留证：脱敏截图（只截文案区）、`sync_tasks` 行与回执字段文本、服务端同一 `jobId` 的状态与时间线。
**不得**提交原始健康数据、精确路线、上传 ZIP 或 SQLite。

真机执行前先在 macOS 上跑 `npm run test:ios`：它本机（Windows）是**显式跳过**，不是通过。
`HealthKitSync.swift` 不被任何回归编译，所以它的问题只在真机与结构门禁上暴露。

## 训练计划/WorkoutKit 发布前设备清单（2026-10-09，2026-10-20 重新指向）

当前自动回归与设备侧排期职责见 [IOS_NATIVE_PLAN_SCHEDULING](IOS_NATIVE_PLAN_SCHEDULING.md)；
wire 字段与退役矩阵见 [IOS_NATIVE_API_CONTRACT](IOS_NATIVE_API_CONTRACT.md)。
两条页面共用“手表课表”管理入口；无计划、已结束、离线也可显式“撤回 RAI 系统旧排期”。
“上次记录”不是本次验证，重启初态为“未核验”。系统排期是 app 级，不是 server/dataset 各自拥有一份。

以下必须由配对真机负责人现场执行，不用模拟器或 fake 替代：

- 支持性、首次授权、拒绝/受限、恢复授权；在当前 OS 的系统设置定位 RAI 体能训练计划权限，记下设备/OS/实际入口。不要默认建议卸载或还原位置与隐私。
- WorkoutPlan.id 是否稳定读回；日期是否转为 UTC、是否保持规范化排期时刻；内容是否保持同一 Workout。
- 同日更新、提醒时刻变化、时区/午夜、同步期间恢复闸门变化、授权等待期间变化；未核验日期不能登记。
- 三日两成功及 offered3/pending2/confirmed2：逐日结果、覆盖与服务端登记分别确认。
- 暂停/结束、空窗口的撤回核验；清空失败的风险文案不能被“没有新训练”掩盖。
- 同步后重启、离线/无当前计划/换服务域；显式撤回仍可达，上次 ledger 不冒充本次结果。
- 系统排期读回延迟：记下实际延迟分布再决定有限、可取消的重试参数，当前一次读回缺失就保持未核验。
- **分别**保存系统列表 UUID/日期/时刻/内容一致证据和配对手表实际可见证据；后者不可由前者代替。

不对个人健康主库或个人手表实施破坏性故障注入。真实设备未参与时发布状态写“设备验收待完成”，不得写成全链路已验收。
