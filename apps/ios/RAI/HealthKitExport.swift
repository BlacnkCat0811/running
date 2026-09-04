#if os(iOS)
import CoreLocation
import Foundation
import HealthKit

nonisolated struct HealthKitExportResult: Sendable {
    let zipURL: URL
    let workoutCount: Int
    let recordCount: Int
    let routeCount: Int
    let warnings: [String]
    let maxEndDate: Date?
    let workoutAnchor: Data?
}

nonisolated enum HealthKitExportError: LocalizedError {
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
            return "Apple 健康里没有可读取的跑步记录。请确认健康 App 中已有跑步记录，并在设置 → 健康 → 数据访问与设备中确认 RAI 已开启，然后返回 RAI 重试。"
        }
    }
}

nonisolated private final class ResumeBox<T>: @unchecked Sendable {
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

nonisolated private final class WarningBag: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    func add(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        if !items.contains(message) {
            items.append(message)
        }
    }

    var snapshot: [String] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

nonisolated enum HealthKitExport {
    @MainActor
    static func requestReadAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthKitExportError.unavailable }
        try await HKHealthStore().requestAuthorization(toShare: [], read: readTypes)
    }

    static func exportArchive(
        from startDate: Date?,
        workoutAnchor: Data?,
        onProgress: @escaping @Sendable (String) async -> Void
    ) async throws -> HealthKitExportResult {
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthKitExportError.unavailable }
        let store = HKHealthStore()
        let warnings = WarningBag()
        await onProgress("正在读取跑步记录")
        let (workouts, nextAnchor) = try await runningWorkouts(
            store: store,
            from: startDate,
            anchorData: workoutAnchor
        )
        if workouts.isEmpty {
            // authorizationStatus(for:) only reports whether this app may *save*
            // samples of the type. It does not report read authorization. Since
            // RAI intentionally requests no write types, this status is normally
            // .notDetermined even when the user has granted read access. Query
            // errors are mapped to .notAuthorized in runningWorkouts instead.
            if startDate == nil {
                throw HealthKitExportError.noRunningWorkouts
            }
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-hk-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
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
            await onProgress("正在读取第 \(index + 1)/\(workouts.count) 次跑步")
            let routeFiles = try await routeEntries(
                for: workout,
                store: store,
                directory: directory,
                warnings: warnings
            )
            routeCount += routeFiles.count
            files.append(contentsOf: routeFiles)
            try write(xml, workoutXML(workout, routeNames: routeFiles.map(\.name)))
            recordCount += try await writeWorkoutRecords(for: workout, store: store, xml: xml, warnings: warnings)
        }

        await onProgress("正在读取心率与恢复数据")
        recordCount += try await writeGlobalRecords(store: store, from: startDate, xml: xml, warnings: warnings)
        try write(xml, "\n</HealthData>\n")
        try xml.synchronize()

        await onProgress("正在打包健康数据")
        let zipURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-health-healthkit-\(UUID().uuidString).zip")
        try StoredZip.write(files: files, to: zipURL)
        return HealthKitExportResult(
            zipURL: zipURL,
            workoutCount: workouts.count,
            recordCount: recordCount,
            routeCount: routeCount,
            warnings: warnings.snapshot,
            maxEndDate: workouts.map(\.endDate).max(),
            workoutAnchor: nextAnchor
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
            HKQuantityType(.respiratoryRate),
            HKCategoryType(.sleepAnalysis)
        ]
        if let recovery = HKQuantityType.quantityType(forIdentifier: .heartRateRecoveryOneMinute) {
            types.insert(recovery)
        }
        if let physicalEffort = HKQuantityType.quantityType(forIdentifier: .physicalEffort) {
            types.insert(physicalEffort)
        }
        if let wrist = HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature) {
            types.insert(wrist)
        }
        if let biologicalSex = HKObjectType.characteristicType(forIdentifier: .biologicalSex) {
            types.insert(biologicalSex)
        }
        if let birth = HKObjectType.characteristicType(forIdentifier: .dateOfBirth) {
            types.insert(birth)
        }
        return types
    }

    private static func runningWorkouts(
        store: HKHealthStore,
        from startDate: Date?,
        anchorData: Data?
    ) async throws -> (workouts: [HKWorkout], anchor: Data?) {
        if let anchorData, let stored = decodeAnchor(anchorData) {
            do {
                let (added, next) = try await anchoredWorkouts(store: store, anchor: stored)
                return (added, encodeAnchor(next))
            } catch {
                if isAuthorizationError(error) { throw HealthKitExportError.notAuthorized }
            }
        }
        var predicates = [HKQuery.predicateForWorkouts(with: .running)]
        if let startDate {
            predicates.append(HKQuery.predicateForSamples(withStart: startDate, end: nil, options: .strictStartDate))
        }
        do {
            let workouts: [HKWorkout] = try await samples(
                type: .workoutType(),
                predicate: NSCompoundPredicate(andPredicateWithSubpredicates: predicates),
                store: store
            )
            let (_, next) = try await anchoredWorkouts(store: store, anchor: nil)
            return (workouts, encodeAnchor(next))
        } catch {
            if isAuthorizationError(error) {
                throw HealthKitExportError.notAuthorized
            }
            throw error
        }
    }

    private static func workoutXML(_ workout: HKWorkout, routeNames: [String]) -> String {
        let source = workout.sourceRevision.source.name
        let version = workout.sourceRevision.version ?? "1"
        let device = deviceDescription(workout.device) ?? workout.device?.name ?? workout.sourceRevision.productType ?? "Watch"
        let durationMinutes = workout.duration / 60
        let created = workout.startDate
        var body = """

          <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="\(format(durationMinutes))" durationUnit="min" sourceName="\(escape(source))" sourceVersion="\(escape(version))" creationDate="\(appleDate(created))" startDate="\(appleDate(workout.startDate))" endDate="\(appleDate(workout.endDate))" device="\(escape(device))">
            <MetadataEntry key="HKIndoorWorkout" value="\(isIndoor(workout) ? "1" : "0")"/>
        """
        body += "    <MetadataEntry key=\"HKMetadataKeySyncIdentifier\" value=\"\(escape(workoutSyncId(workout)))\"/>\n"
        body += metadataXML(workout)
        body += workoutEventXML(workout)
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
        body += heartRateStatisticXML(workout)
        for name in routeNames {
            body += """
                <WorkoutRoute sourceName="\(escape(source))" sourceVersion="\(escape(version))" creationDate="\(appleDate(created))" startDate="\(appleDate(workout.startDate))" endDate="\(appleDate(workout.endDate))">
                  <FileReference path="\(escape(name))"/>
                </WorkoutRoute>
            """
        }
        body += "  </Workout>"
        return body
    }

    private static func workoutEventXML(_ workout: HKWorkout) -> String {
        var body = ""
        for event in workout.workoutEvents ?? [] {
            guard let typeName = eventTypeName(event.type) else { continue }
            var attrs = "type=\"\(typeName)\" date=\"\(appleDate(event.dateInterval.start))\""
            let duration = event.dateInterval.duration
            if duration > 0 {
                attrs += " duration=\"\(format(duration))\" durationUnit=\"s\""
            }
            body += "    <WorkoutEvent \(attrs)/>\n"
        }
        return body
    }

    private static func eventTypeName(_ type: HKWorkoutEventType) -> String? {
        switch type {
        case .pause: return "HKWorkoutEventTypePause"
        case .resume: return "HKWorkoutEventTypeResume"
        case .motionPaused: return "HKWorkoutEventTypeMotionPaused"
        case .motionResumed: return "HKWorkoutEventTypeMotionResumed"
        default: return nil
        }
    }

    private static func statistic(
        _ workout: HKWorkout,
        _ type: HKQuantityType,
        unit: HKUnit
    ) -> Double? {
        workout.statistics(for: type)?.sumQuantity()?.doubleValue(for: unit)
            ?? workout.statistics(for: type)?.averageQuantity()?.doubleValue(for: unit)
    }

    private static func heartRateStatisticXML(_ workout: HKWorkout) -> String {
        let type = HKQuantityType(.heartRate)
        guard let stats = workout.statistics(for: type) else { return "" }
        let unit = HKUnit.count().unitDivided(by: .minute())
        let average = stats.averageQuantity()?.doubleValue(for: unit)
        let minimum = stats.minimumQuantity()?.doubleValue(for: unit)
        let maximum = stats.maximumQuantity()?.doubleValue(for: unit)
        guard average != nil || minimum != nil || maximum != nil else { return "" }
        return statisticXML(
            type: "HKQuantityTypeIdentifierHeartRate",
            workout: workout,
            average: average,
            minimum: minimum,
            maximum: maximum,
            unit: "count/min"
        )
    }

    private static func statisticXML(
        type: String,
        workout: HKWorkout,
        sum: Double? = nil,
        average: Double? = nil,
        minimum: Double? = nil,
        maximum: Double? = nil,
        unit: String
    ) -> String {
        var attrs = "type=\"\(type)\" startDate=\"\(appleDate(workout.startDate))\" endDate=\"\(appleDate(workout.endDate))\" unit=\"\(unit)\""
        if let sum { attrs += " sum=\"\(format(sum))\"" }
        if let average { attrs += " average=\"\(format(average))\"" }
        if let minimum { attrs += " minimum=\"\(format(minimum))\"" }
        if let maximum { attrs += " maximum=\"\(format(maximum))\"" }
        return "    <WorkoutStatistics \(attrs)/>\n"
    }

    private static func writeWorkoutRecords(
        for workout: HKWorkout,
        store: HKHealthStore,
        xml: FileHandle,
        warnings: WarningBag
    ) async throws -> Int {
        var types: [(HKQuantityType, HKUnit, String, String, String)] = [
            (HKQuantityType(.heartRate), HKUnit.count().unitDivided(by: .minute()), "HKQuantityTypeIdentifierHeartRate", "count/min", "未授权读取心率"),
            (HKQuantityType(.distanceWalkingRunning), .meter(), "HKQuantityTypeIdentifierDistanceWalkingRunning", "m", "部分健康数据类型未授权"),
            (HKQuantityType(.activeEnergyBurned), .kilocalorie(), "HKQuantityTypeIdentifierActiveEnergyBurned", "kcal", "部分健康数据类型未授权"),
            (HKQuantityType(.stepCount), .count(), "HKQuantityTypeIdentifierStepCount", "count", "部分健康数据类型未授权"),
            (HKQuantityType(.runningSpeed), HKUnit.meter().unitDivided(by: .second()), "HKQuantityTypeIdentifierRunningSpeed", "m/s", "部分健康数据类型未授权"),
            (HKQuantityType(.runningPower), HKUnit.watt(), "HKQuantityTypeIdentifierRunningPower", "W", "部分健康数据类型未授权"),
            (HKQuantityType(.runningStrideLength), .meter(), "HKQuantityTypeIdentifierRunningStrideLength", "m", "部分健康数据类型未授权"),
            (HKQuantityType(.runningVerticalOscillation), HKUnit.meterUnit(with: .centi), "HKQuantityTypeIdentifierRunningVerticalOscillation", "cm", "部分健康数据类型未授权"),
            (HKQuantityType(.runningGroundContactTime), HKUnit.secondUnit(with: .milli), "HKQuantityTypeIdentifierRunningGroundContactTime", "ms", "部分健康数据类型未授权")
        ]
        if let physicalEffort = HKQuantityType.quantityType(forIdentifier: .physicalEffort) {
            let unit = HKUnit.kilocalorie().unitDivided(by: HKUnit.hour().unitMultiplied(by: .gramUnit(with: .kilo)))
            types.append((
                physicalEffort,
                unit,
                "HKQuantityTypeIdentifierPhysicalEffort",
                "kcal/hr·kg",
                "部分健康数据类型未授权"
            ))
        }
        let predicate = HKQuery.predicateForObjects(from: workout)
        var count = 0
        for (type, unit, xmlType, xmlUnit, denied) in types {
            let samples: [HKQuantitySample] = try await optionalSamples(
                type: type,
                predicate: predicate,
                store: store,
                warnings: warnings,
                deniedMessage: denied
            )
            for sample in samples {
                try write(xml, recordXML(sample, type: xmlType, unit: unit, xmlUnit: xmlUnit))
                count += 1
            }
        }
        return count
    }

    private static func writeGlobalRecords(
        store: HKHealthStore,
        from startDate: Date?,
        xml: FileHandle,
        warnings: WarningBag
    ) async throws -> Int {
        let start = startDate ?? Calendar.current.date(byAdding: .year, value: -3, to: Date()) ?? Date.distantPast
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        var count = 0
        var quantities: [(HKQuantityType, HKUnit, String, String)] = [
            (HKQuantityType(.restingHeartRate), HKUnit.count().unitDivided(by: .minute()), "HKQuantityTypeIdentifierRestingHeartRate", "count/min"),
            (HKQuantityType(.heartRateVariabilitySDNN), HKUnit.secondUnit(with: .milli), "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "ms"),
            (HKQuantityType(.vo2Max), HKUnit.literUnit(with: .milli).unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute())), "HKQuantityTypeIdentifierVO2Max", "mL/min·kg"),
            (HKQuantityType(.bodyMass), .gramUnit(with: .kilo), "HKQuantityTypeIdentifierBodyMass", "kg"),
            (HKQuantityType(.respiratoryRate), HKUnit.count().unitDivided(by: .minute()), "HKQuantityTypeIdentifierRespiratoryRate", "count/min")
        ]
        if let wrist = HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature) {
            quantities.append((
                wrist,
                .degreeCelsius(),
                "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
                "degC"
            ))
        }
        if let recovery = HKQuantityType.quantityType(forIdentifier: .heartRateRecoveryOneMinute) {
            quantities.append((
                recovery,
                HKUnit.count().unitDivided(by: .minute()),
                "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
                "count/min"
            ))
        }
        for (type, unit, xmlType, xmlUnit) in quantities {
            let samples: [HKQuantitySample] = try await optionalSamples(
                type: type,
                predicate: predicate,
                store: store,
                warnings: warnings,
                deniedMessage: "部分恢复数据未授权"
            )
            for sample in samples {
                try write(xml, recordXML(sample, type: xmlType, unit: unit, xmlUnit: xmlUnit))
                count += 1
            }
        }
        let sleeps: [HKCategorySample] = try await optionalSamples(
            type: HKCategoryType(.sleepAnalysis),
            predicate: predicate,
            store: store,
            warnings: warnings,
            deniedMessage: "部分恢复数据未授权"
        )
        for sample in sleeps {
            var attrs = "type=\"HKCategoryTypeIdentifierSleepAnalysis\" sourceName=\"\(escape(sample.sourceRevision.source.name))\" sourceVersion=\"\(escape(sample.sourceRevision.version ?? "1"))\""
            if let device = deviceDescription(sample.device) {
                attrs += " device=\"\(escape(device))\""
            }
            attrs += " value=\"\(sleepName(sample.value))\" creationDate=\"\(appleDate(sample.startDate))\" startDate=\"\(appleDate(sample.startDate))\" endDate=\"\(appleDate(sample.endDate))\""
            try write(xml, "\n              <Record \(attrs)/>")
            count += 1
        }
        return count
    }

    private static func optionalSamples<T: HKSample>(
        type: HKSampleType,
        predicate: NSPredicate?,
        store: HKHealthStore,
        warnings: WarningBag,
        deniedMessage: String
    ) async throws -> [T] {
        do {
            return try await samples(type: type, predicate: predicate, store: store)
        } catch {
            if isAuthorizationError(error) {
                warnings.add(deniedMessage)
                return []
            }
            if isNoDataError(error) {
                return []
            }
            throw error
        }
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
        var attrs = "type=\"\(type)\" sourceName=\"\(escape(source))\" sourceVersion=\"\(escape(version))\""
        if let device = deviceDescription(sample.device) {
            attrs += " device=\"\(escape(device))\""
        }
        attrs += " unit=\"\(xmlUnit)\" creationDate=\"\(appleDate(sample.startDate))\" startDate=\"\(appleDate(sample.startDate))\" endDate=\"\(appleDate(sample.endDate))\" value=\"\(format(value))\""
        return "\n          <Record \(attrs)/>"
    }

    private static func routeEntries(
        for workout: HKWorkout,
        store: HKHealthStore,
        directory: URL,
        warnings: WarningBag
    ) async throws -> [(name: String, url: URL)] {
        let routes: [HKWorkoutRoute] = try await optionalSamples(
            type: HKSeriesType.workoutRoute(),
            predicate: HKQuery.predicateForObjects(from: workout),
            store: store,
            warnings: warnings,
            deniedMessage: "未授权读取路线"
        )
        var entries: [(name: String, url: URL)] = []
        let routesDirectory = directory.appendingPathComponent("workout-routes", isDirectory: true)
        try FileManager.default.createDirectory(at: routesDirectory, withIntermediateDirectories: true)
        let workoutId = routeFileWorkoutId(workout)
        for route in routes {
            let locations: [CLLocation]
            do {
                locations = try await routeLocations(route, store: store)
            } catch {
                if isAuthorizationError(error) {
                    warnings.add("未授权读取路线")
                    continue
                }
                if isNoDataError(error) {
                    continue
                }
                throw error
            }
            guard !locations.isEmpty else { continue }
            let name = "workout-routes/\(workoutId)_\(entries.count + 1).gpx"
            let url = directory.appendingPathComponent(name)
            try gpx(locations).write(to: url, atomically: true, encoding: .utf8)
            if FileManager.default.fileExists(atPath: url.path) {
                entries.append((name: name, url: url))
            }
        }
        return entries
    }

    private static func workoutSyncId(_ workout: HKWorkout) -> String {
        let raw = (workout.metadata?[HKMetadataKeySyncIdentifier] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (raw?.isEmpty == false) ? raw! : workout.uuid.uuidString
    }

    private static func routeFileWorkoutId(_ workout: HKWorkout) -> String {
        workout.uuid.uuidString
    }

    private static func routeLocations(_ route: HKWorkoutRoute, store: HKHealthStore) async throws -> [CLLocation] {
        try await withCheckedThrowingContinuation { continuation in
            let box = ResumeBox<[CLLocation]>(continuation)
            let lock = NSLock()
            var collected: [CLLocation] = []
            let query = HKWorkoutRouteQuery(route: route) { _, locations, done, error in
                if let error {
                    box.resume(throwing: error)
                    return
                }
                lock.lock()
                if let locations { collected.append(contentsOf: locations) }
                let finished = done ? collected : nil
                lock.unlock()
                if let finished {
                    box.resume(returning: finished)
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
        if let components = try? store.dateOfBirthComponents(), let date = Calendar.current.date(from: components) {
            attrs += " dateOfBirth=\"\(appleDate(date))\""
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

    private static func metadataXML(_ workout: HKWorkout) -> String {
        guard let metadata = workout.metadata else { return "" }
        var body = ""
        let skip = Set([HKMetadataKeyIndoorWorkout, HKMetadataKeySyncIdentifier])
        for (key, value) in metadata {
            if skip.contains(key) { continue }
            guard let serialized = serializeMetadata(value) else { continue }
            body += "    <MetadataEntry key=\"\(escape(key))\" value=\"\(escape(serialized))\"/>\n"
        }
        return body
    }

    private static func serializeMetadata(_ value: Any) -> String? {
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number.stringValue }
        if let flag = value as? Bool { return flag ? "1" : "0" }
        if let quantity = value as? HKQuantity {
            if quantity.is(compatibleWith: .degreeCelsius()) {
                return "\(format(quantity.doubleValue(for: .degreeCelsius()))) degC"
            }
            if quantity.is(compatibleWith: .degreeFahrenheit()) {
                return "\(format(quantity.doubleValue(for: .degreeFahrenheit()))) degF"
            }
            if quantity.is(compatibleWith: .percent()) {
                return "\(format(quantity.doubleValue(for: .percent()) * 100)) %"
            }
            if quantity.is(compatibleWith: .meter()) {
                return "\(format(quantity.doubleValue(for: .meter()))) m"
            }
            let mets = HKUnit.kilocalorie().unitDivided(by: HKUnit.hour().unitMultiplied(by: .gramUnit(with: .kilo)))
            if quantity.is(compatibleWith: mets) {
                return "\(format(quantity.doubleValue(for: mets))) kcal/hr·kg"
            }
        }
        return String(describing: value)
    }

    private static func anchoredWorkouts(
        store: HKHealthStore,
        anchor: HKQueryAnchor?
    ) async throws -> (added: [HKWorkout], next: HKQueryAnchor) {
        try await withCheckedThrowingContinuation { continuation in
            let box = ResumeBox<(added: [HKWorkout], next: HKQueryAnchor)>(continuation)
            let query = HKAnchoredObjectQuery(
                type: .workoutType(),
                predicate: HKQuery.predicateForWorkouts(with: .running),
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
                if let error {
                    box.resume(throwing: error)
                    return
                }
                box.resume(returning: (
                    added: (samples as? [HKWorkout]) ?? [],
                    next: newAnchor ?? HKQueryAnchor(fromValue: 0)
                ))
            }
            store.execute(query)
        }
    }

    private static func encodeAnchor(_ anchor: HKQueryAnchor) -> Data? {
        try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
    }

    private static func decodeAnchor(_ data: Data) -> HKQueryAnchor? {
        try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private static func isIndoor(_ workout: HKWorkout) -> Bool {
        if let value = workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool { return value }
        if let value = workout.metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber { return value.boolValue }
        return false
    }

    private static func deviceDescription(_ device: HKDevice?) -> String? {
        guard let device else { return nil }
        var parts: [String] = []
        if let name = device.name { parts.append("name:\(name)") }
        if let manufacturer = device.manufacturer { parts.append("manufacturer:\(manufacturer)") }
        if let model = device.model { parts.append("model:\(model)") }
        if let hardware = device.hardwareVersion { parts.append("hardware:\(hardware)") }
        if let software = device.softwareVersion { parts.append("software:\(software)") }
        if parts.isEmpty { return device.name }
        return "<<" + parts.joined(separator: ", ") + ">>"
    }

    private static func isAuthorizationError(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == HKError.errorDomain else { return false }
        return nsError.code == HKError.Code.errorAuthorizationDenied.rawValue
            || nsError.code == HKError.Code.errorAuthorizationNotDetermined.rawValue
    }

    private static func isNoDataError(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == HKError.errorDomain else { return false }
        return nsError.code == HKError.Code.errorNoData.rawValue
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
#endif
