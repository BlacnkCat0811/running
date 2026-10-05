import CoreGraphics
import Foundation

func techShareRoutePolylinesForRendering(_ polylines: [[ShareCardRoutePoint]]) -> [[ShareCardRoutePoint]] {
    // Reject a malformed line as a whole, rather than joining across a removed point.
    polylines.filter { line in
        line.count >= 2 && line.allSatisfy {
            $0.latitude.isFinite && $0.longitude.isFinite && abs($0.latitude) <= 90 && abs($0.longitude) <= 180
        }
    }
}

func techShareGradeAdjustedPace(card: ShareCardWorkout, detailGrade: WorkoutGradeSummary?) -> Double? {
    card.gradeAdjustedPaceSecondsPerKm ?? detailGrade?.gradeAdjustedPaceSecondsPerKm
}

func techWorkoutPrimaryStimulusScore(_ summary: WorkoutZoneSummary?) -> StimulusScore? {
    guard let summary, summary.stimulusType != "unclassified" else { return nil }
    return summary.stimulusScores.first { $0.stimulusType == summary.stimulusType }
}

func techSeriesSelectionTime(points: [MetricPoint], selectedTime: Double?, direction: Int) -> Double? {
    guard !points.isEmpty, direction != 0 else { return nil }
    let current = selectedTime.flatMap { time -> Int? in
        guard time.isFinite else { return nil }
        return points.indices.min {
            abs(points[$0].offsetSeconds / 60 - time) < abs(points[$1].offsetSeconds / 60 - time)
        }
    }
    let index = current.map { min(max($0 + direction.signum(), 0), points.count - 1) }
        ?? (direction > 0 ? 0 : points.count - 1)
    return points[index].offsetSeconds / 60
}

/// Returns the shortest circular interval containing the values on a periodic axis.
/// The width may cross the period boundary, while the start stays in one world
/// so map SDKs that normalize world coordinates can still apply the rectangle.
func techCircularInterval(values: [Double], period: Double) -> (start: Double, width: Double)? {
    guard period.isFinite, period > 0 else { return nil }
    let normalized = values.compactMap { value -> Double? in
        guard value.isFinite else { return nil }
        let remainder = value.truncatingRemainder(dividingBy: period)
        return remainder >= 0 ? remainder : remainder + period
    }.sorted()
    guard let first = normalized.first else { return nil }
    guard normalized.count > 1 else { return (first, 0) }

    var largestGap = -Double.infinity
    var gapStart = first
    for index in normalized.indices {
        let current = normalized[index]
        let next = index + 1 < normalized.count ? normalized[index + 1] : normalized[0] + period
        let gap = next - current
        if gap > largestGap {
            largestGap = gap
            gapStart = current
        }
    }
    let start = (gapStart + largestGap).truncatingRemainder(dividingBy: period)
    return (start >= 0 ? start : start + period, max(period - largestGap, 0))
}

/// Display order and units only; workout averages and grade adjustment remain server-owned.
enum TechWorkoutMetric: String, CaseIterable, Identifiable {
    case pace, heartRate, cadence, strideLength, power, groundContactTime, verticalOscillation, elevation

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pace: return "配速"
        case .heartRate: return "心率"
        case .cadence: return "步频"
        case .strideLength: return "步幅"
        case .power: return "跑步功率"
        case .groundContactTime: return "触地时间"
        case .verticalOscillation: return "垂直振幅"
        case .elevation: return "海拔"
        }
    }

    var digits: Int {
        switch self {
        case .strideLength: return 2
        case .verticalOscillation: return 1
        default: return 0
        }
    }

    var unit: String {
        switch self {
        case .pace: return "s/km"
        case .heartRate: return "bpm"
        case .cadence: return "spm"
        case .strideLength, .elevation: return "m"
        case .power: return "W"
        case .groundContactTime: return "ms"
        case .verticalOscillation: return "cm"
        }
    }

    func average(in workout: WorkoutDetail) -> Double? {
        switch self {
        case .pace: return workout.averagePaceSecondsPerKm
        case .heartRate: return workout.averageHeartRateBpm
        case .cadence: return workout.averageCadenceSpm
        case .strideLength: return workout.averageStrideLengthMeters
        case .power: return workout.averagePowerWatts
        case .groundContactTime: return workout.averageGroundContactTimeMs
        case .verticalOscillation: return workout.averageVerticalOscillationCm
        case .elevation: return nil
        }
    }

    func series(in series: WorkoutSeries) -> MetricSeries {
        switch self {
        case .pace: return series.speed
        case .heartRate: return series.heartRate
        case .cadence: return series.cadence
        case .strideLength: return series.strideLength
        case .power: return series.power
        case .groundContactTime: return series.groundContactTime
        case .verticalOscillation: return series.verticalOscillation
        case .elevation: return series.elevation
        }
    }

    func chartSeries(from source: MetricSeries) -> MetricSeries {
        let transform: (Double) -> Double?
        switch self {
        case .pace:
            // The API preserves the HealthKit sample unit, not its fallback unit.
            let numerator: Double?
            switch source.unit {
            case "km/hr", "km/h": numerator = 3600
            case "m/s": numerator = 1000
            case "mi/hr", "mph": numerator = 1000 / 0.44704
            default: numerator = nil
            }
            transform = { value in
                guard let numerator, value.isFinite, value > 0 else { return nil }
                let pace = numerator / value
                return pace.isFinite && pace > 0 && pace < Double(Int.max) ? pace : nil
            }
        case .heartRate:
            transform = { (source.unit == "count/min" || source.unit == unit) && $0 > 0 ? $0 : nil }
        case .strideLength where source.unit == "cm":
            transform = { $0 / 100 }
        case .verticalOscillation where source.unit == "m":
            transform = { $0 * 100 }
        case .groundContactTime where source.unit == "s":
            transform = { $0 * 1000 }
        default:
            transform = { source.unit == unit ? $0 : nil }
        }
        let points = source.points.compactMap { point -> MetricPoint? in
            guard let value = transform(point.value), value.isFinite else { return nil }
            return MetricPoint(timestamp: point.timestamp, offsetSeconds: point.offsetSeconds, value: value)
        }
        return MetricSeries(unit: unit, totalSamples: source.totalSamples, points: points)
    }
}

