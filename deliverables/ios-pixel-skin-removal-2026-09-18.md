# iOS 原生像素皮肤移除 — 变更清单与验收要点

**日期**：2026-09-18 ｜ **范围**：`apps/ios`（iOS 原生 App）＋ 相关文档
**净变更**：`29 files changed, 269 insertions(+), 4012 deletions(-)`
**门禁**：`typecheck-ios.sh` ✅ 43 文件通过 ｜ `run-model-tests.sh` ❌ exit=1（**既有缺口，非本次回归**，见 §4）｜ `git diff --check` ✅

---

## 0. 范围裁定（这一刀最容易误伤）

| 对象 | 处置 | 理由 |
|---|---|---|
| **iOS 原生像素皮肤**（`apps/ios/RAI/Pixel*`、`Skins/AppSkin.swift`） | 🔴 **本次移除** | 小唐指令，原生端只留一套视觉 |
| **Web 的 iOS 壳像素界面**（`apps/web/src/ios/*`、`ios-pixel.css`、`design/ios-app-design.html`） | ⚪ **保留，不在范围** | 那是 Web 页面的像素版式，与 iOS 原生皮肤无关 |
| HealthKit / 数据导入 / 评分核心 / 课表排期 | ⚪ **零改动** | 皮肤纯属表现层，未触碰任何持久化或业务逻辑 |

> iOS 皮肤**完全由 Swift 代码实现**：`Info.plist` 与 `Assets.xcassets` 里没有像素专属资源，`.pbxproj` 用的是
> `PBXFileSystemSynchronizedRootGroup`（文件夹自动同步），对 `Pixel*` 零引用 ⇒ **无资源配置需要删除**，
> 删源文件也不必改工程文件。

---

## 1. 删除文件（6 个，`git rm`，共 1121 行）

| 文件 | 行数 | 内容 |
|---|---|---|
| `apps/ios/RAI/PixelTheme.swift` | 397 | `PixelColor` / `PixelMetrics` + 全部 `Pixel*` 组件（Background / Panel / HeroCard / Badge / SectionHeader / SegmentedControl / MetricTile / IconButton / PrimaryButton / ProgressBar / StatLine / EmptyState / LoadingState / Field / InsightCard） |
| `apps/ios/RAI/PixelCharts.swift` | 368 | 6 个像素图表组件（删除时已零调用方） |
| `apps/ios/RAI/NativeHeartRateChart.swift` | 96 | 唯一调用方在像素页面内；其注释自述「共享组件」已过时 |
| `apps/ios/RAI/PixelTabBar.swift` | 81 | `PixelTabBar` ＋ **`NativeTab`（迁移，见 §3）** |
| `apps/ios/RAI/PixelIcons.swift` | 69 | `PixelRunnerIcon` / `PixelIconBox` ＋ **`nativeSessionSymbol`（迁移，见 §3）** |
| `apps/ios/RAI/Skins/AppSkin.swift` | 110 | `AppSkin` 枚举 / `AppSkinKey` / `AppSkinPicker` / `SkinSwatch` |

---

## 2. 修改文件（23 个）

### 2.1 代码（12）

