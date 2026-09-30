#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# 刻意**不加** `-O`：脚本里的 `check` 走 `precondition`，`-O` 下断言仍会执行
# （实测失败同样 EXIT 132），但失败消息会被吞掉，只剩 `Illegal instruction: 4` ——
# 排障时得重新编一遍才知道挂的是哪条。末尾打印的毫秒数只是主机微基准，不是设备帧率，
# 也不参与任何断言，没有为它牺牲可诊断性的理由（`run-model-tests.sh` 同样不带 `-O`）。
# `-disable-sandbox` 与 `run-model-tests.sh` / `run-session-tests.sh` 保持一致。当前编译
# 单元里 `@Observable` 计数为 0，所以本脚本今天不带也能过；但那是巧合而不是保证 —— 一旦
# 有人往这些文件里加 `@Observable`，触发宏插件后失败形态会是 `sandbox_apply: Operation
# not permitted` 加满屏 `produced malformed response`，与真实错误完全无关。预置掉这个坑。
xcrun swiftc -parse-as-library -disable-sandbox apps/ios/RAI/APIModels.swift \
  apps/ios/RAI/VerdictPresentation.swift \
  apps/ios/RAI/Skins/Technology/TechPlotData.swift \
  apps/ios/RAI/Skins/Technology/TechSyncPresentation.swift \
  apps/ios/RAI/Skins/Technology/TechEnumPresentation.swift \
  apps/ios/tests/TechPresentationRegression.swift -o "$tmp/tech-presentation"
"$tmp/tech-presentation"
python3 - <<'PY'
import pathlib, re

source = pathlib.Path("apps/ios/RAI/Skins/Technology/TechTheme.swift").read_text()
colors = {}
for name, r, g, b in re.findall(
    r"static let (\w+) = Color\(red: (\d+)/255, green: (\d+)/255, blue: (\d+)/255\)", source
):
    colors[name] = tuple(int(x) / 255 for x in (r, g, b))
muted = source.split("static let muted =", 1)[1].split("static let elevated", 1)[0]
variants = re.findall(r"UIColor\(red: ([\d.]+), green: ([\d.]+), blue: ([\d.]+), alpha: 1\)", muted)
assert len(variants) == 2, "Both default and high-contrast muted colors must be verified"
for index, variant in enumerate(variants):
    colors[f"muted-{index}"] = tuple(map(float, variant))

def luminance(rgb):
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb]
    return sum(v * w for v, w in zip(linear, [0.2126, 0.7152, 0.0722]))

def contrast(foreground, background):
    high, low = sorted([luminance(foreground), luminance(background)], reverse=True)
    return (high + 0.05) / (low + 0.05)

def blend(foreground, background, alpha):
    return tuple(alpha * top + (1 - alpha) * bottom for top, bottom in zip(foreground, background))

def token(pattern, text, label):
    """从源码里取 token 名。取不到必须报错，不能静默跳过 —— 否则源码一改写，
    这条断言就会悄悄失效，门禁变成装饰。"""
    match = re.search(pattern, text, re.S)
    assert match, f"Could not locate {label}; the contrast gate must fail loudly instead of skipping"
    return match.groups()

checks = 0
for foreground in ["ink", "cyan", "coral", "yellow", "leaf", "muted-0", "muted-1"]:
    for background in ["background", "paper", "elevated"]:
        ratio = contrast(colors[foreground], colors[background])
        assert ratio >= 4.5, f"{foreground} on {background}: {ratio:.2f} < 4.5"
        checks += 1

# ---------------------------------------------------------------------------
# 反色控件：文字压在**填充色**上，判据是"文字色 / 填充色"。
#
# 旧版写法是 `for fill in ["action","coral"]: (lum(fill)+.05)/(lum(background)+.05)`，
# 消息写着 "Action label on {fill}"，算式里却既没有文字色、也没有显式排序 —— 它验证的
# 其实是"填充色与页面底色可区分"。今天两者数值恰好相同（background 最暗、填充最亮），
# 所以它看起来是对的；但按钮文字从 `background` 改成 `ink` 时它不会有任何反应
# （实测 `ink` on `coral` 只有 2.45:1，on `action` 1.55:1，都该被拦下）。
#
# 因此这里改为从**源码**取"文字 token / 填充 token"，让断言跟着代码走。
# ---------------------------------------------------------------------------
primary = source.split("struct TechPrimaryButton", 1)[1].split("struct TechProgressBar", 1)[0]
(label_token,) = token(
    r"foregroundStyle\(isDisabled \? TechColor\.\w+ : TechColor\.(\w+)\)", primary,
    "TechPrimaryButton label color")
