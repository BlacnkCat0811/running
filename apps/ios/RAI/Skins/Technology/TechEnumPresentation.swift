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

/// `MobilePlanExecutionDay.status` = observed | pending | unknown
///
/// 契约注释把语义写死了：这是**历史观测**，不是完成度/依从性评分（"Missing imports remain
/// pending"）—— 所以文案只说服务端收到了什么，不说用户做没做到（"未导入" ≠ "未完成"）。
/// 生产者：`apps/api/src/plan-execution.ts:37`
/// （`workoutCount > 0 ? "observed" : planned ? "pending" : "unknown"`）。
///
/// 闭集在 Swift 侧只声明一次（就是这个枚举）：视图按它给状态胶囊配色，而那个 switch
/// **没有 `default`**，所以枚举少一个取值编译不过。此前它在视图里是三份平行 switch，文案
/// 那份的 `default` 是「缺少计划快照」—— 契约多一个取值就编译通过、回归全绿，用户却看到
/// 一句自信的错话（"这份计划没有快照"，而它可能恰恰有）。与 `techSyncPhase` 的
/// `default: "等待同步"` 同一个形状（那次 SyncPhase 事故记在
/// `apps/ios/tests/run-tech-presentation-tests.sh` 里）。
///
/// ⚠️ "枚举少一个 ⇒ 编译不过"只在**枚举与契约配平**时成立，配平由闸门钉住：同一脚本的穷举表
/// 比对的是从 `packages/api-contracts` 解析出来的取值，不是脚本里手抄的一份清单 ——
/// 手抄的那份不随契约变，会让穷举表与枚举对账一起对着过期清单配平、双双变绿。
enum TechPlanExecutionStatus: String {
    case observed
    case pending
    case unknown
}

/// `MobilePlanExecutionDay.status` 的文案：唯一来源（闸门 `mapped_cases` 逐值对账）。
///
/// `default` 是**域外取值**（契约新增、本端还没跟上）：它只许说"本端不认识这个取值"，
/// 不许借一句域内的话 —— 借来的那句会在某个真实取值上变成假话。
func techPlanExecutionStatusName(_ value: String) -> String {
    switch value {
    case "observed": return "已记录训练"
    case "pending": return "等待数据"
    case "unknown": return "缺少计划快照"
    default: return "未知状态"
    }
}

/// 训练感受的一个档位。
struct TechEffortOption: Equatable {
    /// 契约接受的 `rpe` 整数（1–10）。
    let value: Int
    /// 用户直接点选的词。
    let label: String
}

/// 训练感受：契约里 `rpe`（1–10 的整数）的**展示切面**。
///
/// 为什么不是自由数字输入：用户要回答的是"这次跑得有多累"，不是量表读数。1–10 得先知道
/// 量表定义才能填，填出来的数字因人而异（2026-10-01 可用性反馈："不适合用户反馈"）。
///
/// 但**服务端读的仍是数字**，所以档位不是可以另立的一套枚举：
/// - `packages/application/src/service.ts:149` 只接受 1–10 的整数，0/11/小数直接拒收；
/// - `packages/training-zones/src/index.ts:932` 用 `RPE_INTENSITY[round(rpe)]` 折算内部负荷；
/// - `packages/application/src/prediction-data.ts:150` 把 `rpe >= 9` 当成"这跑得很吃力"的证据。
///
/// 于是三条硬约束（前两条的断言在 `apps/ios/tests/TechPresentationRegression.swift`）：档位值必须
/// 落在 1–10、必须单调、**只有最高档跨过 `rpe >= 9`** —— 否则用户选了"最累"却拿不到
/// hard_workout 证据，界面说什么都不会报错。
///
/// 🔴 第三条是这张表的**决定**，不是剩下的巧合：五个档位里只有"极限"(10) 会走进 hard_workout
/// 分支，"很累"(8) 什么都不产生；而 9 与 10 产出的是**同一条**证据（quality 均 0.55），
/// 差别只在 `RPE_INTENSITY`（8→0.76、9→0.84、10→0.90）。让出去的是 8 与 10 之间那一格负荷
/// 精度，不是证据供给；换来的是词与阈值第一次对齐 —— 旧路径（1–10 数字输入）能存下一个
/// 界面读作"很累"（`label(for: 9)`）、模型却当成接近极限的 9。
///
/// 不去改档位值凑阈值：顶档改 9（或整表下移）会让同一个词在改版前后写入不同的数，而界面
/// 零变化；在 8 与 10 之间插一档 9，则要给 9 起一个与"很累""极限"都分得开的词，而"接近
/// 极限 vs 极限"恰是这张量表上最不可靠的一次区分 —— 一次点击就决定要不要产出证据。
///
/// 阈值在 iOS 侧**不留副本**：唯一来源是 `packages/application/src/prediction-data.ts:150`，
/// 由 `apps/ios/tests/run-tech-presentation-tests.sh` 从 TS 源码解析后与下表逐值对账。
/// 在这里（或测试里）写一个字面量 9，对账就会在模型侧改成 8 之后变成"对着副本自证"。
/// Web 端今天仍可直接写 9，所以旧值照旧要能读。
enum TechEffortScale {
    /// 五档覆盖 1–10 的代表点，取的是契约本身接受的整数，不是新造的量表。
    static let options: [TechEffortOption] = [
        TechEffortOption(value: 2, label: "轻松"),
        TechEffortOption(value: 4, label: "稍微累"),
        TechEffortOption(value: 6, label: "累"),
        TechEffortOption(value: 8, label: "很累"),
        TechEffortOption(value: 10, label: "极限"),
    ]

    /// 档位里**恰好等于**该值的选项。旧数据里那些非档位取值（1/3/5/7/9）返回 `nil` ——
    /// 调用方据此提示"当前记录 7"，而不是把它显示成"很累"、再在用户没动它的时候悄悄改成 8。
    static func option(for value: Int) -> TechEffortOption? {
        options.first { $0.value == value }
    }

    /// 任意合法取值都能读成一句人话：取最接近的档位。等距时取较小的一档 ——
    /// 宁可说得轻一点，不替用户加码。
    static func label(for value: Int) -> String {
        var best = options[0]
        var bestDistance = Int.max
        for option in options {
            let distance = abs(option.value - value)
            if distance < bestDistance { bestDistance = distance; best = option }
        }
        return best.label
    }
}