| 文件 | 变更行数(±) | 摘要 |
|---|---:|---|
| `apps/ios/RAI/NativeViews.swift` | 2607 | **重写为壳层**（~90 行）。原来它同时承载全部像素页面；现只留 `NativeTab`（五入口 + 标题 + SF Symbol）与 `NativeRootView`（`TechBackground` + 内容 + `TechTabBar`，`.task` 拉数据、请求失败弹 `TechRequestFailure`）。页面全部指向 `Tech*View` |
| `apps/ios/RAI/RootView.swift` | 113 | 删 `import UIKit`、`pixelBody`、`serverPlaceholder` 与两个无人再读的草稿 `@State`；`SetupView` 的 iOS 分支**固定** `TechSetupView()` |
| `apps/ios/RAI/NativeFormat.swift` | 90 | 删 `import SwiftUI`；**迁入** `nativeSessionSymbol`；删 5 个只服务像素页的函数（`nativeHeartRateZoneColor` / `nativeToneColor` / `nativeDayPhaseName` / `nativeStimulusMatchName` / `nativeRaceDistanceName`）。⇒ **成为纯 Foundation**，已纳入 `run-model-tests.sh` 编译列表（见 §3） |
| `apps/ios/RAI/RAIApp.swift` | 8 | 删 `@AppStorage(AppSkin.storageKey)`；改为固定 `.preferredColorScheme(.dark)` + `.tint(TechColor.cyan)` |
| `apps/ios/RAI/Skins/Technology/TechViews.swift` | 41 | ⚠️ **本文件 diff 含两条在飞改动，非本次工作**（恢复卡 → `TechTodayRecoveryMetrics`、跑力 → `TechTodayAbilityRuler`，含未跟踪新文件 `TechTodayRecovery.swift`，均**未回退**）。本次只叠加两处：删设置页「外观皮肤」`settingsLink`；两处注释去掉对像素皮肤的位置依赖 |
| `apps/ios/RAI/Skins/Technology/TechSetupView.swift` | 2 | 删 `DisclosureGroup { AppSkinPicker() }` |
| `apps/ios/RAI/Skins/Technology/TechTheme.swift` | 3 | 注释去像素引用 + 2026-09-18 说明 |
| `apps/ios/RAI/Skins/Technology/TechEnumPresentation.swift` | 3 | 注释改为「映射只有这一份」 |
| `apps/ios/RAI/MapPrivacyConsentView.swift` | 9 | **用户可见文案**：原「启用后科技皮肤…像素皮肤保持纯轨迹图」→「启用后训练详情页使用该底图；不启用时保持纯轨迹图」 |
| `apps/ios/RAI/CalibrationState.swift` | 8 | 注释更新（`PixelColor` 已成历史，判据保留动因不变） |
| `apps/ios/RAI/VerdictPresentation.swift` | 9 | 注释去「两皮肤行为相反」表述，保留白名单判据与「只有 `green` 是通过」的结论 |
| `apps/ios/RAI/NativeAppModel.swift` | 2 | 注释去像素引用 |

### 2.2 测试与门禁（4）

| 文件 | 变更行数(±) | 摘要 |
|---|---:|---|
| `apps/ios/tests/VisualAcceptance.swift` | 40 | 删 `test09AppearancePersistence`；`test05Settings` 去外观入口步骤；3 处启动参数删 `-rai.appearance.skin`；类文档加说明 |
| `apps/ios/tests/run-tech-presentation-tests.sh` | 39 | 闭集枚举断言改单皮肤（删 `native_format` 与三个 `native*Name` 映射，调用点断言只留 `TechViews.swift`） |
| `apps/ios/tests/typecheck-ios.sh` | 20 | 排除清单 4 → 3：**纳入 `MapPrivacyConsentView.swift`**（它其实只用 `MapPrivacy` 静态接口，不依赖高德 SDK；本次它改了用户可见文案，不改门禁就会出现「改过的文件不在闸门里」） |
| `apps/ios/tests/run-model-tests.sh` | 6 | 编译列表加入 `apps/ios/RAI/NativeFormat.swift` |

### 2.3 文档（7）

| 文件 | 变更行数(±) | 摘要 |
|---|---:|---|
| `apps/ios/design/TECHNOLOGY_SKIN.md` | 78 | 标题改「原生 iOS 视觉：冰蓝科技」；**新增「2026-09-18 移除像素皮肤」节**（删除/重写/迁移/入口变化/刻意不动项）；修正 19/22 → 19/23 |
| `apps/ios/README.md` | 49 | 「外观皮肤」节 → 「界面视觉」；重写像素 UI 节、路线/地图/门禁描述；明确旧键不需迁移 |
| `docs/IOS_NATIVE_ACCEPTANCE.md` | 7 | 删像素皮肤验收项，补单皮肤后的验收口径 |
| `docs/IOS_NATIVE_UI_REVIEW.md` | 6 | 去掉双皮肤一致性评审项 |
| `docs/ARCHITECTURE.md` | 4 | 皮肤层描述改单皮肤 |
| `docs/IOS_NATIVE_IMPLEMENTATION_PLAN.md` | 2 | 计划项改为「已收敛为单皮肤」 |
| `README.md`（根） | 14 | 项目级描述同步 |

