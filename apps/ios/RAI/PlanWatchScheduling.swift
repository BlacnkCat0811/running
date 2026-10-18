import Foundation

struct PlanWatchDayResult: Equatable {
    enum Status: String { case confirmed, failed, filtered }
    let localDate: String
    let status: Status
    let reason: String?
}

struct PlanWatchSyncOutcome: Equatable {
    var scheduled = 0
    var attempted = 0
    var skipped = 0
    var authorized = false
    var verified = false
    var deviceUnsupported = false
    var authorizationState: String?
    var timeZoneFallback = false
    var offered = 0
    var expired = 0
    var alreadyTrained = 0
    var clearVerified = false
    var didAttemptClear = false
    var superseded = false
    var cleanupVerified = true
    var validationError: String?
    var storageError: String?
    var submittedEntries: [PlanScheduledEntry] = []
    var submittedRequests: [PlanSchedulingRequest] = []
    var confirmedEntries: [PlanScheduledEntry] = []
    var receipts: [PlanSyncReceipt] = []
    var days: [PlanWatchDayResult] = []

    var scheduledLocalDates: [String] { confirmedEntries.map(\.localDate) }
    var report: String {
        if let storageError {
            return storageError + (didAttemptClear || !submittedEntries.isEmpty
                ? "；需要重新核验，不能宣称排期成功。"
                : "；未启动新的系统排期副作用。")
        }
        if deviceUnsupported { return "此设备不支持系统训练排期；需要已配对 Apple Watch 的 iPhone（模拟器不支持）。" }
        if superseded {
            if submittedEntries.isEmpty {
                if !didAttemptClear { return "计划已变化，本次同步已在提交排期前终止，未改动系统排期。" }
                return clearVerified ? "计划已变化，本次同步已终止；未下发新训练，旧排期已核验清空。"
                    : "计划已变化，本次同步已终止；旧排期未能确认撤回，请显式撤回并检查手表。"
            }
            return cleanupVerified ? "计划已变化，本次同步已终止并核验撤回本次条目。"
                : "计划已变化，本次同步已终止；本次旧条目未能确认撤回，请显式撤回并检查手表。"
        }
        if !authorized {
            return authorizationState == "denied"
                ? "排期授权已被拒绝，请在系统设置检查 RAI 的体能训练计划授权；具体入口以当前系统为准。"
                : "尚未获得系统训练排期授权（\(authorizationState ?? "未知")）。"
        }
        if let validationError { return validationError + "；未改动系统排期。" }
        if offered == 0 {
            return clearVerified ? "当前窗口没有需要下发的新训练；系统旧排期已核验清空。"
                : "没有新训练，但旧排期未能确认撤回，请重试并检查手表「体能训练」。"
        }
        var text = verified ? "系统训练日程已核验 \(scheduled) 项。" : "系统训练日程部分核验 \(scheduled)/\(offered) 项，未核验日期不登记回执。"
        if !clearVerified { text += " 旧排期未能确认撤回。" }
        let reasons = days.filter { $0.status != .confirmed }.compactMap { day in day.reason.map { "\(day.localDate)：\($0)" } }
        if !reasons.isEmpty { text += " " + reasons.joined(separator: "；") }
        if expired + alreadyTrained > 0 { text += "（\(expired) 天已过去，\(alreadyTrained) 天已记录训练，不再排期）" }
        text += " 请在配对手表确认实际可见。"
        return text
    }
}

struct PlanWatchClearOutcome: Equatable {
    var authorized: Bool
    var verified: Bool
    var deviceUnsupported = false
    var authorizationState: String?
    var superseded = false
    var report: String {
        if deviceUnsupported { return "此设备不支持系统训练排期，尚未撤回旧排期。" }
        if superseded { return "撤回操作已失效，系统排期状态需要重新核验；请显式重试。" }
        if !authorized {
            if authorizationState == "restricted" { return "系统限制了训练排期授权，尚未撤回旧排期；请检查系统限制设置。" }
            if authorizationState == "denied" { return "排期授权已被拒绝，尚未撤回旧排期；请在系统设置检查 RAI 的体能训练计划授权。" }
            return "未获排期授权，尚未撤回旧排期；请检查系统设置。"
        }
        return verified ? "系统旧排期已核验清空；请在配对手表确认。"
            : "未能确认旧排期已撤回，请重试并检查手表「体能训练」。"
    }
}

