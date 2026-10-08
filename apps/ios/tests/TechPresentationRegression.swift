import CoreGraphics
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

        let selectionPoints = [0.0, 60, 120].map {
            MetricPoint(timestamp: "\($0)", offsetSeconds: $0, value: 150)
        }
        check(techSeriesSelectionTime(points: [], selectedTime: nil, direction: 1) == nil,
              "Empty charts have no accessible selection")
        check(techSeriesSelectionTime(points: selectionPoints, selectedTime: nil, direction: 1) == 0,
              "The first forward accessibility action selects the first point")
        check(techSeriesSelectionTime(points: selectionPoints, selectedTime: nil, direction: -1) == 2,
              "The first backward accessibility action selects the last point")
        check(techSeriesSelectionTime(points: selectionPoints, selectedTime: 0, direction: 1) == 1,
              "Accessibility moves one sample forward in minute coordinates")
        check(techSeriesSelectionTime(points: selectionPoints, selectedTime: 1, direction: -1) == 0,
              "Accessibility moves one sample backward")
        check(techSeriesSelectionTime(points: selectionPoints, selectedTime: 0.8, direction: 1) == 2,
              "Accessibility continues from the nearest tapped sample")
        check(techSeriesSelectionTime(points: selectionPoints, selectedTime: 0, direction: -1) == 0 &&
              techSeriesSelectionTime(points: selectionPoints, selectedTime: 2, direction: 1) == 2,
              "Accessible selection stays at the chart endpoints without wrapping")
        check(techSeriesSelectionTime(points: [selectionPoints[1]], selectedTime: nil, direction: -1) == 1 &&
              techSeriesSelectionTime(points: [selectionPoints[1]], selectedTime: 1, direction: 1) == 1,
              "Single-point charts remain accessible in both directions")
        check(techSeriesSelectionTime(points: selectionPoints, selectedTime: .nan, direction: 1) == 0,
              "Invalid selection time starts from a real sample")

        func stimulusSummary(_ type: String, scores: [StimulusScore]) -> WorkoutZoneSummary {
            WorkoutZoneSummary(trainingSessionId: "empty", zoneProfileId: "profile", stimulusType: type,
                secondaryStimulusTypes: [], stimulusConfidence: 0, heartRateCoverage: 0, paceCoverage: 0,
                heartRateExposure: [], paceExposure: [], stimulusScores: scores, explanationCodes: [])
        }
        let zeroScores = ["recovery", "aerobic_base", "marathon_pace", "lactate_threshold", "vo2max", "anaerobic_endurance"].map {
            StimulusScore(stimulusType: $0, qualifyingSeconds: 0, targetSeconds: 1800, score: 0, confidence: 0)
        }
        check(techWorkoutPrimaryStimulusScore(nil) == nil, "Missing stimulus data cannot invent a classification")
        check(techWorkoutPrimaryStimulusScore(stimulusSummary("unclassified", scores: zeroScores)) == nil,
              "Zero scores preserve the server's unclassified verdict")
        let recoveryScore = StimulusScore(stimulusType: "recovery", qualifyingSeconds: 1800,
            targetSeconds: 1800, score: 1, confidence: 1)
        let thresholdScore = StimulusScore(stimulusType: "lactate_threshold", qualifyingSeconds: 600,
            targetSeconds: 900, score: 0.67, confidence: 0.8)
        check(techWorkoutPrimaryStimulusScore(stimulusSummary("unclassified", scores: [recoveryScore])) == nil,
              "Even a positive score cannot override the server's unclassified verdict")
        check(techWorkoutPrimaryStimulusScore(stimulusSummary("lactate_threshold", scores: [recoveryScore, thresholdScore]))?.stimulusType == "lactate_threshold",
              "The primary stimulus is server-owned, not inferred from the highest score")
        check(techWorkoutPrimaryStimulusScore(stimulusSummary("lactate_threshold", scores: [recoveryScore])) == nil,
              "A missing primary score never substitutes another stimulus")
        check(techWorkoutPrimaryStimulusScore(stimulusSummary("recovery", scores: zeroScores))?.score == 0,
              "An explicitly classified zero score is preserved as a real observation")

        let shareLines = [
            [ShareCardRoutePoint(latitude: 31, longitude: 121), ShareCardRoutePoint(latitude: 31.001, longitude: 121.001)],
            [ShareCardRoutePoint(latitude: 31.01, longitude: 121.01), ShareCardRoutePoint(latitude: 31.011, longitude: 121.011)]
        ]
        check(techShareRoutePolylinesForRendering(shareLines) == shareLines,
              "Privacy-trimmed route segments must stay separate and unchanged")
        check(techShareRoutePolylinesForRendering([[], [shareLines[0][0]]]).isEmpty,
              "Empty or single-point routes cannot produce a map share card")
        for invalid in [ShareCardRoutePoint(latitude: .nan, longitude: 121),
                        ShareCardRoutePoint(latitude: 31, longitude: .infinity),
                        ShareCardRoutePoint(latitude: 91, longitude: 121),
                        ShareCardRoutePoint(latitude: 31, longitude: 181)] {
            let malformed = [shareLines[0][0], invalid, shareLines[0][1]]
            check(techShareRoutePolylinesForRendering([malformed, shareLines[1]]) == [shareLines[1]],
                  "Invalid route geometry cannot be removed and reconnected across a gap")
        }
        let shareCardWorkout = ShareCardWorkout(startedAt: "2026-09-18", sessionType: "outdoor_run",
            distanceKm: 5, durationSeconds: 1500, averagePaceSecondsPerKm: 300,
            averageHeartRateBpm: 150, elevationGainMeters: 42, gradeAdjustedPaceSecondsPerKm: 285)
        let detailGrade = WorkoutGradeSummary(policyVersion: "v1", coveredSplits: 1, totalSplits: 1,
            gainMeters: 42, lossMeters: 40, gradeAdjustedPaceSecondsPerKm: 290, reasonCodes: [])
        check(techShareGradeAdjustedPace(card: shareCardWorkout, detailGrade: detailGrade) == 285,
              "Share card uses the server grade before the detail series arrives")
        let fallbackCard = ShareCardWorkout(startedAt: "2026-09-18", sessionType: "outdoor_run",
            distanceKm: 5, durationSeconds: 1500, averagePaceSecondsPerKm: 300,
            averageHeartRateBpm: 150, elevationGainMeters: 42, gradeAdjustedPaceSecondsPerKm: nil)
        check(techShareGradeAdjustedPace(card: fallbackCard, detailGrade: detailGrade) == 290,
              "Share grade falls back to the loaded detail series")
        let wrappedInterval = techCircularInterval(values: [0.99, 0.01], period: 1)!
        check(abs(wrappedInterval.start - 0.99) < 0.000001 && abs(wrappedInterval.width - 0.02) < 0.000001,
              "Dateline route bounds use the short wrapped interval")
        let ordinaryInterval = techCircularInterval(values: [0.2, 0.3], period: 1)!
        check(abs(ordinaryInterval.start - 0.2) < 0.000001 && abs(ordinaryInterval.width - 0.1) < 0.000001,
              "Ordinary route bounds stay inside one world and remain tight")

        check(TechWorkoutMetric.allCases == [.pace, .heartRate, .cadence, .strideLength, .power,
                                             .groundContactTime, .verticalOscillation, .elevation],
              "Workout metrics are displayed individually in reading order")
        let speed = MetricSeries(unit: "km/hr", totalSamples: 5, points: [
            MetricPoint(timestamp: "a", offsetSeconds: 0, value: 10),
            MetricPoint(timestamp: "b", offsetSeconds: 10, value: 0),
            MetricPoint(timestamp: "c", offsetSeconds: 20, value: -1),
            MetricPoint(timestamp: "d", offsetSeconds: 30, value: .nan),
            MetricPoint(timestamp: "e", offsetSeconds: 40, value: 12)
        ])
        let displayedPace = TechWorkoutMetric.pace.chartSeries(from: speed)
        check(displayedPace.unit == "s/km" && displayedPace.points.map(\.value) == [360, 300],
              "Pace uses km/h reciprocals and omits stopped or invalid samples")
        check(displayedPace.points.map(\.offsetSeconds) == [0, 40] && displayedPace.totalSamples == 5,
              "Conversion retains the original timing and sample count")
        check(speed.points.count == 5 && speed.points[0].value == 10,
              "Display conversion never rewrites stored speed samples")
        let metersPerSecond = MetricSeries(unit: "m/s", totalSamples: 1,
            points: [MetricPoint(timestamp: "a", offsetSeconds: 0, value: 2.5)])
        check(TechWorkoutMetric.pace.chartSeries(from: metersPerSecond).points.first?.value == 400,
              "Pace respects HealthKit's m/s unit instead of assuming the API fallback")
        for unit in ["mi/hr", "mph"] {
            let imperialSpeed = MetricSeries(unit: unit, totalSamples: 1,
                points: [MetricPoint(timestamp: "a", offsetSeconds: 10, value: 10)])
            let imperialPace = TechWorkoutMetric.pace.chartSeries(from: imperialSpeed)
            check(abs((imperialPace.points.first?.value ?? 0) - 1000 / (10 * 0.44704)) < 0.000001,
                  "Imperial speed \(unit) remains available as seconds per kilometer")
            check(imperialPace.points.first?.offsetSeconds == 10 && imperialPace.totalSamples == 1,
                  "Imperial pace conversion preserves timing and sample count")
        }
        let unknownUnit = MetricSeries(unit: "unknown", totalSamples: 1, points: metersPerSecond.points)
        check(TechWorkoutMetric.pace.chartSeries(from: unknownUnit).points.isEmpty,
              "An unknown speed unit must not fabricate a pace")
        let tinySpeed = MetricSeries(unit: "m/s", totalSamples: 1,
            points: [MetricPoint(timestamp: "a", offsetSeconds: 0, value: 1e-20)])
        check(TechWorkoutMetric.pace.chartSeries(from: tinySpeed).points.isEmpty,
              "Finite but unrenderable pace must not overflow the duration formatter")
        let zeroHeartRate = MetricSeries(unit: "count/min", totalSamples: 2, points: [
            MetricPoint(timestamp: "a", offsetSeconds: 0, value: 0),
            MetricPoint(timestamp: "b", offsetSeconds: 1, value: 150)
        ])
        check(TechWorkoutMetric.heartRate.chartSeries(from: zeroHeartRate).points.map(\.value) == [150],
              "Heart-rate extrema exclude nonpositive samples")
        let centimeters = MetricSeries(unit: "cm", totalSamples: 1,
            points: [MetricPoint(timestamp: "a", offsetSeconds: 0, value: 104)])
        check(TechWorkoutMetric.strideLength.chartSeries(from: centimeters).points.first?.value == 1.04,
              "Stride display uses meters consistently with the server average")
        let meters = MetricSeries(unit: "m", totalSamples: 1,
            points: [MetricPoint(timestamp: "a", offsetSeconds: 0, value: 0.079)])
        check(abs((TechWorkoutMetric.verticalOscillation.chartSeries(from: meters).points.first?.value ?? 0) - 7.9) < 0.0001,
              "Vertical oscillation displays centimeters")
        let seconds = MetricSeries(unit: "s", totalSamples: 1,
            points: [MetricPoint(timestamp: "a", offsetSeconds: 0, value: 0.25)])
        check(TechWorkoutMetric.groundContactTime.chartSeries(from: seconds).points.first?.value == 250,
              "Ground contact time respects seconds instead of relabelling them as milliseconds")
        check(TechWorkoutMetric.strideLength.chartSeries(from: unknownUnit).points.isEmpty,
              "Unknown numeric units must not be relabelled as known units")
        let belowSeaLevel = MetricSeries(unit: "m", totalSamples: 1,
            points: [MetricPoint(timestamp: "a", offsetSeconds: 0, value: -3)])
        check(TechWorkoutMetric.elevation.chartSeries(from: belowSeaLevel).points.first?.value == -3,
              "Negative elevation is valid, not a missing sample")
        check(techWorkoutPaceZoneName("future_zone") == "配速区间", "Unknown zone does not leak a machine label")

        check(TechWorkoutWeather(condition: 3).title == "多云", "HealthKit partly-cloudy weather is displayed")
        check(TechWorkoutWeather(condition: 24).symbol == "cloud.bolt.rain", "Thunderstorm has its own icon")
        check((1...27).allSatisfy { TechWorkoutWeather(condition: $0).title != "未记录" }, "All HealthKit weather values render")
        for code in [nil, 0, 28, -1] as [Int?] {
            check(TechWorkoutWeather(condition: code).title == "未记录", "Unknown weather is not invented")
        }
        var weatherPayload: [String: Any] = ["policyVersion": "v1", "adapterVersion": "v1",
            "status": "unavailable", "source": "workout_metadata", "reasonCodes": []]
        func decodeWeather() -> WorkoutEnvironmentView {
            try! JSONDecoder().decode(WorkoutEnvironmentView.self, from: JSONSerialization.data(withJSONObject: weatherPayload))
        }
        check(decodeWeather().weatherCondition == nil, "Old servers without weather codes still decode")
        weatherPayload["weatherCondition"] = 3
        weatherPayload["temperatureC"] = 28
        weatherPayload["humidityPercent"] = 85
        check(decodeWeather().weatherCondition == 3 && decodeWeather().temperatureC == 28 && decodeWeather().humidityPercent == 85,
              "Summary weather, temperature and humidity share the server observations")

        let routeStart = "2026-08-25T12:31:00.000Z"
        let routeStartDate = ISO8601DateFormatter().date(from: "2026-08-25T12:31:00Z")!
        let dateFormat = ISO8601DateFormatter()
        func routePoint(_ seconds: Double, longitude: Double) -> RoutePoint {
            RoutePoint(latitude: 31, longitude: longitude, elevationMeters: nil, speedMetersPerSecond: nil,
                       timestamp: dateFormat.string(from: routeStartDate.addingTimeInterval(seconds)))
        }
        func routeSplit(_ index: Int, meters: Double = 1000, seconds: Double = 307.5) -> WorkoutSplit {
            WorkoutSplit(index: index, distanceMeters: meters, durationSeconds: seconds,
                         averagePaceSecondsPerKm: seconds / (meters / 1000), averageHeartRateBpm: nil,
                         averageCadenceSpm: nil, grade: nil)
        }
        let routePoints = (0...50).map { routePoint(Double($0 * 15), longitude: 121 + Double($0) / 1000) }
        let routeSplits = [routeSplit(1), routeSplit(2), routeSplit(3, meters: 400, seconds: 120)]
        let renderedRoute = techRoutePointsForRendering(Array(routePoints.reversed()))
        check(renderedRoute.first?.longitude == routePoints.first?.longitude && renderedRoute.last?.longitude == routePoints.last?.longitude,
              "Rendered route and kilometer interpolation share chronological point order")
        let markers = techRouteKilometerMarkers(route: routePoints.reversed(), splits: routeSplits, startedAt: routeStart)
        check(markers.map(\.kilometer) == [1, 2], "Only full kilometers get markers, not a fractional tail")
        check(abs(markers[0].longitude - 121.0205) < 0.000001, "Markers interpolate at the server split time")
        check(abs(markers[1].longitude - 121.041) < 0.000001, "Second marker uses cumulative split time")
        check(techRouteKilometerMarkers(route: routePoints, splits: [], startedAt: routeStart).isEmpty,
              "Missing splits do not invent a GPS-derived kilometer count")
        check(techRouteKilometerMarkers(route: routePoints, splits: routeSplits, startedAt: "invalid").isEmpty,
              "Invalid start time does not create markers")
        let gapRoute = routePoints.filter { $0.timestamp! < dateFormat.string(from: routeStartDate.addingTimeInterval(200))
            || $0.timestamp! > dateFormat.string(from: routeStartDate.addingTimeInterval(400)) }
        check(techRouteKilometerMarkers(route: gapRoute, splits: routeSplits, startedAt: routeStart).map(\.kilometer) == [2],
              "A GPS gap must not acquire an invented kilometer location")
        let sparseRoute = (0...20).map { routePoint(Double($0 * 90), longitude: 121 + Double($0) / 1000) }
        check(techRouteKilometerMarkers(route: sparseRoute, splits: routeSplits, startedAt: routeStart).count == 2,
              "Long-run route downsampling is not mistaken for missing GPS")
        let untimed = [RoutePoint(latitude: 31, longitude: 121, elevationMeters: nil, speedMetersPerSecond: nil, timestamp: nil)]
        check(techRouteKilometerMarkers(route: untimed, splits: routeSplits, startedAt: routeStart).isEmpty,
              "Routes without timestamps cannot be mapped to split times")
        let mixedTiming = routePoints.dropLast().map { $0 } + [untimed[0]]
        check(techRouteKilometerMarkers(route: mixedTiming, splits: routeSplits, startedAt: routeStart).isEmpty,
              "Mixed-timestamp routes do not place markers on an uncertain segment")
        let repeatedPoints = Array(repeating: CGPoint(x: 150, y: 100), count: 10)
        let markerFrames = techRouteMarkerFrames(points: repeatedPoints, kilometers: Array(1...10), size: CGSize(width: 350, height: 220))
        check(markerFrames.compactMap { $0 }.count == 10, "Every repeated-lap marker gets a frame")
        let visibleMarkerFrames = markerFrames.compactMap { $0 }
        check(visibleMarkerFrames.indices.allSatisfy { index in
            visibleMarkerFrames.dropFirst(index + 1).allSatisfy { !visibleMarkerFrames[index].intersects($0) }
        }, "Repeated-lap badges must not obscure each other")
        check(markerFrames.first!?.midX == 150 && markerFrames.first!?.midY == 100,
              "The first badge remains on the route anchor")
        check(visibleMarkerFrames.allSatisfy { CGRect(x: 0, y: 0, width: 350, height: 220).contains($0) },
              "All repeated-lap badges remain within the map")
        check(techRouteMarkerLeader(point: repeatedPoints[0], frame: visibleMarkerFrames[0]) == nil,
              "An anchored badge does not need a leader")
        check(visibleMarkerFrames.dropFirst().allSatisfy { frame in
            guard let leader = techRouteMarkerLeader(point: repeatedPoints[0], frame: frame) else { return false }
            return leader.start == repeatedPoints[0] && leader.end == CGPoint(x: frame.midX, y: frame.midY)
        }, "Every displaced badge is linked to its original GPS anchor")
        check(techRouteMarkerFrames(points: repeatedPoints, kilometers: Array(1...10), size: CGSize(width: 350, height: 220)) == markerFrames,
              "Marker layout is deterministic across map redraws")
        for anchor in [CGPoint(x: 1, y: 1), CGPoint(x: 349, y: 219)] {
            let edgeLapFrames = techRouteMarkerFrames(points: Array(repeating: anchor, count: 20),
                kilometers: Array(1...20), size: CGSize(width: 350, height: 220)).compactMap { $0 }
            check(edgeLapFrames.count == 20 && edgeLapFrames.allSatisfy {
                CGRect(x: 0, y: 0, width: 350, height: 220).contains($0)
            }, "Repeated laps near the edge keep every badge within the map")
            check(edgeLapFrames.indices.allSatisfy { index in
                edgeLapFrames.dropFirst(index + 1).allSatisfy { !edgeLapFrames[index].intersects($0) }
            }, "Repeated laps near the edge never overlap")
        }
        let separatePoints = [CGPoint(x: 50, y: 50), CGPoint(x: 150, y: 100), CGPoint(x: 250, y: 150)]
        let separateFrames = techRouteMarkerFrames(points: separatePoints, kilometers: [1, 2, 3], size: CGSize(width: 350, height: 220))
        check(zip(separatePoints, separateFrames).allSatisfy { point, frame in
            frame.map { CGPoint(x: $0.midX, y: $0.midY) == point } ?? false
        }, "Nonoverlapping badges do not move off their route anchors")
        check(techRouteMarkerFrames(points: repeatedPoints, kilometers: [], size: CGSize(width: 350, height: 220)).allSatisfy { $0 == nil },
              "Mismatched marker inputs do not produce frames")
        check(techRouteMarkerFrames(points: repeatedPoints, kilometers: Array(1...10), size: CGSize(width: 0, height: 220)).allSatisfy { $0 == nil },
              "An unlaid-out map does not produce marker frames")
        let edgeFrames = techRouteMarkerFrames(points: [CGPoint(x: 1, y: 1), CGPoint(x: 349, y: 219)],
            kilometers: [1, 12], size: CGSize(width: 350, height: 220))
        check(edgeFrames.allSatisfy { CGRect(x: 0, y: 0, width: 350, height: 220).contains($0!) },
              "Markers near the edge stay inside the map")
        let invalidFrames = techRouteMarkerFrames(points: [CGPoint(x: CGFloat.nan, y: 10), CGPoint(x: -20, y: 10)],
            kilometers: [1, 2], size: CGSize(width: 350, height: 220))
        check(invalidFrames.allSatisfy { $0 == nil }, "Offscreen and invalid map projections do not produce badges")

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

        func coachPlan(startedOn: String = "2026-10-08", raceDate: String? = nil,
                       goal: String = "fitness", durationWeeks: Int? = 12) -> MobileRunCoachPlan {
            MobileRunCoachPlan(id: "cycle-test", startedOn: startedOn, status: "active",
                pausedOn: nil, endedOn: nil, adaptationKey: nil, adaptedAt: nil,
                goal: goal, raceDate: raceDate, raceDistanceKm: goal == "fitness" ? nil : 10,
                targetTimeSeconds: nil, runningDays: [1, 3, 5], longRunDays: [5],
                targetType: "pace", strengthTraining: false, durationWeeks: durationWeeks)
        }
        check(techCoachTotalWeeks(for: coachPlan(durationWeeks: 6)) == 6,
              "Fitness programmes keep their configured duration")
        check(techCoachTotalWeeks(for: coachPlan(durationWeeks: nil)) == 12,
              "Legacy fitness programmes use the API's twelve-week default")
        check(techCoachTotalWeeks(for: coachPlan(durationWeeks: 0)) == nil,
              "Invalid fitness durations do not invent a cycle")
        let longRace = coachPlan(raceDate: "2027-04-08", goal: "finish")
        check(techCoachTotalWeeks(for: longRace) == 27,
              "Race cycles ignore the twelve-week fitness setting and include the final race-day bucket")
        check(techCoachTotalWeeks(for: coachPlan(raceDate: "2027-04-08", goal: "time", durationWeeks: 6)) == 27,
              "A hidden fitness duration cannot shorten a target-time race programme")
        check(techCoachTotalWeeks(for: coachPlan(raceDate: "2027-04-08", goal: "finish", durationWeeks: nil)) == 27,
              "Legacy race plans derive their cycle without a duration field")
        check(techCoachTotalWeeks(for: coachPlan(raceDate: "2026-10-14", goal: "finish")) == 1 &&
              techCoachTotalWeeks(for: coachPlan(raceDate: "2026-10-15", goal: "finish")) == 2,
              "Inclusive cycle buckets match floor(days / 7) + 1 at the race-day boundary")
        check(techCoachTotalWeeks(for: coachPlan(startedOn: "2028-02-28", raceDate: "2028-03-06", goal: "finish")) == 2,
              "Race cycle dates account for leap days")
        check(techCoachTotalWeeks(for: coachPlan(startedOn: "2027-03-08", raceDate: "2027-03-15", goal: "finish")) == 2,
              "Civil-date cycle lengths do not lose a day across daylight-saving changes")
        for invalidRace in [nil, "2026-10-07", "2027-02-29", "2027-4-08", "not-a-date"] as [String?] {
            check(techCoachTotalWeeks(for: coachPlan(raceDate: invalidRace, goal: "finish")) == nil,
                  "Missing or invalid race dates do not fall back to a fitness duration")
        }
        check(techCoachTotalWeeks(for: coachPlan(startedOn: "not-a-date", raceDate: "2027-04-08", goal: "finish")) == nil,
              "An invalid start date cannot create race-cycle progress")

        let coachPaceAlert = MobileStepAlert(kind: "pace", lower: 360, upper: 450)
        let coachHeartRateAlert = MobileStepAlert(kind: "heart_rate", lower: 130, upper: 145)
        func coachStructure(_ alerts: [MobileStepAlert?]) -> MobileSessionStructure {
            let warmup = MobileWorkoutStep(purpose: "warmup", goal: .time(seconds: 300), alert: coachHeartRateAlert)
            let recovery = MobileWorkoutStep(purpose: "recovery", goal: .time(seconds: 120), alert: coachHeartRateAlert)
            return MobileSessionStructure(warmup: warmup, blocks: [
                MobileIntervalBlock(iterations: 3, steps: [recovery] + alerts.map {
                    MobileWorkoutStep(purpose: "work", goal: .distance(meters: 800), alert: $0)
                })
            ], cooldown: MobileWorkoutStep(purpose: "cooldown", goal: .time(seconds: 300), alert: coachHeartRateAlert))
        }
        func coachSession(_ structure: MobileSessionStructure?, heartRateUpper: Double? = 125) -> MobileNextSession {
            MobileNextSession(kind: "easy", title: "轻松跑", reason: "", distanceKm: 5, durationMinutes: 30,
                paceSecondsPerKmLower: 360, paceSecondsPerKmUpper: 450,
                heartRateBpmLower: nil, heartRateBpmUpper: heartRateUpper, structure: structure)
        }
        func coachDay(_ date: String, kind: String = "easy", structure: MobileSessionStructure? = nil) -> MobileWorkoutPlanDay {
            MobileWorkoutPlanDay(localDate: date, kind: kind, title: "", reason: "",
                distanceKm: kind == "rest" ? nil : 5, durationMinutes: kind == "rest" ? nil : 30,
                paceSecondsPerKmLower: 360, paceSecondsPerKmUpper: 450,
                heartRateBpmLower: 120, heartRateBpmUpper: 125,
                structure: structure, source: "heuristic", executable: kind != "rest")
        }
        let hrStructure = coachStructure([coachHeartRateAlert, coachHeartRateAlert])
        let hrTarget = techCoachTrainingTarget(for: coachSession(hrStructure), preferredType: "heart_rate")
        check(hrTarget?.alert == coachHeartRateAlert && hrTarget?.title == "目标心率",
              "Today uses the actual main-work heart-rate target, not either session-level reference range")
        check(techCoachTrainingTarget(for: coachDay("2026-10-09", structure: hrStructure), preferredType: "heart_rate") == hrTarget,
              "Upcoming rows and executable details share today's prescription-based target rule")
        check(techCoachTrainingTarget(for: coachSession(hrStructure), preferredType: "pace") == hrTarget,
              "A preserved heart-rate prescription outranks newly changed preferences")
        let paceTarget = techCoachTrainingTarget(structure: coachStructure([coachPaceAlert]))
        check(paceTarget?.alert == coachPaceAlert && paceTarget?.title == "目标配速",
              "Main-work pace is not replaced by warmup, recovery or cooldown heart rate")
        check(techCoachTrainingTarget(for: coachSession(coachStructure([nil])), preferredType: "heart_rate") == nil,
              "A structured workout with no work alert cannot silently acquire a pace or heart-rate target")
        check(techCoachTrainingTarget(structure: coachStructure([coachHeartRateAlert, nil]), legacyAlert: coachPaceAlert) == nil,
              "An untargeted work step cannot be hidden behind another step's target")
        check(techCoachTrainingTarget(structure: coachStructure([coachHeartRateAlert, coachPaceAlert])) == nil,
              "Mixed work targets stay in the detailed steps rather than becoming one misleading range")
        check(techCoachTrainingTarget(structure: coachStructure([]), legacyAlert: coachPaceAlert) == nil,
              "Warmup-only structures do not invent a main training target")
        check(techCoachTrainingTarget(structure: coachStructure([MobileStepAlert(kind: "unknown", lower: 130, upper: 145)])) == nil,
              "An unknown alert kind cannot be labelled as pace")
        let singleBound = MobileStepAlert(kind: "heart_rate", lower: nil, upper: 145)
        check(techCoachTrainingTarget(structure: coachStructure([singleBound]))?.alert == singleBound,
              "A real one-sided target remains one-sided")
        check(techCoachTrainingTarget(for: coachSession(nil), preferredType: "heart_rate")?.alert ==
              MobileStepAlert(kind: "heart_rate", lower: nil, upper: 125),
              "Legacy unstructured sessions use the selected heart-rate reference, not pace")
        check(techCoachTrainingTarget(for: coachSession(nil), preferredType: "pace")?.alert == coachPaceAlert,
              "Legacy pace sessions keep their existing target display")
        check(techCoachTrainingTarget(for: coachSession(nil, heartRateUpper: nil), preferredType: "heart_rate") == nil,
              "Missing legacy heart-rate evidence never falls back to pace")
        check(techCoachTrainingTarget(for: coachDay("2026-10-09"), preferredType: "heart_rate")?.alert ==
              MobileStepAlert(kind: "heart_rate", lower: 120, upper: 125),
              "Legacy executable rows and details also respect the selected target type")

        // Schedule display does not take a today response: a failed/missing today
        // endpoint cannot hide a valid independently refreshed executable week.
        let upcomingScheduleDays = [
            coachDay("2026-10-13"), coachDay("2026-10-08"), coachDay("2026-10-11", kind: "rest"),
            coachDay("2026-10-10"), coachDay("2026-10-07"), coachDay("2026-10-12"), coachDay("2026-10-09")
        ]
        func coachSchedule(timezone: String = "Asia/Shanghai", days: [MobileWorkoutPlanDay]) -> MobileWorkoutPlanResponse {
            MobileWorkoutPlanResponse(generatedAt: "2026-10-01T00:00:00Z", timezone: timezone,
                windowDays: days.count, planRevision: 2, audit: nil, days: days)
        }
        let coachNow = ISO8601DateFormatter().date(from: "2026-10-08T04:00:00Z")!
        let validSchedule = coachSchedule(days: upcomingScheduleDays)
        check(techCoachUpcomingTrainingDays(in: validSchedule, now: coachNow).map(\.localDate) ==
              ["2026-10-09", "2026-10-10", "2026-10-12"],
              "Independent schedules exclude today, past days and rest, sort chronologically and limit to three")
        let midnightNow = ISO8601DateFormatter().date(from: "2026-10-08T16:30:00Z")!
        check(techCoachUpcomingTrainingDays(in: validSchedule, now: midnightNow).map(\.localDate) ==
              ["2026-10-10", "2026-10-12", "2026-10-13"],
              "The current schedule-local date, not a cached response date or generatedAt, is the cutoff")
        check(techCoachUpcomingTrainingDays(in: coachSchedule(timezone: "America/New_York", days: upcomingScheduleDays),
              now: midnightNow).map(\.localDate) == ["2026-10-09", "2026-10-10", "2026-10-12"],
              "Future training respects the schedule timezone rather than Shanghai or the device timezone")
        check(techCoachUpcomingTrainingDays(in: coachSchedule(days: [coachDay("2026-10-08"),
              coachDay("2026-10-09", kind: "rest")]), now: coachNow).isEmpty,
              "An exhausted or all-rest schedule does not fabricate future training")

        // The API's week strip marks observations planned=false, and marks rest days planned=true.
        let recorded = MobileWeekPlanDay(localDate: "2026-10-07", kind: "completed", title: "已完成",
            planned: false, completedWorkoutId: "recorded-run", distanceKm: 5, workoutCount: 2, structure: nil)
        let upcoming = MobileWeekPlanDay(localDate: "2026-10-09", kind: "easy", title: "轻松跑",
            planned: true, completedWorkoutId: nil, distanceKm: 5, workoutCount: 0, structure: nil)
        let restDays = ["2026-10-05", "2026-10-06", "2026-10-08", "2026-10-10", "2026-10-11"].map {
            MobileWeekPlanDay(localDate: $0, kind: "rest", title: "休息", planned: true,
                completedWorkoutId: nil, distanceKm: 0, workoutCount: 0, structure: nil)
        }
        let weekDays = restDays + [recorded, upcoming]
        let legacyProgress = TechCoachWeekProgress(days: weekDays, adherence: nil)
        check(legacyProgress.completedCount == 1 && legacyProgress.plannedCount == 2,
              "A recorded day remains in progress; rest days never add training obligations")
        check(legacyProgress.fraction == 0.5 && legacyProgress.unrecordedCount == 1,
              "Two workouts on one date still complete one prescribed day")
        let onlyRest = TechCoachWeekProgress(days: restDays, adherence: nil)
        check(onlyRest.plannedCount == 0 && onlyRest.fraction == nil,
              "An all-rest week has no training obligations or fabricated progress")
        let allRecorded = TechCoachWeekProgress(days: [recorded], adherence: nil)
        check(allRecorded.completedCount == 1 && allRecorded.plannedCount == 1 && allRecorded.fraction == 1,
              "Recording the final training day must complete the week instead of emptying its denominator")
        let adherence = MobileAdherenceWeek(weekStart: "2026-10-05", phase: nil, plannedDays: 4,
            observedDays: 1, unknownDays: 1, plannedDistanceKm: 20, observedDistanceKm: 5,
            volumeRatio: 0.25, qualityPlanned: 0, qualityObserved: 0, status: "on_track")
        let progress = TechCoachWeekProgress(days: weekDays, adherence: adherence)
        check(progress.completedCount == 1 && progress.plannedCount == 4 && progress.fraction == 0.25,
              "Frozen adherence obligations outrank the strip's current prescriptions")
        check(progress.unknownCount == 1 && progress.unrecordedCount == 3,
              "Unobserved prescribed days stay explicitly unknown, not missed workouts")
        let distanceMissing = MobileAdherenceWeek(weekStart: "2026-10-05", phase: nil, plannedDays: 4,
            observedDays: 1, unknownDays: 1, plannedDistanceKm: nil, observedDistanceKm: 5,
            volumeRatio: nil, qualityPlanned: 0, qualityObserved: 0, status: "unknown")
        let countProgress = TechCoachWeekProgress(days: weekDays, adherence: distanceMissing)
        check(countProgress.fraction == 0.25 && countProgress.unknownCount == 1,
              "Missing distance uses observed-day progress without hiding pending sync")

        check(techCoachWeekDayTitle(recorded) == "已完成", "Observed planned=false days are never labelled unplanned")
        check(techCoachWeekDayTitle(upcoming) == "轻松跑", "Upcoming prescriptions keep their training title")
        check(techCoachWeekDayTitle(restDays[0]) == "休息", "Explicit rest stays distinct from an unplanned day")
        let noRecordID = MobileWeekPlanDay(localDate: "2026-10-07", kind: "completed", title: "已完成",
            planned: false, completedWorkoutId: nil, distanceKm: 5, workoutCount: 1, structure: nil)
        check(techCoachDayIsCompleted(noRecordID) && techCoachWeekDayTitle(noRecordID) == "已完成",
              "An observed day without a detail ID still counts and reads as completed")
        let unplanned = MobileWeekPlanDay(localDate: "2026-10-09", kind: "easy", title: "轻松跑",
            planned: false, completedWorkoutId: nil, distanceKm: 0, workoutCount: 0, structure: nil)
        check(techCoachWeekDayTitle(unplanned) == "未排课" &&
              TechCoachWeekProgress(days: [unplanned], adherence: nil).plannedCount == 0,
              "A genuinely unplanned day is not a prescribed training day")

        check(techCoachRaceCountdown(raceDate: "2026-10-07", todayLocalDate: "2026-10-08", daysToRace: 0) == "比赛日已过",
              "A past race stays past when the server clamps its countdown to zero")
        check(techCoachRaceCountdown(raceDate: "2026-10-08", todayLocalDate: "2026-10-08", daysToRace: 0) == "距比赛 0 天",
              "Race day is not confused with an expired race")
        check(techCoachRaceCountdown(raceDate: "2026-10-15", todayLocalDate: "2026-10-08", daysToRace: 7) == "距比赛 7 天",
              "Future races retain their countdown")
        check(techCoachRaceCountdown(raceDate: "2026-10-07", todayLocalDate: "2026-10-08", daysToRace: nil) == "比赛日已过",
              "The date can establish an expired race even without countdown metadata")
        check(techCoachRaceCountdown(raceDate: nil, todayLocalDate: "2026-10-08", daysToRace: 0) == nil,
              "Fitness plans do not acquire a race countdown")

        func calibration(_ status: String, sessions: Int) -> MobileCalibrationCard {
            MobileCalibrationCard(status: status, eligibleSessions: sessions, eligibleDurationMinutes: 0,
                spanDays: 0, highCoverageSessions: 0,
                requirements: CalibrationRequirements(sessions: 6, durationMinutes: 180, spanDays: 14, highCoverageSessions: 3),
                message: "")
        }
        let coldStart = calibration("not_started", sessions: 0)
        check(techCoachCalibrationLabel(coldStart) == "校准未完成（0/6 次）",
              "Cold start names the actual calibration progress")
        let coldStartExplanation = techCoachCalibrationExplanation(coldStart, weeklyBudgetKm: 5)
        check(coldStartExplanation?.contains("本周 5.0 km 是保守起步，不是整个计划的全部内容") == true &&
              coldStartExplanation?.contains("校准未完成时只排轻松训练") == true,
              "The small budget must explain conservative training rather than read as the whole programme")
        check(techCoachCalibrationLabel(calibration("calibrating", sessions: 2)) == "校准未完成（2/6 次）",
              "Calibration in progress keeps the server's session counts")
        let calibrated = calibration("completed", sessions: 6)
        check(techCoachCalibrationLabel(calibrated) == "校准已完成" &&
              techCoachCalibrationExplanation(calibrated, weeklyBudgetKm: 5) == nil,
              "Completed calibration must not keep claiming a conservative calibration start")
        check(techCoachCalibrationExplanation(nil, weeklyBudgetKm: 5) == nil,
              "Missing calibration cannot be reported as incomplete")
        check(techCoachCalibrationExplanation(coldStart, weeklyBudgetKm: nil)?.hasPrefix("当前训练安排是保守起步") == true,
              "Missing budget still explains conservative training without inventing a distance")

        print("Technology presentation: \(checks) checks passed")
        print(String(format: "50,000 points preparation: %.2f ms/run (host microbenchmark without -O, not device FPS)",
                     Date().timeIntervalSince(start) * 100))
    }
}
