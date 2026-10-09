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
  apps/ios/RAI/NativeFormat.swift apps/ios/RAI/WorkoutPlanMapper.swift apps/ios/RAI/CalibrationState.swift \
  apps/ios/RAI/VerdictPresentation.swift \
  apps/ios/RAI/Skins/Technology/TechPlotData.swift \
  apps/ios/RAI/Skins/Technology/TechSyncPresentation.swift \
  apps/ios/RAI/Skins/Technology/TechEnumPresentation.swift \
  apps/ios/RAI/Skins/Technology/TechWorkoutDetailPresentation.swift \
  apps/ios/RAI/Skins/Technology/TechRunCoachPresentation.swift \
  apps/ios/tests/TechPresentationRegression.swift -o "$tmp/tech-presentation"
"$tmp/tech-presentation"
python3 - <<'PY'
import pathlib, re

def without_comments(text):
    """去注释：多处判据要钉的是"源码在说什么"，不是"注释在说什么"，放最前面共用。"""
    return re.sub(r"/\*.*?\*/|//[^\n]*", "", text, flags=re.S)

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
for foreground in ["ink", "cyan", "blue", "coral", "yellow", "leaf", "success", "violet", "muted-0", "muted-1"]:
    for background in ["background", "paper", "elevated", "mint", "paleCyan", "paleCoral", "paleYellow"]:
        ratio = contrast(colors[foreground], colors[background])
        assert ratio >= 4.5, f"{foreground} on {background}: {ratio:.2f} < 4.5"
        checks += 1

# Dark semantic badges and insight panels use translucent fills. Verify the
# resulting color on every neutral layer, including BOTH muted contrast variants,
# rather than comparing uncomposited palette tokens.
for foreground in ["cyan", "blue", "coral", "yellow", "leaf", "success", "violet", "muted-0", "muted-1"]:
    for background in ["background", "paper", "elevated"]:
        for alpha in [0.07, 0.08, 0.12, 0.15]:
            ratio = contrast(colors[foreground], blend(colors[foreground], colors[background], alpha))
            assert ratio >= 4.5, f"{foreground} on {foreground}@{alpha} over {background}: {ratio:.2f} < 4.5"
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
    r"else \{ TechSurfaceShape\(\)\.fill\(TechColor\.(\w+)\) \}", primary,
    "TechPrimaryButton enabled fill color")

sheet = pathlib.Path("apps/ios/RAI/Skins/Technology/TechConfirmationSheet.swift").read_text()
destructive = sheet.split("if destructive {", 1)[1].split("} else {", 1)[0]
(destructive_label,) = token(r"foregroundStyle\(TechColor\.(\w+)\)", destructive,
                             "destructive confirmation label color")
(destructive_fill,) = token(r"background\(TechColor\.(\w+), in: TechSurfaceShape\(\)\)", destructive,
                            "destructive confirmation fill color")

consent = without_comments(pathlib.Path("apps/ios/RAI/MapPrivacyConsentView.swift").read_text())
consent_primary = consent.split('Button("同意并启用地图"', 1)[1].split("Button(", 1)[0]
assert ".buttonStyle(.borderedProminent)" in consent_primary, "Keep the native privacy consent action"
(consent_label,) = token(r"foregroundStyle\(TechColor\.(\w+)\)", consent_primary,
                         "privacy consent explicit inverse label")
(consent_fill,) = token(r"tint\(TechColor\.(\w+)\)", consent_primary,
                        "privacy consent explicit prominent fill")

for label, foreground, fill in [
    ("Primary button label", label_token, fill_token),
    ("Destructive confirmation label", destructive_label, destructive_fill),
    ("Privacy consent button label", consent_label, consent_fill),
]:
    ratio = contrast(colors[foreground], colors[fill])
    assert ratio >= 4.5, f"{label} ({foreground} on {fill}): {ratio:.2f} < 4.5"
    checks += 1

# 配速区间徽章：必须按实际填充与 paper 面板**叠加后**的颜色算。
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

# Disabled buttons must remain neutral and readable; the enabled inverse label
# must not leak onto the dark disabled fill.
(disabled_label,) = token(
    r"foregroundStyle\(isDisabled \? TechColor\.(\w+) :", primary,
    "TechPrimaryButton disabled label color")
(disabled_fill,) = token(
    r"if isDisabled \{ TechSurfaceShape\(\)\.fill\(TechColor\.(\w+)\) \}", primary,
    "TechPrimaryButton disabled fill color")
disabled_variants = ["muted-0", "muted-1"] if disabled_label == "muted" else [disabled_label]
for foreground in disabled_variants:
    ratio = contrast(colors[foreground], colors[disabled_fill])
    assert ratio >= 4.5, f"Disabled button ({foreground} on {disabled_fill}): {ratio:.2f} < 4.5"
    checks += 1

# Today's inline CTA stays bound to the ORIGINAL availability predicate while
# adopting the same enabled inverse / disabled neutral color contract.
today_source = pathlib.Path("apps/ios/RAI/Skins/Technology/TechViews.swift").read_text()
lock_cta = today_source.split("private func recommendationPanel", 1)[1].split("private func lockDisabled", 1)[0]
disabled_lock_label, enabled_lock_label = token(
    r"foregroundStyle\(lockDisabled\(data\) \? TechColor\.(\w+) : TechColor\.(\w+)\)",
    lock_cta, "Today lock CTA label colors")
