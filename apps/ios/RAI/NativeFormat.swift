import Foundation

func nativeKilometers(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "--" }
    return String(format: "%.1f km", locale: Locale(identifier: "en_US_POSIX"), value)
}

func nativeNumber(_ value: Double?, digits: Int = 1) -> String {
    guard let value, value.isFinite else { return "--" }
    return String(format: "%.*f", locale: Locale(identifier: "en_US_POSIX"), digits, value)
}

func nativeDuration(_ seconds: Double?) -> String {
    guard let seconds, seconds.isFinite else { return "--" }
    let total = max(0, Int(seconds.rounded()))
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    if hours > 0 { return "\(hours)小时 \(minutes)分" }
    if minutes == 0 { return "\(total)秒" }
    return "\(minutes)分"
}

func nativeHoursMinutes(_ minutes: Double?) -> String {
    guard let minutes, minutes.isFinite else { return "无记录" }
    let total = max(0, Int(minutes.rounded()))
    let hours = total / 60
    let remainder = total % 60
    if hours > 0 { return "\(hours)小时\(remainder)分钟" }
    return "\(remainder)分钟"
}

func nativePace(_ secondsPerKm: Double?) -> String {
    guard let secondsPerKm, secondsPerKm.isFinite, secondsPerKm > 0 else { return "--" }
    let total = max(0, Int(secondsPerKm.rounded()))
    // Keep the value unitless so callers can place "/km" once, either inline
    // or in a metric tile's dedicated unit label.
    return String(format: "%d' %02d\"", locale: Locale(identifier: "en_US_POSIX"), total / 60, total % 60)
}

func nativePercent(_ fraction: Double?, digits: Int = 0) -> String {
    guard let fraction, fraction.isFinite else { return "--" }
    return String(format: "%.*f%%", locale: Locale(identifier: "en_US_POSIX"), digits, fraction * 100)
}

func nativeSigned(_ value: Double?, digits: Int = 1) -> String {
    guard let value, value.isFinite else { return "--" }
    let prefix = value > 0 ? "+" : ""
    return "\(prefix)\(nativeNumber(value, digits: digits))"
}

func nativeSignedPercent(_ value: Double?, digits: Int = 0) -> String {
    guard let value, value.isFinite else { return "--" }
    let prefix = value > 0 ? "+" : ""
    return "\(prefix)\(nativePercent(value, digits: digits))"
}

func nativeDate(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "--" }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    guard let date else { return String(value.prefix(10)) }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "yyyy年M月d日 HH:mm"
    return formatter.string(from: date)
}

func nativeDay(_ value: String) -> String {
    guard !value.isEmpty else { return "--" }

    // Trend assessment dates can be workout timestamps
    // (for example, 2026-09-02T01:00:00.000Z), not just YYYY-MM-DD.
    // Taking the last five characters of an ISO timestamp renders ".000Z".
    let datePart = String(value.prefix(10))
    let components = datePart.split(separator: "-")
    guard components.count == 3,
          components[0].count == 4,
          let month = Int(components[1]),
          let day = Int(components[2]),
          (1...12).contains(month),
          (1...31).contains(day) else {
        return String(value.prefix(min(value.count, 10)))
    }
    return "\(month)月\(day)日"
}

func nativeWeekday(_ value: String) -> String {
    guard value.count >= 10 else { return value }
    let date = String(value.prefix(10))
    let parser = DateFormatter()
    parser.locale = Locale(identifier: "en_US_POSIX")
    parser.dateFormat = "yyyy-MM-dd"
    guard let parsed = parser.date(from: date) else { return nativeDay(value) }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "EEE"
    return formatter.string(from: parsed)
}

func nativeShortWeek(_ value: String) -> String {
    guard value.count >= 10 else { return value }
    let date = String(value.prefix(10))
    let parser = DateFormatter()
    parser.locale = Locale(identifier: "en_US_POSIX")
    parser.dateFormat = "yyyy-MM-dd"
    guard let parsed = parser.date(from: date) else { return nativeDay(value) }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "'W'ww"
    return formatter.string(from: parsed)
}