(fill_token,) = token(
    r"else \{ Capsule\(\)\.fill\(TechColor\.(\w+)\) \}", primary,
    "TechPrimaryButton enabled fill color")

sheet = pathlib.Path("apps/ios/RAI/Skins/Technology/TechConfirmationSheet.swift").read_text()
destructive = sheet.split("if destructive {", 1)[1].split("} else {", 1)[0]
(destructive_label,) = token(r"foregroundStyle\(TechColor\.(\w+)\)", destructive,
                             "destructive confirmation label color")
(destructive_fill,) = token(r"background\(TechColor\.(\w+), in: Capsule\(\)\)", destructive,
                            "destructive confirmation fill color")

for label, foreground, fill in [
    ("Primary button label", label_token, fill_token),
    ("Destructive confirmation label", destructive_label, destructive_fill),
]:
    ratio = contrast(colors[foreground], colors[fill])
    assert ratio >= 4.5, f"{label} ({foreground} on {fill}): {ratio:.2f} < 4.5"
    checks += 1

# 配速区间徽章：文字压在 `cyan.opacity(0.75)` 上，必须按**叠加后**的颜色算。
# 承载面取 `paper`（本皮肤里最暗的面板底），叠加结果最暗、深色文字对比度最低，即最不利情形。
detail = pathlib.Path("apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift").read_text()
badge = re.search(
    r"foregroundStyle\(TechColor\.(\w+)\)\s*\n\s*\.padding\(6\)\s*\n"
    r"\s*\.background\(TechColor\.(\w+)\.opacity\(([\d.]+)\)",
    detail)
assert badge, "Could not locate the pace-zone badge; the contrast gate must fail loudly instead of skipping"
badge_label, badge_fill, badge_alpha = badge.group(1), badge.group(2), float(badge.group(3))
ratio = contrast(colors[badge_label], blend(colors[badge_fill], colors["paper"], badge_alpha))
assert ratio >= 4.5, (f"Pace zone badge label ({badge_label} on {badge_fill}@{badge_alpha} "
                      f"over paper): {ratio:.2f} < 4.5")
checks += 1

# ---------------------------------------------------------------------------
# 「有数据、有契约、没有展示位」是这套皮肤上真实复发过的一类缺陷：改版今日页时把
# 「训练阶段 / 比赛目标 / 最近一次训练反馈」整块删掉（`HEAD:bd1ee25` 的
# `TechViews.swift:382-434`），5 个字段就失去入口 —— 契约还在给值、服务端还在算、
# 界面上却没入口，而脚本、类型检查、UI 回归全绿。
#
# 2026-09-17 的初版只钉了当时出事的那 5 个字段，那是"门禁宽度 < 结论宽度"：报告说的
# 是"契约字段都有入口"，断言只守 5 个 —— 删掉 `injuryFlags` 整块照样全绿（实测）。
# 因此这里把**全集改为从契约源码解析**，并强制「锚点 ∪ 例外 == 契约字段全集」：
# 契约将来新增字段而没人给展示位时，这条断言会自己变红，不需要有人记得回来改清单。
# 例外必须逐条写明理由，不允许静默漏过。
# ---------------------------------------------------------------------------
tech_views = pathlib.Path("apps/ios/RAI/Skins/Technology/TechViews.swift").read_text()
tech_views += pathlib.Path("apps/ios/RAI/Skins/Technology/TechPlanView.swift").read_text()
tech_views = re.sub(r"/\*.*?\*/|//[^\n]*", "", tech_views, flags=re.S)