disabled_lock_fill, enabled_lock_fill = token(
    r"background\(lockDisabled\(data\) \? TechColor\.(\w+) : TechColor\.(\w+), in:",
    lock_cta, "Today lock CTA fill colors")
for foreground, fill in [
    (enabled_lock_label, enabled_lock_fill),
    *[(variant, disabled_lock_fill) for variant in (
        ["muted-0", "muted-1"] if disabled_lock_label == "muted" else [disabled_lock_label])],
]:
    ratio = contrast(colors[foreground], colors[fill])
    assert ratio >= 4.5, f"Today lock CTA ({foreground} on {fill}): {ratio:.2f} < 4.5"
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
tech_views += (pathlib.Path("apps/ios/RAI/Skins/Technology/TechManualPlanView.swift").read_text() + pathlib.Path("apps/ios/RAI/Skins/Technology/TechPlanWatchSection.swift").read_text())
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
# The weekly goal is retired. The detail must still state the observed distance,
# and nothing may reintroduce a goal ring, fraction or remaining distance.
assert "data.week.distanceKm" in week_view, "Week detail must still render the observed distance"
for retired in ["goalProgressFraction", "goalDistanceKm", "remainingDistanceKm", "remainingDistanceLabel"]:
    assert retired not in week_view, f"Retired weekly-goal field came back: {retired}"

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
    # 2026-10-02 §9.6：负荷外推的建议间隔。它与 `recovery`（实测证据）是相邻但**不同**的
    # 两个对象，所以锚点也必须分开 —— 复用同一个锚点会让"卡片还在"同时为两条判据背书。
    "recoveryTime": "estimate.isAvailable",
    # 2026-10-02 §20：周期骨架、依从性与重排建议。三者都要有落点 —— 一个"计划阶段"
    # 不显示在今天页上，用户就只能在减量期里按专项期的量去跑。
    "periodization": "data.periodization",
    "adherence": "data.adherence",
    "replan": "data.replan",
    "postRun": "today.postRun",
    "weekStructure": "data.weekStructure.",
    "race": "data.race.",
    "injuryFlags": "summary.injuryFlags",
    "weekPlan": "ForEach(native.planPresentation.today?.weekPlan ?? [])",  # 用户移除本周活动内课表，计划页继续承载
    "recentPlanExecution": "native.planPresentation.today?.recentPlanExecution",
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

# ---------------------------------------------------------------------------
# 教练响应（`MobileRunCoachResponse`）的字段覆盖。
#
# 在这之前这里是**零覆盖**：`MobileTodayResponse` 的 33 个字段被逐个对账，教练响应一个都
# 没有 —— 于是给它加字段是"裸奔"改动（本次新增的 `confidence` 与 `unplannedDays` 就是在
# 这种状态下做的，是本次改动要一并补上的判据）。口径与上面完全一致：字段全集从**契约源码**
# 解析，锚点逐条写在视图里，例外逐条写理由 —— 任何"payload 发了但没人显示"的字段在这里
# 变红，而不是等用户发现。
#
# ⚠️ 用 `^ {2}` 而不是 `^\s{2}`：`unplannedDays` 是内联对象数组，成员缩进 4 格，
# `\s{2}` 会把它们一并收进字段集，于是门禁开始对账几个并不存在的顶层字段。
# ---------------------------------------------------------------------------
coach_interface = re.search(r"export interface MobileRunCoachResponse \{(.*?)\n\}", contract, re.S)
assert coach_interface, ("Could not locate MobileRunCoachResponse in the contract; the coach field "
                         "coverage gate must fail loudly instead of skipping")
coach_fields = re.findall(r"^ {2}(\w+)\??:", coach_interface.group(1), re.M)
assert len(coach_fields) >= 8, (
    f"MobileRunCoachResponse parsed as {len(coach_fields)} fields, which is implausibly few — "
    "the regex stopped matching the contract, it did not shrink.")

coach_view = without_comments(
    ("\n".join(pathlib.Path("apps/ios/RAI/Skins/Technology/" + name).read_text() for name in ['TechRunCoachView.swift', 'TechCoachOverviewSection.swift', 'TechCoachWeekSection.swift', 'TechCoachUpcomingSection.swift', 'TechCoachEvidenceSection.swift', 'TechCoachDaySheet.swift', 'TechRunCoachSetup.swift', 'TechCoachStrengthSection.swift']))
    + pathlib.Path("apps/ios/RAI/Skins/Technology/TechPlanPreviewSheet.swift").read_text())
