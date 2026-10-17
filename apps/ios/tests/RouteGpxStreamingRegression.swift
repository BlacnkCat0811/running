import CryptoKit
import Foundation

/// `RouteGpxWriter` 的字节与预算判据。
///
/// 判据的核心不是"写出来了"，而是**与旧的拼串实现逐字节相同**：路线摘要
/// （`RouteSyncRecord.routeHash`）是"这条轨迹有没有变"的唯一证据，格式上多一个空格就会让
/// 每一次同步都判定"轨迹变了"，进而每轮重读 GPX。
///
/// 本文件是纯 Foundation/CryptoKit（不含 `CLLocation`/HealthKit），因此能在 macOS 上直接跑。
/// 旧的拼串实现被**抄进这里当 oracle**：生产侧改成流式之后，这条对照是唯一还能发现
/// "格式漂移"的地方。
@main
struct RouteGpxStreamingRegression {
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-gpx-stream-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        // ---- 1. 字节一致（含全部可选字段缺失 / 600 点跨过一次预算检查）----
        let points = fixturePoints(count: 600)
        let writer = RouteGpxWriter(
            directory: root, workoutId: "abc-123", maxRouteBytes: 30_000_000,
            maxRouteFiles: 180, usedRouteBytes: 0, usedRouteFiles: 0
        )
        for point in points { try writer.append(point) }
        try writer.endSegment()
        let written = try writer.finish()
        check(written.entries.count == 1, "one segment produces one file")
        let data = try Data(contentsOf: written.entries[0].url)
        let legacy = legacyDocument(points)
        check(data == Data(legacy.utf8), "streamed GPX is byte-identical to the legacy document")
        check(written.bytes == data.count, "reported bytes equal the file size")
        check(written.pointCount == points.count, "point count matches")
        check(written.routeHash == sha256Hex(data), "route hash matches the file content")

        // ---- 2. 空段不占文件号 ----
        let second = RouteGpxWriter(
            directory: root, workoutId: "def-456", maxRouteBytes: 30_000_000,
            maxRouteFiles: 180, usedRouteBytes: 0, usedRouteFiles: 0
        )
        for point in fixturePoints(count: 2) { try second.append(point) }
        try second.endSegment()
        try second.endSegment() // 空段：什么都不写
        for point in fixturePoints(count: 3) { try second.append(point) }
        try second.endSegment()
        let twoSegments = try second.finish()
        check(twoSegments.entries.map(\.name) == [
            "workout-routes/def-456_1.gpx", "workout-routes/def-456_2.gpx"
        ], "an empty segment does not consume a file index")
        check(twoSegments.pointCount == 5, "points from both segments are counted")

        // ---- 3. 预算：单段自身超满额 ⇒ oversized；余额不足 ⇒ budgetDeferred ----
        let oversizedWriter = RouteGpxWriter(
            directory: root, workoutId: "big-1", maxRouteBytes: 120,
            maxRouteFiles: 180, usedRouteBytes: 0, usedRouteFiles: 0
        )
        try oversizedWriter.append(fixturePoints(count: 1)[0])
        var oversized = false
        do { try oversizedWriter.endSegment() } catch RouteGpxBudgetStop.oversized { oversized = true }
        check(oversized, "a single segment past the full budget is oversized, not deferred")
        oversizedWriter.abort()
        check(!FileManager.default.fileExists(atPath: root.appendingPathComponent("workout-routes/big-1_1.gpx").path),
              "abort removes the partial file")

        let deferredWriter = RouteGpxWriter(
            directory: root, workoutId: "defer-1", maxRouteBytes: 400,
            maxRouteFiles: 180, usedRouteBytes: 380, usedRouteFiles: 0
        )
        try deferredWriter.append(fixturePoints(count: 1)[0])
        var deferred = false
        do { try deferredWriter.endSegment() } catch RouteGpxBudgetStop.budgetDeferred { deferred = true }
        check(deferred, "exhausted batch budget is deferred, not oversized")
        deferredWriter.abort()

