#if os(iOS)
import CoreLocation
import Foundation
import HealthKit

struct HealthKitExportResult {
    let zipURL: URL
    let workoutCount: Int
    let recordCount: Int
    let routeCount: Int
}

enum HealthKitExportError: LocalizedError {
    case unavailable
    case notAuthorized
    case noRunningWorkouts

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "这台设备没有 Apple 健康数据"
        case .notAuthorized:
            return "未获得 Apple 健康读取权限。请在 iPhone 设置 → 健康 → 数据访问与设备 中打开 RAI。"
        case .noRunningWorkouts:
            return "Apple 健康里没有跑步记录。如果刚才没允许读取，请到设置 → 健康 → 数据访问与设备 中打开 RAI。"
        }
    }
}

private final class ResumeBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?

    init(_ continuation: CheckedContinuation<T, Error>) {
        self.continuation = continuation
    }

    func resume(returning value: T) {
        lock.lock()
        let item = continuation
        continuation = nil
        lock.unlock()
        item?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        lock.lock()
        let item = continuation
        continuation = nil
        lock.unlock()
        item?.resume(throwing: error)
    }
}

enum HealthKitExport {
    static func exportArchive(
        onProgress: @MainActor @escaping (String) -> Void
    ) async throws -> HealthKitExportResult {
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthKitExportError.unavailable }
        let store = HKHealthStore()
        try await store.requestAuthorization(toShare: [], read: readTypes)
        onProgress("正在读取跑步记录")
        let workouts = try await runningWorkouts(store: store)
        if workouts.isEmpty { throw HealthKitExportError.noRunningWorkouts }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-hk-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let xmlURL = directory.appendingPathComponent("export.xml")
        FileManager.default.createFile(atPath: xmlURL.path, contents: nil)
        let xml = try FileHandle(forWritingTo: xmlURL)
        defer { try? xml.close() }

        var files: [(name: String, url: URL)] = [("export.xml", xmlURL)]
        var recordCount = 0
        var routeCount = 0

        try write(xml, """
        <?xml version="1.0" encoding="UTF-8"?>
        <HealthData locale="zh_CN">
          <ExportDate value="\(appleDate(Date()))"/>
          \(meElement(store: store))
        """)

        for (index, workout) in workouts.enumerated() {
            try Task.checkCancellation()
            onProgress("正在读取第 \(index + 1)/\(workouts.count) 次跑步")
            let routeFiles = await routeEntries(for: workout, store: store, directory: directory, startIndex: routeCount)
            routeCount += routeFiles.count
            files.append(contentsOf: routeFiles)
            try write(xml, workoutXML(workout, routeNames: routeFiles.map(\.name)))
            recordCount += try await writeWorkoutRecords(for: workout, store: store, xml: xml)
        }

        onProgress("正在读取心率与恢复数据")
        recordCount += try await writeGlobalRecords(store: store, xml: xml)
        try write(xml, "\n</HealthData>\n")
        try xml.synchronize()