coach_anchors = {
    "revision": "native.planPresentation",
    "plan": "snapshot.coachPlan",
    "phase": "$0.phase.map(techCoachPhaseName)",
    "daysToRace": "snapshot.coach?.daysToRace",
    "elapsedWeeks": "snapshot.coach?.elapsedWeeks",
    # 2026-10-07：这一格是"算完却丢掉"的正例。它此前是另一套公式算出来的容量，直接上屏会
    # 与今天页的量带打架；现在它是本周**预算**，与今天页量带上限同源（见 `runCoachWeeklyBudget`）。
    # 断言锚在解释行上：那个数字必须带着"校准未完成"一起出现，否则一句孤立的 km 数会被读成承诺。
    "weeklyCapacityKm": "本周预算 \\(nativeNumber($0, digits: 1)) km",
    "notices": "coach.notices",
    "phases": "snapshot.coach?.phases",
    "strength": "snapshot.coach?.strength",
    "unplannedDays": "snapshot.coach?.unplannedDays",
    # 🔴 锚在**形状**上（`<读> {`），不是裸子串。裸子串 `snapshot.coach?.confidence` 在这个
    # 文件里有**两处**命中（另一处是 `:31` 的 unsupported-distance 提示），所以把信心卡片整块
    # 删掉它照样命中；再给绑定加一个条件（`, false {`）也照样命中。
    # 2026-10-07 突变验证实测：13 条突变里**唯一存活**的就是
    # `if let confidence = snapshot.coach?.confidence, false {` —— 覆盖表全绿。
    # 收紧成 `<读> {` 后它变红，且对局部变量改名免疫（`if let c = snapshot.coach?.confidence {` 仍匹配）。
    "confidence": "snapshot.coach?.confidence {",
}
coach_metadata_only = {
    # v1 只有 `"preparation"` 一个取值。要出现第二个（目标可达性）才需要展示位 ——
    # 那时它必须回答"按当前预测能不能跑到目标时间"，而那是**另一条预测链**，
    # 不是在本页再抄一份准备度。
    "confidence.basis": "v1 只有 preparation 一个取值，无需区分",
}
coach_unaccounted = set(coach_fields) - set(coach_anchors) - set(coach_metadata_only)
assert not coach_unaccounted, (
    f"MobileRunCoachResponse grew {sorted(coach_unaccounted)} with no display slot and no "
    "documented reason. Give it an anchor in TechRunCoachView.swift, or list it in "
    "coach_metadata_only with a reason — payload present + no display slot is the 2026-09-17 "
    "regression, and the coach response had zero coverage of it until 2026-10-07.")
# 两个集合都可能写子字段（`confidence.basis`），所以比"顶层契约字段"时只取点号前那一段 ——
# 否则一条合法登记会被判成 stale，那是假红。假红的门禁和恒绿的门禁一样糟。
coach_stale = ({key.split(".")[0] for key in set(coach_anchors) | set(coach_metadata_only)}
               - set(coach_fields))
assert not coach_stale, f"the coach field gate still lists {sorted(coach_stale)}, which the contract no longer has"
for field, anchor in sorted(coach_anchors.items()):
    assert anchor in coach_view, (
        f"The coach page stopped rendering {field} ({anchor!r} missing). Payload present + "
        "contract present + no display slot is exactly the 2026-09-17 regression.")

# 覆盖表（上面）证明的是"字段被**读到**"，**不**证明"卡片会**渲染**" —— 两者差一个条件子句。
# `if let sessions = snapshot.coach?.strength, false {` 保留 anchor 子串、关掉整块 UI，
# 覆盖表与锚点全都照绿（2026-10-07 突变验证实测 13 条里唯一存活的就是这个形状）。
# 视图的条件表里出现**裸布尔字面量**只可能是死代码或开关，所以整类一次钉死，
# 而不是逐字段去猜哪个 `if let` 可以被"多接一个条件"绕过。
# ⚠️ 它挡不住的不是字面量的开关：`if cond, someFlag {`（`someFlag` 是变量）、`.opacity(0)`、
# 或者把读改写进一个恒为 nil 的表达式 —— 那些要另设判据。
literal_conditions = [
    match.group(0)
    for match in re.finditer(
        r"(?:if|guard|while)\s+(?:true|false)\s*(?:,|\{)"
        r"|(?:if|guard|while)[^\n]*?,\s*(?:true|false)\s*(?:,|\{)",
        coach_view)
]
assert not literal_conditions, (
    f"A literal boolean appears in a condition list in the coach view: {literal_conditions}. It "
    "either makes the branch dead code or switches a whole card off while every anchor above "
    "still matches. Remove the condition instead of forcing it.")

# 方向断言：`confidence` 的空态必须真的走空态分支。
# `value` 在 `status != "available"` 时是 `null`（服务端永远不发 0），所以任何把它读成数字的
# 写法都得先过这一关；`?? 0` 这类兜底会把"没有证据"渲染成"准备度为零"这个断言 ——
# 与 `@rai/durability` 对 `durabilityScore` 的红线同形（"`null` 也不是 0"）。
assert 'if confidence.status == "available", let value = confidence.value' in coach_view, (
    "TechRunCoachView no longer gates the confidence value on `status == \"available\"`. Without "
    "it a `?? 0` fallback is one edit away, and 0 reads as the assertion \"preparedness is zero\" "
    "— the shape `@rai/durability` explicitly forbids for `durabilityScore`.")
assert "?? 0" not in coach_view.split("if confidence.status")[1].split("private func componentLine")[0], (
    "The confidence card grew a `?? 0` fallback. Absent evidence must render an empty state, "
    "never a zero: `null` is not `0`.")
