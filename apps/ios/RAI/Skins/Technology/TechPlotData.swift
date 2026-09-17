import Foundation

/// Presentation only. Endpoints and each bucket's extrema survive; the source
/// series and all server-derived scores/averages are left untouched.
enum TechPlotSampling {
    static func indices(values: [Double], limit: Int = 360) -> [Int] {
        let valid = values.indices.filter { values[$0].isFinite }
        guard valid.count > max(limit, 4) else { return valid }
        let bucketCount = max(1, (max(limit, 4) - 2) / 2)
        var result = [valid[0]]
        let interiorCount = valid.count - 2
        for bucket in 0..<bucketCount {
            let lower = 1 + bucket * interiorCount / bucketCount
            let upper = 1 + (bucket + 1) * interiorCount / bucketCount
            guard lower < upper else { continue }
            var low = valid[lower], high = low
            for position in lower..<upper {
                let index = valid[position]
                if values[index] < values[low] { low = index }
                if values[index] > values[high] { high = index }
            }
            result.append(min(low, high))
            if low != high { result.append(max(low, high)) }
        }
        result.append(valid[valid.count - 1])
        return result
    }
}

struct TechSeriesData {
    let points: [MetricPoint]
    let validCount: Int
    let minimum: Double?
    let maximum: Double?

    init(points source: [MetricPoint]) {
        // Stable ordering and de-duplication keep Chart identities unique. When
        // a timestamp repeats, keep the last received value for that instant.
        let ordered = source.enumerated()
            .filter { $0.element.offsetSeconds.isFinite && $0.element.offsetSeconds >= 0 && $0.element.value.isFinite }
            .sorted {
                $0.element.offsetSeconds == $1.element.offsetSeconds
                    ? $0.offset < $1.offset
                    : $0.element.offsetSeconds < $1.element.offsetSeconds
            }
        var valid: [MetricPoint] = []
        valid.reserveCapacity(ordered.count)
        for item in ordered {
            if valid.last?.offsetSeconds == item.element.offsetSeconds { valid[valid.count - 1] = item.element }
            else { valid.append(item.element) }
        }
        validCount = valid.count
        let values = valid.map(\.value)
        minimum = values.min()
        maximum = values.max()
        points = TechPlotSampling.indices(values: values).map { valid[$0] }
    }
}
