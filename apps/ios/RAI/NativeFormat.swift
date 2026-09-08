import Foundation
import SwiftUI

func nativeKilometers(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "--" }
    return String(format: "%.1f km", value)
}

func nativeNumber(_ value: Double?, digits: Int = 1) -> String {
    guard let value, value.isFinite else { return "--" }
    return String(format: "%.*f", digits, value)
}

func nativeDuration(_ seconds: Double?) -> String {
    guard let seconds, seconds.isFinite else { return "--" }
    let total = max(0, Int(seconds.rounded()))
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    if hours > 0 { return "\(hours)小时 \(minutes)分" }
    return "\(minutes)分"
}

func nativePace(_ secondsPerKm: Double?) -> String {
    guard let secondsPerKm, secondsPerKm.isFinite, secondsPerKm > 0 else { return "--" }
    let total = max(0, Int(secondsPerKm.rounded()))
    return String(format: "%d' %02d\"/km", total / 60, total % 60)
}

func nativePercent(_ fraction: Double?, digits: Int = 0) -> String {
    guard let fraction, fraction.isFinite else { return "--" }
    return String(format: "%.*f%%", digits, fraction * 100)
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
    String(value.suffix(5)).replacingOccurrences(of: "-", with: "/")
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

func nativeToneColor(_ tone: String) -> Color {
    switch tone {
    case "green", "positive": return .green
    case "red", "warning": return .red
    default: return .orange
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
    default: return value ?? "--"
    }
}