# 显示映射必须真的被调用（定义存在 ≠ 视图用它）：这四组闭集文案都在 `TechEnumPresentation`，
# 视图直出契约取值就会把 `moderate` / `pre_race_taper` / `half_marathon` 这类机器码送上屏。
for call in ["techCoachPhaseName(", "techCoachConfidenceBandName(", "techCoachEvidenceLevelName(",
             "techCoachUnplannedReasonName("]:
    assert call in coach_view, (
        f"TechRunCoachView no longer calls {call} — the mapping exists but the view bypasses it, "
        "which is how contract machine codes reach the screen.")
assert "private func phaseName" not in coach_view, (
    "A private `phaseName` came back into the coach view. Its `default:` was「持续训练」, a word "
    "already reached in production by fitness programmes, so a seventh contract phase would "
    "reuse it silently. Use `techCoachPhaseName` + `techCoachNoRaceBlockLabel`.")
print(f"Coach field coverage: {len(coach_anchors)}/{len(coach_fields)} MobileRunCoachResponse "
      f"fields have a Technology display slot and {len(coach_metadata_only)} is metadata by design.")

# Unit-tested presentation must remain wired into the cards, and the calibration explanation
# must render near the overview rather than surviving only as an unused helper or bottom notice.
coach_page = without_comments(("\n".join(pathlib.Path("apps/ios/RAI/Skins/Technology/" + name).read_text() for name in ['TechRunCoachView.swift', 'TechCoachOverviewSection.swift', 'TechCoachWeekSection.swift', 'TechCoachUpcomingSection.swift', 'TechCoachEvidenceSection.swift', 'TechCoachDaySheet.swift', 'TechRunCoachSetup.swift', 'TechCoachStrengthSection.swift'])))
assert coach_page.index('.accessibilityIdentifier("coach.overview")') < coach_page.index("\n                    explanation\n") < coach_page.index('.accessibilityIdentifier("coach.today")'), (
    "Calibration progress and conservative-start context must render immediately after the overview")
explanation = coach_page.split("@ViewBuilder private var explanation:", 1)[1].split("private func coachControls", 1)[0]
for anchor in ["$0.recommendation.planRevision == native.currentPlanRevision", "techCoachCalibrationLabel",
               "techCoachCalibrationExplanation", "未来7日已排", "本周预算"]:
    assert anchor in explanation, f"Coach first-screen explanation lost {anchor}"
assert ".executable" not in explanation, "Recording or reconfirming today must not remove it from the scheduled count"
week_progress = coach_page.split("struct TechCoachWeekProgressCard:", 1)[1].split("struct TechCoachProgressStat:", 1)[0]
assert "TechCoachWeekProgress(days: days, adherence: adherence)" in week_progress, "Weekly counts must use the tested adherence/legacy presentation"
assert "progress.unknownCount" in week_progress and "天待同步" in week_progress, "Missing observations must remain explicit, including without distance data"
week_timeline = coach_page.split("struct TechCoachWeekTimeline:", 1)[1].split("struct TechCoachTrainingDays:", 1)[0]
assert "Text(techCoachWeekDayTitle(day))" in week_timeline, "The timeline must use completion before planned status"
hero = coach_page.split("struct TechCoachHeroCard:", 1)[1].split("struct TechTodayTrainingCard:", 1)[0]
assert "techCoachTotalWeeks(for: plan)" in hero and "plan.durationWeeks" not in hero, \
    "Race-cycle progress must use the tested date-derived duration, not the fitness setting"
assert "techCoachRaceCountdown(raceDate: plan.raceDate, todayLocalDate: todayLocalDate, daysToRace: daysToRace)" in hero, "A zero countdown must be checked against the actual race date"
training_days = coach_page.split("struct TechCoachTrainingDays:", 1)[1].split("struct TechCoachRollingUpcomingSection:", 1)[0]
assert "可跑步日" in training_days and "可选，不是承诺" in training_days and "$0.detail" in training_days, "Running-day preferences must not promise sessions or drop unplanned-day facts"
print("Coach presentation: observed-day progress, calibration context, timeline status and race expiry are wired into the view.")

# Main-work alerts, rather than session-level zone references, drive every target summary.
for name in ["TechTodayTrainingCard", "TechCoachRollingUpcomingRow",
             "TechCoachExecutableDaySheet", "TechCoachUpcomingRow"]:
    card = coach_page.split(f"struct {name}: View {{", 1)[1].split("\nstruct ", 1)[0]
    assert "techCoachTrainingTarget(" in card and "target.formattedRange" in card, (
        f"{name} must render the tested prescription-based target")
    assert "paceSecondsPerKmLower" not in card and "heartRateBpmLower" not in card, (
        f"{name} bypasses the target helper and may prefer pace over the actual heart-rate alert")
assert 'if plan.status == "active" {' in coach_page, "Upcoming schedules must be gated only on active coach status"
upcoming_block = coach_page.split('if plan.status == "active" {', 1)[1].split("if let confidence", 1)[0]
assert re.match(r"\s*if let schedule \{\s*TechCoachRollingUpcomingSection\(", upcoming_block), (
    "A valid schedule must render before and independently of the today fallback")
