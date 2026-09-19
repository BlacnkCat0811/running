# UI 回归验收：时效与恢复四态语义（2026-09-19）

本目录是 `deliverables/DATA_FRESHNESS_SEMANTICS_PLAN_2026-09-19.md` 的 P1 改动之后的 UI 回归证据。

改动内容（一句话）：**把「同步状态 / 数据覆盖 / 恢复评估 / 训练建议」拆成四件互不替代的事**，
使「偶尔不戴表」表现为**少一份判断依据**，而不是**多一个负面判断**。

## 证据的核心：同一块横幅，改前 vs 改后

| 面板 | 2026-09-17（改前） | 2026-09-19（改后） |
|---|---|---|
| 数据状态横幅 | 黄底「**数据过期**」/「健康数据截至 8月25日」 | 青底「**正常**」/「今天没有恢复监测记录；**最近一次是 9月4日，未参与今日安排**。」 |
| 训练判定 | 「只宜有氧」+「恢复信号偏低，先跑轻，不要上强度」 | 不再出现该降级 |
| 推荐卡 | 「建议已过期，请先刷新再锁定」+ 锁定按钮禁用 | 不再出现该文案，锁定可用 |

改前对照图在 `../2026-09-17-field-coverage/screenshots/01-today.png`；
改后为 `screenshots/01-today-freshness-banner.png`（即本次 `unreachable-target` 那一屏，
它恰好完整拍到横幅，故原样保留可复核）。

## 结果

| 项 | 值 |
|---|---|
| 用例 | **13 / 13**（`test09AppearancePersistence` 已随像素皮肤删除，套件从 14 条变 13 条） |
| 首轮结果 | 13 条中 **12 passed / 1 failed**（`test11NativeBackGestureAndSafeArea`，**既有回归，见下**） |
| `test11` 修复后单独重跑 | **passed（51.349 秒，EXIT=0）** |
| 设备 | `RAI Technology Acceptance`（`91C2D1F3`，iOS 26.5 模拟器），状态栏覆写 9:41 满电满格 |
| 夹具 | `var/rai.sqlite` 的副本（`sqlite3 .backup`），临时服务只监听 8792 |
| 首轮退出码 | `65`（因 `test11`）；仅 `test11` 的重跑退出码 `0` |

## 源码冻结（结论成立的前提）

| 检查 | 值 |
|---|---|
| 原始 `build.log` mtime | `2026-09-19 15:53:53` |
| 该时刻之后被改动的 `apps/ios/RAI/**/*.swift` | **0 个**（冻结成立） |
| 该时刻之后被改动的测试驱动 | `apps/ios/tests/VisualAcceptance.swift`（仅修 `test11` 的失效调用，不动 app 渲染） |

> 本目录里的 `build.log` / `ui-tests.log` 是 `cp` 过来的，**mtime 已被 `cp` 覆盖**；
> 上面这行判据必须回到 `/tmp/rai-visual-2026-09-19-freshness/build.log` 才能复核。

## `test11` 失败：既有回归，非本批引入

- 失败点 `VisualAcceptance.swift:53`（`scrollTo` helper）：`Expected fully visible target: "today.body" Button`，
  该按钮实际帧 `{{312.0, 71.0}, {44.0, 44.0}}` ⇒ **midY = 93**。
- 🔴 `scrollTo` 只在 `midY >= 115 && midY < bottom-25` 时返回，而 **115 是给页头以下的内容校准的**。
  `today.body` 是**页头里的 home-link**（`TechSyncStatus.swift:35`，全仓唯一一处）⇒
  无论怎么滚动都停在 midY≈93 ⇒ 该调用**从搬移那一刻起就必然失败**（实测循环 30 次后 `XCTFail`，耗时 158s）。
- 根因提交：**`15e8126`**（2026-09-18 15:47，已在 `HEAD` 祖先链上）「move the weekly and body entry links
  beside the sync action」——它同步把 `test01TodayAndBody` 的两处 `scrollTo` 改成了 `isHittable`，
  **却漏了 `test11:233`**。09-17 那次 14/14 早于该提交，因此不构成「本批打红」的证据。
- ✅ 已修（`apps/ios/tests/VisualAcceptance.swift`）：`scrollTo(app.buttons["today.body"])` → `isHittable`（与 test01 一致），
  安全区断言改挂到今日页最后一个**有 identifier** 的条目 `today.ability`。
  ⚠️ **这次修复刻意弱化了原断言，且已在代码注释里写明**：原意是「**最后一个**内容避开底部栏」，
  而今日页真正的末元素 `raceSummary` **没有 accessibility identifier**，没有可滚动定位的抓手。
  正确的收口方式是给 `raceSummary` 加 id 再恢复严格断言——**没有把弱断言伪装成原断言**。

## 本轮另修的一处基础设施缺陷

`run-visual-tests.sh` 内部两处 `xcodebuild` 都**没有** `OTHER_SWIFT_FLAGS`。在会拒绝嵌套沙箱的环境里
（WorkBuddy 等加固沙箱），swift-driver 把 `swift-plugin-server` 包进 `sandbox-exec`，插件直接死掉 ⇒
每个 `@Observable` 报 `produced malformed response`，再级联几十条假的 `no exact matches in call to initializer`，
`build.log` 里一眼看去像满屏源码错误，而 `ui-tests.log` **从未生成**（脚本 `set -e` 在 build 阶段就退出）。

已加**默认关闭**的开关（默认留空 ⇒ 普通本机 / CI 构建仍保留 swift-driver 自带沙箱）：

```bash
RAI_XCODEBUILD_SWIFT_FLAGS=-disable-sandbox bash apps/ios/tests/run-visual-tests.sh
```

判据：`grep -c 'produced malformed response' <out>/build.log` 从 >0 变成 **0**（本次实测 0）。

## 文件

| 文件 | 内容 |
|---|---|
| `screenshots/01-today-freshness-banner.png` | **改后横幅**（「正常」+「今天没有恢复监测记录；最近一次是 9月4日，未参与今日安排」） |
| `screenshots/02-today-top.png` | 改后今日页首屏 |
| `screenshots/03-visible-back.png` | `test11` 的边缘返回手势中间态 |
| `ui-tests.log` | 完整 xcodebuild UI 测试日志（13 条用例的起止与断言） |
| `build.log` | 完整应用构建日志（`malformed response` 计数 0） |
| `api.log` | 隔离服务启动日志 |