### 2.4 明确**未**改动的相关文件

`apps/web/**`、`apps/api/**`、`packages/**`、`apps/ios/RAI/HealthKitExport.swift`、`WorkoutKitBridge.swift`、
`CoordinateConversion.swift`、`Info.plist`、`Assets.xcassets/**`、`RAI.xcodeproj/project.pbxproj`。

---

## 3. 两个「不是像素专属」的符号（本次唯一的技术陷阱）

文件按名字看都属于像素皮肤，但其中两个符号被非像素代码依赖 —— **直接整文件删会编译不过**：

| 符号 | 原位置 | 调用方 | 迁移到 |
|---|---|---|---|
| `NativeTab` | `PixelTabBar.swift` | `TechTabBar` 的 selection 类型；**UI 回归用例的 `tab.<标题>` 可访问性标识符** | `NativeViews.swift` |
| `nativeSessionSymbol` | `PixelIcons.swift` | `TechViews.swift` 三处（纯符号名映射，与皮肤无关） | `NativeFormat.swift` |

> 方法：删文件前先做**死后引用分析**（构造待删文件集 → 扫剩余文件的符号引用），别按文件名判断归属。

**附带收益**：`NativeFormat.swift` 去掉 `PixelColor` 依赖后成为纯 Foundation ⇒ 被 `run-model-tests.sh` 纳入
编译列表。它是页面数值/单位/日期的唯一归一化点，此前正因 iOS 专属依赖而进不了那扇秒级闸门
（`CalibrationState.swift` 的注释记录了这段历史）—— **规则存在但不在闸门里，等于没有**。

---

## 4. 门禁实测结果

| 门禁 | 结果 | 说明 |
|---|---|---|
| `bash apps/ios/tests/typecheck-ios.sh` | ✅ **通过** | 脚本自报 **检查 43 个文件（跳过 3 个仅依赖高德 SDK 的）**。口径变化：受检文件 **47 → 43**（−6 个已删文件 ＋1 个新纳入的 `MapPrivacyConsentView.swift`）；当前 `apps/ios/RAI/**` 磁盘上共 46 个 `.swift`（含在飞的未跟踪 `TechTodayRecovery.swift`），跳过 `MapPrivacy.swift` / `RAIApp.swift` / `TechRouteView.swift` |
| `bash apps/ios/tests/run-model-tests.sh` | ❌ **exit=1** | 121 PASS，唯一红点：`MobileTodayResponse grew ['recentPlanExecution'] with no display slot` |
| `git diff --check` | ✅ 干净 | |
| `bash apps/ios/tests/run-visual-tests.sh` | ⏸️ **本轮未跑** | 需已启动模拟器 + `var/rai.sqlite` 验收库（`var/` 被 gitignore），约 25–30 min |

🔴 **关于那个红点（务必不要误判为本次回归）**：已**双向复核**——用 `git show HEAD:apps/ios/tests/run-tech-presentation-tests.sh`
取出旧版脚本运行，**旧版同样红在同一断言**（旧版 line 144 / 新版 line 161），报错文字一致。
引入提交 `7427d7d feat(api): surface recent plan execution to today and the coach` 新增了该字段却没同步门禁清单，
全仓 grep 也确认它**没有任何展示位**。
⇒ 这是**产品决策**（在 `TechViews.swift` 里补一个展示位，或按例外登记并写明理由），
本次**没有绕过门禁、也没有把它塞进 `metadata_only` 蒙混**。

---

## 5. 需重点验证的功能场景

### 🔴 P0 — 直接影响用户可见行为