assert "techCoachUpcomingTrainingDays(in: schedule)" in upcoming_block, (
    "Independent schedules must use the tested schedule-local current-date cutoff")
assert "} else if let today = todayForCurrentPlan {" in upcoming_block, (
    "The week-strip fallback still requires an available revision-matching today response")
print("Coach targets follow main-work alerts; valid future schedules remain visible without a today response.")

# 闭集枚举：契约里的每个取值都必须在展示映射里出现，多一个少一个都算红。
# 域外值会以机器码形式漏到界面上（`need_sync` / `too_hard` / `half_marathon`）。
def mapped_cases(source, function_name):
    """取 `func x(_ y: String) -> String` 的 switch 分支值；函数体以顶格 `}` 收尾。"""
    found = re.search(rf"func {function_name}\(_ \w+: String\) -> String \{{(.*?)\n\}}", source, re.S)
    assert found, f"Could not locate {function_name}; the enum gate must fail loudly instead of skipping"
    return set(re.findall(r'case "([^"]+)": return', found.group(1)))

def mapped_labels(source, function_name):
    """同一条函数体正则，取 `case "x": return "y"` 的**文案** y（`default` 行不匹配，故不在内）。

    文案清单必须从源码里取。写死在闸门里的话，文案一改这条断言就静默失效（判据恒真），
    而"面板里又抄了一份状态文案"正是它要拦的事。
    """
    found = re.search(rf"func {function_name}\(_ \w+: String\) -> String \{{(.*?)\n\}}", source, re.S)
    assert found, (f"Could not locate {function_name}; the copy gate must fail loudly instead of "
                   "skipping")
    labels = re.findall(r'case "[^"]+": return "([^"]+)"', found.group(1))
    assert labels, (f"Could not read any label out of {function_name}; the copy gate would otherwise "
                    "compare nothing and pass")
    return labels

tech_enums = pathlib.Path("apps/ios/RAI/Skins/Technology/TechEnumPresentation.swift").read_text()

# `MobilePlanExecutionDay.status` 的闭集只有一个来源：**契约源码**。这里沿用本文件对
# `MobileTodayResponse` 的做法（正则解析 + 数量下限），而不是在脚本里再抄一份取值清单 ——
# 手抄的那份不随契约变，于是契约新增一个取值时，穷举表与枚举对账会**一起**对着过期清单
# 配平、双双变绿，而界面已经落到域外分支上（本文件后面记的 SyncPhase 事故就是这个形状：
# default ⇒ 新增取值编译通过、回归全绿、用户看到错文案）。
plan_day = re.search(r"export interface MobilePlanExecutionDay \{(.*?)\n\}", contract, re.S)
assert plan_day, ("Could not locate MobilePlanExecutionDay in the contract; the plan-execution "
                  "status gate must fail loudly instead of skipping")
plan_status_line = re.search(r"^\s*status\??:\s*(.+?);\s*$", plan_day.group(1), re.M)
assert plan_status_line, ("MobilePlanExecutionDay has no parseable `status` field; the plan-execution "
                          "status gate must fail loudly instead of skipping")
plan_execution_status = re.findall(r'"([^"]+)"', plan_status_line.group(1))
assert len(plan_execution_status) >= 2, (
    f"MobilePlanExecutionDay.status parsed as {plan_execution_status}, which is implausibly few — "
    "the regex stopped matching the contract, it did not shrink.")

def union_values(interface_name, field_name):
    """契约里某个内联联合字段的取值清单。

    逐字解析而不是在脚本里手抄：手抄的那份不随契约变，于是契约新增一个取值时，穷举表与
    枚举对账会**一起**对着过期清单配平、双双变绿 —— 而界面已经落到 `default` 上。
    解析不到就报错，不许静默跳过（静默跳过的门禁比没有门禁更糟）。
    """
    body = re.search(rf"export interface {interface_name} \{{(.*?)\n\}}", contract, re.S)
    assert body, (f"Could not locate {interface_name} in the contract; the closed-set gate must "
                  "fail loudly instead of skipping")
    line = re.search(rf"^\s*{field_name}\??:\s*(.+?);\s*$", body.group(1), re.M)
    assert line, (f"{interface_name} has no parseable `{field_name}` field; the closed-set gate "
                  "must fail loudly instead of skipping")
    values = re.findall(r'"([^"]+)"', line.group(1))
    assert len(values) >= 2, (
        f"{interface_name}.{field_name} parsed as {values}, which is implausibly few — the regex "
        "stopped matching the contract, it did not shrink.")
    return values

phase_alias = re.search(r"export type MobilePeriodizationPhase = (.+?);", contract)
assert phase_alias, ("Could not locate MobilePeriodizationPhase in the contract; the coach phase "
                     "gate must fail loudly instead of skipping")
periodization_phases = re.findall(r'"([^"]+)"', phase_alias.group(1))
assert len(periodization_phases) >= 4, (
    f"MobilePeriodizationPhase parsed as {periodization_phases}, which is implausibly few.")
