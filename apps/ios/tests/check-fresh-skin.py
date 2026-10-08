"""Guard the athletic dark surface and the original layout/input boundaries.

The filename is historical. Only the old light appearance contract is migrated;
layout, measurements, touch targets and interaction guards remain enforced.
"""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parents[1] / "RAI"
skin = root / "Skins" / "Technology"


def source(path):
    return re.sub(r"/\*.*?\*/|//[^\n]*", "", path.read_text(), flags=re.S)


theme = source(skin / "TechTheme.swift")
surfaces = source(skin / "TechSurfaceStyle.swift")
illustrations = source(skin / "TechIllustrations.swift")
charts = source(skin / "TechCharts.swift")
app = source(root / "RAIApp.swift")
route = source(skin / "TechRouteView.swift")
share = source(skin / "TechShareCardView.swift")

assert ".preferredColorScheme(.dark)" in app
assert r".environment(\.colorScheme, .dark)" in share
assert route.count("map.mapType = .standardNight") == 2, "Interactive and exported maps must use the SDK night basemap"
assert not re.search(r"map\.mapType = \.standard\b", route), "No light basemap may remain"
for path in [root / "RAIApp.swift", *skin.glob("*.swift")]:
    text = source(path)
    assert not re.search(r"(?:preferredColorScheme|toolbarColorScheme)\(\.light", text), path
    assert r".environment(\.colorScheme, .light)" not in text, path
    assert "Color.white" not in text and "UIColor.white" not in text, f"Fixed white surface remains: {path}"
    assert "LinearGradient(" not in text and "AngularGradient(" not in text, path
    assert ".ultraThinMaterial" not in text and ".glassEffect(" not in text, f"No glass layers: {path}"
    if path.name != "TechIllustrations.swift":
        assert "linearGradient(" not in text, f"Gradient fill outside the page backdrop: {path}"
    assert "TechPixel" not in text, f"Pixel component remains: {path}"
    assert ".interpolation(.none)" not in text, f"Pixelated rendering remains: {path}"

# 2026-10-05：今日首页头部改成"渐隐融入页底色"后，插画里第一次出现 Canvas 的
# `.linearGradient`（小写 —— 上面查的 `LinearGradient(` 是 SwiftUI 的视图，两者不是
# 同一个 API，所以那条禁令**看不见**它）。禁令的意图是"皮肤不要再出现渐变填充的
# 表面"，不是"装饰插画不许把边缘藏起来"。于是把禁令扩到小写形式，只为这一处用途
# 留一个具名例外，并把例外钉死在**比较值**上：渐变体只能取页底色、且必须包含它的
# 透明版本，块数固定为三 —— 一旦有人拿它去铺第二种颜色，或者多铺一块，门禁变红，
# 而不是悄悄给皮肤加回一种渐变表面。
illustrations_clean = source(skin / "TechIllustrations.swift")
assert "TechRunningLandscape(blendsIntoPage: true)" in illustrations_clean, \
    "今日首页头部必须仍然把插画当页面背景用（柔化开关不能被摘掉）"
def tail_after(text, anchor, label):
    """锚点必须**恰好命中 1 次**：0 次 = 判据载体被搬走（会静默恒真），>1 次 = 指代不明。

    与 `run-tech-presentation-tests.sh` 里的同名助手同一约定：判据载体先自证存在，再谈内容。
    """
    count = text.count(anchor)
    assert count == 1, f"{label}：锚点 {anchor!r} 命中 {count} 次（必须恰好 1 次）"
    return text.split(anchor, 1)[1]


fade_body = tail_after(illustrations_clean, "private func blendEdgesIntoPage", "渐隐函数")
# 函数体末尾是**4 空格缩进**的 `}`。不要用 `"\n}"`：那要等到所属结构体的顶层 `}` 才命中，
# 切片会越过函数边界、把函数之后的所有 stop 也算进来（2026-10-05 实测：切片长度是函数体的一倍，
# 今天恰好没多算才没报错 —— 一旦函数后新增 `.init(color:location:)` 就会误报红）。
fade_parts = fade_body.split("\n    }\n", 1)
assert len(fade_parts) == 2, "渐隐函数边界未能定位（函数体末尾不再是 4 空格缩进的 `}`）"
fade = fade_parts[0]

# 三块覆盖共 7 个 stop：左 3（含 seam 处的实色）+ 上 2 + 下 2。两个数都必须钉住 ——
# 只数 stop 会放过"再加一块同色覆盖"，只数块数会放过"块内多切一刀"。
FADE_BLOCKS, FADE_STOPS = 3, 7
assert fade.count(".linearGradient(") == FADE_BLOCKS, \
    f"页面背景柔化必须恰好 {FADE_BLOCKS} 块覆盖，实际 {fade.count('.linearGradient(')}"
