import Foundation

@main
struct TechPresentationRegression {
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message)
            checks += 1
        }
        // Old servers and inferred plan replays must not expose a plan-execution panel.
        let emptyMetric: [String: Any] = ["unit": "bpm", "totalSamples": 0, "points": []]
        let metrics = Dictionary(uniqueKeysWithValues:
            ["heartRate", "speed", "power", "cadence", "elevation", "strideLength", "verticalOscillation", "groundContactTime"]
                .map { ($0, emptyMetric) })
        let segment: [String: Any] = ["index": 1, "label": "训练", "purpose": "work",
                                    "startOffsetSeconds": 0, "durationSeconds": 60, "distanceMeters": 200]
        var payload: [String: Any] = ["trainingSessionId": "test", "startedAt": "2026-09-18", "endedAt": "2026-09-18",
                                      "sourceCategory": "apple_health", "splits": [], "segments": [segment], "series": metrics]
        func decodeSeries() -> WorkoutSeriesResponse {
            try! JSONDecoder().decode(WorkoutSeriesResponse.self, from: JSONSerialization.data(withJSONObject: payload))
        }
        check(!decodeSeries().showsPlanSegments, "Legacy server has no structured-execution evidence")
        payload["hasMeasuredWorkoutSteps"] = false
        check(!decodeSeries().showsPlanSegments, "Replay/manual laps are not plan execution")
        payload["hasMeasuredWorkoutSteps"] = true
        check(decodeSeries().showsPlanSegments, "Measured workout steps show plan segments")
        payload["segments"] = []
        check(!decodeSeries().showsPlanSegments, "No empty plan panel")
        check(TechSyncPresentation.resolve(phase: "cancelled", isBusy: false, hasError: false, hasSyncDate: true) == .cancelled,
              "Previous success cannot mask cancellation")
        check(TechSyncPresentation.resolve(phase: "cancelled", isBusy: true, hasError: false, hasSyncDate: false) == .cancelled,
              "Show cancellation before deferred busy reset")
        check(TechSyncPresentation.resolve(phase: "failed", isBusy: false, hasError: false, hasSyncDate: true) == .failed,
              "Failure without a detailed message is not success")
        check(TechSyncPresentation.resolve(phase: "uploading", isBusy: true, hasError: false, hasSyncDate: true) == .busy,
              "Current operation wins over history")
        check(TechSyncPresentation.resolve(phase: "idle", isBusy: false, hasError: false, hasSyncDate: true) == .previousSuccess,
              "Restored history is labelled as history")
        check(TechSyncPresentation.resolve(phase: "succeeded", isBusy: false, hasError: false, hasSyncDate: true) == .succeeded,
              "Completed sync is clearly reported")
        check(TechSyncPresentation.resolve(phase: "idle", isBusy: false, hasError: false, hasSyncDate: false) == .hidden,
              "No operation does not fabricate status")
        // 「磁盘上还有一批没走完」必须压过历史。不加 `hasPendingTask` 时的可见后果：
        // 一次生命周期中断之后 `phase` 已回到 `idle`，而 `lastSyncAt` 是上次成功的时间，
        // 界面读起来像一切正常，实际却卡着一批没发出去的数据。
        check(TechSyncPresentation.resolve(phase: "idle", isBusy: false, hasError: false,
                                           hasSyncDate: true, hasPendingTask: true) == .pending,
              "A pending batch must not be reported as a previous success")
        check(TechSyncPresentation.resolve(phase: "exported", isBusy: false, hasError: false,
                                           hasSyncDate: true, hasPendingTask: true) == .pending,
              "A batch on disk with no upload in flight is pending, not history")
        check(TechSyncPresentation.resolve(phase: "uploaded", isBusy: false, hasError: false,
                                           hasSyncDate: true, hasPendingTask: true) == .pending,
              "A batch the server already holds is still pending until the import is started")
        // 优先级：中止 > 进行中 > 失败 > 有待办。反了会把"明确失败"降级成"不用管"，
        // 或把"正在跑"说成"卡住了"。
        check(TechSyncPresentation.resolve(phase: "cancelled", isBusy: false, hasError: false,
                                           hasSyncDate: true, hasPendingTask: true) == .cancelled,
              "Cancellation outranks a pending batch")
        check(TechSyncPresentation.resolve(phase: "uploading", isBusy: true, hasError: false,
                                           hasSyncDate: true, hasPendingTask: true) == .busy,
              "Running outranks a pending batch")
        check(TechSyncPresentation.resolve(phase: "failed", isBusy: false, hasError: false,
                                           hasSyncDate: true, hasPendingTask: true) == .failed,
              "A named failure outranks a pending batch")
        // 反向：`hasPendingTask == false` 时旧行为一个字都不许变（默认参数就是为此存在的）。
        check(TechSyncPresentation.resolve(phase: "idle", isBusy: false, hasError: false,
                                           hasSyncDate: true, hasPendingTask: false) == .previousSuccess,
              "Without a pending batch the history label is unchanged")
        check(TechPlotSampling.indices(values: []).isEmpty, "Empty is not a fabricated zero")
        check(TechPlotSampling.indices(values: [3]) == [0], "Single value is retained")
        check(TechPlotSampling.indices(values: [.nan, 2, .infinity, -3]) == [1, 3], "Non-finite samples are excluded")
        for limit in [4, 5, 32, 240, 360] {
            var values = (0..<50_000).map { sin(Double($0) * 0.07) * 30 + 120 }
            values[2711] = 999
            values[48000] = -999
            let sampled = TechPlotSampling.indices(values: values, limit: limit)
            check(sampled.count <= limit, "Bounded draw cost for \(limit)")
            check(sampled.first == 0 && sampled.last == values.count - 1, "Retain endpoints")
            check(sampled.contains(2711) && sampled.contains(48000), "Retain global peak and trough")
            check(sampled == sampled.sorted() && Set(sampled).count == sampled.count, "Stable unique identities")
        }
        let flat = TechPlotSampling.indices(values: Array(repeating: 1, count: 10000))
        check(flat.count <= 360 && flat.first == 0 && flat.last == 9999, "Constant series is bounded")
        let points = [
            MetricPoint(timestamp: "c", offsetSeconds: 3, value: 40),
            MetricPoint(timestamp: "a", offsetSeconds: 0, value: 10),
            MetricPoint(timestamp: "b", offsetSeconds: 1, value: 20),
            MetricPoint(timestamp: "b2", offsetSeconds: 1, value: 25),
            MetricPoint(timestamp: "invalid", offsetSeconds: -1, value: 90),
            MetricPoint(timestamp: "invalid", offsetSeconds: 2, value: .nan),
            MetricPoint(timestamp: "invalid", offsetSeconds: .infinity, value: 5)
        ]
        let data = TechSeriesData(points: points)
        check(data.points.map(\.offsetSeconds) == [0, 1, 3], "Sort and deduplicate display instants")
        check(data.points.map(\.value) == [10, 25, 40], "Last received duplicate wins")
        check(data.validCount == 3 && data.minimum == 10 && data.maximum == 40, "Summary from valid full input")
        check(points.count == 7 && points[2].value == 20, "Source samples never mutate")

        // 判定图标：契约 `MobileVerdictTone` 是闭集 {green, yellow, red}，这里用白名单 ——
        // 只有 green 才渲染"通过"，其余一律警示侧。换成黑名单（列出"坏值"）会把域外值
        // 渲染成对勾，与项目判据"未知一律归未知/拒绝，不许归通过"直接相悖。
        check(verdictIconName(tone: "green") == "checkmark.shield", "Only green is presented as passing")
        check(verdictIconName(tone: "yellow") == "exclamationmark.shield", "Yellow is an alert")
        check(verdictIconName(tone: "red") == "exclamationmark.shield", "Red is an alert")
        check(verdictIconName(tone: "orange") == "exclamationmark.shield", "Unknown tone fails closed, not open")
        check(verdictIconName(tone: "") == "exclamationmark.shield", "Empty tone is never a pass")

        let large = (0..<50_000).map { MetricPoint(timestamp: "\($0)", offsetSeconds: Double($0), value: Double($0 % 203)) }
        let start = Date()
        var prepared = TechSeriesData(points: [])
        for _ in 0..<10 { prepared = TechSeriesData(points: large) }
        check(prepared.points.count <= 360 && prepared.validCount == 50_000, "50k input bounded")

        // 训练感受档位 = 契约 `rpe`（1–10 整数）的展示切面，不是新枚举。
        // 下面四条是"档位仍能被服务端读懂"的前提：值域越界会被 `service.ts:149` 直接拒收，
        // 非单调会让两个词指向同一个强度，最高档 < 9 则用户选了"最累"却拿不到
        // `prediction-data.ts:150` 的 hard_workout 证据 —— 三种都不会让任何测试变红，
        // 只让界面和算法各说各话。
        let effortValues = TechEffortScale.options.map(\.value)
        check(effortValues == effortValues.sorted(), "Effort tiers must be monotone in rpe value")
        check(Set(effortValues).count == effortValues.count,
              "Two tiers sharing a value make their labels indistinguishable")
        check(effortValues.allSatisfy { (1...10).contains($0) },
              "Tier values must stay inside the contract's 1...10")
        check(effortValues.last == 10, "Picking the hardest tier must reach rpe 10")
        let effortLabels = TechEffortScale.options.map(\.label)
        check(Set(effortLabels).count == effortLabels.count && effortLabels.allSatisfy { !$0.isEmpty },
              "Tier labels must be non-empty and unique")
        check((1...10).allSatisfy { !TechEffortScale.label(for: $0).isEmpty },
              "Every legal rpe must render as a word, including off-tier legacy values")
        check(TechEffortScale.label(for: 1) == "轻松" && TechEffortScale.label(for: 10) == "极限",
              "The ends of 1...10 must read as words")
        check(TechEffortScale.label(for: 9) == "很累", "Every legal rpe renders as a word")
        check(TechEffortScale.label(for: 3) == "轻松",
              "A tie reads as the lighter tier rather than talking the user's effort up")
        check(TechEffortScale.option(for: 8)?.label == "很累",
              "A tier value resolves to its own label")
        check(TechEffortScale.option(for: 7) == nil,
              "An off-tier stored value must not be silently relabelled as a tier")

        print("Technology presentation: \(checks) checks passed")
        print(String(format: "50,000 points preparation: %.2f ms/run (host microbenchmark without -O, not device FPS)",
                     Date().timeIntervalSince(start) * 100))
    }
}