coach_bands = union_values("MobileRunCoachConfidence", "band")
coach_evidence_levels = union_values("MobileRunCoachConfidence", "evidenceLevel")
coach_unplanned_codes = union_values("MobileRunCoachResponse", "code")

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
    # 近七日执行记录的状态。它在视图里此前是三个平行 switch，文案那份的 `default` 是
    # 「缺少计划快照」：契约多一个取值就编译通过、回归全绿，用户看到一句自信的错话 ——
    # 与 `techSyncPhase` 的 `default: "等待同步"` 同一个形状。
    # 清单来自**契约源码**（见上面的解析），不是这里手写的一行：契约新增取值时，这条会自己
    # 变红，而不是等着谁记得回来改。
    ("MobilePlanExecutionDay.status", plan_execution_status,
     [("techPlanExecutionStatusName", tech_enums)]),
    # 2026-10-07 教练页的四组新闭集。`techCoachPhaseName` 尤其重要：它此前是视图里的一个
    # 私有函数，`default:` 是「持续训练」，而体能计划在生产里已经走到那个分支 —— 契约新增
    # 第七个阶段时它会静默复用这个词。现在它与契约逐值配平，多一个少一个都红。
    # 取值全部从契约源码解析（`union_values` / `periodization_phases`），不在这里手抄。
    ("MobilePeriodizationPhase", periodization_phases,
     [("techCoachPhaseName", tech_enums)]),
    ("MobileRunCoachConfidence.band", coach_bands,
     [("techCoachConfidenceBandName", tech_enums)]),
    ("MobileRunCoachConfidence.evidenceLevel", coach_evidence_levels,
     [("techCoachEvidenceLevelName", tech_enums)]),
    ("MobileRunCoachResponse.unplannedDays[].code", coach_unplanned_codes,
     [("techCoachUnplannedReasonName", tech_enums)]),
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
      f"({', '.join(sorted(metadata_only))}); {len(coach_anchors)}/{len(coach_fields)} "
      f"MobileRunCoachResponse fields likewise ({len(coach_metadata_only)} metadata by design); "
      f"{enum_checks} closed-set enum mappings cover every contract value.")