        onProgress("正在打包健康数据")
        let zipURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-health-healthkit-\(UUID().uuidString).zip")
        try StoredZip.write(files: files, to: zipURL)
        try? FileManager.default.removeItem(at: directory)
        return HealthKitExportResult(
            zipURL: zipURL,
            workoutCount: workouts.count,
            recordCount: recordCount,
            routeCount: routeCount
        )
    }

    private static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKQuantityType(.heartRate),
            HKQuantityType(.distanceWalkingRunning),
            HKQuantityType(.activeEnergyBurned),
            HKQuantityType(.stepCount),
            HKQuantityType(.runningSpeed),
            HKQuantityType(.runningPower),
            HKQuantityType(.runningStrideLength),
            HKQuantityType(.runningVerticalOscillation),
            HKQuantityType(.runningGroundContactTime),
            HKQuantityType(.restingHeartRate),
            HKQuantityType(.heartRateVariabilitySDNN),
            HKQuantityType(.vo2Max),
            HKQuantityType(.bodyMass),
            HKCategoryType(.sleepAnalysis)
        ]
        if let recovery = HKQuantityType.quantityType(forIdentifier: .heartRateRecoveryOneMinute) {
            types.insert(recovery)
        }
        return types
    }

    private static func runningWorkouts(store: HKHealthStore) async throws -> [HKWorkout] {
        let predicate = HKQuery.predicateForWorkouts(with: .running)
        return try await samples(type: .workoutType(), predicate: predicate, store: store)
    }

    private static func workoutXML(_ workout: HKWorkout, routeNames: [String]) -> String {
        let source = workout.sourceRevision.source.name
        let version = workout.sourceRevision.version ?? "1"
        let device = workout.device?.name ?? workout.sourceRevision.productType ?? "Watch"
        let durationMinutes = workout.duration / 60
        var body = """

          <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="\(format(durationMinutes))" durationUnit="min" sourceName="\(escape(source))" sourceVersion="\(escape(version))" creationDate="\(appleDate(workout.endDate))" startDate="\(appleDate(workout.startDate))" endDate="\(appleDate(workout.endDate))" device="\(escape(device))">
            <MetadataEntry key="HKIndoorWorkout" value="\(workout.indoor ? "1" : "0")"/>
        """
        let syncId = (workout.metadata?[HKMetadataKeySyncIdentifier] as? String) ?? workout.uuid.uuidString
        body += "    <MetadataEntry key=\"HKMetadataKeySyncIdentifier\" value=\"\(escape(syncId))\"/>\n"
        if let distance = statistic(workout, HKQuantityType(.distanceWalkingRunning), unit: .meter()) {
            body += statisticXML(
                type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
                workout: workout,
                sum: distance / 1000,
                unit: "km"
            )
        }
        if let energy = statistic(workout, HKQuantityType(.activeEnergyBurned), unit: .kilocalorie()) {
            body += statisticXML(
                type: "HKQuantityTypeIdentifierActiveEnergyBurned",
                workout: workout,
                sum: energy,
                unit: "kcal"
            )
        }
        if let heart = statistic(workout, HKQuantityType(.heartRate), unit: HKUnit.count().unitDivided(by: .minute())) {
            body += statisticXML(
                type: "HKQuantityTypeIdentifierHeartRate",
                workout: workout,
                average: heart,
                unit: "count/min"
            )
        }
        for name in routeNames {
            body += """
                <WorkoutRoute sourceName="\(escape(source))" sourceVersion="\(escape(version))" creationDate="\(appleDate(workout.endDate))" startDate="\(appleDate(workout.startDate))" endDate="\(appleDate(workout.endDate))">
                  <FileReference path="\(name)"/>
                </WorkoutRoute>
            """
        }
        body += "  </Workout>"
        return body
    }

    private static func statistic(
        _ workout: HKWorkout,
        _ type: HKQuantityType,
        unit: HKUnit
    ) -> Double? {
        workout.statistics(for: type)?.sumQuantity()?.doubleValue(for: unit)
            ?? workout.statistics(for: type)?.averageQuantity()?.doubleValue(for: unit)
    }

    private static func statisticXML(
        type: String,
        workout: HKWorkout,
        sum: Double? = nil,
        average: Double? = nil,
        unit: String
    ) -> String {
        var attrs = "type=\"\(type)\" startDate=\"\(appleDate(workout.startDate))\" endDate=\"\(appleDate(workout.endDate))\" unit=\"\(unit)\""
        if let sum { attrs += " sum=\"\(format(sum))\"" }
        if let average { attrs += " average=\"\(format(average))\"" }
        return "    <WorkoutStatistics \(attrs)/>\n"
    }

    private static func writeWorkoutRecords(
        for workout: HKWorkout,
        store: HKHealthStore,
        xml: FileHandle
    ) async throws -> Int {
        let types: [(HKQuantityType, HKUnit, String, String)] = [
            (HKQuantityType(.heartRate), HKUnit.count().unitDivided(by: .minute()), "HKQuantityTypeIdentifierHeartRate", "count/min"),
            (HKQuantityType(.distanceWalkingRunning), .meter(), "HKQuantityTypeIdentifierDistanceWalkingRunning", "m"),
            (HKQuantityType(.activeEnergyBurned), .kilocalorie(), "HKQuantityTypeIdentifierActiveEnergyBurned", "kcal"),
            (HKQuantityType(.stepCount), .count(), "HKQuantityTypeIdentifierStepCount", "count"),
            (HKQuantityType(.runningSpeed), HKUnit.meter().unitDivided(by: .second()), "HKQuantityTypeIdentifierRunningSpeed", "m/s"),
            (HKQuantityType(.runningPower), HKUnit.watt(), "HKQuantityTypeIdentifierRunningPower", "W"),
            (HKQuantityType(.runningStrideLength), .meter(), "HKQuantityTypeIdentifierRunningStrideLength", "m"),
            (HKQuantityType(.runningVerticalOscillation), HKUnit.meterUnit(with: .centi), "HKQuantityTypeIdentifierRunningVerticalOscillation", "cm"),
            (HKQuantityType(.runningGroundContactTime), HKUnit.secondUnit(with: .milli), "HKQuantityTypeIdentifierRunningGroundContactTime", "ms")
        ]
        let predicate = HKQuery.predicateForObjects(from: workout)
        var count = 0
        for (type, unit, xmlType, xmlUnit) in types {
            let samples: [HKQuantitySample] = (try? await samples(type: type, predicate: predicate, store: store)) ?? []
            for sample in samples {
                try write(xml, recordXML(sample, type: xmlType, unit: unit, xmlUnit: xmlUnit))
                count += 1
            }
        }
        return count
    }

    private static func writeGlobalRecords(store: HKHealthStore, xml: FileHandle) async throws -> Int {
        let start = Calendar.current.date(byAdding: .year, value: -3, to: Date()) ?? Date.distantPast
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        var count = 0
        let quantities: [(HKQuantityType, HKUnit, String, String)] = [
            (HKQuantityType(.restingHeartRate), HKUnit.count().unitDivided(by: .minute()), "HKQuantityTypeIdentifierRestingHeartRate", "count/min"),
            (HKQuantityType(.heartRateVariabilitySDNN), HKUnit.secondUnit(with: .milli), "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "ms"),
            (HKQuantityType(.vo2Max), HKUnit.literUnit(with: .milli).unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute())), "HKQuantityTypeIdentifierVO2Max", "mL/kg·min"),
            (HKQuantityType(.bodyMass), .gramUnit(with: .kilo), "HKQuantityTypeIdentifierBodyMass", "kg")
        ]
        for (type, unit, xmlType, xmlUnit) in quantities {
            let samples: [HKQuantitySample] = (try? await samples(type: type, predicate: predicate, store: store)) ?? []
            for sample in samples {
                try write(xml, recordXML(sample, type: xmlType, unit: unit, xmlUnit: xmlUnit))
                count += 1
            }
        }
        let sleeps: [HKCategorySample] = (try? await samples(
            type: HKCategoryType(.sleepAnalysis),
            predicate: predicate,
            store: store
        )) ?? []
        for sample in sleeps {
            try write(xml, """

              <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="\(escape(sample.sourceRevision.source.name))" sourceVersion="\(escape(sample.sourceRevision.version ?? "1"))" value="\(sleepName(sample.value))" creationDate="\(appleDate(sample.endDate))" startDate="\(appleDate(sample.startDate))" endDate="\(appleDate(sample.endDate))"/>
            """)
            count += 1
        }
        return count
    }

    private static func samples<T: HKSample>(
        type: HKSampleType,
        predicate: NSPredicate?,
        store: HKHealthStore
    ) async throws -> [T] {
        try await withCheckedThrowingContinuation { continuation in
            let box = ResumeBox<[T]>(continuation)
            let query = HKSampleQuery(
                sampleType: type,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: type is HKWorkoutType
                    ? [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
                    : nil
            ) { _, samples, error in
                if let error {
                    box.resume(throwing: error)
                    return
                }
                box.resume(returning: (samples as? [T]) ?? [])
            }
            store.execute(query)
        }
    }

    private static func recordXML(
        _ sample: HKQuantitySample,
        type: String,
        unit: HKUnit,
        xmlUnit: String
    ) -> String {
        let value = sample.quantity.doubleValue(for: unit)
        let source = sample.sourceRevision.source.name
        let version = sample.sourceRevision.version ?? "1"
        return """

          <Record type="\(type)" sourceName="\(escape(source))" sourceVersion="\(escape(version))" unit="\(xmlUnit)" creationDate="\(appleDate(sample.endDate))" startDate="\(appleDate(sample.startDate))" endDate="\(appleDate(sample.endDate))" value="\(format(value))"/>
        """
    }

    private static func routeEntries(
        for workout: HKWorkout,
        store: HKHealthStore,
        directory: URL,
        startIndex: Int
    ) async -> [(name: String, url: URL)] {
        let routes: [HKWorkoutRoute]
        do {
            routes = try await samples(
                type: HKSeriesType.workoutRoute(),
                predicate: HKQuery.predicateForObjects(from: workout),
                store: store
            )
        } catch {
            return []
        }
        var entries: [(name: String, url: URL)] = []
        let routesDirectory = directory.appendingPathComponent("workout-routes", isDirectory: true)
        try? FileManager.default.createDirectory(at: routesDirectory, withIntermediateDirectories: true)
        for (offset, route) in routes.enumerated() {
            let locations: [CLLocation]
            do {
                locations = try await routeLocations(route, store: store)
            } catch {
                continue
            }
            guard !locations.isEmpty else { continue }
            let name = "workout-routes/route_\(startIndex + offset + 1).gpx"
            let url = directory.appendingPathComponent(name)
            try? gpx(locations).write(to: url, atomically: true, encoding: .utf8)
            if FileManager.default.fileExists(atPath: url.path) {
                entries.append((name: name, url: url))
            }
        }
        return entries
    }

    private static func routeLocations(_ route: HKWorkoutRoute, store: HKHealthStore) async throws -> [CLLocation] {
        try await withCheckedThrowingContinuation { continuation in
            let box = ResumeBox<[CLLocation]>(continuation)
            var collected: [CLLocation] = []
            let query = HKWorkoutRouteQuery(route: route) { _, locations, done, error in
                if let error {
                    box.resume(throwing: error)
                    return
                }
                if let locations { collected.append(contentsOf: locations) }
                if done {
                    box.resume(returning: collected)
                }
            }
            store.execute(query)
        }
    }

    private static func gpx(_ locations: [CLLocation]) -> String {
        var xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <gpx version="1.1" creator="RAI">
          <trk><name>RAI HealthKit route</name><trkseg>
        """
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        for location in locations {
            xml += "\n    <trkpt lat=\"\(location.coordinate.latitude)\" lon=\"\(location.coordinate.longitude)\">"
            if location.verticalAccuracy >= 0 {
                xml += "<ele>\(location.altitude)</ele>"
            }
            xml += "<time>\(iso.string(from: location.timestamp))</time>"
            if location.speed >= 0 { xml += "<speed>\(location.speed)</speed>" }
            if location.course >= 0 { xml += "<course>\(location.course)</course>" }
            if location.horizontalAccuracy >= 0 { xml += "<hAcc>\(location.horizontalAccuracy)</hAcc>" }
            if location.verticalAccuracy >= 0 { xml += "<vAcc>\(location.verticalAccuracy)</vAcc>" }
            xml += "</trkpt>"
        }
        xml += "\n  </trkseg></trk>\n</gpx>\n"
        return xml
    }

    private static func meElement(store: HKHealthStore) -> String {
        var attrs = ""
        if let sex = try? store.biologicalSex() {
            switch sex.biologicalSex {
            case .female: attrs += " biologicalSex=\"HKBiologicalSexFemale\""
            case .male: attrs += " biologicalSex=\"HKBiologicalSexMale\""
            case .other: attrs += " biologicalSex=\"HKBiologicalSexOther\""
            default: break
            }
        }
        return "<Me\(attrs)/>"
    }

    private static func sleepName(_ value: Int) -> String {
        switch value {
        case HKCategoryValueSleepAnalysis.inBed.rawValue:
            return "HKCategoryValueSleepAnalysisInBed"
        case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue:
            return "HKCategoryValueSleepAnalysisAsleepUnspecified"
        case HKCategoryValueSleepAnalysis.awake.rawValue:
            return "HKCategoryValueSleepAnalysisAwake"
        case HKCategoryValueSleepAnalysis.asleepCore.rawValue:
            return "HKCategoryValueSleepAnalysisAsleepCore"
        case HKCategoryValueSleepAnalysis.asleepDeep.rawValue:
            return "HKCategoryValueSleepAnalysisAsleepDeep"
        case HKCategoryValueSleepAnalysis.asleepREM.rawValue:
            return "HKCategoryValueSleepAnalysisAsleepREM"
        default:
            return "HKCategoryValueSleepAnalysisAsleepUnspecified"
        }
    }

    private static let dateLock = NSLock()
    private static let appleDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        return formatter
    }()

    private static func appleDate(_ date: Date) -> String {
        dateLock.lock()
        defer { dateLock.unlock() }
        return appleDateFormatter.string(from: date)
    }

    private static func format(_ value: Double) -> String {
        String(format: "%.4f", value)
    }

    private static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private static func write(_ handle: FileHandle, _ text: String) throws {
        guard let data = text.data(using: .utf8) else { return }
        try handle.write(contentsOf: data)
    }
}

private extension HKWorkout {
    var indoor: Bool {
        if let value = metadata?[HKMetadataKeyIndoorWorkout] as? Bool { return value }
        if let value = metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber { return value.boolValue }
        return false
    }
}
#endif