        let fileLimited = RouteGpxWriter(
            directory: root, workoutId: "files-1", maxRouteBytes: 30_000_000,
            maxRouteFiles: 1, usedRouteBytes: 0, usedRouteFiles: 1
        )
        var fileStop = false
        do { try fileLimited.append(fixturePoints(count: 1)[0]) } catch RouteGpxBudgetStop.oversized { fileStop = true }
        check(fileStop, "file-count overflow is oversized")
        fileLimited.abort()

        // ---- 4. 失败后整体放弃：已完成的段也删掉（半条轨迹比没有更坏）----
        let failing = RouteGpxWriter(
            directory: root, workoutId: "fail-1", maxRouteBytes: 30_000_000,
            maxRouteFiles: 180, usedRouteBytes: 0, usedRouteFiles: 0
        )
        for point in fixturePoints(count: 2) { try failing.append(point) }
        try failing.endSegment()
        for point in fixturePoints(count: 2) { try failing.append(point) } // 第二段写到一半
        failing.abort()
        let leftover = (try? FileManager.default.contentsOfDirectory(
            atPath: root.appendingPathComponent("workout-routes").path
        )) ?? []
        check(!leftover.contains { $0.hasPrefix("fail-1_") }, "abort removes every file of the workout")

        print("OK: \(checks) checks")
    }

    // MARK: - 夹具与 oracle

    private static func fixturePoints(count: Int) -> [RouteGpxPoint] {
        var points: [RouteGpxPoint] = []
        points.reserveCapacity(count)
        for index in 0..<count {
            let latitude: Double = 23.0 + Double(index) / 100_000
            let longitude: Double = 113.0 + Double(index) / 100_000
            let elevation: Double? = index % 3 == 0 ? (10.5 + Double(index) / 100) : nil
            let timestamp = Date(timeIntervalSince1970: 1_772_000_000 + Double(index))
            let speed: Double? = index % 4 == 0 ? 2.75 : nil
            let course: Double? = index % 5 == 0 ? 91.25 : nil
            let horizontal: Double? = index % 6 == 0 ? 4.5 : nil
            let vertical: Double? = index % 7 == 0 ? 3.25 : nil
            points.append(RouteGpxPoint(
                latitude: latitude,
                longitude: longitude,
                elevationMeters: elevation,
                timestamp: timestamp,
                speedMetersPerSecond: speed,
                courseDegrees: course,
                horizontalAccuracyMeters: horizontal,
                verticalAccuracyMeters: vertical
            ))
        }
        return points
    }

    /// **旧实现**（`HealthKitExport.gpx(_:)` 的拼串版）逐字复制，作为格式 oracle。
    /// ⛔ 不要改成调用 `RouteGpxWriter.pointXML` —— 那会让这个对照变成同义反复。
    private static func legacyDocument(_ points: [RouteGpxPoint]) -> String {
        var xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <gpx version="1.1" creator="RAI">
          <trk><name>RAI HealthKit route</name><trkseg>
        """
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        for point in points {
            xml += "\n    <trkpt lat=\"\(point.latitude)\" lon=\"\(point.longitude)\">"
            if let elevation = point.elevationMeters {
                xml += "<ele>\(elevation)</ele>"
            }
            xml += "<time>\(iso.string(from: point.timestamp))</time>"
            if let speed = point.speedMetersPerSecond { xml += "<speed>\(speed)</speed>" }
            if let course = point.courseDegrees { xml += "<course>\(course)</course>" }
            if let horizontal = point.horizontalAccuracyMeters { xml += "<hAcc>\(horizontal)</hAcc>" }
            if let vertical = point.verticalAccuracyMeters { xml += "<vAcc>\(vertical)</vAcc>" }
            xml += "</trkpt>"
        }
        xml += "\n  </trkseg></trk>\n</gpx>\n"
        return xml
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