# Weekly/body navigation lives beside sync, not at the bottom of Today.
home_actions = pathlib.Path("apps/ios/RAI/Skins/Technology/TechSyncStatus.swift").read_text()
assert 'id: "today.week"' in home_actions and 'id: "today.body"' in home_actions
assert "TodayDetailLinks" not in tech_views
week_view = tech_views.split("struct TechWeekOverviewView", 1)[1].split("struct TechBodyMetricsView", 1)[0]
assert 'title: "本周计划"' not in week_view
for field in ["averageSpeedKmPerHour", "averagePaceSecondsPerKm", "averageHeartRateBpm", "heartRateZones", "paceZones"]:
    assert f"data.week.{field}" in week_view, f"Weekly metric not rendered: {field}"
assert week_view.count("TechZoneDistributionPanel(") == 2
assert "native.today ?? initialData" in week_view, "Week detail must observe refreshed data instead of a navigation snapshot"
assert ".task { await native.refreshAll(requestHandshake: false) }" in week_view
assert ".refreshable { await native.refreshAll() }" in week_view
assert "data.week.hasWeeklyActivityStatistics" in week_view, "Missing API fields must not be shown as empty distributions"
assert "detail: remainingDistanceLabel" in week_view
assert "data.week.remainingDistanceKm" in week_view

# Today redesign: keep the three real measurements and a distinct linear ability visual.
today_widgets = pathlib.Path("apps/ios/RAI/Skins/Technology/TechTodayRecovery.swift").read_text()
recovery_panel = tech_views.split("private func recoveryPanel", 1)[1].split("struct TechZoneDistributionPanel", 1)[0]
ability_card = tech_views.split("private func abilityCard", 1)[1].split("private func abilityAccessibilityLabel", 1)[0]
assert "data.recovery.stateLabel" in recovery_panel
assert "TechTodayRecoveryMetrics(recovery: data.recovery)" in recovery_panel
assert "data.recovery.note" not in recovery_panel, "Compact recovery must not restore the tall evidence paragraph"
for field in ["lastNightSleepMinutes", "restingHeartRateBpm", "morningHrvMs"]:
    assert f"recovery.{field}" in today_widgets, f"Recovery measurement lost: {field}"
assert "Baseline" not in today_widgets, "Recovery no longer displays baseline comparisons"
assert "isAccessibilitySize" in today_widgets, "Large text must not be squeezed into three columns"
assert "TechTodayAbilityRuler(score: data.ability.trueAbility)" in ability_card
assert '"chart.bar.xaxis"' in ability_card
assert "TechAbilityGauge(" not in ability_card and "TechInstrumentRing(" not in ability_card
assert "score.isFinite" in today_widgets and "if let fraction" in today_widgets
print("Today compact recovery / linear ability presentation checks passed")

contract = pathlib.Path("packages/api-contracts/src/index.ts").read_text()
today_interface = re.search(r"export interface MobileTodayResponse \{(.*?)\n\}", contract, re.S)
assert today_interface, ("Could not locate MobileTodayResponse in the contract; the field "
                         "coverage gate must fail loudly instead of skipping")
contract_fields = re.findall(r"^\s{2}(\w+)\??:", today_interface.group(1), re.M)
assert len(contract_fields) >= 20, (
    f"MobileTodayResponse parsed as {len(contract_fields)} fields, which is implausibly few — "
    "the regex stopped matching the contract, it did not shrink.")