struct PlanSchedulingRequest: Equatable {
    let entry: PlanScheduledEntry
    let at: DateComponents
    let workout: PlannedWorkout
    let exportedStructure: MobileSessionStructure
    let exportNotes: [String]
    var kind: String = "easy"
}

struct PlanSchedulingReadback: Equatable {
    let workoutID: UUID
    let at: DateComponents
    let contentMatches: Bool
    let complete: Bool
}

/// SDK boundary with no Apple types, executed unchanged by fake-scheduler tests.
@MainActor
protocol WorkoutScheduling: AnyObject {
    var isSupported: Bool { get }
    var capacity: Int { get }
    func authorization() async -> String
    func requestAuthorization() async -> String
    func prepare(_ request: PlanSchedulingRequest) -> String?
    func schedule(_ request: PlanSchedulingRequest) async
    func remove(_ request: PlanSchedulingRequest) async
    func removeEntries(_ entries: [PlanScheduledEntry]) async
    func removeAll() async
    func readBack() async -> [PlanSchedulingReadback]
}

@MainActor
enum PlanWatchScheduling {
    static func clear(scheduler: any WorkoutScheduling, journal: PlanScheduleJournal, isCurrent: () -> Bool) async -> PlanWatchClearOutcome {
        guard scheduler.isSupported else { return .init(authorized: false, verified: false, deviceUnsupported: true) }
        guard isCurrent() else { return .init(authorized: false, verified: false, superseded: true) }
        var state = await scheduler.authorization()
        guard isCurrent() else { return .init(authorized: state == "authorized", verified: false, superseded: true) }
        if state == "notDetermined" {
            state = await scheduler.requestAuthorization()
            guard isCurrent() else { return .init(authorized: state == "authorized", verified: false, superseded: true) }
        }
        guard state == "authorized" else { return .init(authorized: false, verified: false, authorizationState: state) }
        guard isCurrent() else { return .init(authorized: true, verified: false, superseded: true) }
        guard journal.prepareClear(), journal.persist(.clearing) else { return .init(authorized: true, verified: false) }
        await scheduler.removeAll()
        let remaining = await scheduler.readBack()
        let current = isCurrent()
        let persisted = journal.persist(remaining.isEmpty && current ? .verifying : .withdrawalRequired)
        return .init(authorized: true, verified: remaining.isEmpty && current && persisted, superseded: !current)
    }