fade_stops = re.findall(r"\.init\(color: ([^,]+), location:", fade)
assert len(fade_stops) == FADE_STOPS, \
    (f"页面背景柔化必须恰好 {FADE_STOPS} 个 stop"
     f"（{FADE_BLOCKS} 块覆盖 = 左 3 + 上 2 + 下 2），实际 {len(fade_stops)}: {fade_stops}")
for stop in fade_stops:
    assert stop.strip() in ("TechColor.background", "TechColor.background.opacity(0)"), \
        f"页面背景柔化只能渐变页底色本身，不得引入第二种颜色: {stop}"

for name, rgb in {
    "background": (11, 12, 13), "paper": (21, 23, 25), "elevated": (32, 35, 38),
    "grid": (52, 56, 61), "ink": (247, 248, 243), "cyan": (196, 255, 0),
    "action": (196, 255, 0), "actionInk": (11, 12, 13),
    "yellow": (242, 198, 109), "coral": (255, 140, 152), "blue": (139, 190, 255),
}.items():
    r, g, b = rgb
    assert f"static let {name} = Color(red: {r}/255, green: {g}/255, blue: {b}/255)" in theme, \
        f"Athletic color contract changed: {name}"
assert ".toolbarColorScheme(.dark, for: .navigationBar)" in theme
layout = source(skin / "TechLayout.swift")
assert "enum TechFontRole" in layout and "func techFont(_ role: TechFontRole)" in layout
assert "ScaledMetric(wrappedValue: size, relativeTo: relativeTo)" in layout
assert "content.font(.system(size: size, weight: weight))" in layout, "Keep scaled system fonts"
for role in ["display", "hero", "metric", "compactMetric", "pageTitle", "section", "label"]:
    assert f"case .{role}: return" in layout, f"Missing typography role: {role}"
for name, value in {"pageHorizontal": 20, "pageVertical": 16, "bottomClearance": 24,
                    "sectionSpacing": 16, "panelPadding": 16, "border": 1,
                    "smallBorder": 1, "shadow": 0}.items():
    assert f"static let {name}: CGFloat = {value}\n" in theme, f"Layout metric changed: {name}"
for boundary in [".frame(maxWidth: .infinity, minHeight: 50)",
                 ".frame(width: 44, height: 44)", ".frame(height: 25)",
                 ".frame(maxWidth: .infinity, minHeight: 48)"]:
    assert boundary in theme, f"Control layout boundary lost: {boundary}"
assert "ForEach(NativeTab.allCases" in theme and "Button { selection = tab }" in theme
assert ".disabled(isDisabled || isBusy)" in theme

assert "static let corner: CGFloat = 8" in theme
assert "struct TechSurfaceShape: InsettableShape" in surfaces
assert "RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)" in surfaces
assert ".inset(by: insetAmount)" in surfaces and ".path(in: rect)" in surfaces
assert "shape.insetAmount += amount" in surfaces
assert "UIGraphicsImageRenderer" not in surfaces + theme, "Keep symbols in their native vector form"
assert "Image(systemName: systemName)" in theme
icon_button = theme.split("struct TechIconButton", 1)[1].split("struct TechPrimaryButton", 1)[0]
assert ".accessibilityLabel(accessibilityLabel)" in icon_button
assert r"@Environment(\.isEnabled) private var isEnabled" in icon_button
assert ".foregroundStyle(isEnabled ? color : TechColor.muted)" in icon_button
assert ".accessibilityIdentifier(\"tab.\\(tab.title)\")" in theme
assert ".accessibilityAddTraits(selection == tab ? .isSelected : [])" in theme
assert not (skin / "TechPixelStyle.swift").exists(), "Retire the pixel drawing implementation"
for label, text in [("TechIllustrations.swift", illustrations), ("TechCharts.swift", charts)]:
    assert "dash: [4, 2]" not in text, f"{label}: progress rings must be continuous"
    # 弱存在性判据：只保证这两个文件里确实用过 round cap。
    # 实测边界（2026-10-05）：摘掉某一处 trim 弧的 cap、或**整条删掉一个进度环**都不会红 ——
    # 它挡不住"少画一个环"，只挡得住"round cap 用法被整体移除"。别把它当强判据。
    assert "lineCap: .round" in text, f"{label}: trimmed arcs must use a round cap"
    # 强判据：完整圆环（`Circle().stroke` 且**不含** `.trim(`）不得带 `StrokeStyle`。
    # 闭合子路径会忽略 `lineCap`，而弱判据会反过来驱动实现给它补一个（2026-10-05 实测）。
    # 逐行判定：`TechAbilityGauge` 把 `StrokeStyle` 提成了预定义变量，按次数配对会误伤。
    for line in text.splitlines():
        if "Circle().stroke(" in line and "style: StrokeStyle(" in line:
            assert "trim" in line, f"{label}: 完整轨道环不该带 StrokeStyle/lineCap — {line.strip()}"
