# 计划页：一周七列与手表面板归位 v1

日期：2026-09-15 | 范围：`apps/ios`（双皮肤 + 验收脚本）
触发：小唐指出首页与计划页对「同一周」给出了两份说法，且计划页本身读不到本周安排。

---

## 1. 这次改的三件事

| # | 变化 | 位置 | 为什么 |
|---|---|---|---|
| ① | 计划页新增**一周七列**（`weekStrip`），点任一列打开那天处方 | `NativeViews.swift:1583`、`TechViews.swift:1569` | 看整周要能一眼看完；原来只有一段文字描述 |
| ② | **手表课表面板从首页搬到计划页**（`watchPlanPanel`） | `NativeViews.swift:1654` | 同步是「计划」动作；面板留在两页 = 两处可能对同一周给出不同说法 |
| ③ | 首页删掉 `workoutPlanPanel()` 与 `recentPanel()` | 全仓 `grep` 0 命中 | 最近训练与底部 Tab 的训练列表重复 |

---

## 2. 数据源：为什么读 `/v1/mobile/today` 的 `weekPlan`，而不是库里存的周计划

`weekStrip` 的 days 直接取 `native.today?.weekPlan`（`NativeViews.swift:1584`、`TechViews.swift:1570`），
即 `/v1/mobile/today` 的响应字段，服务端由 `buildWeekPlan` 生成（`apps/api/src/mobile-read.ts:272`）。

这条线不是随手挑的。`TechViews.swift:1554-1562` 把踩过的坑留在了注释里：

- 用**存储的**周计划去画列，读到的是「上次保存的处方」——
  - 今天那格会显示一个**已被恢复闸门推翻**的 session；
  - 过去的某天会显示「间歇跑 8.6 km」，而首页显示的是**那天实际跑的内容**。
- 服务端（`buildWeekPlan`）已经解好了三种时态：已完成（带 `completedWorkoutId`）、休息、未到的计划。
  这条规则留在服务端，客户端不重算。

判据是可验证的：周计划**恒为 7 天**，`apps/api/test/mobile.test.ts:105` 断言 `weekPlan.length === 7`。
所以 `weekStrip` 的列数等于服务端返回的天数，七列是结果而不是硬编码——客户端没有「只画工作日」这种筛选。

---

## 3. 为什么是七列等宽，而不是横向滚动

```swift
HStack(spacing: 4) {                       // NativeViews.swift:1593（Tech 皮肤是 spacing: 5）
    ForEach(days) { day in
        Button { selectedDay = day } label: { weekChip(day) }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)    // 每列等宽
    }
}
.frame(maxWidth: .infinity)
```

注释写明了取舍（`NativeViews.swift:1576-1582`、`TechViews.swift:1564-1566`）：

> 横向滚动条会把**最后一天裁掉**，而且整行**够不到面板右边缘**。这一行**就是**整周，不是一周的窗口。

`weekChip` 里标签 `lineLimit(1)` + `minimumScaleFactor`（`NativeViews.swift:1617-1618`）——
换行会**悄悄改变整行高度**，所以宁可缩字也不换行。

---

## 4. 双皮肤各自实现（共享组件不得硬编码单一皮肤视觉）

| 皮肤 | 周条 | 日详情 |
|---|---|---|
| pixel（默认） | `weekStrip`（`NativeViews.swift:1583`） | `PlanDaySheet`（`NativeViews.swift:1952`） |
| technology | 页内内联块（`TechViews.swift:1569`） | `TechPlanDaySheet`（`TechViews.swift:1921`） |

两边都通过 `.sheet(item: $selectedDay)` 弹出（`NativeViews.swift:1563` / `TechViews.swift:1509`），
`selectedDay` 是 `@State private var selectedDay: MobileWeekPlanDay?`。

`PlanDaySheet` 承担周条**装不下**的那部分（`NativeViews.swift:1947-1951`）：

> 周条只能带一个类型、一个颜色和一个距离；真正让这天**可执行**的是间歇分解、热身与配速区间，
> 而这些只有结构化的处方带着。

它渲染 `nativeStructureLines(day.structure)`（`NativeViews.swift:1968`）——
**这个函数由本批的前一个提交引入**（见 §6）。

计划页冷启动自填（`NativeViews.swift:1566-1571`）：面板搬过来之后，页面必须能在首页从未跑过的会话里自己填数据，
所以 `.task` 里 `if native.workoutPlan == nil { _ = await native.refreshWorkoutPlan() }`。

---

## 5. 验收钩子

`apps/ios/tests/VisualAcceptance.swift`：

- `test03Plan` 新增 `scrollTo(app.buttons["编辑周计划"])`——周条与手表面板现在排在编辑器**上方**，
  编辑按钮不再落在第一屏；
- 新增快照 `03-plan-day-detail`，定位方式是 `label CONTAINS '查看训练详情'`。
  这个 label 由 `weekChipLabel` 拼出（`NativeViews.swift:1644-1647`）：

  ```
  "\(weekday)\(day)，\(sessionName)，\(distance)，查看训练详情"
  ```

  它同时是**无障碍标签**和**测试锚点**，所以改文案必须同时改断言。
- `test10RevisionConflict` 同样先 `scrollTo` 再点编辑器（同一原因）。

---

## 6. 提交边界：为什么这个提交必须排在分段提交之后

本批的 `PlanDaySheet` 调用 `nativeStructureLines(...)`，而该函数**由前一个提交**（`feat(ios): render executed
segments and export the Watch's own lap events`）引入。证据：

```
$ for sha in ... 8762ee8 90f8a35; do git show $sha -- apps/ios/RAI/NativeFormat.swift | grep -c '^+.*nativeStructureLines'; done
8762ee8 → 1     # 引入
90f8a35 → 0     # 消费
$ git grep -c nativeStructureLines 57a359b -- apps/ios/RAI/NativeFormat.swift
（无命中 → 起点不存在）
```

反过来不成立：B 不引用 A 的任何符号。因此**先 B 后 A** 是唯一能让两个提交各自独立通过类型检查的顺序。
每个节点都实跑过（`apps/ios/tests/typecheck-ios.sh`，36 文件全量，含两套皮肤视图），两个节点均 `EXIT=0`。

---

## 7. 未做 / 边界

- **真机验证由小唐做**（模拟器可跑但图形栈有瑕疵，视觉验收不可完全信）。
- 首页删面板是**结构性**改动，`VisualAcceptance` 里 `01-home` 快照的期望内容随之变化；
  脚本改的是滚动与点击，快照本身需真机重新采。
- 周条只读，不提供「点开即编辑」——编辑仍然只有 `编辑周计划` 一个入口，避免两处写同一份草稿。
