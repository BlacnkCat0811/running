import Foundation
import SwiftUI

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

func nativePace(_ secondsPerKm: Double?) -> String {
    guard let secondsPerKm, secondsPerKm.isFinite, secondsPerKm > 0 else { return "--" }
    let total = max(0, Int(secondsPerKm.rounded()))
    return String(format: "%d' %02d\"/km", locale: Locale(identifier: "en_US_POSIX"), total / 60, total % 60)
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
    formatter.dateFormat = "M月d日 HH:mm"
    return formatter.string(from: date)
}

func nativeDay(_ value: String) -> String {
    guard value.count >= 5 else { return value }
    return String(value.suffix(5)).replacingOccurrences(of: "-", with: "/")
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

func nativeHeartRateZoneColor(_ value: String) -> Color {
    switch nativeHeartRateZoneKey(value) {
    case "anaerobic": return PixelColor.coral
    case "lactate_threshold": return PixelColor.yellow
    case "aerobic_power": return PixelColor.green
    case "aerobic_base": return PixelColor.leaf
    case "recovery": return PixelColor.grid
    default: return PixelColor.grid
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

func nativeToneColor(_ tone: String) -> Color {
    switch tone {
    case "green", "positive", "recovered", "ready": return PixelColor.green
    case "red", "warning", "stale", "injury": return PixelColor.coral
    case "blue", "info": return PixelColor.cyan
    case "yellow", "caution", "insufficient": return PixelColor.yellow
    default: return PixelColor.yellow
    }
}

func nativeStatusName(_ value: String?) -> String {
    switch value {
    case "eligible": return "纳入分析"
    case "trial": return "观察中"
    case "excluded": return "已排除"
    case "completed": return "已完成"
    case "stale": return "数据过期"
    case "valid": return "数据有效"
    case "ready": return "已校准"
    case "insufficient": return "数据不足"
    case "recovered": return "恢复良好"
    case "fatigued": return "需要恢复"
    case "pending": return "等待处理"
    default: return value ?? "--"
    }
}
