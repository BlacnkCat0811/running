# 今日页「计划」类卡片的口径审查与改法清单

- Status: **未决（本轮只诊断，未改任何代码）**
- Date: 2026-10-06
- Scope: iOS Technology 皮肤今日页的两张卡 ——「今日推荐训练」与打基础期（`planPhaseLine`）
- 触发：真机截图反馈「这两张卡是不是冲突，我是用户不知道看哪个」

> 结论先行：**是冲突。但不是算法互相矛盾，而是三个不同作用域的「计划」被并列成同级卡片，
> 且彼此完全不对账**。两张卡各自都没算错，错的是它们被摆在了同一个层级、用同一套字眼。

## 0. 一句话答案（给用户）

- **执行看「今日推荐训练」的「今天的动作」**。它就是 `nextSession`，也是手表课表与「锁定安排」的来源。
- **打基础期只回答「我在哪个阶段、这几周量够不够」**，不是今天的任务。那里的 15–18 km 是**阶段信封**，
  不是今天要补的距离。

## 1. 四层冲突

### 🔴 C1 权威性缺失（「不知道看哪个」的直接原因）

- 两张卡视觉同级：都用 `TechPanel`，默认 `fill: paper` / `stroke: grid`（`apps/ios/RAI/Skins/Technology/TechTheme.swift:115-138`）；
  「今日推荐训练」只多一道青色描边（`apps/ios/RAI/Skins/Technology/TechViews.swift:410`）。
- 「今日推荐训练」有「锁定安排」动作；`planPhaseLine` **没有任何动作**，
  但标题是阶段名、正文是命令式句子「本周 15–18 km，长距离 ≤6 km，质量课 ≤1」（`TechViews.swift:456-489`）——读起来像任务。
- 界面没有任何一处说明谁是权威。而代码注释与文档写得很清楚：骨架**不是计划本身**，只是「信封」
  （`apps/api/src/plan-periodization.ts` 头注释；`docs/ALGORITHM.md:156`）。

### 🟡 C2 打基础期卡内部两个「本周」数字打架

同一张卡上有两个不同来源的量：

| 卡上文案 | 来源 | 算法 |
| --- | --- | --- |
| 本周 15–18 km | 阶段量带 | 基线 = 最近 4 个完整自然周实测均量（`apps/api/src/data.ts:117-135`）× base 系数 0.9–1.05（`apps/api/src/plan-periodization.ts:74`） |
| 已完成 10.0 / 计划 10.5 km | 课表处方里程之和 | 按计划日志逐日累加非休息处方里程（`apps/api/src/plan-adherence.ts:117-142`） |

截图里 **10.5 < 15**：课表本身低于量带下限约 30%，界面一个字都没解释。
更要紧的是 `replanAdvice` **只有「计划高于量带上限」这一条**（`plan-adherence.ts:225-235`），
**没有「低于量带下限」**——所以这个矛盾永远不会被系统说出来，只能靠用户自己发现。

> **部分已决（2026-10-06）**：这条的一半成因已修 —— 生成路径此前把**用户手填的周跑量目标**当成
> "近期实际量"喂进周期化，而展示路径用的却是真实 4 周均值，同一周两条路径基线不同；该目标退役后
> 两边同源（见 [DECISIONS](DECISIONS.md) D14）。
> **剩下的一半仍在**：课表处方还要过 ramp、质量课上限与单堂长距离上限，落在量带之下是这些约束的
> 正常结果，而"低于下限"依旧没有任何一条建议会说出口。

### 🟡 C3「按计划」与「建议重新生成课表」同屏

- 卡头右侧 = `adherence.current.status`（`TechViews.swift:467-471`），只看**本周**、且只看**已到期**义务
  （`plan-adherence.ts:148-157`）→ `on_track` → 显示「按计划」。
- 尾行 replan 只看**已结束的周**（`plan-adherence.ts:195` 用 `shiftDate(weekStart, 6) < generatedFor` 过滤掉本周）。
- 两者窗口不同、数值上都成立，但文案都没写窗口 ⇒ 用户读成「一边说没问题、一边说计划不现实」。
- **并且文案本身越界**：`plan-adherence.ts:206-211` 的 detail 写「…**当前周量**可能已经不现实」，
  而这条判据只统计已结束的周；同一张卡的完成度行完全可能显示本周达标（截图即如此）。
  这是措辞与同卡数据冲突，不是算法冲突。

