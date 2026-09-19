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
/// 比落机器码更早暴露问题。（2026-09-18 删除像素皮肤后这里成了唯一的展示映射；
/// 契约改枚举时只需同步本文件，闸门会逐值断言。）

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

/// `MobileSyncStatus.status` = never | ok | failed
///
/// 与「睡眠日期」无关的刷新结果。刻意不复用 `nativeStatusName(_:)`：那边的
/// `stale` 映射是"数据过期"，而这里要表达的恰恰是"刷新有没有跑成"，
/// 两者混淆正是这一轮要修掉的缺陷。
func techSyncStatusName(_ value: String) -> String {
    switch value {
    case "never": return "尚未同步"
    case "ok": return "正常"
    case "failed": return "同步失败"
    default: return "未知同步状态"
    }
}

/// `MobileCoverageMetric.state` = none | historical | current
func techCoverageStateName(_ value: String) -> String {
    switch value {
    case "none": return "无记录"
    case "historical": return "更早的记录"
    case "current": return "已记录"
    default: return "未知覆盖"
    }
}

/// `MobileRecoveryAssessment.coverage` = none | partial | complete
func techRecoveryCoverageName(_ value: String) -> String {
    switch value {
    case "none": return "未监测"
    case "partial": return "部分监测"
    case "complete": return "已监测"
    default: return "未知覆盖"
    }
}

/// `MobileRecoveryAssessment.assessment` = not_assessed | no_low_signal |
/// low_signal | multiple_low_signals
func techRecoveryAssessmentName(_ value: String) -> String {
    switch value {
    case "not_assessed": return "未评估"
    case "no_low_signal": return "未见异常"
    case "low_signal": return "恢复信号偏低"
    case "multiple_low_signals": return "多项恢复信号偏低"
    default: return "未知评估"
    }
}

/// `MobileRecommendation.basis` = training_load_and_plan |
/// insufficient_training_history | high_load
func techRecommendationBasisName(_ value: String) -> String {
    switch value {
    case "training_load_and_plan": return "依据负荷与课表"
    case "insufficient_training_history": return "训练历史不足"
    case "high_load": return "负荷偏高"
    default: return "未知依据"
    }
}

/// `MobileRecommendation.recoveryAdjustment` = none | veto | no_evidence
func techRecoveryAdjustmentName(_ value: String) -> String {
    switch value {
    case "none": return "已结合今日恢复"
    case "veto": return "今日恢复已否决强度"
    case "no_evidence": return "未结合今日恢复"
    default: return "未知恢复处理"
    }
}