func techWorkoutPaceZoneName(_ zone: String) -> String {
    switch zone {
    case "easy": return "轻松区"
    case "marathon": return "马拉松区"
    case "lactate_threshold": return "阈值区"
    case "anaerobic_endurance": return "无氧耐力区"
    case "sprint": return "冲刺区"
    default: return "配速区间"
    }
}

struct TechWorkoutWeather {
    let title: String
    let symbol: String

    init(condition: Int?) {
        switch condition {
        case 1, 2: (title, symbol) = ("晴", "sun.max")
        case 3, 4: (title, symbol) = ("多云", "cloud.sun")
        case 5: (title, symbol) = ("阴", "cloud")
        case 6: (title, symbol) = ("雾", "cloud.fog")
        case 7: (title, symbol) = ("霾", "sun.haze")
        case 8, 9: (title, symbol) = ("大风", "wind")
        case 10: (title, symbol) = ("烟雾", "smoke")
        case 11: (title, symbol) = ("扬尘", "sun.dust")
        case 12: (title, symbol) = ("雪", "cloud.snow")
        case 13: (title, symbol) = ("冰雹", "cloud.hail")
        case 14, 18, 19, 20: (title, symbol) = ("雨夹雪", "cloud.sleet")
        case 15, 16: (title, symbol) = ("冻雨", "cloud.sleet")
        case 17: (title, symbol) = ("雨夹冰雹", "cloud.hail")
        case 21: (title, symbol) = ("小雨", "cloud.drizzle")
        case 22, 23: (title, symbol) = ("阵雨", "cloud.rain")
        case 24: (title, symbol) = ("雷雨", "cloud.bolt.rain")
        case 25: (title, symbol) = ("热带风暴", "tropicalstorm")
        case 26: (title, symbol) = ("飓风", "hurricane")
        case 27: (title, symbol) = ("龙卷风", "tornado")
        default: (title, symbol) = ("未记录", "cloud")
        }
    }
}

struct TechRouteKilometerMarker: Equatable, Identifiable {
    let kilometer: Int
    let latitude: Double
    let longitude: Double
    var id: Int { kilometer }
}

/// Nearby free slots keep lap numbers readable; leaders retain their GPS anchors.
func techRouteMarkerFrames(points: [CGPoint], kilometers: [Int], size: CGSize) -> [CGRect?] {
    guard points.count == kilometers.count, size.width.isFinite, size.height.isFinite,
          size.width >= 28, size.height >= 28 else { return Array(repeating: nil, count: points.count) }
    let bounds = CGRect(x: 2, y: 2, width: size.width - 4, height: size.height - 4)
    var placed: [CGRect] = []
    return points.enumerated().map { index, point in
        guard point.x.isFinite, point.y.isFinite,
              CGRect(origin: .zero, size: size).contains(point) else { return nil }
        let diameter = min(bounds.width, bounds.height, max(14, CGFloat(String(kilometers[index]).count * 6 + 6)))
        func frame(offset: CGPoint = .zero) -> CGRect {
            CGRect(x: min(max(point.x + offset.x - diameter / 2, bounds.minX), bounds.maxX - diameter),
                   y: min(max(point.y + offset.y - diameter / 2, bounds.minY), bounds.maxY - diameter),
                   width: diameter, height: diameter)
        }
        func available(_ candidate: CGRect) -> Bool {
            placed.allSatisfy { !candidate.insetBy(dx: -2, dy: -2).intersects($0) }
        }
        let anchored = frame()
        if available(anchored) {
            placed.append(anchored)
            return anchored
        }
        let step = diameter + 4
        for radius in stride(from: step, through: max(bounds.width, bounds.height) + step, by: step) {
            var offsets: [CGPoint] = []
            for x in stride(from: -radius, through: radius, by: step) {
                offsets.append(CGPoint(x: x, y: -radius))
                offsets.append(CGPoint(x: x, y: radius))
            }
            for y in stride(from: -radius + step, through: radius - step, by: step) {
                offsets.append(CGPoint(x: -radius, y: y))
                offsets.append(CGPoint(x: radius, y: y))
            }
            offsets.sort {
                let left = $0.x * $0.x + $0.y * $0.y, right = $1.x * $1.x + $1.y * $1.y
                if left != right { return left < right }
                return $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y
            }
            for offset in offsets {
                let candidate = frame(offset: offset)
                if available(candidate) {
                    placed.append(candidate)
                    return candidate
                }
            }
        }
        return nil
    }
}