    static func sync(
        scheduler: any WorkoutScheduling, plan: MobileWorkoutPlanResponse, completedDates: Set<String>,
        hour: Int, now: Date, journal: PlanScheduleJournal, isCurrent: () -> Bool
    ) async -> PlanWatchSyncOutcome {
        var outcome = PlanWatchSyncOutcome()
        guard scheduler.isSupported else { outcome.deviceUnsupported = true; return outcome }
        guard isCurrent() else { outcome.superseded = true; return outcome }
        var state = await scheduler.authorization()
        guard isCurrent() else { outcome.superseded = true; return outcome }
        if state == "notDetermined" {
            state = await scheduler.requestAuthorization()
            guard isCurrent() else { outcome.superseded = true; return outcome }
        }
        outcome.authorizationState = state
        guard state == "authorized" else { return outcome }
        outcome.authorized = true
        // Unsafe execution metadata never receives an optimistic timezone default.
        guard let zone = TimeZone(identifier: plan.timezone), (1...14).contains(plan.windowDays),
              Set(plan.days.map(\.localDate)).count == plan.days.count else {
            outcome.validationError = "排期时区、窗口或逐日身份无法确认"
            outcome.days = plan.days.map { .init(localDate: $0.localDate, status: .filtered, reason: "排期时区／窗口无法确认") }
            return outcome
        }
        let offer = WorkoutPlanMapper.weekOffer(in: plan, now: now, completedLocalDates: completedDates, hour: hour)
        outcome.expired = offer.expired
        outcome.alreadyTrained = offer.alreadyTrained
        // Include prescribed days lost by the tolerant mapper in coverage, not
        // just pending requests. Rest, past and completed days are not owed.
        let localToday = UserDataNoticePolicy.localDate(now: now, timezone: plan.timezone)
        let owed = plan.days.filter { $0.kind != "rest" && $0.localDate >= localToday && !completedDates.contains($0.localDate) && $0.executable }
        outcome.offered = owed.count
        var requests: [PlanSchedulingRequest] = []
        for day in plan.days where !owed.contains(where: { $0.localDate == day.localDate }) {
            outcome.days.append(.init(localDate: day.localDate, status: .filtered, reason: "休息、已完成、已过去或暂不可执行"))
        }
        for day in owed {
            guard isCurrent() else { outcome.superseded = true; return outcome }
            guard requests.count < scheduler.capacity else {
                outcome.days.append(.init(localDate: day.localDate, status: .failed, reason: "系统排期容量不足")); continue
            }
            guard ["easy", "recovery", "long_run", "tempo", "interval"].contains(day.kind) else {
                outcome.days.append(.init(localDate: day.localDate, status: .failed, reason: "未知训练类型，拒绝导出")); continue
            }
            let mapping = WorkoutPlanMapper.executionMapping(from: day, hour: hour)
            guard let mapped = mapping.workout, let structure = mapping.exportedStructure,
                  let at = WorkoutPlanMapper.scheduleComponents(for: mapped, timeZone: zone, now: now),
                  let instant = PlanReceiptMatcher.instant(at, fallbackTimeZone: zone),
                  UserDataNoticePolicy.localDate(now: instant, timezone: plan.timezone) == day.localDate else {
                outcome.days.append(.init(localDate: day.localDate, status: .failed, reason: "必要步骤／剂量或排期日期无法无损导出")); continue
            }
            let request = PlanSchedulingRequest(entry: .init(workoutID: UUID(), localDate: day.localDate, scheduledAt: instant),
                at: at, workout: mapped, exportedStructure: structure, exportNotes: structure == day.structure ? [] : ["目标区间规范化；回执为实际导出结构"], kind: day.kind)
            if let reason = scheduler.prepare(request) {
                outcome.days.append(.init(localDate: day.localDate, status: .failed, reason: reason)); continue
            }
            requests.append(request)
        }
        guard isCurrent() else { outcome.superseded = true; return outcome }
        guard requests.count == owed.count else {
            outcome.validationError = "预检未全部通过，保留旧排期；请修正失败日期后重试"
            return outcome
        }
        guard journal.prepare(requests) else {
            outcome.storageError = "无法持久化排期意图，未改动系统排期"
            return outcome
        }
        let before = await scheduler.readBack()
        guard isCurrent() else { outcome.superseded = true; return outcome }
        let previousIDs = Set(journal.operation.previousEntries.map(\.workoutID))
        guard before.allSatisfy({ previousIDs.contains($0.workoutID) }) else {
            outcome.validationError = "系统旧排期未能确认撤回或属于其他服务；请先显式管理旧日程"
            return outcome
        }
        guard journal.persist(.clearing) else { outcome.storageError = "排期清理意图未持久化，未改动系统排期"; return outcome }
        outcome.didAttemptClear = true
        await scheduler.removeEntries(journal.operation.previousEntries)
        let afterClear = await scheduler.readBack()
        outcome.clearVerified = afterClear.isEmpty
        var submitted: [PlanSchedulingRequest] = []
        func superseded() async -> PlanWatchSyncOutcome {
            outcome.submittedRequests = submitted
            return await withdrawSuperseded(outcome, scheduler: scheduler, journal: journal)
        }
        guard isCurrent() else { return await superseded() }
        // A silent clear failure must not be made to look like a replacement.
        guard outcome.clearVerified else { outcome.skipped = owed.count; return outcome }
        for request in requests {
            guard isCurrent() else { return await superseded() }
            guard journal.persist(.scheduling, entry: request.entry.workoutID, itemPhase: .submitting) else {
                outcome.storageError = "单条提交意图未持久化，停止后续排期"
                outcome.submittedRequests = submitted
                outcome.submittedEntries = submitted.map(\.entry)
                return outcome
            }
            // Include even silent/partial calls in cleanup.
            submitted.append(request)
            await scheduler.schedule(request)
            guard journal.persist(.scheduling, entry: request.entry.workoutID, itemPhase: .returned) else {
                outcome.storageError = "系统调用后日志写入失败，请前台重新核验"
                outcome.submittedRequests = submitted
                outcome.submittedEntries = submitted.map(\.entry)
                return outcome
            }
            guard isCurrent() else { return await superseded() }
        }
        outcome.attempted = submitted.count
        outcome.submittedEntries = submitted.map(\.entry)
        outcome.submittedRequests = submitted
        guard journal.persist(.verifying) else { outcome.storageError = "读回意图未持久化，请重新核验"; return outcome }
        // One read, no guessed delay. Device measurements can later justify a
        // bounded retry; a missing entry currently stays honestly unverified.
        let listed = await scheduler.readBack()
        guard isCurrent() else { return await superseded() }
        outcome.clearVerified = outcome.clearVerified &&
            PlanReceiptMatcher.hasOnlyRequestedEntries(requests: requests, listed: listed, timeZone: zone)
        let confirmed = PlanReceiptMatcher.confirm(requests: requests, listed: listed, timeZone: zone)
        for request in requests {
            if confirmed.contains(request.entry.workoutID) {
                outcome.confirmedEntries.append(request.entry)
                outcome.days.append(.init(localDate: request.entry.localDate, status: .confirmed, reason: nil))
                if let day = plan.days.first(where: { $0.localDate == request.entry.localDate }) {
                    outcome.receipts.append(PlanSyncReceipt(localDate: day.localDate, kind: day.kind, revision: plan.planRevision,
                        structure: request.exportedStructure, workoutID: request.entry.workoutID.uuidString,
                        scheduledAt: ISO8601DateFormatter().string(from: request.entry.scheduledAt),
                        idempotencyKey: request.entry.workoutID.uuidString, exportNotes: request.exportNotes))
                }
            } else {
                outcome.days.append(.init(localDate: request.entry.localDate, status: .failed, reason: "系统未读回匹配的 UUID、时刻与内容"))
            }
        }
        outcome.scheduled = outcome.confirmedEntries.count
        outcome.skipped = outcome.offered - outcome.scheduled
        outcome.verified = outcome.clearVerified && outcome.scheduled == outcome.offered
        return outcome
    }

