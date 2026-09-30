# 审查后的收尾：P1-1 补入口 + UI 回归 + CI（2026-09-17）

承接 `UNCOMMITTED_REVIEW_2026-09-17.md`（审查）与 `FIX_VERIFICATION_2026-09-17.md`（复核 + 修复）。
当时留了 3 项待拍板，小唐的处置是：**线上 v22 探测已自行完成，其余按建议做**。本文件记录其余两项的落地与证据。

`HEAD = bd1ee25`（未变）。本文件不覆盖线上探测结论 —— 那部分以小唐的实测为准，本仓库侧未做任何线上读写。

---

## 1. 结论摘要

| # | 事项 | 结论 | 证据 |
|---|---|---|---|
| 1 | P1-1 科技风 5 字段补入口 | ✅ 全部补回，并**写进门禁** | 覆盖率复核 17/17 字段有入口；突变 3/3 真红 |
| 2 | 顺带发现：两皮肤闭集枚举直出机器码 | ✅ 3 个闭集 × 2 皮肤全部映射 | 6 个映射函数逐值断言（集合相等） |
| 3 | UI 回归重跑 | 见 §5 | 源码冻结 + 结果归档 |
| 4 | UI 回归进 CI | ⚠️ **原建议不可行**，改为编译级门禁 | 夹具 `var/rai.sqlite` 未入库（`.gitignore`） |

---

## 2. P1-1：5 个字段的展示位

审查时给的修法是"显式声明"（写进 `TECHNOLOGY_SKIN.md`）。本轮改为**真补入口** —— 声明只解决"下次审计不用重查"，不解决用户看不到。

| 字段 | 像素风展示位 | 科技风新展示位 |
|---|---|---|
| `MobileTodayResponse.phase` | 「训练阶段」面板标题右侧 | 「今日推荐训练」标题右侧（`techPhaseName`） |
| `race.note` | 「训练阶段」面板正文 | 比赛目标卡副标题 |
| `race.shapeScore` | 「比赛目标」三格之一 | 比赛目标卡指标格（百分比） |
| `race.taper` | 「比赛目标」三格之一 | 比赛目标卡指标格 |
| `postRun` | 独立珊瑚色面板 | 训练判定卡下方独立面板 |

三个实现取舍（都写进了代码注释与 `TECHNOLOGY_SKIN.md`）：

1. **比赛目标卡改为无条件渲染。** 旧版整卡包在 `if let target` 里；服务端在没有目标时仍返回 `race.note` 引导文案（`mobile-coach.ts` 的 `buildRaceCard` 无目标分支），所以整卡有条件是"连引导一起吞掉"。
2. **`postRun` 放今日页，不放训练详情页。** 我在审查报告里建议的是详情页，**这次推翻了**：`buildPostRun` 对非今日训练直接返回 `null`，它本来就是今日页的即时信息；放详情页要用户先找到那次训练。位置对齐像素风的上下文面板（紧接训练判定之后）。
3. **`race.note` 与日期不再重复。** 服务端 note 已含"距 X 还有 N 天"+ 专项形态建议，所以标题行回到"距离 · 日期"，不再单列 `daysUntil` —— 旧版把它拼成 `（-3天）`，目标过期时会漏出负数（`daysUntil` 契约上确可负）。

## 3. 顺带发现并修掉的：闭集枚举直出机器码

补入口时撞见同一类缺陷：**契约是闭集联合类型，展示层却把机器码原样打到界面上**。

| 契约类型 | 取值 | 原显示（像素风） | 原显示（科技风） |
|---|---|---|---|
| `MobileDayPhase` | `need_sync \| morning_open \| locked \| post_run \| rest_done` | `data.phase` 直出 | 无入口 |
| `MobileStimulusMatch` | `aligned \| too_hard \| too_easy \| unknown` | `postRun.stimulusMatch` 直出 | 无入口 |
| `MobileRaceDistance` | `five_k \| ten_k \| half_marathon` | `target.distance` 直出 | `target.distance` 直出 |

修法：6 个映射函数（每皮肤 3 个），**穷举全部契约值**，域外值落中文兜底而不是漏机器码。

- 科技风：`apps/ios/RAI/Skins/Technology/TechEnumPresentation.swift`（**新建，纯 Foundation**）。
  `techRaceDistanceName` 从 `TechAbilityDetailView.swift` **移过来** —— 它此前住在 iOS-only 的 View 文件里，我上一轮改过它的 default 却没有任何通道能钉住。
- 像素风：`NativeFormat.swift` 的 `nativeDayPhaseName` / `nativeStimulusMatchName` / `nativeRaceDistanceName`。

⚠️ 这里与上一轮的处理不一致，是有意的：上一轮我驳回了"改 `nativeStatusName` 的 default 直出"，理由是它的输入契约是**开放 string**（原值本身就是有意义的业务标签）。本轮这三个是**闭集**，穷举后 default 只剩"契约新增枚举而展示层没跟上"，所以兜底给中文。两个策略都写在 `NativeFormat.swift` 的注释里。

---