func nativeSessionName(_ value: String) -> String {
    switch value {
    case "easy": return "轻松跑"
    case "steady": return "稳态跑"
    case "tempo": return "节奏跑"
    case "interval": return "间歇跑"
    case "long_run": return "长距离"
    case "race": return "比赛"
    case "recovery": return "恢复跑"
    case "rest": return "休息"
    case "completed": return "已完成"
    default: return value.isEmpty ? "未知训练" : value
    }
}

/// SF Symbol for a session type.
///
/// 只返回符号名，按皮肤无关的方式表达训练类型；`TechIconBox` 决定它的颜色与底。
/// 2026-09-18 从 `PixelIcons.swift` 迁来 —— 那个文件整体属像素皮肤，已删除。
func nativeSessionSymbol(_ value: String, indoor: Bool = false) -> String {
    if indoor { return "figure.run.circle.fill" }
    switch value {
    case "easy", "recovery": return "figure.run"
    case "steady": return "figure.walk.motion"
    case "tempo": return "speedometer"
    case "interval": return "bolt.fill"
    case "long_run": return "figure.run.circle"
    case "race": return "flag.fill"
    case "rest": return "bed.double.fill"
    default: return "figure.run"
    }
}

/// The dose a segment asked for.
///
/// "无目标" is a real answer: a Watch lap and the trailing stretch no plan step
/// covered carry no prescription, and inventing one would be a lie.
func nativeSegmentDose(_ segment: WorkoutSegment) -> String {
    switch segment.goalType {
    case "distance": return segment.goalMeters.map { "目标 \(nativeNumber($0, digits: 0)) m" } ?? "目标距离"
    case "time": return segment.goalSeconds.map { "目标 \(nativeDuration($0))" } ?? "目标时长"
    case "open": return "自由"
    default: return "无目标"
    }
}

/// The alert the watch was told to enforce — the plan's intent, not the outcome.
func nativeSegmentAlert(_ segment: WorkoutSegment) -> String? {
    guard let kind = segment.alertKind else { return nil }
    if kind == "pace", [segment.alertLower, segment.alertUpper].contains(where: { value in
        guard let value else { return false }
        return !value.isFinite || value < 120 || value > WorkoutPlanMapper.maxPaceSecondsPerKm
    }) { return "配速目标异常" }
    let unit = kind == "pace" ? "/km" : " bpm"
    func format(_ value: Double?) -> String? {
        guard let value else { return nil }
        return kind == "pace" ? nativePace(value) : nativeNumber(value, digits: 0)
    }
    let bounds = [segment.alertLower, segment.alertUpper].compactMap { $0 }.sorted()
    let lower = format(bounds.count == 2 ? bounds.first : segment.alertLower)
    let upper = format(bounds.count == 2 ? bounds.last : segment.alertUpper)
    if let lower, let upper { return "提醒 \(lower)–\(upper)\(unit)" }
    if let upper { return "提醒 ≤ \(upper)\(unit)" }
    if let lower { return "提醒 ≥ \(lower)\(unit)" }
    return kind == "pace" ? "配速提醒" : "心率提醒"
}

/// One readable line of a structured prescription.
///
/// Both plan pages render the same stored week, so the breakdown a day opens
/// into has to be produced once: two hand-written formatters would eventually
/// describe the same session differently depending on which screen was open.
struct NativeStructureLine: Identifiable {
    let id: Int
    let title: String
    let detail: String
}