1. **冷启动**：删除旧 App 重装后启动，**直接进冰蓝科技界面**，无白屏/无崩溃、无皮肤相关 alert。
2. **旧安装升级启动**：保留含有 `rai.appearance.skin` 的 UserDefaults（曾选「清新像素」），升级后启动 ——
   **必须正常进入科技界面**（该键已无人读取，不做迁移、不需清数据）；服务地址、API Token、健康同步状态全部保留。
3. **启动外观变化**：此前是「跟随系统」，现在**固定深色**。请在**系统设为浅色**的情况下启动确认 ——
   这是本次唯一"看起来像 bug 的预期行为变化"，值得单独确认是否符合预期。
4. **设置页**：不再出现「外观皮肤 / 冰蓝科技 / 清新像素」入口；地图底图、同步、缓存等其余项**行为不变**。
5. **首次连接页**（`SetupView`）：不再有皮肤选择 `DisclosureGroup`，且**能正常完成服务地址 + Token 连接流程**。
6. **训练详情页**：路线 `Canvas`（纯轨迹）↔ 高德底图切换正常；未同意隐私时**文案为新的措辞**（不再提"像素皮肤"），
   「不启用时保持纯轨迹图」与实际一致。

### 🟡 P1 — 结构/回归风险

7. **五个 Tab 全部可达**且切换正常（今日 / 训练 / 统计 / 趋势 / 设置）；`TechTabBar` 的选中态与
   `tab.<标题>` 可访问性标识符**未被 `NativeTab` 迁移破坏**（这是唯一被迁移的共享符号）。
8. **各页面导航进/出**：训练详情、课表、趋势子页的 push/pop 正常 —— `NativeViews.swift` 被整个重写，
   这是风险最集中的地方。
9. **数据加载路径**：`.task(id: serverURL + token)` 触发刷新；断网时 `isOffline` 与缓存横幅正常；请求失败弹 `TechRequestFailure`。
10. **`NativeFormat.swift` 归一化点**：页面上的距离/配速/时长/日期格式**逐项抽查**（它现在是门禁内文件，
    但格式一旦改坏是全机展示错误 —— 重点看今日页与训练列表）。
11. **训练类型图标**：`nativeSessionSymbol` 从 `PixelIcons.swift` 迁到 `NativeFormat.swift` 后，
    今日推荐、训练列表的图标**与迁移前一致**（这是肉眼可验的迁移正确性）。

### 🟡 P2 — 测试资产

12. `test05Settings` 去掉外观步骤后**仍能跑到缓存面板**；`test09AppearancePersistence` 已删除，不再有引用残留。
13. `run-model-tests.sh` 恢复绿的前提是 `recentPlanExecution` 得到处置（补展示位 / 登记例外）——
    **在此之前它不会绿**，请勿在 CI 上把它当成新回归。

---

## 6. 回滚方案

改动集中在 iOS 表现层与文档，**无数据迁移、无 schema 变更、无持久化写入**，回滚即代码回滚：

```bash
git revert --no-commit <本次提交>      # 或在合并前 git checkout HEAD -- apps/ios
```

- 6 个删除文件均为 `git rm`（变更已暂存），回滚无内容丢失风险。
- 回滚后需重跑 `typecheck-ios.sh` 确认 43 → 42 文件口径复原，并**重新 build + 安装**（改 Swift 源 ≠ 真机生效）。
- 唯一有外部影响的是 `MapPrivacyConsentView.swift` 的隐私页文案，回滚后文案回到提及"像素皮肤"的旧版。

---

## 7. 提交时的补充核验（2026-09-18 14:20–14:45，小满）

本文档 §4 的门禁结论在**提交前复算**时有两处需要更正，另有 1 个上一轮漏掉的**真回归**：