## 4. 门禁：把这两类缺陷变成可回归的

改在 `apps/ios/tests/run-tech-presentation-tests.sh`（已挂在 `run-model-tests.sh`，CI 会跑）。**从源码取事实，取不到就 assert 失败**，不静默跳过。

新增两组检查：

1. **字段覆盖**：`TechViews.swift` 必须引用 `data.phase` / `data.race.note` / `data.race.shapeScore` / `data.race.taper` / `today.postRun`。
2. **闭集穷举 + 接线**：
   - 6 个映射函数的 `case` 取值集合必须与契约**完全相等**（多一个少一个都红）；
   - 两皮肤的视图必须**真的调用**映射函数（只断言函数名被调用，不锁参数写法）。

第 2 组的第二层是写第一层时发现的缺口：把 `nativeDayPhaseName(data.phase)` 改回直出 `data.phase`，函数体一个字没变，穷举断言照样全绿，用户却重新看到 `morning_open`。

### 突变验证（三处全真红，且排除了"编译错误假红"）

| # | 突变 | 结果 |
|---|---|---|
| 1 | `TechViews.swift` 的 `Text(data.race.note)` → `Text("")`（保持可编译） | `EXIT=1` + `Technology skin stopped rendering 比赛备注 race.note`；Swift 段 41 checks 仍过（证明不是编译错误） |
| 2 | 删 `techPhaseName` 的 `case "rest_done"` | `EXIT=1` + `techPhaseName does not cover MobileDayPhase: missing ['rest_done']` |
| 3 | 像素风 `nativeStimulusMatchName(postRun.stimulusMatch)` 改回直出 | `EXIT=1` + `no longer calls nativeStimulusMatchName(` |

突变全部还原并逐文件校验 `shasum` + 复原 mtime。

### 门禁实跑

| 通道 | 结果 |
|---|---|
| `typecheck-ios.sh` | `EXIT=0`，**47 文件**（新增 `TechEnumPresentation.swift`，45→46→47） |
| `run-model-tests.sh`（聚合，含展示逻辑） | `EXIT=0`，七组全过 |
| `run-tech-presentation-tests.sh` 单跑 | `EXIT=0`：41 checks + 24 组对比度 + `Field coverage: …` + `Enum mappings are wired into both skins' views` |

### 顺带做完的覆盖率复核

把 `MobileTodayResponse` 的 17 个载荷字段逐个与科技风视图交叉 grep，**17/17 都有入口**（最少 1 处正是本轮新增的 `phase` / `postRun`）。即：本轮之后，科技风不存在"契约有值、没展示位"的字段。

---

## 5. UI 回归

源码改完（含 3 处突变全部还原、`touch -t` 复原 mtime）之后重跑全量 UI 回归，**14/14 通过**：

| 项 | 值 |
|---|---|
| 用例 | **14/14 passed**，`0 failures (0 unexpected)`，用时 1025.3s；总耗时 **25m18s**，`EXIT=0` |
| 设备 | `RAI Technology Acceptance`（iOS 26.5 模拟器），状态栏覆写 9:41 |
| 冻结 | `build.log` mtime `13:18:23`，之后被改动的 `apps/ios/**/*.swift` = **0 个** |
| 对照 | 上一轮（08:58）是 13/14，`test06Setup` runner 崩溃；本轮 14/14 |

证据归档在 `apps/ios/design/acceptance/2026-09-17-field-coverage/`（`ui-tests.log` + 5 张今日页截图 + 截图索引）。

**截图直接验证了新比赛目标卡**（`screenshots/01-today-links.png`，无目标态）：

```
[旗标图标] 尚未设置比赛目标
           还没有目标赛事。设一个日期和距离后，首页会给出倒计时和专项形态。   >
体型分
78%
```

一张图证明三件事：① 卡片无条件渲染（夹具无目标，旧版这块根本不存在）；② `race.note` 是服务端 `buildRaceCard` 无目标分支的原文；③ **`race.shapeScore` 与 target 解耦** —— 服务端在无目标时仍给 `0.78`，旧版永远看不到。

⚠️ **两条覆盖边界，别当成已测**：

- **`postRun` 面板无渲染级证据**：`buildPostRun` 对"今天没训练"返回 `null`，而夹具是 `0.00 km` ⇒ 面板按设计不渲染。它只有编译 + 门禁断言覆盖。
- **像素风今日页无截图**：`test01TodayAndBody` 走默认皮肤（科技风），像素风那三处映射改动同样只有编译 + 断言覆盖。

要补这两条得给 `VisualAcceptance.swift` 加用例（今天有训练的状态 / 像素风今日页），属于另一件事。

---

## 6. CI：把 UI 用例的**编译**接进去（原"接进 CI"的建议不可行）

先验证再动手 —— 结论是**全量运行接不进去**：

```bash
git ls-files var/          # → 空
grep -n "var/" .gitignore  # → 4:var/
```