/// Flattens warmup / interval blocks / cooldown into displayable lines.
///
/// `nil` (or an empty structure) yields no lines rather than a fake one: rest
/// days and days whose prescription was never built must be describable as
/// "没有结构化处方" by the caller instead of showing an invented workout.
func nativeStructureLines(_ structure: MobileSessionStructure?) -> [NativeStructureLine] {
    guard let structure else { return [] }
    var lines: [NativeStructureLine] = []
    func append(_ title: String, _ step: MobileWorkoutStep) {
        lines.append(NativeStructureLine(id: lines.count, title: title, detail: nativeStepDetail(step)))
    }
    if let warmup = structure.warmup { append("热身", warmup) }
    for block in structure.blocks {
        let sets = max(1, block.iterations)
        for (index, step) in block.steps.enumerated() {
            // Intent comes from the step, not from its position: a block may
            // open with a recovery step, and calling that "主训练" would invert
            // exactly the part of the prescription a runner reads first.
            let base = step.purpose == "recovery" ? "恢复" : (index == 0 ? "主训练" : "训练")
            append(sets > 1 ? "\(base) × \(sets)" : base, step)
        }
    }
    if let cooldown = structure.cooldown { append("放松", cooldown) }
    return lines
}

/// Goal plus intensity for one step, e.g. `800 m · 配速 4'00"–4'25"/km`.
func nativeStepDetail(_ step: MobileWorkoutStep) -> String {
    [nativeStepGoalText(step.goal), nativeStepAlertText(step.alert)]
        .compactMap { $0 }
        .joined(separator: " · ")
}

func nativeStepGoalText(_ goal: MobileStepGoal) -> String {
    switch goal {
    case let .distance(meters):
        guard meters.isFinite, meters > 0 else { return "按距离跑" }
        return meters >= 1_000
            ? String(format: "%.1f km", locale: Locale(identifier: "en_US_POSIX"), meters / 1_000)
            : String(format: "%.0f m", locale: Locale(identifier: "en_US_POSIX"), meters)
    case let .time(seconds):
        guard seconds.isFinite, seconds > 0 else { return "按时间跑" }
        if seconds >= 60 {
            return String(format: "%.0f 分钟", locale: Locale(identifier: "en_US_POSIX"), seconds / 60)
        }
        return String(format: "%.0f 秒", locale: Locale(identifier: "en_US_POSIX"), seconds)
    case .open:
        return "按感觉跑"
    }
}

/// The intensity band, or nil when the step carries none — a step with no
/// target is legitimately "just run" and must not be padded with a fake range.
func nativeStepAlertText(_ alert: MobileStepAlert?) -> String? {
    guard let alert, alert.isUsable else { return nil }
    // `nativePace` keeps a space between the minute and second marks so a caller
    // can place "/km" once; inside a step line that space only widens the row.
    func pace(_ seconds: Double) -> String {
        nativePace(seconds).replacingOccurrences(of: " ", with: "")
    }
    switch alert.kind {
    case "pace":
        switch (alert.lower, alert.upper) {
        case let (lower?, upper?):
            return "配速 \(pace(min(lower, upper)))–\(pace(max(lower, upper)))/km"
        case let (lower?, nil):
            return "配速 \(pace(lower))/km 或更慢"
        case let (nil, upper?):
            return "配速 \(pace(upper))/km 或更快"
        default:
            return nil
        }
    case "heart_rate":
        switch (alert.lower, alert.upper) {
        case let (lower?, upper?):
            return "心率 \(nativeNumber(min(lower, upper), digits: 0))–\(nativeNumber(max(lower, upper), digits: 0)) bpm"
        case let (lower?, nil):
            return "心率 \(nativeNumber(lower, digits: 0)) bpm 以上"
        case let (nil, upper?):
            return "心率 \(nativeNumber(upper, digits: 0)) bpm 以下"
        default:
            return nil
        }
    default:
        return nil
    }
}

func nativeStimulusName(_ value: String) -> String {
    switch value {
    case "aerobic_base": return "有氧基础"
    case "marathon_pace": return "马拉松配速"
    case "lactate_threshold": return "乳酸阈值"
    case "vo2max": return "最大摄氧"
    case "anaerobic_endurance": return "无氧耐力"
    case "recovery": return "恢复"
    default: return value.isEmpty ? "未分类" : value
    }
}