# 每个字段的取值锚点。注意 `injuryFlags` 的锚点在**二级页**
# （今日页「身体指标」链接 → `TechBodyMetricsView`），今日页本身不渲染它。
# 这是有意的信息降级，不是缺失。
field_anchors = {
    "generatedAt": "today.generatedAt",
    "latestDataDate": "today.latestDataDate",
    "today": "data.today.",
    "week": "data.week.",
    "weekDaily": "data.weekDaily",
    "recentWorkouts": "today.recentWorkouts",
    "ability": "data.ability.",
    "calibration": "data.calibration.",
    "verdict": "data.verdict.",
    "nextSession": "data.nextSession",
    "recovery": "data.recovery.",
    "postRun": "today.postRun",
    "weekStructure": "data.weekStructure.",
    "race": "data.race.",
    "injuryFlags": "summary.injuryFlags",
    "weekPlan": "ForEach(native.today?.weekPlan ?? [])",  # 用户移除本周活动内课表，计划页继续承载
    "recentPlanExecution": "native.today?.recentPlanExecution",
    "phase": "data.phase",
    "lock": "data.lock.",
    # 2026-09-19：时效语义拆成四件事，界面各自有落点 —— 刷新结果（`sync`）与
    # 逐指标记录覆盖（`coverage`）在 `TechFreshnessBanner`，恢复评估与建议依据
    # 在同一横幅的披露区与推荐面板。三者的锚点必须分开列，否则「横幅还挂着」会让
    # 某一路退化（例如建议退回直出机器码）也全绿。
    "sync": "today.sync.",
    "coverage": "today.coverage.",
    "recoveryAssessment": "today.recoveryAssessment.",
    "recommendation": "data.recommendation.",
}
# 明确不需要展示位的字段，逐条写理由。
metadata_only = {
    "timezone": "时区元数据；界面统一按 Asia/Shanghai 呈现",
    "lastSyncedAt": "同步时间戳；刷新结果已由 sync.status/lastSuccessAt 承载（横幅披露区渲染的是 sync 那一路）",
    "recommendationRevision": "CAS 版本号，仅供写入冲突检测",
    # 严格日期合同的**完整**评估结果（V2），不是展示层摘要。首页渲染的是由它派生的
    # 紧凑 `recoveryAssessment`（四态互不替代：sync / coverage / recoveryAssessment /
    # recommendation，各自回答不同问题）；把它整份铺到首页会让首页同时出现两套恢复说法。
    # 它随 payload 发出是为了**服务端验收与工具核对**（能逐信号看到 observedAt/availableAt/
    # reasonCodes），iOS 目前刻意不消费 —— 已核实 `grep readinessSnapshot apps/ios` 为空。
    # 要改成展示位，请连同"首页应该展示哪一套恢复说法"一起决定，别只加一行锚点。
    "readinessSnapshot": "严格 V2 完整评估结果：证据层，首页展示的是派生的 recoveryAssessment 摘要",
    # 2026-09-30 §13.3：与 verdict/nextSession 是**同一次决策的两个投影**，不是第二套算法。
    # tone 来自同一个 verdict，action 来自决策自己报告的分支（CoachPlanDisposition），
    # 所以首页已有的 verdict/nextSession 就是它的展示位 —— 再铺一遍会让同一个决定出现两种说法。
    # 它随 payload 发出是为了**服务端验收与工具核对**：`action` 这个"计划被怎么处理"的
    # 结构化标签在 verdict 里没有等价物（verdict 只有 tone + 文案），而它正是
    # "计划被保留/降阶/预算钳制"这类问题唯一可机读的答案。要改成展示位，
    # 请连同"首页该显示哪一套动作标签"一起决定。
    "decision": "版本化决策输出（rai-coach-v2.0.0）：verdict/nextSession 的机读投影，展示位是它们本身",
    # 刻意移出展示位，不是遗漏：它把「今晚有没有夜」当成「数据新不新」，于是一个
    # 没戴表的普通夜晚被显示成"数据过期"，还让历史夜参与今天的判断。契约里它已标
    # `@deprecated`，iOS 也已停止渲染 —— 保留解码只为尚未升级的旧客户端。
    "freshness": "已废弃：语义拆分为 sync / coverage / recoveryAssessment；界面刻意不再渲染",
}

unaccounted = set(contract_fields) - set(field_anchors) - set(metadata_only)
if unaccounted:
    raise AssertionError(
        f"MobileTodayResponse grew {sorted(unaccounted)} with no display slot and no documented "
        "reason. Give it an anchor in TechViews.swift, or list it in metadata_only with a reason — "
        "payload present + no display slot is the 2026-09-17 regression.")
stale = (set(field_anchors) | set(metadata_only)) - set(contract_fields)
assert not stale, f"field gate still lists {sorted(stale)}, which MobileTodayResponse no longer has"

