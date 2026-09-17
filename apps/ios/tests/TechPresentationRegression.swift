import Foundation

@main
struct TechPresentationRegression {
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message)
            checks += 1
        }
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
        print("Technology presentation: \(checks) checks passed")
        print(String(format: "50,000 points preparation: %.2f ms/run (host microbenchmark without -O, not device FPS)",
                     Date().timeIntervalSince(start) * 100))
    }
}