| 项 | 本文档原述 | 实测（工作区最终态） |
|---|---|---|
| `run-model-tests.sh` | ❌ exit=1（`recentPlanExecution` 无展示位） | ✅ **exit=0**。同一工作区里"今日页紧凑恢复卡"那批改动给该字段补了展示锚点，缺口已经闭合（`Field coverage: 20/23 … 3 are metadata by design`）。**§4 的红点描述已过期** |
| `run-tech-presentation-tests.sh` | 未单列 | ✅ 45 checks 通过（含新增的今日页断言） |
| `npm test`（全仓 TS 门禁） | 未跑 | 🔴 **基线红：641 项 / 2 fail**，见下 |

### 🔴 漏掉的真回归：`apps/api/test/schemas.test.ts` 的"每个皮肤一处"下限

`npm test` 的 2 个红点都来自**按皮肤计数**的源码级断言，删除像素皮肤后分母从 2 变 1，断言却仍写 `>= 2`：

| 位置 | 断言 | 报错 |
|---|---|---|
| `schemas.test.ts:558` | 可编辑周计划行 `checked.length >= 2` | `两个皮肤都应当有可编辑的周计划行，实际找到 1 处` |
| `schemas.test.ts:625` | 训练类型选择器 `pickers >= 2` | `两个皮肤各应有一个训练类型选择器，实际扫描到 1 个` |

**这是本次皮肤删除引入的回归**，不是既有缺口：断言扫的是 `apps/ios/RAI/**` 的 Swift 源（`swiftSources()`），像素皮肤的周计划行与类型选择器一被删除，分母就只剩 1。**§2.4 把 `apps/api/**` 列为"明确未改动"是错的** —— 至少 `apps/api/test/schemas.test.ts` 必须同批修改，否则"每个节点可编译可测"这条红线在删除皮肤的那一刻就断了。

已修：两处下限改 `>= 1`，测试标题与注释同步去掉"两个皮肤"的措辞（`the week editor offers neither today…`）。判据保留（防"改名/删行导致空过"的守卫目的不变），只是分母随皮肤数变化。

### 顺带修正的 3 处陈旧文案（同一提交）

- `apps/ios/RAI/VerdictPresentation.swift`：新增文案里混入一个孤立的 `「`（`「insufficient`），改回 `` `insufficient` ``。
- `apps/ios/RAI/NativeAppModel.swift:62`：`Shared by both skins` → 去掉双皮肤假设。
- `apps/ios/RAI/NativeAppModel.swift:832-839`：`shared by both skins` / `pin them once for both` → 改为"历史上有过两套皮肤"，保留事故沿革。

### 提交切分（7 个，逐节点可编译可测）

| # | commit | 范围 |
|---|---|---|
| 1 | `feat(api): require measured steps before showing plan segments` | `api-contracts` + `apps/api/src/data.ts` + 其测试 |
| 2 | `feat(ios): gate the plan-segment panel on measured workout steps` | `APIModels` + `TechPresentationRegression` + `TechViews` 调用点 |
| 3 | `fix(ios): plot the workout series chart in minutes, not seconds` | `TechSeriesChart` |
| 4 | `fix(ios): open the workout route on the interactive map by default` | `TechRouteView`（同意仍由 `mapAllowed` 把守） |
| 5 | `feat(ios): tighten the today page into paired summary cards` | 今日页那批 + `TechTodayRecovery.swift` + `check-today-layout.py` |
| 6 | `refactor(ios): drop the pixel skin and keep one native look` | 本文档 §1–§3 + `schemas.test.ts` 下限修正 |
| 7 | `docs: record the pixel-skin removal and the today page revision` | README / `docs/**` / 本文档 |

### 仍未闭合的两项（不阻塞提交/部署）

1. `apps/ios/tests/check-today-layout.py` 目前**没有任何入口调用它**（全仓 grep 零命中，`run-model-tests.sh` 也没挂）——按本项目的判据，这就是"判据存在但没被执行"，等同孤儿脚本。要它成为闸门，得挂进 `run-model-tests.sh`。
2. `run-visual-tests.sh` 本轮仍未跑（需模拟器 + `var/rai.sqlite`），即 §5 的 13 条真机/模拟器验收项**仍未取得证据**。

