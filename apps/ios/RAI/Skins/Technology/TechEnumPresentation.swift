/// 科技风：闭集枚举的展示名。
///
/// 这个文件刻意住在**纯 Foundation** 里（无 `SwiftUI`、无 `#if os(iOS)`），这样
/// `apps/ios/tests/run-tech-presentation-tests.sh` 能在 macOS 上编译并钉住它们。
/// 规则写在 `TechViews.swift` / `TechAbilityDetailView.swift` 里时没有任何通道能发现退化
/// —— 与 `CalibrationState.swift`、`PlanReceiptMatcher.swift`、`VerdictPresentation.swift`
/// 同一教训：判据存在不等于判据被执行。
///
/// 🔴 下列字段在 `packages/api-contracts` 里都是**闭集**联合类型
/// （`MobileDayPhase` / `MobileStimulusMatch` / `MobileRaceDistance`），所以这里不直出
/// 原始契约值：把 `need_sync`、`too_hard`、`half_marathon` 原样打到界面上，不是"保留
/// 细节"，是展示层没跟上契约。出现域外值意味着契约新增了枚举而这里没改，落「未知…」
/// 比落机器码更早暴露问题（像素风对应的 `native*Name` 走另一套策略：default 直出原值）。

/// `MobileDayPhase` = need_sync | morning_open | locked | post_run | rest_done
func techPhaseName(_ phase: String) -> String {
    switch phase {
    case "need_sync": return "待同步"
    case "morning_open": return "晨间开放"
    case "locked": return "已锁定"
    case "post_run": return "已训练"
    case "rest_done": return "休息日完成"
    default: return "未知阶段"
    }
}

/// `MobileStimulusMatch` = aligned | too_hard | too_easy | unknown
func techStimulusMatchName(_ value: String) -> String {
    switch value {
    case "aligned": return "匹配"
    case "too_hard": return "偏强"
    case "too_easy": return "偏弱"
    case "unknown": return "未知"
    default: return "未知"
    }
}

/// `MobileRaceDistance` = five_k | ten_k | half_marathon
func techRaceDistanceName(_ value: String) -> String {
    switch value {
    case "five_k": return "5 公里"
    case "ten_k": return "10 公里"
    case "half_marathon": return "半马"
    default: return "距离"
    }
}