# ---------------------------------------------------------------------------
# 方向断言：`freshness` 不得重新回到展示层。
#
# 上面的两个集合检查只保证「契约字段都有交代」，它们**允许**把 `freshness` 从
# `metadata_only` 挪进 `field_anchors` —— 迁完两边依然配平，门禁照样绿。可这个字段
# 之所以被挪出去，是因为它把「今晚有没有戴表」当成「数据新不新」，于是一个普通的
# 覆盖缺口被渲染成「数据过期」。那是 2026-09-19 整轮改动要拆掉的东西，而"删掉一个
# 展示位"恰好是最容易被后人顺手回退的一类改动（它看起来只是少了一行）。
#
# 因此这里钉死方向：视图层不得再引用 `.freshness`。要把它加回来，必须显式删掉本条
# 并说明为什么「数据过期」的语义应当恢复 —— 正是这个动作会让人读到上面这段历史。
# 注意范围只到视图：`APIModels.swift` 仍解码该字段（旧客户端兼容），不在此列。
# ---------------------------------------------------------------------------
resurrected = re.search(r"\.freshness\b", tech_views)
assert not resurrected, (
    "TechViews.swift reads `.freshness` again. That field is deprecated because it reported an "
    "ordinary coverage gap (a night without a watch) as an expired dataset — the exact judgement "
    "this round removed. Use `sync` for the refresh outcome, `coverage` for per-metric records and "
    "`recoveryAssessment` for what the evidence supports. If the old semantics really must come "
    f"back, delete this assertion and say why. First match: {resurrected.group(0)!r}")

for field, anchor in sorted(field_anchors.items()):
    assert anchor in tech_views, (
        f"Technology skin stopped rendering {field} ({anchor!r} missing from TechViews.swift). "
        "Payload present + contract present + no display slot is exactly the 2026-09-17 "
        "regression, so this gate fails instead of passing quietly.")

# 闭集枚举：契约里的每个取值都必须在展示映射里出现，多一个少一个都算红。
# 域外值会以机器码形式漏到界面上（`need_sync` / `too_hard` / `half_marathon`）。
def mapped_cases(source, function_name):
    """取 `func x(_ y: String) -> String` 的 switch 分支值；函数体以顶格 `}` 收尾。"""
    found = re.search(rf"func {function_name}\(_ \w+: String\) -> String \{{(.*?)\n\}}", source, re.S)
    assert found, f"Could not locate {function_name}; the enum gate must fail loudly instead of skipping"
    return set(re.findall(r'case "([^"]+)": return', found.group(1)))

tech_enums = pathlib.Path("apps/ios/RAI/Skins/Technology/TechEnumPresentation.swift").read_text()

enum_checks = 0
for enum_name, values, mappings in [
    ("MobileDayPhase", ["need_sync", "morning_open", "locked", "post_run", "rest_done"],
     [("techPhaseName", tech_enums)]),
    ("MobileStimulusMatch", ["aligned", "too_hard", "too_easy", "unknown"],
     [("techStimulusMatchName", tech_enums)]),
    ("MobileRaceDistance", ["five_k", "ten_k", "half_marathon"],
     [("techRaceDistanceName", tech_enums)]),
    # 2026-09-19 新增的四组状态枚举。它们最容易被"偷懒复用" —— 例如把 sync.status
    # 直接塞进 `nativeStatusName`（那边的 `stale` 是"数据过期"，而这边要表达的是
    # "刷新有没有跑成"），或把 recoveryAssessment.coverage 当成 verdict 的语气。
    # 因此逐组穷举，多一个少一个都红。
    ("MobileSyncStatus", ["never", "ok", "failed"],
     [("techSyncStatusName", tech_enums)]),
    ("MobileCoverageMetric", ["none", "historical", "current"],
     [("techCoverageStateName", tech_enums)]),
    ("MobileRecoveryAssessment.coverage", ["none", "partial", "complete"],
     [("techRecoveryCoverageName", tech_enums)]),
    ("MobileRecoveryAssessment.assessment",
     ["not_assessed", "no_low_signal", "low_signal", "multiple_low_signals"],
     [("techRecoveryAssessmentName", tech_enums)]),
    ("MobileRecommendation.basis",
     ["training_load_and_plan", "insufficient_training_history", "high_load"],
     [("techRecommendationBasisName", tech_enums)]),
    ("MobileRecommendation.recoveryAdjustment", ["none", "veto", "no_evidence"],
     [("techRecoveryAdjustmentName", tech_enums)]),
]:
    expected = set(values)
    for function_name, source in mappings:
        actual = mapped_cases(source, function_name)
        assert actual == expected, (
            f"{function_name} does not cover {enum_name}: missing {sorted(expected - actual)}, "
            f"unexpected {sorted(actual - expected)}")
        enum_checks += 1