# 映射函数存在 ≠ 映射函数被调用：把 `techPhaseName(data.phase)` 改回直出
# `data.phase` 时，上面的穷举断言依然全绿（函数体一个字没动），用户却重新看到
# `morning_open`。所以再钉一层"展示层确实经过映射"。这里只断言函数被调用，不锁
# 参数写法 —— 防的是直出回归，不是合法重构。
for file_name, functions in [
    ("apps/ios/RAI/Skins/Technology/TechViews.swift",
     ["techPhaseName(", "techStimulusMatchName(", "techRaceDistanceName(",
      "techSyncStatusName(", "techCoverageStateName(", "techRecoveryCoverageName(",
      "techRecoveryAssessmentName(", "techRecommendationBasisName(", "techRecoveryAdjustmentName("]),
    # 执行状态胶囊住在计划预览表里（不在 TechViews.swift）：文案必须走映射函数，
    # 否则契约机器码——或面板自己抄的一句话——就会直接上屏。
    ("apps/ios/RAI/Skins/Technology/TechPlanPreviewSheet.swift",
     ["techPlanExecutionStatusName("]),
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
preview_sheet = without_comments(pathlib.Path(preview_sheet_path).read_text())

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

# ---------------------------------------------------------------------------
# 训练计划页的两处可用性修复（2026-10-01 反馈），各钉一条"改回去不会变红"的判据。
#
# ① 两个返回按钮：`techNavigation` 隐藏系统返回按钮并自加一个，而页面里
#    `.navigationBarBackButtonHidden(isSaving)` 在非保存态传 `false`，把系统按钮又放了
#    回来 —— 页面上就出现两个箭头。挡住返回只能作用在自定义那条 ToolbarItem 上。
# ② 两条七日表：本页同时平铺「7 天训练安排」（自然周）与「未来七日」（生成窗口）。
#    两个时间窗不同所以不能合并，但第二条必须折起来。判据落在"平铺渲染只有一处"上，
#    而不是"文件里有没有 DisclosureGroup 四个字"（后者在合法重构时会假红）。
# ---------------------------------------------------------------------------
def slice_between(text, start, end, label):
    """取 `start` 之后、`end` 之前的源码。两端锚点缺失**或顺序颠倒**都必须报错 —— 判据载体
    被搬走、或 end 跑到了 start 前面时，切片会静默退化成"start 之后全文"（或整个文件），
    是这仓库踩过的"判据恒真"事故。"""
    assert text.count(start) >= 1, f"{label}: start anchor {start!r} not found"
    assert text.count(end) >= 1, f"{label}: end anchor {end!r} not found"
    tail = text.split(start, 1)[1]
    assert end in tail, (f"{label}: end anchor {end!r} must come after start anchor {start!r}; "
                         "otherwise the slice silently widens to everything after start")
    return tail.split(end, 1)[0]

plan_view = without_comments(
    (pathlib.Path("apps/ios/RAI/Skins/Technology/TechManualPlanView.swift").read_text() + pathlib.Path("apps/ios/RAI/Skins/Technology/TechPlanWatchSection.swift").read_text()))
assert "navigationBarBackButtonHidden" not in plan_view, (
    "TechPlanView.swift hides/re-shows the system back button again. `techNavigation` already "
    "hides it and adds its own; a second `navigationBarBackButtonHidden(false)` is what put two "
    "arrows in the bar. To block leaving mid-save use `backDisabled:` instead.")
assert "backDisabled: isSaving" in plan_view, (
    "The plan page stopped disabling the custom back button while saving; that guard used to be "
    "expressed by re-showing the system button, which cannot come back.")
theme = without_comments(
    pathlib.Path("apps/ios/RAI/Skins/Technology/TechTheme.swift").read_text())
assert ".navigationBarBackButtonHidden(true)" in theme, (
    "The shared navigation modifier must keep the system back button hidden")
assert ".disabled(backDisabled)" in theme, (
    "TechNavigation must apply backDisabled to its own back button, not to the bar")
assert plan_view.count('TechSectionHeader(title: "7 天训练安排"') == 1, (
    "Exactly one flat seven-day strip belongs on the plan page")
watch_section = without_comments(pathlib.Path("apps/ios/RAI/Skins/Technology/TechPlanWatchSection.swift").read_text())
assert watch_section.count("ForEach(plan.days)") == 1, "Exactly one rolling schedule list belongs in the shared section"
assert "DisclosureGroup" in watch_section and "TechExecutablePlanDay" in watch_section, "Rolling window remains collapsed and separate from natural-week progress"
assert "TechPlanWatchSection(allowsSynchronization: true)" in plan_view, "Manual page must use the shared explicit scheduling entry"
assert 'Button("撤回 RAI 系统旧排期"' in watch_section, "No-plan/offline users must retain an explicit withdrawal entry"
assert "PlanWatchSyncCoordinator.shared" in watch_section and "WorkoutKitBridge" not in plan_view, "Views must not own divergent scheduling flows"
print("Plan page: one back button, one flat seven-day strip (rolling window collapsed).")

editable_plan = slice_between(plan_view, "private var editablePlanIndexes", "private var weekPlanPanel",
                              "pending migration editor guard")
assert "native.planPresentation.goals?.weekPlanReplanRequired != true" in editable_plan, (
    "Pending migration must not offer future-day editors")
watch_panel = watch_section
assert "native.goals?.weekPlanReplanRequired == true" in watch_panel, "Migration notice uses server-owned state"
for text in ["重新预览规则课表", "手表上的旧排期不会自动撤回", "请手动同步以撤回或替换"]:
    assert text in watch_panel, f"Missing migration warning: {text}"
assert "NativeAppModel.planSourceName(audit.generatedBy)" in watch_panel, "Provenance retains rule/manual/history labels"
print("Plan migration: future editing withheld, explicit preview offered, manual Watch replacement explained.")

# ---------------------------------------------------------------------------
# 近七日执行记录：一天一行、只留一个入口。
#
# 旧版每天铺三行文字 + 最多两个 NavigationLink（"查看当天训练"、"检查数据与同步"），
# 七天就是十几条链接（2026-10-01 反馈："太乱"）。这条钉的是形态：执行面板里
# NavigationLink 只许出现一次（整行那个），且 0 条记录必须说成"尚未导入训练"，
# 不许把缺失渲染成 0 公里 —— 那正是这个面板存在的意义（区分"没导入"与"没跑")。
# ---------------------------------------------------------------------------
execution = slice_between(preview_sheet, "struct TechPlanExecutionPanel",
                          "struct TechExecutablePlanDay", "plan execution panel")
assert execution.count("NavigationLink") == 1, (
    "The execution panel must offer exactly one entry per day (the whole row); per-day "
    "'查看当天训练' / '检查数据与同步' links are the clutter this round removed.")
assert "检查数据与同步" not in execution, (
    "Sync diagnostics belong in the day's detail view, not repeated on all seven rows")
assert execution.count("TechBadge(") == 1, "One status chip per row, not a paragraph"
assert "尚未导入训练" in execution, (
    "Zero records must read as 'nothing imported yet', never as 0 km")
assert 'guard day.observedWorkoutCount > 0 else' in execution, (
    "The absence of an import must stay a separate branch from a zero-distance run")
# 状态文案只有一个来源：面板里不得再出现 `techPlanExecutionStatusName` 会产出的任何一句。
# 清单从那个函数的源码里取（不写死 —— 写死的话文案一改，这条就变成永远成立的废话）。
for status_copy in mapped_labels(tech_enums, "techPlanExecutionStatusName"):
    assert status_copy not in execution, (
        f"The execution panel hard-codes the status copy {status_copy!r}. The chip must read it from "
        "techPlanExecutionStatusName; a second copy is the one that keeps the old wording after the "
        "contract grows a value.")
# 域外取值（契约新增、本端枚举没跟上）说的是"未知状态"，配色也复用 unknown 那一档。
# 这条钉的是那个开关形状：`?? .unknown` 被改成别的档位时，这里没有保护（真出问题只会在
# 屏上画错一种颜色），但"配色 switch 不许长 default"能钉住，因为它一旦有 default，
# 枚举少一个取值就不再是编译错误 —— 那正是这次修复的全部意义。
assert "default:" not in slice_between(
    preview_sheet, "private func statusChip", "struct TechExecutablePlanDay", "status chip resolver"), (
    "The status chip resolver grew a `default:` branch. Colours must switch over "
    "TechPlanExecutionStatus with no default, so losing an enum case is a compile error instead of "
    "a catch-all colour.")
print("Execution panel: one row per day, one entry, absence never rendered as zero.")

# ---------------------------------------------------------------------------
# 训练感受：用户点的是词，服务端读的是 1–10 的整数。
#
# 2026-10-01 反馈：「训练详情里训练反馈 1–10 不适合用户」。把数字输入换回文本框、
# 或把档位映射删掉，本脚本、类型检查、UI 回归都不会有任何反应 —— 用户却又要面对量表。
# 因此这里钉三件事：反馈页**确实渲染**档位、整页只有一个自由文本框（备注）、以及档位表与
# 模型侧 `rpe >= 9` 阈值的跨语言对账（阈值只在 TS 源码里解析，本端不留副本）。
# ---------------------------------------------------------------------------
feedback_path = "apps/ios/RAI/Skins/Technology/TechWorkoutFeedbackView.swift"
feedback = without_comments(pathlib.Path(feedback_path).read_text())
# 判据要钉"档位真的渲染了"，不是"文件里出现过这几个字"：
#  - 只断言 `TechEffortScale.options` 存在，会被死代码骗过（档位表还在、界面已经不用它）；
#  - 只断言 `effortChip(` 存在更糟 —— 那个函数**定义**本身就含这四个字，删掉调用照样绿；
#  - 只断言 `.numberPad` 不存在，挡不住"换回普通键盘的自由文本 RPE 框"（1–10 又回来了）。
body = slice_between(feedback, "var body: some View", "private var effortChips", "feedback body")
assert "effortChips" in body, (
    f"{feedback_path} no longer renders the effort chips in its body; the tiers are still defined "
    "but the form bypasses them, which is how the 1–10 question comes back.")
assert "ForEach(TechEffortScale.options" in feedback, (
    f"{feedback_path} no longer iterates TechEffortScale.options — the chips must come from the "
    "tier table, not from a list written next to the buttons.")
text_fields = feedback.count("TextField(")
assert text_fields == 1 and 'TextField("备注"' in feedback, (
    f"{feedback_path} has {text_fields} text fields; the only free-text field on this form is 备注. "
    "A second field is how the 1–10 RPE box comes back — words are the only way to record effort.")
assert ".numberPad" not in feedback, (
    f"{feedback_path} brought back a numeric keyboard; a free RPE field is what made the runner "
    "read a scale instead of choosing a word.")

# 档位表与模型阈值的跨语言单源对账。
# `row.rpe >= 9` 是"这跑得很吃力"的证据门槛（packages/application/src/prediction-data.ts），
# 也是 `TechEffortScale` 第三条硬约束的对手方。阈值必须在**模型侧解析**后与档位表比对：
# 在 Swift 或本脚本里再写一个字面量 9，模型侧改成 8 时对账就变成"对着副本自证" —— 界面上
# 两个词换了意思，而所有判据全绿。解析不到就报错，不许静默跳过。
prediction_data = pathlib.Path("packages/application/src/prediction-data.ts").read_text()
threshold_match = re.search(r"row\.rpe\s*>=\s*(\d+)", prediction_data)
assert threshold_match, ("Could not locate the hard_workout rpe threshold in prediction-data.ts; "
                         "the effort gate must fail loudly instead of skipping")
hard_workout_rpe = int(threshold_match.group(1))
tiers = [(int(value), label) for value, label in
         re.findall(r'TechEffortOption\(value: (\d+), label: "([^"]+)"\)', tech_enums)]
assert len(tiers) >= 2, (f"parsed {len(tiers)} effort tiers out of TechEnumPresentation.swift; the "
                         "regex stopped matching the tier table, it did not shrink.")
crossing = [(value, label) for value, label in tiers if value >= hard_workout_rpe]
assert len(crossing) == 1 and crossing[0][0] == max(value for value, _ in tiers), (
    f"exactly one tier may cross rpe >= {hard_workout_rpe} (parsed from prediction-data.ts) and it "
    f"must be the hardest one; got {crossing}. Either the tier table changed meaning, or the model "
    f"threshold moved — change them together and this reconciliation with them.")
print(f"Effort tiers: only {crossing[0][1]!r} ({crossing[0][0]}) crosses the rpe >= {hard_workout_rpe} "
      "hard_workout threshold parsed from prediction-data.ts.")

# 训练详情的人工覆盖面板：显示词，但必须同时给出整数（算法读的是整数）。
override_panel = slice_between(without_comments(
    pathlib.Path("apps/ios/RAI/Skins/Technology/TechViews.swift").read_text()),
    "private func overridePanel", "struct TechAnalysisView", "override panel")
assert "TechEffortScale.label(for: Int(value))" in override_panel, (
    "The training-detail override panel must present the effort as a word, not a bare number")
assert "（RPE \\(Int(value))）" in override_panel, (
    "The override panel must still print the stored integer; `prediction-data.ts` reads `rpe >= 9`")
print("Effort tiers: the feedback form offers words, the detail panel prints word + integer.")
PY
python3 apps/ios/tests/check-fresh-skin.py