assert "let cell" not in illustrations and "floor(" not in illustrations
assert "path.addCurve(" in illustrations and "path.addQuadCurve(" in illustrations
assert ".frame(height: 150).accessibilityHidden(true)" in illustrations
assert ".clipped().allowsHitTesting(false).accessibilityHidden(true)" in illustrations
assert "context.stroke(line," in illustrations and "line.addLines(points)" in illustrations
shoe = illustrations.split("struct TechShoeIllustration", 1)[1].split("struct TechRaceLandscape", 1)[0]
landscape = illustrations.split("struct TechRunningLandscape", 1)[1].split("struct TechTodayHeader", 1)[0]
for label, text in [("Shoe", shoe), ("Landscape", landscape)]:
    assert "TechColor.action" not in text and "TechColor.cyan" not in text, \
        f"{label}: keep Volt for actions/current data, not decorative fills"

progress = theme.split("struct TechProgressBar", 1)[1].split("struct TechStatLine", 1)[0]
assert "guard let fraction, fraction.isFinite else { return nil }" in progress
assert "return min(max(fraction, 0), 1)" in progress
assert ".frame(width: proxy.size.width * clamped)" in progress
assert progress.count("Capsule().fill(") == 2
assert ".animation(reduceMotion ? nil" in progress
assert ".accessibilityValue(nativePercent(clamped))" in progress
recovery = source(skin / "TechTodayRecovery.swift")
ruler = recovery.split("struct TechTodayAbilityRuler", 1)[1]
assert "guard let score, score.isFinite else { return nil }" in ruler
assert "return min(max(score / 100, 0), 1)" in ruler
assert "if let fraction {" in ruler and ruler.count("Capsule().fill(") == 2
for boundary in [".frame(width: width * fraction, height: 5)",
                 ".frame(width: 7, height: 7)", ".frame(height: 18)",
                 "ForEach(0..<11)", "width * fraction - 3.5"]:
    assert boundary in ruler, f"Ability ruler layout or measurement changed: {boundary}"
plan = source(skin / "TechPlanView.swift")
assert ".contentShape(RoundedRectangle(cornerRadius: 9))" in plan, "Plan hit area must not change"
assert "map.isScrollEnabled = false" in route and "map.isZoomEnabled = false" in route
assert "mapInteractive" in route and "applyGesturePolicy()" in route
assert "GCJ02.fromWGS84" in route
assert "static let storageKey" not in theme, "Do not introduce a second skin or theme preference"
coach = source(skin / "TechRunCoachView.swift")
timeline = coach.split("private struct TechCoachWeekTimeline", 1)[1].split("private struct TechCoachTrainingDays", 1)[0]
assert "@ScaledMetric(relativeTo: .caption) private var cardWidth" in timeline
assert "@ScaledMetric(relativeTo: .title3) private var iconHeight" in timeline
assert ".frame(width: min(cardWidth, 260), alignment: .topLeading)" in timeline
assert ".frame(minHeight: 140, alignment: .topLeading)" in timeline, \
    "Week cards must grow vertically rather than clip accessibility text at 140pt"
assert ".frame(height: iconHeight)" in timeline, "Scaled symbols must reserve their full height"
assert not re.search(r"\.frame\([^)]*\bheight:\s*140\b", timeline), \
    "A fixed-height frame would undo the week-card accessibility reflow"
assert timeline.count(".fixedSize(horizontal: false, vertical: true)") >= 5, \
    "Weekday, date, title, distance and stack must retain their full text height"
assert '"coach.week-day.\\(day.localDate)"' in timeline, "Keep individually testable day controls"
ring = coach.split("private struct TechRingProgress", 1)[1].split("private struct TechCoachDaySheet", 1)[0]
assert ".frame(width: 76, height: 76)" in ring, "Do not enlarge the coach's original ring"
assert ring.count(".lineLimit(1).minimumScaleFactor(0.25)") == 2, \
    "Both ring texts must fit their original graphic slot at accessibility sizes"
assert ".accessibilityLabel(label)" in ring and ".accessibilityValue(value)" in ring, \
    "Font fitting must not change or shorten the original spoken metric"
assert "guard let fraction, fraction.isFinite else { return nil }" in ring
assert "return min(1, max(0, fraction))" in ring
assert ".animation(reduceMotion ? nil" in ring
print("Athletic skin: dark surfaces/night maps, scaled type roles, native symbols, original layout and progress semantics passed")