print(f"Technology color tokens: {checks} foreground/background pairs meet the 4.5:1 project target")
print("Token checks do not replace rendered-view accessibility auditing.")
print(f"Field coverage: {len(field_anchors)}/{len(contract_fields)} MobileTodayResponse fields have a "
      f"Technology display slot and {len(metadata_only)} are metadata by design "
      f"({', '.join(sorted(metadata_only))}); {enum_checks} closed-set enum mappings cover every "
      f"contract value.")

# 映射函数存在 ≠ 映射函数被调用：把 `techPhaseName(data.phase)` 改回直出
# `data.phase` 时，上面的穷举断言依然全绿（函数体一个字没动），用户却重新看到
# `morning_open`。所以再钉一层"展示层确实经过映射"。这里只断言函数被调用，不锁
# 参数写法 —— 防的是直出回归，不是合法重构。
for file_name, functions in [
    ("apps/ios/RAI/Skins/Technology/TechViews.swift",
     ["techPhaseName(", "techStimulusMatchName(", "techRaceDistanceName(",
      "techSyncStatusName(", "techCoverageStateName(", "techRecoveryCoverageName(",
      "techRecoveryAssessmentName(", "techRecommendationBasisName(", "techRecoveryAdjustmentName("]),
]:
    body = pathlib.Path(file_name).read_text()
    for call in functions:
        assert call in body, (
            f"{file_name} no longer calls {call} — the mapping exists but the view bypasses it, "
            "which is how contract machine codes reach the screen.")
# 阶段展示映射必须覆盖闭集里的每个取值。
# ---------------------------------------------------------------------------
# `techSyncPhase` 有 `default: return "等待同步"`，所以新增一个阶段（P1 加了 `exported` /
# `uploaded`）**编译通过、回归全绿**，用户却会看到"等待同步"—— 而那一刻磁盘上明明有一批
# 数据在等。闭集在 `SyncPhase.swift`，文案在 `TechTheme.swift`，两者必须逐个配平。
# 这条同时是「阶段闭集只有一个来源」的展示侧对账：那边删一个取值，这里也会红。
sync_phase_source = pathlib.Path("apps/ios/RAI/SyncPhase.swift").read_text()
enum_body = re.search(r"enum SyncPhase: String, CaseIterable, Sendable \{(.*?)\n\}", sync_phase_source, re.S)
assert enum_body, ("Could not locate the SyncPhase enum; the phase-label gate must fail loudly "
                   "instead of skipping")
# 🔴 这里收的是**落盘值**（`rawValue`），不是 case 名 —— 展示层 `techSyncPhase` 的
# `case "..."` 比对的也是落盘值（`HealthKitSync` 写进 `phase` 的那个字符串）。
# V2.1 的两个阻塞阶段用了蛇形 rawValue（`deferred_protected_data` / `auth_required`，
# 与状态机文档逐字对齐），于是"case 名 == rawValue"这个此前**恰好**成立的前提不再成立：
# 只抓 case 名会让这两个取值同时被判成"没有标签"（unlabelled）与"标签是死的"（stale），
# 而两条都是假红 —— 假红的门禁和恒绿的门禁一样糟。
declared_cases = re.findall(
    r"^\s*case ([a-z][A-Za-z0-9_]*)\s*(?:=\s*\"([^\"]*)\")?\s*$", enum_body.group(1), re.M
)
# 没有显式 rawValue 的取值，按 Swift 规则其 rawValue 就等于 case 名。
sync_phases = {raw or name for name, raw in declared_cases}
assert len(sync_phases) >= 8, f"SyncPhase parsed as only {sorted(sync_phases)}"
theme_source = pathlib.Path("apps/ios/RAI/Skins/Technology/TechTheme.swift").read_text()
label_block = re.search(r"func techSyncPhase\(_ phase: String\) -> String \{(.*?)\n\}", theme_source, re.S)
assert label_block, "Could not locate techSyncPhase; the phase-label gate must fail loudly instead of skipping"
labelled = set(re.findall(r'case "([^"]+)": return', label_block.group(1)))
# `idle` 是"没有进度"这一态，由 `default` 的"等待同步"承载，是唯一允许没有显式分支的取值。
unlabelled = sync_phases - labelled - {"idle"}
assert not unlabelled, (
    f"techSyncPhase has no label for {sorted(unlabelled)}; they fall through to the default "
    '"等待同步", which is wrong for a batch that is sitting on disk waiting to go out.')