func techRouteMarkerLeader(point: CGPoint, frame: CGRect) -> (start: CGPoint, end: CGPoint)? {
    let center = CGPoint(x: frame.midX, y: frame.midY)
    guard hypot(point.x - center.x, point.y - center.y) > 1 else { return nil }
    return (point, center)
}

/// Route drawing and kilometer interpolation must use the same point order.
/// HealthKit exports are normally chronological, but an out-of-order payload
/// must not make a marker land on a different rendered segment.
func techRoutePointsForRendering(_ route: [RoutePoint]) -> [RoutePoint] {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let fallback = ISO8601DateFormatter()
    func date(_ value: String) -> Date? { parser.date(from: value) ?? fallback.date(from: value) }
    let valid = route.filter {
        $0.latitude.isFinite && $0.longitude.isFinite &&
        abs($0.latitude) <= 90 && abs($0.longitude) <= 180
    }
    let dated = valid.compactMap { point -> (Date, RoutePoint)? in
        guard let timestamp = point.timestamp, let timestamp = date(timestamp) else { return nil }
        return (timestamp, point)
    }
    return dated.count == valid.count ? dated.sorted { $0.0 < $1.0 }.map { $0.1 } : valid
}

/// Use the API's kilometer boundary times, not a second GPS-distance estimate.
func techRouteKilometerMarkers(route: [RoutePoint], splits: [WorkoutSplit], startedAt: String) -> [TechRouteKilometerMarker] {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let fallback = ISO8601DateFormatter()
    func date(_ value: String) -> Date? { parser.date(from: value) ?? fallback.date(from: value) }
    guard let start = date(startedAt) else { return [] }
    let orderedRoute = techRoutePointsForRendering(route)
    let points = orderedRoute.compactMap { point -> (time: TimeInterval, point: RoutePoint)? in
        guard point.latitude.isFinite, point.longitude.isFinite,
              abs(point.latitude) <= 90, abs(point.longitude) <= 180,
              let timestamp = point.timestamp, let timestamp = date(timestamp) else { return nil }
        return (timestamp.timeIntervalSince1970, point)
    }
    guard points.count == orderedRoute.count else { return [] }
    guard points.count >= 2 else { return [] }
    // The API downsamples routes to roughly 500 points; long runs have wider intervals.
    let intervals = zip(points, points.dropFirst()).map { $1.time - $0.time }.filter { $0 > 0 }.sorted()
    let maximumGap = max(30, (intervals.isEmpty ? 0 : intervals[intervals.count / 2]) * 3)
    var result: [TechRouteKilometerMarker] = []
    var elapsed = 0.0
    var distance = 0.0
    var cursor = 1
    for split in splits {
        guard split.durationSeconds.isFinite, split.durationSeconds > 0,
              split.distanceMeters.isFinite, split.distanceMeters > 0 else { return [] }
        elapsed += split.durationSeconds
        distance += split.distanceMeters
        let kilometers = distance / 1000
        let nearest = kilometers.rounded()
        guard nearest >= 1, nearest < Double(Int.max), abs(kilometers - nearest) < 0.000001 else { continue }
        let time = start.timeIntervalSince1970 + elapsed
        guard time >= points[0].time, time <= points[points.count - 1].time else { continue }
        while cursor < points.count - 1, points[cursor].time < time { cursor += 1 }
        let before = points[cursor - 1], after = points[cursor]
        // A missing route section must not acquire an invented kilometer location.
        guard time == before.time || time == after.time || after.time - before.time <= maximumGap else { continue }
        let fraction = after.time == before.time ? 0 : (time - before.time) / (after.time - before.time)
        var longitudeDelta = after.point.longitude - before.point.longitude
        if longitudeDelta > 180 { longitudeDelta -= 360 }
        if longitudeDelta < -180 { longitudeDelta += 360 }
        var longitude = before.point.longitude + longitudeDelta * fraction
        if longitude > 180 { longitude -= 360 }
        if longitude < -180 { longitude += 360 }
        result.append(TechRouteKilometerMarker(kilometer: Int(nearest),
            latitude: before.point.latitude + (after.point.latitude - before.point.latitude) * fraction,
            longitude: longitude))
    }
    return result
}