`run-visual-tests.sh:28` 的第一步是 `sqlite3 "${RAI_VISUAL_DATABASE:-$root/var/rai.sqlite}" ".backup …"`，而 `var/` 被忽略、那份 324 MB 库含个人健康数据 ⇒ **CI 上根本没有夹具**。把 job 直接加进去只会得到一个必然失败的步骤。

改做的事（`.github/workflows/ci.yml` 的 `ios` job 加一步）：

```yaml
      - name: Compile visual acceptance UI tests
        run: |
          xcodebuild -project apps/ios/tests/VisualAcceptance.xcodeproj -scheme VisualAcceptance \
            -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
            -derivedDataPath "$RUNNER_TEMP/visual-acceptance" \
            CODE_SIGNING_ALLOWED=NO build-for-testing
```

- **只编译不运行**：抓的是"用例写错 API / 签名对不上 / 语法错"这类 CI 本该拦下的问题（审查报告里 P0-1 的同类：`ci.yml` 从不构建 `VisualAcceptance.xcodeproj`，写错语法 CI 一路全绿）。
- 用 `generic/platform=iOS Simulator` 而不是具体机型名 —— runner 上不一定有某个 iPhone 型号。
- 该工程是**独立极简工程**（只有一个 `com.apple.product-type.bundle.ui-testing` target，无 app target、无 `TEST_TARGET_NAME`，`dependencies = ()`），所以单独 `build-for-testing` 不需要先构建 app。
- 边界写清：**CI 覆盖编译，本机覆盖断言**。不要把"编译通过"说成"UI 回归通过"。

`ci.yml` 已用 YAML 解析校验（3 个 job + 新步骤就位）。

---

## 7. 改动清单（10 个文件 + 1 份本报告）

| 文件 | 改动 |
|---|---|
| `apps/ios/RAI/Skins/Technology/TechEnumPresentation.swift` | **新建**：3 个闭集映射（纯 Foundation，进得了闸门） |
| `apps/ios/RAI/Skins/Technology/TechViews.swift` | `raceSummary` 无条件渲染 + note/体型分/减量；`recommendationPanel` 标题加阶段；新增 `postRunPanel` |
| `apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift` | 移出 `techRaceDistanceName`（改住纯文件） |
| `apps/ios/RAI/NativeFormat.swift` | 新增 `nativeDayPhaseName` / `nativeStimulusMatchName` / `nativeRaceDistanceName` |
| `apps/ios/RAI/NativeViews.swift` | 3 处直出改为经映射函数 |
| `apps/ios/tests/run-tech-presentation-tests.sh` | 加编译新纯文件；加"字段覆盖 / 闭集穷举 / 映射接线"三组断言 |
| `.github/workflows/ci.yml` | `ios` job 加 UI 用例编译级门禁 |
| `apps/ios/design/TECHNOLOGY_SKIN.md` | 「不展示的字段」→「已补入口 + 进门禁」，含实现取舍与复核命令 |
| `apps/ios/design/acceptance/2026-09-16-tech-polish/README.md` | 文件数 46→47（保留沿革） |
| `apps/ios/README.md` | 展示逻辑那组的覆盖范围、CI 步骤说明与"只编译不运行"的原因 |

## 8. 回滚

纯展示层与门禁脚本，**无迁移、无契约变更、无服务端改动**：

```bash
git checkout -- apps/ios/RAI/Skins/Technology/TechViews.swift \
  apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift \
  apps/ios/RAI/NativeFormat.swift apps/ios/RAI/NativeViews.swift \
  apps/ios/tests/run-tech-presentation-tests.sh .github/workflows/ci.yml \
  apps/ios/design/TECHNOLOGY_SKIN.md apps/ios/README.md \
  apps/ios/design/acceptance/2026-09-16-tech-polish/README.md
rm apps/ios/RAI/Skins/Technology/TechEnumPresentation.swift
```

## 9. 遗留

- **UI 用例仍不在 CI 的运行通道**：本机跑一轮约 30 分钟且需要真实库。若要在 CI 覆盖断言，得先造一份**合成夹具库**（不含个人数据、可入库），那是独立一件事。
- **`techPaceZoneName` / `nativeSessionName` 等仍在 iOS-only 文件或开放域里**：前者可照 `techRaceDistanceName` 的做法搬进纯文件，后者按开放域策略保持直出。本轮未动。
- 🔴 **`apps/web/src/ios/Home.tsx:267-272` 复制了一份 `decideDayPhase`，且已经漂移。** 服务端 `mobile-coach.ts:1155-1165` 的顺序是
  `post_run → need_sync → (rest&&lock) rest_done → lock locked → morning_open`，
  web 复刻版**少了 `locked` 分支**（`lock.present` 且 `kind !== "rest"` 时返回 `morning_open`，服务端返回 `locked`）。
  今天不可达 —— 它写在 `data.phase ?? inferPhase(data)` 的兜底位置，而契约里 `phase` 是必填；但这个兜底**没有任何断言**，
  且这正是"同一判据在多端各写一份 ⇒ 必然漂移"的样本。该目录是旧的 WKWebView 壳（`AGENTS.md` 标为开发兜底），优先级低，本轮未动。