stale = labelled - sync_phases
assert not stale, (
    f"techSyncPhase labels {sorted(stale)}, which SyncPhase no longer produces — "
    "a label for a phase that cannot occur is dead text that reads like coverage.")
print("Enum mappings are wired into the view, not just defined.")
print(f"Phase labels: {len(sync_phases)} SyncPhase values, {len(labelled)} explicit labels "
      "(idle falls through to the default by design).")

# ---------------------------------------------------------------------------
# 未来七日预览是一次**未经确认的提议**：在用户点「确认替换」之前，打开它不得产生任何写入。
#
# 2026-09-26 新增 `TechPlanPreviewSheet.swift` 时，`tech_views` 的锚点清单同步补了
# `TechPlanView.swift`，但**这张 sheet 本身零断言**（全仓只有定义点与 `TechPlanView.swift:93`
# 的调用点）——「预览不隐式确认」「替换提示有两态」「过期候选提示存在」三条行为全靠读码成立。
#
# 预览恰好是那种"坏了也看不出来"的入口：谁在这里加一个
# `.task { await native.confirmPlanPreview(preview) }`，用户**只是打开看一眼**
# 就会覆盖掉自己整周的课表 —— 而本脚本、类型检查、UI 回归全绿。
# 因此这里按「确认只能由显式按钮触发」的形态钉死，而不是断言"文件里有没有 confirm 二字"
# （那只会在合法重命名时变红，是真红里的假红）。
# ---------------------------------------------------------------------------
preview_sheet_path = "apps/ios/RAI/Skins/Technology/TechPlanPreviewSheet.swift"
preview_sheet = re.sub(r"/\*.*?\*/|//[^\n]*", "", pathlib.Path(preview_sheet_path).read_text(), flags=re.S)

# 1) 预览不得隐式落库。
for auto in [".task", ".onAppear", ".onChange"]:
    assert auto not in preview_sheet, (
        f"{preview_sheet_path} gained {auto}. The preview is only a proposal until the runner taps "
        "确认替换; an automatic lifecycle hook here would save a plan nobody agreed to.")
confirm_calls = preview_sheet.count("confirmPlanPreview(")
assert confirm_calls == 1, (
    f"{preview_sheet_path} calls confirmPlanPreview {confirm_calls} times; exactly one is expected, "
    "inside the explicit 确认替换 toolbar button.")
assert re.search(r'Button\([^)]*"确认替换"\)\s*\{\s*Task\s*\{', preview_sheet), (
    "Could not locate the 确认替换 button that starts the confirm Task; the preview gate must fail "
    "loudly instead of skipping.")
assert "preview.revision != native.goals?.revision" in preview_sheet, (
    "The stale-preview guard disappeared. The confirm button must stay disabled once the goals "
    "revision moved on, otherwise a stale candidate overwrites the current plan.")

# 2) 两态提示必须都在：替换日期（空 / 非空）与既有处方（有 / 无）。
for anchor, label in [
    ("replacedDates.isEmpty", "replaced-date empty branch"),
    ("preview.replacedDates.joined(separator:", "replaced-date non-empty branch"),
    ("preview.previousDays?.first(where:", "previous-prescription lookup"),
    ('Text("原计划：未安排")', "previous-prescription fallback"),
]:
    assert anchor in preview_sheet, (
        f"{preview_sheet_path} lost the {label}. A one-sided branch silently hides either "
        "'nothing was replaced' or the replaced dates themselves.")
print("Plan preview gate: confirm-only, with both replaced-date and previous-prescription branches present.")
PY