// 闭集契约（TS 里的联合类型）的展示映射现在只住在科技皮肤：
// `techPhaseName` / `techStimulusMatchName` / `techRaceDistanceName`
// （`Skins/Technology/TechEnumPresentation.swift`），由
// `run-tech-presentation-tests.sh` 对着契约逐值断言。原生像素皮肤那三份副本随皮肤
// 一并删除（2026-09-18）。
// 与 `nativeSessionName` / `nativeStimulusName` 的 default 直出不同：那两个的输入契约
// 是开放 string，原值本身可能就是有意义的业务标签，直出不算说谎；闭集映射必须穷举，
// 否则 `half_marathon` 这类机器码会漏到界面上。策略同 `nativeHeartRateZone` 的 default
// （该函数同样拒绝直出英文原值）。
func nativeHeartRateZone(_ value: String) -> String {
    switch nativeHeartRateZoneKey(value) {
    case "recovery": return "恢复区"
    case "aerobic_base": return "有氧基础区"
    case "aerobic_power": return "有氧动力区"
    case "lactate_threshold": return "乳酸阈值区"
    case "anaerobic": return "无氧区间"
    default:
        // API 重建或升级期间可能返回新的非标准值，避免把英文原值直接展示给用户。
        return value.range(of: #"[A-Za-z]"#, options: .regularExpression) != nil ? "心率区间" : value
    }
}

private func nativeHeartRateZoneKey(_ value: String) -> String {
    let normalized = value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "_", with: "")
        .replacingOccurrences(of: "-", with: "")
        .replacingOccurrences(of: " ", with: "")

    switch normalized {
    case "recovery", "warmup", "zone1", "z1", "恢复", "恢复区", "热身":
        return "recovery"
    case "aerobicbase", "fatburn", "zone2", "z2", "有氧基础", "有氧基础区", "燃脂", "燃脂区":
        return "aerobic_base"
    case "aerobicpower", "zone3", "z3", "有氧动力", "有氧动力区", "有氧":
        return "aerobic_power"
    case "lactatethreshold", "threshold", "zone4", "z4", "乳酸阈值", "乳酸阈值区", "阈值":
        return "lactate_threshold"
    case "anaerobic", "zone5", "z5", "无氧", "无氧区间":
        return "anaerobic"
    default:
        return value
    }
}

func nativeStatusName(_ value: String?) -> String {
    switch value {
    case "eligible": return "纳入分析"
    case "trial": return "观察中"
    case "excluded": return "已排除"
    case "completed": return "已完成"
    case "not_started": return "尚未开始"
    case "calibrating": return "校准中"
    case "stale": return "数据过期"
    case "valid": return "数据有效"
    case "ready": return "已校准"
    case "insufficient": return "数据不足"
    case "recovered", "recovered_phys": return "恢复良好"
    case "reduced": return "恢复不足"
    case "depleted": return "需要休息"
    case "fatigued": return "需要恢复"
    case "pending": return "等待处理"
    case "recovery": return "恢复"
    case "recovering": return "恢复中"
    default: return value ?? "--"
    }
}

// `calibrationNeedsAttention(_:)` 已移到 `CalibrationState.swift`：那边是纯
// Foundation，能被 `run-model-tests.sh` 在 macOS 上编译并钉住；本文件当时依赖
// `PixelColor`（iOS 专属），判据留在这里就永远进不了秒级闸门。
// 2026-09-18 删除像素皮肤后本文件已无 iOS 专属依赖（不再 `import SwiftUI`），
// 因此**本文件自身**也进了同一扇闸门 —— 见 `run-model-tests.sh` 的编译列表。

/// A blank pace is intentional; malformed/out-of-range values must never become nil silently.
enum NativeRaceGoalDraft {
    static func paceSeconds(_ text: String) -> Double? {
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].count == 2,
              parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
              let minutes = Double(parts[0]), let seconds = Double(parts[1]), seconds < 60 else { return nil }
        let value = minutes * 60 + seconds
        return (150...900).contains(value) ? value : nil
    }

    static func isValidPace(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || paceSeconds(text) != nil
    }

    static var dateFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }
}
