# UI 回归验收：科技风字段覆盖（2026-09-17）

本目录是 `deliverables/FIELD_COVERAGE_2026-09-17.md` 那轮改动之后的 UI 回归证据。
改动内容：科技风向今日页补回 5 个曾丢失字段的展示位（`phase` / `race.note` / `race.shapeScore` / `race.taper` / `postRun`），
两皮肤的闭集枚举改为经映射函数输出（不再直出 `need_sync` / `half_marathon` 这类机器码）。

## 结果

| 项 | 值 |
|---|---|
| 用例 | **14 / 14 passed**，`0 failures (0 unexpected)` |
| 用时 | 1025.3 秒（测试阶段）＋ 构建阶段，共 **25m18s** |
| 退出码 | `0`（`run-visual-tests.sh` 以 xcodebuild test 的状态码退出） |
| 设备 | `RAI Technology Acceptance`（iOS 26.5 模拟器），状态栏覆写为 9:41 满电满格 |
| 夹具 | `var/rai.sqlite` 的副本（`sqlite3 .backup`），临时服务只监听 8792 |

用例逐个通过：`test01TodayAndBody` / `test02Workouts` / `test03Plan` / `test04Analysis` / `test05Settings` /
`test06Setup` / `test07LargeText` / `test08FaultStates` / `test09AppearancePersistence` / `test10RevisionConflict` /
`test11NativeBackGestureAndSafeArea` / `test12LargeAbilityAndKeyboard` / `test13SeriesInteractionDoesNotStealScroll` /
`test14ScrollPerformanceBaseline`。

> 上一轮（2026-09-17 08:58）这一套是 13/14，`test06Setup` runner 崩溃；本轮是 14/14。

## 源码冻结（结论成立的前提）

| 检查 | 值 |
|---|---|
| `build.log` mtime | `2026-09-17 13:18:23` |
| 该时刻之后被改动的 `apps/ios/**/*.swift` | **0 个** |

所以这一轮截图对应的就是当前工作区的源码，不存在"截图比代码旧"。

## 关键截图

`screenshots/01-today-links.png` —— 今日页底部，**本轮新增的比赛目标卡**（无目标态）：

```
[旗标图标] 尚未设置比赛目标
           还没有目标赛事。设一个日期和距离后，首页会给出倒计时和专项形态。   >
体型分
78%
```

这一张同时证明三件事：

1. **卡片无条件渲染**：夹具里没有比赛目标，旧版整卡包在 `if let target` 里 ⇒ 这一块根本不会存在。
2. **`race.note` 真的来自服务端**：那句引导语是 `mobile-coach.ts` 的 `buildRaceCard` 无目标分支返回的原文。
3. **`race.shapeScore` 与 target 解耦**：服务端在无目标时仍给 `shapeScore = 0.78` —— 旧版永远显示不出来，现在显示 `78%`。
   （`减量` 格按设计不显示：`taper` 无目标时恒 `false`，显示"否"是噪音。）

其余归档截图：`01-today.png` / `01-today-lower.png` / `01-today-ability-card.png` / `01-body.png`（今日页其余分段与身体指标）。

## 覆盖边界（说清没测到什么）

- **`postRun` 面板没有截图覆盖**：`buildPostRun` 对"今天没有训练"返回 `null`，而夹具是 `0.00 km`（今日无训练）⇒ 面板按设计不渲染。
  它的正确性由编译 + 展示逻辑门禁断言（字段被引用 + 映射函数被调用）保证，**没有渲染级证据**。
- **像素风今日页没有截图覆盖**：`test01TodayAndBody` 走默认皮肤（科技风）。像素风那三处改动（`nativeDayPhaseName` /
  `nativeStimulusMatchName` / `nativeRaceDistanceName` 替换直出）只有编译 + 门禁断言覆盖。
- **65 张截图里只归档了今日页相关的 5 张**（其余页面本轮未改动）。完整清单见 `screenshot-manifest.json`。
  源目录 `/tmp/rai-visual-2026-09-17-field/`（含 `tests.xcresult` 20 MB）**会随重启丢失**，需要全量请重跑。

## 重跑

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
RAI_VISUAL_OUTPUT=/tmp/rai-visual-$(date +%Y%m%d-%H%M%S) bash apps/ios/tests/run-visual-tests.sh
# 单跑一个用例（注意 -only-testing 必须三段式，写错会「Executed 0 tests」并假通过）：
# … run-visual-tests.sh -only-testing:VisualAcceptance/VisualAcceptance/test01TodayAndBody
```

前置：`pod` 装好（`Pods/` 已在本地，`Podfile.lock` 未变时无需 `pod install`）、存在名为 `RAI Technology Acceptance`
的模拟器、端口 8792–8794 空闲、`var/rai.sqlite` 存在。

## 归档文件

| 文件 | 说明 |
|---|---|
| `ui-tests.log` | 完整 xcodebuild UI 测试日志（含每条用例的起止与断言） |
| `screenshots/01-today-links.png` 等 5 张 | 今日页分段截图 |
| `screenshot-manifest.json` | 本轮 65 张截图的名字 → 用例 → 附件 ID 索引 |