    /// Also covers changes during foreground receipt POSTs, after SDK readback
    /// but before the whole coordinated operation returns to the user.
    static func withdrawSuperseded(_ original: PlanWatchSyncOutcome, scheduler: any WorkoutScheduling, journal: PlanScheduleJournal) async -> PlanWatchSyncOutcome {
        var outcome = original
        outcome.superseded = true
        outcome.submittedEntries = outcome.submittedRequests.map(\.entry)
        guard journal.persist(.withdrawalRequired) else {
            outcome.cleanupVerified = false; outcome.storageError = "撤回意图无法持久化，请重新核验"; return outcome
        }
        await scheduler.removeEntries(outcome.submittedEntries)
        let left = await scheduler.readBack()
        // UUID + 精确时刻的身份匹配；与 WorkoutKitBridge.removeEntries 一致。
        outcome.cleanupVerified = !PlanReceiptMatcher.hasResidualEntries(outcome.submittedEntries, in: left,
            timeZone: PlanReceiptMatcher.planTimeZone(journal.operation.timezone))
        outcome.clearVerified = left.isEmpty && outcome.didAttemptClear
        outcome.verified = false
        outcome.receipts = []
        outcome.confirmedEntries = []
        _ = journal.persist(outcome.cleanupVerified ? .verifying : .withdrawalRequired)
        return outcome
    }