### 🟡 C4 两张卡方向相反

| | 判据 | 量的口径 |
| --- | --- | --- |
| 今日推荐训练 →「负荷偏高，今天不要排质量课」 | `trainingStatus ∈ {attention, high_load}`（`apps/api/src/mobile-coach.ts:300`、reason 在 `:312`） | **强度加权负荷**（ACWR 类分类） |
| 打基础期 →「连续 2 周完成量低于计划的 60%」 | 里程依从性（`plan-adherence.ts:197-211`） | **原始里程 vs 处方里程** |

两套口径数值上可以同时成立。最容易踩的组合：跑量落在课表标为「休息」的日子上——
依从性只统计非休息处方日（`plan-adherence.ts:128`），那些跑量一分都不抵扣依从性，
但会全额计入 `recentWeeklyKm`（`data.ts:117-135`）。界面上一个让你停、一个暗示你练得不够。

### 🟢 C5 附带发现：教练推翻今日处方后，依从性完全不知道

`buildPlanAdherence` 只吃 `planHistory + actual`（`apps/api/src/mobile-read.ts:145-151`），**不读**教练的每日决策。
所以卡 A 说「原计划恢复跑 → 今天休息」，卡 B 同时说「按计划」，两边都没算错。
这也是 C2/C3 长期无法自愈的结构性原因。

### 🟢 C6 文档口径滞后

`docs/WEB.md:12` 写「今日页显示所处阶段、本周量带与依从性」，但 `apps/web/src` 对
`periodization` / `adherence` / `replan` 的引用数为 **0**（实测 grep 为空，
`volumeBandKm`/`weeksToRace`/`observedDistanceKm` 同样为 0）。**这两张卡目前是 iOS 独有**。

## 2. 现状数据流（谁读谁）

```
周课表 weekPlan（已确认）                阶段骨架 periodization
  ├─ today 当天的处方「恢复跑」             └─ 本周量带 15–18 km
  │    └→ 教练 verdict/nextSession 推翻 ──→ 「休息」   ✗ 不回流
  └─ 本周非休息处方合计 10.5 km
       └→ 依从性 plan-adherence ──→ 「按计划」        ✗ 不知道教练推翻过
              └→ replan（只看已结束周）
```

三条口径各自独立，界面上没有任何一处做交叉核对。

## 3. 改法清单

> 三档从轻到重，可单独采用，也可叠加。**每条都带验收判据与回滚方式。**

### 方案 A（最小改动）：只做文案分层，不动算法

- **A1** `TechViews.swift:473` 的量带行改为显式信封措辞，例如
  「阶段建议量带 15–18 km（按最近 4 周实测推算）· 长距离 ≤6 km · 质量课 ≤1」。
- **A2** `TechViews.swift:477` 的完成度行补上「课表」限定词，并把顺序统一为
  「课表计划 10.5 km，已完成 10.0 km，其中 1 天没有观测记录（不等于没跑）」
  （现在是「已完成 / 计划」，与上一行的量带混读）。
- **A3** 卡头状态带窗口：`TechViews.swift:467-471` 显示「本周 按计划」；
  同时把 `plan-adherence.ts:206-211` 的 detail 改成
  「连续 N 周（已结束）完成量低于计划的 60%，周量上限可能需要下调」——去掉对「当前周」的越界断言。
- **A4**（可选，强烈建议）在「今日推荐训练」里把两张卡串起来：当 `recommendation.adjustmentReason` 非空时，
  加一行「今日改为休息后，本周课表还差 X km」，让用户不必自己去对齐两个数。

- **验收标准**
  1. `npm run test:ios` 全绿，且新增断言能**真的红**：在 `/tmp` 副本上删掉「量带」或「课表」任一字样，
     `check-today-layout.py` 必须失败。
  2. `apps/api/test/plan-periodization.test.ts` 新增一条：构造「过去 2 周 under、本周达标」的 adherence，
     断言 replan detail **不含**「当前周」三字（现文案含，故改前必红）。
  3. 真机/模拟器上截图复核：只看打基础期卡，能一句话说清「15–18 是阶段建议、10.5 是我的课表」。
