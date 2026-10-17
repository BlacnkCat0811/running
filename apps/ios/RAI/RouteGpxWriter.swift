import CryptoKit
import Foundation

/// 一个 GPX 轨迹点。
///
/// 刻意与 `CLLocation` 解耦：本文件只依赖 Foundation/CryptoKit，因而能被
/// `run-health-sync-tests.sh` 的 macOS 编译单元直接编进去断言 —— 而 `CLLocation`/HealthKit
/// 在那些单元里不存在。
nonisolated struct RouteGpxPoint: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    let elevationMeters: Double?
    let timestamp: Date
    let speedMetersPerSecond: Double?
    let courseDegrees: Double?
    let horizontalAccuracyMeters: Double?
    let verticalAccuracyMeters: Double?
}

/// 写出中途触到预算：调用方据此区分"下批满额可再试"与"这条按满额也装不下"。
nonisolated enum RouteGpxBudgetStop: Error, Equatable {
    /// 本批余额不足（本 workout 自身没有超过满额）。
    case budgetDeferred
    /// 本条轨迹自身就超过满额预算（或文件数），任何批次都装不下。
    case oversized
}

/// 路线 GPX 的**流式**写入器。
///
/// ## 为什么不是"先拼字符串再写"
///
/// 旧实现把一整段路线的全部点拼成一个 `String`，再判字节预算 —— 一条 24 小时越野
/// （8.6 万点）在判定之前就已经付出了"整串内存 + 一次 `utf8.count`"。而判定通常是**不通过**：
/// 超限路线白读了 HealthKit、白拼了字符串，最后整段丢弃。
///
/// 现在：每点到达即写、即累加字节、即更新 SHA256；每 `budgetCheckEvery` 点查一次预算，
/// 超限当场停（不再读后面的点）。产物与旧的 `gpx(_:)` **逐字节相同** —— 格式串只有这一份
/// 实现，旧的组合函数改为调用它。
///
/// ## 文件生命周期
///
/// 段内点到达第一个时才建文件（空段不占文件号，与旧实现一致）。写完后 `endSegment()`
/// 才把 entry 计入结果；中途失败用 `discardCurrentSegment()` 只删当前段，`abort()` 删全部。
nonisolated final class RouteGpxWriter {
    struct Result {
        let entries: [(name: String, url: URL)]
        let bytes: Int
        let pointCount: Int
        let routeHash: String?
    }

    /// 与旧的 `gpx(_:)` 逐字节一致的头/尾（改这里必须同步改回归的对照）。
    static let header = """
    <?xml version="1.0" encoding="UTF-8"?>
    <gpx version="1.1" creator="RAI">
      <trk><name>RAI HealthKit route</name><trkseg>
    """
    static let footer = "\n  </trkseg></trk>\n</gpx>\n"
    /// 每多少个点查一次预算。512 点时最坏多写 ~100 KB，对 30 MB 的上限是噪声。
    static let budgetCheckEvery = 512

    private let directory: URL
    private let workoutId: String
    private let maxRouteBytes: Int
    private let maxRouteFiles: Int
    private let usedRouteBytes: Int
    private let usedRouteFiles: Int
    private let iso: ISO8601DateFormatter

    private var entries: [(name: String, url: URL)] = []
    private var handle: FileHandle?
    private var currentURL: URL?
    private var currentName: String?
    private var currentPoints = 0
    private var writtenBytes = 0
    private var pointTotal = 0
    private var digest = SHA256()
    private var finalizedHash: String?

    init(
        directory: URL,
        workoutId: String,
        maxRouteBytes: Int,
        maxRouteFiles: Int,
        usedRouteBytes: Int,
        usedRouteFiles: Int
    ) {
        self.directory = directory
        self.workoutId = workoutId
        self.maxRouteBytes = maxRouteBytes
        self.maxRouteFiles = maxRouteFiles
        self.usedRouteBytes = usedRouteBytes
        self.usedRouteFiles = usedRouteFiles
        self.iso = ISO8601DateFormatter()
        self.iso.formatOptions = [.withInternetDateTime]
    }

    /// 追加一个点。首个点会惰性创建本段文件。
    func append(_ point: RouteGpxPoint) throws {
        if handle == nil { try openSegment() }
        guard let handle else { throw CocoaError(.fileWriteUnknown) }
        let data = Data(Self.pointXML(point, iso: iso).utf8)
        try handle.write(contentsOf: data)
        writtenBytes += data.count
        currentPoints += 1
        pointTotal += 1
        digest.update(data: data)
        if currentPoints % Self.budgetCheckEvery == 0 { try checkBudget() }
    }

    /// 结束当前段：写尾、关闭、把 entry 计入结果。空段什么都不做（不占文件号）。
    func endSegment() throws {
        guard let handle else { return }
        // 🔴 段的**收尾检查**不能省：`budgetCheckEvery` 是 512，单段少于 512 点时循环里
        // 一次都没查过 —— 一条超满额的小轨迹会"顺利写完"，而调用方以为预算是硬的。
        try checkBudget()
        let footer = Data(Self.footer.utf8)
        try handle.write(contentsOf: footer)
        writtenBytes += footer.count
        digest.update(data: footer)
        try handle.close()
        self.handle = nil
        if let url = currentURL, let name = currentName {
            entries.append((name: name, url: url))
        }
        currentURL = nil
        currentName = nil
        currentPoints = 0
    }

    /// 丢弃**当前段**（读取失败/取消），已完成的段保留 —— 与旧实现"单段失败置 `complete=false`、
    /// 最后整体放弃"的调用侧语义配合使用。
    func discardCurrentSegment() {
        try? handle?.close()
        handle = nil
        if let url = currentURL { try? FileManager.default.removeItem(at: url) }
        currentURL = nil
        currentName = nil
        currentPoints = 0
    }

    /// 放弃本 workout 的全部产物（超预算 / 任何一段不完整）。
    func abort() {
        discardCurrentSegment()
        for entry in entries { try? FileManager.default.removeItem(at: entry.url) }
        entries = []
    }

    /// 收尾：关闭当前段并给出观测摘要。空路线 ⇒ `routeHash == nil`（"没有轨迹" ≠ "一段空轨迹"）。
    func finish() throws -> Result {
        try endSegment()
        if finalizedHash == nil {
            finalizedHash = entries.isEmpty
                ? ""
                : digest.finalize().map { String(format: "%02x", $0) }.joined()
        }
        let hash = finalizedHash?.isEmpty == true ? nil : finalizedHash
        return Result(
            entries: entries,
            bytes: writtenBytes,
            pointCount: entries.isEmpty ? 0 : pointTotal,
            routeHash: hash
        )
    }

    // MARK: - 预算

    private func openSegment() throws {
        // 文件数先判：多一个文件就超文件上限 ⇒ 任何批次都装不下（与旧判据同义）。
        guard usedRouteFiles + entries.count + 1 <= maxRouteFiles else {
            throw RouteGpxBudgetStop.oversized
        }
        // 已写字节已经到满额 ⇒ 连空文件都放不进；这是"余额不足"，不是"这条太大"。
        guard usedRouteBytes + writtenBytes < maxRouteBytes else {
            throw RouteGpxBudgetStop.budgetDeferred
        }
        let name = "workout-routes/\(workoutId)_\(entries.count + 1).gpx"
        let url = directory.appendingPathComponent(name)
        // 写端自己保证父目录存在：调用方已经建过一次，但"路径布局"的知识在本类型里，
        // 让它在任何调用点（含回归）都自足，比依赖调用顺序更稳。
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let header = Data(Self.header.utf8)
        try handle.write(contentsOf: header)
        writtenBytes += header.count
        digest.update(data: header)
        self.handle = handle
        self.currentURL = url
        self.currentName = name
        self.currentPoints = 0
    }

    /// 与 `DirectSyncBatchBudget.routeBudgetExhausted` 同判据（`>=`），但只针对本条。
    private func checkBudget() throws {
        if writtenBytes > maxRouteBytes { throw RouteGpxBudgetStop.oversized }
        if usedRouteBytes + writtenBytes >= maxRouteBytes { throw RouteGpxBudgetStop.budgetDeferred }
    }

    // MARK: - 格式

    /// 逐点格式与旧的 `gpx(_:)` **逐字节相同**（属性顺序、可选字段条件、Double 插值都一样）。
    static func pointXML(_ point: RouteGpxPoint, iso: ISO8601DateFormatter) -> String {
        var xml = "\n    <trkpt lat=\"\(point.latitude)\" lon=\"\(point.longitude)\">"
        if let elevation = point.elevationMeters {
            xml += "<ele>\(elevation)</ele>"
        }
        xml += "<time>\(iso.string(from: point.timestamp))</time>"
        if let speed = point.speedMetersPerSecond { xml += "<speed>\(speed)</speed>" }
        if let course = point.courseDegrees { xml += "<course>\(course)</course>" }
        if let horizontal = point.horizontalAccuracyMeters { xml += "<hAcc>\(horizontal)</hAcc>" }
        if let vertical = point.verticalAccuracyMeters { xml += "<vAcc>\(vertical)</vAcc>" }
        xml += "</trkpt>"
        return xml
    }
}
