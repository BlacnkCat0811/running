import Foundation

/// Pure draft rules for the native training-session editor.
///
/// The server owns dose measurement, including time-to-distance conversion.
/// Only a distance-only structure has a locally knowable total. Persisted
/// historical values survive unchanged edits; they are checked by the server.
enum TrainingPlanSessionEditorPolicy {
    struct DraftIdentity: Equatable {
        let scope: PlanReceiptScope
        let planInstanceId: String
        let stateRevision: Int
        let sessionId: String?
        let sessionRevision: Int?

        func issue(scope currentScope: PlanReceiptScope?, planInstanceId currentInstance: String?,
                   stateRevision currentRevision: Int?, session: TrainingPlanSessionsView.Session?) -> String? {
            guard currentScope == scope, currentInstance == planInstanceId, currentRevision == stateRevision,
                  sessionId == session?.sessionId, sessionRevision == session?.sessionRevision,
                  session == nil || session?.planInstanceId == planInstanceId else {
                return "计划或课程修订已变化，旧草稿不能提交；请重新读取并重建草稿。"
            }
            if sessionId != nil && (session == nil || session?.lifecycle != "pending" || session?.supersededBySessionId != nil) {
                return "当前课程不能修改。"
            }
            return nil
        }

        func issue(in snapshot: TrainingPlanStateResponseV2?) -> String? {
            issue(scope: snapshot?.scope, planInstanceId: snapshot?.sessions?.planInstanceId,
                stateRevision: snapshot?.stateRevision,
                session: snapshot?.sessions?.sessions.first { $0.sessionId == sessionId })
        }

        func matches(_ draft: TrainingPlanSessionDraft) -> Bool {
            switch draft {
            case let .move(id, revision, _), let .edit(id, revision, _), let .cancel(id, revision), let .unlock(id, revision):
                return id == sessionId && revision == sessionRevision
            case .add, .setRest: return sessionId == nil
            }
        }
    }

    /// Mirrors `apps/api/src/session-structure.ts` (`MAX_STEP_METERS` /
    /// `MAX_STEP_SECONDS`). The editor must not accept a step the server will
    /// reject after preview.
    static let maximumBlocks = 8
    static let maximumStepsPerBlock = 8
    static let maximumBlockIterations = 20
    static let maximumStepMeters = 100_000.0
    static let maximumStepSeconds = 4 * 60 * 60.0

    enum StructureDistance: Equatable {
        /// A valid structure with no distance goal: a purely time-based dose.
        case none
        /// Integer-meter total across warmup, every block iteration and cooldown.
        case meters(Int)
        /// Contains both time and distance goals. The sum of distance goals is
        /// not its total; only the server has the pace model to measure it.
        case mixed
        /// Missing/legacy/open/invalid structure: not editable under the new
        /// prescription contract until the user supplies a measurable dose.
        case invalid
    }

    enum DistanceResolution: Equatable {
        /// `nil` is an explicit wire `distanceKm: null`, not "leave unchanged".
        case value(Double?)
        /// Omit distanceKm: keep unchanged persisted dose or let the server
        /// measure a changed/new structure. Never encode a fabricated zero.
        case serverMeasured
        case failure(String)
    }

    static func compatibleDistance(_ resolution: DistanceResolution, omissionSupported: Bool,
                                   original: MobilePlannedDay?, structure: MobileSessionStructure?, kind: String) -> DistanceResolution {
        guard resolution == .serverMeasured, !omissionSupported else { return resolution }
        if let original, original.structure == structure, original.kind == kind {
            return .value(original.distanceKm)
        }
        return .failure("服务器尚未确认省略距离能力，请升级服务器后再调整混合剂量课程。")
    }

    /// The editor starts new (or structure-less legacy) drafts with one blank
    /// work step. It deliberately contains no distance or duration value, so a
    /// user has to choose a real dose instead of accepting a fabricated one.
    static func blankStructure() -> MobileSessionStructure {
        .init(warmup: nil,
              blocks: [.init(iterations: 1, steps: [.init(purpose: "work", goal: .open, alert: nil)])],
              cooldown: nil)
    }