- **回滚**：`git checkout -- apps/ios/RAI/Skins/Technology/TechViews.swift apps/api/src/plan-adherence.ts`
  以及对应测试文件。iOS 文案**需重装 App 才生效**；`plan-adherence.ts` 属服务端，**需重启 API**。

### 方案 B：补「计划低于量带」判据（对称于现有上限判据）

- **B1** 在 `replanAdvice`（`apps/api/src/plan-adherence.ts:225-235` 同层）增加：
  当 `current.plannedDistanceKm < currentPhase.volumeBandKm.lower` 时产出 `plan_below_phase_band`，
  detail 写明「当前周课表计划 X km 低于 Y 期下限 Z km」。
- ⚠️ **这是产品决定，不只是技术决定**：`replan.recommended` 变 true 会更频繁，
  今日页会常态多出一条黄字「建议重新生成课表」。要接受「计划低于量带也提示重排」这个语义，才做。
- **验收标准**
  1. 新增两条用例：低于下限 → 触发；**恰好等于下限 → 不触发**（边界）。
  2. **突变验证**：把判据改成 `<=`、或整条删除，两条用例必须各自变红，否则判据无效。
  3. 不改变现有三条 reason 的行为（现有用例全绿）。
- **回滚**：单文件 + 用例回滚；服务端重启。

### 方案 C：把阶段卡降级成一行（改动面最大）

今日页只留一行「打基础期 · 距比赛 12 周 · 按计划 ›」，量带与依从性详情进训练计划页。

- ⚠️ **会撞已有的两道门禁，必须先处理**：
  1. `apps/ios/tests/run-tech-presentation-tests.sh:174` 的字段覆盖表要求
     `periodization` / `adherence` / `replan` 都有展示位锚点（该脚本注释里写明理由：
     「一个『计划阶段』不显示在今天页上，用户就只能在减量期里按专项期的量去跑」）。
     降级后这三个锚点必须仍落在 `TechViews.swift` 或 `TechPlanView.swift` 里，否则门禁变红。
  2. `apps/ios/tests/check-today-layout.py:8` 的顺序断言**只覆盖前四个调用**，`planPhaseLine` 不在其中
     ⇒ 移动它不会被现有判据拦住，等于一次**无判据的版式改动**。必须补一条顺序断言。
- **验收标准**：`npm run test:ios` 全绿 + 新增顺序断言经突变验证 + 计划页上量带/依从性/replan 三者可见。
- **回滚**：iOS 单文件级回滚，重装 App。

## 4. 判据落点速查

| 改动 | 覆盖它的门禁 | 现有断言会红吗 |
| --- | --- | --- |
| iOS 文案（A1–A3） | `npm run test:ios`（typecheck + `run-tech-presentation-tests.sh` + `check-today-layout.py`）；提交时 `.githooks/pre-commit` 因 `apps/ios/` 有改动而自动触发 | **否**——现有断言不检查这两句文案，必须新增 |
| `plan-adherence.ts` 文案/判据（A3/B1） | `npm test`（`apps/api/test/plan-periodization.test.ts`） | 新增断言后**是** |
| 阶段卡位置（方案 C） | 上述两条 + 字段覆盖表 + 顺序断言 | **否**——顺序断言需补 |
| 任何新判据自身 | 按仓库规约必须做**突变验证**（`/tmp` 副本逐条翻前提，全部 killed 才算成立） | — |

落点提醒：`run-tech-presentation-tests.sh` 取切片前会剥注释，
**注释里写 `data.replan` 不算展示位**；切片锚点改名后会静默变恒真，
新断言要用「锚点恰好命中 1 次」+ 顺序数组比较，不要裸 `split`。

## 5. 未验证 / 无法确认

- **截图里的 15–18 / 10.5 / 10.0 无法在本机复算**：本机 `var/` 下没有 `rai.sqlite`
  （只有 2026-09-20 的旧 `rai-dev.sqlite`），这三组数是**从截图读数**，不是实测。
  上文的代码路径与行号均为实读。
- 本轮**没有**判断这四层冲突中哪一层在真机上最常出现——需要拿到线上 `/v1/mobile/today`
  的真实 payload 才能给频率。若需要，我可以只读取证一次。