    static func recover(scheduler: any WorkoutScheduling, journal: PlanScheduleJournal, withdraw: Bool, isCurrent: () -> Bool) async -> PlanWatchSyncOutcome {
        var outcome = PlanWatchSyncOutcome()
        guard scheduler.isSupported else { outcome.deviceUnsupported = true; return outcome }
        var state = await scheduler.authorization()
        guard isCurrent() else { outcome.superseded = true; return outcome }
        if state == "notDetermined" { state = await scheduler.requestAuthorization() }
        guard isCurrent() else { outcome.superseded = true; return outcome }
        outcome.authorizationState = state; outcome.authorized = state == "authorized"
        guard outcome.authorized else { return outcome }
        if journal.operation.clearAll && !withdraw {
            guard journal.persist(.verifying) else { outcome.storageError = "核验意图未持久化"; return outcome }
            let remaining = await scheduler.readBack()
            guard isCurrent() else { outcome.superseded = true; return outcome }
            outcome.clearVerified = remaining.isEmpty; outcome.cleanupVerified = remaining.isEmpty
            outcome.verified = remaining.isEmpty
            return outcome
        }
        if withdraw {
            guard journal.persist(.withdrawalRequired) else { outcome.storageError = "撤回意图未持久化"; return outcome }
            let entries = journal.operation.items.filter { $0.phase != .prepared }.map(\.entry) + journal.operation.previousEntries
            if journal.operation.clearAll { await scheduler.removeAll() }
            else { await scheduler.removeEntries(entries) }
            let remaining = await scheduler.readBack()
            // 同 withdrawSuperseded：UUID + 精确 scheduledAt 才是本操作的条目身份。
            outcome.cleanupVerified = journal.operation.clearAll ? remaining.isEmpty
                : !PlanReceiptMatcher.hasResidualEntries(entries, in: remaining,
                    timeZone: PlanReceiptMatcher.planTimeZone(journal.operation.timezone))
            outcome.clearVerified = remaining.isEmpty
            outcome.verified = outcome.cleanupVerified && isCurrent()
            if !journal.persist(outcome.verified ? .verifying : .withdrawalRequired) {
                outcome.verified = false; outcome.cleanupVerified = false; outcome.storageError = "撤回结果未持久化"
            }
            return outcome
        }
        let requests = journal.operation.requests()
        outcome.offered = journal.operation.items.count
        guard requests.count == outcome.offered, let zone = TimeZone(identifier: journal.operation.timezone),
              requests.allSatisfy({ scheduler.prepare($0) == nil }) else { outcome.validationError = "无法重建原操作的实际导出内容，只能显式撤回"; return outcome }
        guard journal.persist(.verifying) else { outcome.storageError = "核验意图未持久化"; return outcome }
        let listed = await scheduler.readBack()
        guard isCurrent() else { outcome.superseded = true; return outcome }
        let confirmed = PlanReceiptMatcher.confirm(requests: requests, listed: listed, timeZone: zone)
        outcome.confirmedEntries = requests.filter { confirmed.contains($0.entry.workoutID) }.map(\.entry)
        outcome.scheduled = outcome.confirmedEntries.count
        outcome.clearVerified = PlanReceiptMatcher.hasOnlyRequestedEntries(requests: requests, listed: listed, timeZone: zone)
        if !outcome.clearVerified {
            outcome.validationError = "系统日程存在原操作之外的条目或重复 UUID／时刻；请先显式核验或撤回旧排期"
        }
        outcome.verified = outcome.clearVerified && outcome.offered > 0 && outcome.scheduled == outcome.offered
        outcome.submittedRequests = requests
        outcome.submittedEntries = requests.map(\.entry)
        return outcome
    }
}