    /// Lossless display text for the editor's `distanceKm` field. The server
    /// accepts whole meters (e.g. 8.05 km = 8,050 m); formatting with `%.1f`
    /// would turn it into "8.1" and make a valid distance structure fail the
    /// integer-meter consistency check. Whole kilometres omit the decimal part,
    /// otherwise trailing zeros are trimmed from the three-digit meter remainder.
    static func distanceText(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0 else { return "" }
        guard let wholeMeters = Int(exactly: (value * 1_000).rounded()), wholeMeters >= 0 else { return "" }
        let kilometres = wholeMeters / 1_000
        let remainder = wholeMeters % 1_000
        if remainder == 0 { return "\(kilometres)" }
        var fraction = String(format: "%03d", remainder)
        while fraction.hasSuffix("0") { fraction.removeLast() }
        return "\(kilometres).\(fraction)"
    }

    static func structureDistance(_ structure: MobileSessionStructure?) -> StructureDistance {
        guard let structure, !structure.blocks.isEmpty, structure.blocks.count <= maximumBlocks else { return .invalid }
        var totalMeters = 0
        var hasDistance = false
        var hasTime = false

        func validStep(_ step: MobileWorkoutStep, multiplier: Int) -> Bool {
            switch step.goal {
            case let .distance(meters):
                guard meters.isFinite, meters >= 1, meters <= maximumStepMeters,
                      let wholeMeters = Int(exactly: meters.rounded()) else { return false }
                let added = wholeMeters.multipliedReportingOverflow(by: multiplier)
                guard !added.overflow else { return false }
                let total = totalMeters.addingReportingOverflow(added.partialValue)
                guard !total.overflow else { return false }
                totalMeters = total.partialValue
                hasDistance = true
                return true
            case let .time(seconds):
                hasTime = true
                return seconds.isFinite && seconds >= 1 && seconds <= maximumStepSeconds && seconds.rounded() == seconds
            case .open:
                return false
            }
        }

        if let warmup = structure.warmup, !validStep(warmup, multiplier: 1) { return .invalid }
        for block in structure.blocks {
            guard block.iterations >= 1, block.iterations <= maximumBlockIterations,
                  !block.steps.isEmpty, block.steps.count <= maximumStepsPerBlock else { return .invalid }
            for step in block.steps where !validStep(step, multiplier: block.iterations) { return .invalid }
        }
        if let cooldown = structure.cooldown, !validStep(cooldown, multiplier: 1) { return .invalid }
        return hasDistance ? (hasTime ? .mixed : .meters(totalMeters)) : .none
    }

    /// Resolve the distance text against the structure that will be submitted.
    ///
    /// Pure time can send null; mixed doses delegate to the server. Unchanged
    /// historical distance values are forwarded/preserved without local
    /// rescaling. Explicit distance-only changes still compare whole metres.
    static func resolveDistance(_ text: String, structure: MobileSessionStructure?,
                                original: MobilePlannedDay? = nil, kind: String? = nil) -> DistanceResolution {
        if let structure, structure.blocks.count > maximumBlocks ||
            structure.blocks.contains(where: { $0.steps.count > maximumStepsPerBlock || $0.iterations > maximumBlockIterations }) {
            return .failure("课程最多8个训练区块，每区块最多8步、20次重复；修改历史超限课程须先调整为合法结构。")
        }
        let unchanged = original != nil && original?.structure == structure && original?.kind == kind
        switch structureDistance(structure) {
        case .invalid:
            return .failure("课程结构不完整或仍含未填写剂量；请填写明确的分段剂量。")
        case .none:
            if unchanged, original?.distanceKm != nil { return .serverMeasured }
            return .value(nil)
        case .mixed:
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                guard let value = Double(trimmed), value.isFinite, value > 0, value <= 80 else {
                    return .failure("总距离必须是大于 0 且不超过 80 公里的有效数值。")
                }
            }
            return .serverMeasured
        case let .meters(meters):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let kilometers = Double(trimmed), kilometers.isFinite, kilometers > 0, kilometers <= 80,
                  let displayedMeters = Int(exactly: (kilometers * 1_000).rounded()) else {
                return .failure("有距离结构的课程必须填写总距离（公里）。")
            }
            if unchanged, kilometers == original?.distanceKm { return .value(kilometers) }
            guard displayedMeters == meters else {
                return .failure("总距离与分段结构不一致：结构合计 \(meters) 米，当前填写 \(displayedMeters) 米。")
            }
            return .value(Double(meters) / 1_000)
        }
    }
}
