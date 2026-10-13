# RAI 原生 iOS 运行说明

## 跨平台命令矩阵

本仓库在 Windows 上开发、在 macOS 上构建 iOS，**同一条命令在三端逐字相同**：

| 命令 | Windows（cmd / PowerShell） | macOS |
|---|---|---|
| `npm run typecheck` | 真跑 | 真跑 |
| `npm test` | 真跑（Node 套件 + Web vitest） | 真跑 |
| `npm run test:ios` | **显式跳过**：打印「本次没有检查任何 iOS 源码」，退出 0 | 真跑（类型检查 + 纯逻辑回归） |
| `npm run build` | 真跑 | 真跑 |
| `npm run test:e2e:web` | 真跑 | 真跑 |

三条硬规则由 `npm run check:scripts` 执行（`scripts/check-npm-scripts-portable.mjs`），不是口头约定：

1. **npm script 正文只用双方言都认的语法**：`&&`、纯命令、`node xxx.mjs`。
   禁用 `;`、`$?`、`$VAR`、`VAR=x cmd`、`test`、`[ ]`、`uname`、依赖 shell 展开的 `*`。
2. **平台判定只在脚本内部**：Node 用 `process.platform`，bash 用 `uname -s`。
3. **`.mjs` 优先**，`.sh` 只留"必须在 macOS 跑"的部分；`.sh` 一律用 `bash <path>` 调用，
   不写 `./x.sh`（Windows 的 git 默认不记录 +x 位）。

⛔ **不要用 WSL / Git Bash 去"模拟"Mac**：`xcodebuild`、CocoaPods、模拟器只在 macOS 上真跑。
Windows 侧的职责只是让**跨平台可验证**的部分（typecheck、纯逻辑回归、Web e2e）与 Mac 一致；
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
> `typecheck` / `test` / `build` / `test:e2e:web` 在 Windows 上同样真跑，不需要它们。

- macOS、Xcode 和 iOS 17 或更新的 SDK。
- 已安装本项目使用的 iOS 平台组件。
- CocoaPods（高德 SDK 由 `apps/ios/Podfile` 引入）。
- Apple ID/开发团队可签名；HealthKit capability 已打开。
- iPhone 与 API 服务处于同一局域网，或通过个人 VPN 访问。

## 构建与运行

从仓库根目录启动可被手机访问的服务（跨平台，Node 入口）：

```bash
npm run dev:device
```

在 macOS 上打开工作副本；`darwin` 调 `open`，Windows/Linux 上**显式跳过**并说明"本次没有打开任何东西"，
不会用 `start` 假装打开（`.xcworkspace` 在 Windows 上没有关联程序，只会弹一个对话框然后照样退出 0）：

```bash
npm run open:ios
```

打开的是 `apps/ios/RAI.xcworkspace`（**不是** `RAI.xcodeproj`），选择 RAI scheme 和真实 iPhone，
检查 Signing & Capabilities 中的 Team，执行 Build/Run。项目最低部署版本保持 iOS 17。

高德 SDK 以 pod 形式链接，只打开 `RAI.xcodeproj` 会构建失败（`ld: framework 'Pods_RAI' not found`）。

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
健康同步取消、缓存与续传日志、Tech 展示层与对比度、今日页版式）。非 macOS 或没装 Xcode 时它会
**显式跳过并打印"本次没有检查任何 iOS 源码"**，不假装通过；`.githooks/pre-commit` 在
`apps/ios/` 有改动时自动跑它。

iOS 家族统一走同一个 Node 包装，四条命令都是"非 macOS ⇒ 显式跳过 + 退出 0"：

| 命令 | 实际执行 | 何时跑 |
|---|---|---|
| `npm run test:ios` | `apps/ios/tests/run-ios-gates.sh` | 每次改动（pre-commit 自动） |
| `npm run test:ios:live` | `check-export-determinism-live.py`（探针装进模拟器，跨进程比对导出字节） | 手工验收 |
| `npm run test:ios:mutation` | `check-background-mutations.py`（逐条改坏源码再跑门禁，十几分钟） | 判据本身被改动时 |
| `npm run test:ios:mutation:scope` | 同上，`RAI_MUTATION_FOR=git` 按改动范围裁剪 | 日常 |

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

### 跑步教练

今日页“打开训练计划”进入新版自适应跑步教练，可创建目标、修改训练偏好、暂停/继续或结束计划。独立旧编辑器在无教练或已结束时由“手动课表”进入；进行中不支持逐日改期。完整边界见 [RUN_COACH](RUN_COACH.md)。

暂停或结束后，应显式点“撤回 RAI 系统旧排期”并检查同步结果，不能把服务端状态变更当成设备已清空。模拟器用例 15/16 覆盖教练生命周期、大字体和目标时间计划；运行时可设 `RAI_VISUAL_DATABASE` 指向隔离验收数据库，不使用真实健康数据也能验证创建流程。

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
| `bad interpreter: /bin/bash^M` | 脚本被 CRLF 污染了。`.gitattributes` 已把 `*.sh`/`*.py`/`*.swift`/`*.pbxproj` 钉成 `eol=lf`，核对用 `git ls-files --eol <path>`（要达到 `i/lf w/lf`）；经 zip/共享目录（而不是 git）拷过来的树不享受这条保护，先确认行尾再跑 |
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

### 直连增量同步的真机验收（§14.5 第七项 / §14.2 A07、A17）

上位判据是 [SQLite 直接增量同步设计](SQLITE_DIRECT_SYNC_DESIGN.md) §14.5 的「真机 HealthKit 自动增量、
续传、有效游标保持和新状态完成手动验收」，逐条步骤、预期观测、留存证据与失败判据见
[PR6 真机验收清单](../deliverables/DIRECT_SYNC_PR6_DEVICE_VERIFICATION_2026-10-13.md)。
四条最容易判错方向的边界先写在下面，**它们的失败形态都不是报错，而是"看起来正常"**：

- **有效游标保持**：连续两轮同步里，第二轮**不得**重导历史。第一轮之后 App 若被强杀，第二轮必须从已提交水位继续；
  判据是服务端的批次/来源数量，不是界面耗时（§14.2 A02）。
- **续传**：`needsContinuation` 为真时**不得**清空后台待办意图 —— 清掉的后果是"用户不打开 App 就再也没人发下一批"，
  而界面当时显示的是成功（§10.2、§5.1）。
- **新状态文案**：raw COMMIT 之后应看到「健康数据已保存，分析更新中」；分析终态由一次独立对账取得，
  之后才可能变成「分析已更新」或「健康数据已保存，分析更新失败，可重试分析」。
  ⚠️ 对账只在某一次同步收尾时触发，**冷启动不会主动对账** ⇒ 别把"重启后没立刻看到终态文案"记成文案失效（§10.3）。
- **老服务端**（未宣告 `factsAnalysisContractVersion`）：必须**仍是旧行为**（游标正常推进）。
  判错方向的后果是每次唤醒都 hold、窗口被反复重导，而用户看到的是"同步完了"（§10.2「保留旧等待含义」）。

真机执行前先在 macOS 上跑 `npm run test:ios`：它本机（Windows）是**显式跳过**，不是通过。
`HealthKitSync.swift` 不被任何回归编译，所以它的问题只在真机与结构门禁上暴露。

## 训练计划/WorkoutKit 发布前设备清单（2026-10-09）

当前自动回归与存储/排期职责见 [IOS_TRAINING_PLAN_IMPLEMENTATION](IOS_TRAINING_PLAN_IMPLEMENTATION.md)。
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
