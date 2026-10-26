import Foundation

/// P2.10 pure regression: the session editor may send `distanceKm: null` for a
/// time-only structure, must not fabricate a 5 km dose, and delegates mixed
/// structure measurement to the server while preserving historical totals.
@main struct TrainingPlanSessionEditorRegression {
    static func main() throws {
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            count += 1
            print("PASS: \(name)")
        }
        func time(_ seconds: Double) -> MobileWorkoutStep {
            .init(purpose: "work", goal: .time(seconds: seconds), alert: nil)
        }
        func distance(_ meters: Double) -> MobileWorkoutStep {
            .init(purpose: "work", goal: .distance(meters: meters), alert: nil)
        }
        func structure(warmup: MobileWorkoutStep? = nil,
                       blocks: [MobileIntervalBlock],
                       cooldown: MobileWorkoutStep? = nil) -> MobileSessionStructure {
            .init(warmup: warmup, blocks: blocks, cooldown: cooldown)
        }

        // EDIT-01: the identity is captured when the form opens, before refresh.
        struct SessionFixture: Decodable {
            let scope: PlanReceiptScope
            let initial: TrainingPlanSessionsView.Session
        }
        let sessionFixture = try JSONDecoder().decode(SessionFixture.self, from: Data(contentsOf:
            URL(fileURLWithPath: "apps/ios/tests/fixtures/training-plan-sessions-v2.json")))
        let opened = sessionFixture.initial
        let binding = TrainingPlanSessionEditorPolicy.DraftIdentity(scope: sessionFixture.scope,
            planInstanceId: opened.planInstanceId, stateRevision: 7,
            sessionId: opened.sessionId, sessionRevision: opened.sessionRevision)
        check(binding.issue(scope: sessionFixture.scope, planInstanceId: opened.planInstanceId,
            stateRevision: 7, session: opened) == nil, "EDIT-01: original form identity is usable")
        let refreshed = TrainingPlanSessionsView.Session(planInstanceId: opened.planInstanceId,
            sessionId: opened.sessionId, sessionRevision: opened.sessionRevision + 1,
            prescription: opened.prescription, recommendation: opened.recommendation, userOverride: opened.userOverride,
            protection: "user_protected", lifecycle: "pending", availableAt: opened.availableAt, supersededBySessionId: nil)
        check(binding.issue(scope: sessionFixture.scope, planInstanceId: opened.planInstanceId,
            stateRevision: 8, session: refreshed) != nil,
              "EDIT-01: background refresh cannot wrap an old draft with the new revision")
        check(binding.issue(scope: sessionFixture.scope, planInstanceId: "replacement", stateRevision: 7, session: opened) != nil,
              "EDIT-01: replacing the plan invalidates the open form")
        check(binding.issue(scope: sessionFixture.scope, planInstanceId: opened.planInstanceId,
            stateRevision: 8, session: opened) != nil, "EDIT-01: even unchanged course needs explicit reload after state change")
        let addBinding = TrainingPlanSessionEditorPolicy.DraftIdentity(scope: sessionFixture.scope,
            planInstanceId: opened.planInstanceId, stateRevision: 7, sessionId: nil, sessionRevision: nil)
        check(addBinding.issue(scope: sessionFixture.scope, planInstanceId: "replacement", stateRevision: 8, session: nil) != nil,
              "EDIT-01: new course drafts cannot cross plan instances")

        // A purely time-based prescription (the contract permits distanceKm:null).
        let timeOnly = structure(warmup: time(600),
            blocks: [.init(iterations: 3, steps: [time(300), time(60)])],
            cooldown: time(300))
        check(TrainingPlanSessionEditorPolicy.structureDistance(timeOnly) == .none,
              "a structure with no distance goal is recognised as purely time-based")
        check(TrainingPlanSessionEditorPolicy.resolveDistance("", structure: timeOnly) == .value(nil),
              "an empty distance on a time-only structure encodes distanceKm:null")
        check(TrainingPlanSessionEditorPolicy.resolveDistance("5.0", structure: timeOnly) == .value(nil),
              "a stale display distance cannot turn a time-only structure into a fake 5 km prescription")

        // A distance structure requires an exactly matching displayed total.
        let distanceOnly = structure(blocks: [.init(iterations: 2, steps: [distance(5_000)])])
        check(TrainingPlanSessionEditorPolicy.structureDistance(distanceOnly) == .meters(10_000),
              "block iterations multiply the structure's integer-meter distance")
        check(TrainingPlanSessionEditorPolicy.resolveDistance("10", structure: distanceOnly) == .value(10),
              "a consistent total distance is accepted and normalised from the structure")
        check(TrainingPlanSessionEditorPolicy.resolveDistance("10.0004", structure: distanceOnly) == .value(10),
              "integer-meter comparison tolerates floating display noise, not a real mismatch")
        if case .failure = TrainingPlanSessionEditorPolicy.resolveDistance("9.999", structure: distanceOnly) {
            check(true, "a displayed total below the structure's metres is rejected")
        } else {
            check(false, "a displayed total below the structure's metres is rejected")
        }
        if case .failure = TrainingPlanSessionEditorPolicy.resolveDistance("", structure: distanceOnly) {
            check(true, "a distance structure cannot be saved with an empty distance")
        } else {
            check(false, "a distance structure cannot be saved with an empty distance")
        }
        if case .failure = TrainingPlanSessionEditorPolicy.resolveDistance("ten", structure: distanceOnly) {
            check(true, "a non-numeric distance is rejected instead of silently becoming zero")
        } else {
            check(false, "a non-numeric distance is rejected instead of silently becoming zero")
        }

        // Mixed and edge structures.
        let mixed = structure(warmup: distance(1_000),
            blocks: [.init(iterations: 4, steps: [distance(800), time(90)])],
            cooldown: time(300))
        var negotiated = RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
            syncProtocolVersion: 1, apiVersion: "v1", trainingPlanContractVersion: 2,
            trainingPlanSessionContractVersion: 1, trainingPlanSessionCommandContractVersion: 1,
            planPublicationContractVersion: 1)
        for version in [nil, 0, 2, -1] as [Int?] {
            negotiated.trainingPlanSessionDistanceOmissionContractVersion = version
            check(!negotiated.trainingPlanSessionDistanceOmissionSupported,
                  "COMPAT-01: absent/unknown omission capability does not inherit session command 1")
        }
        negotiated.trainingPlanSessionDistanceOmissionContractVersion = 1
        check(negotiated.trainingPlanSessionDistanceOmissionSupported, "COMPAT-01: exact omission 1 is supported")
        negotiated.planPublicationContractVersion = nil
        check(!negotiated.trainingPlanSessionDistanceOmissionSupported, "COMPAT-01: omission does not bypass durable/session dependencies")
        let oldMixed = MobilePlannedDay(localDate: "2026-10-28", kind: "easy", distanceKm: 5.8, structure: mixed, reason: nil)
        check(TrainingPlanSessionEditorPolicy.compatibleDistance(.serverMeasured, omissionSupported: false,
            original: oldMixed, structure: mixed, kind: "easy") == .value(5.8),
              "COMPAT-01: unchanged historical mixed course keeps explicit legal old distance")
        if case .failure = TrainingPlanSessionEditorPolicy.compatibleDistance(.serverMeasured, omissionSupported: false,
            original: nil, structure: mixed, kind: "easy") {
            check(true, "COMPAT-01: new mixed dose requires upgrade before sending omission")
        } else { check(false, "old server cannot receive unnegotiated omission") }
        check(TrainingPlanSessionEditorPolicy.compatibleDistance(.value(nil), omissionSupported: false,
            original: nil, structure: timeOnly, kind: "easy") == .value(nil), "COMPAT-01: explicit time-only null stays compatible")
        let delegated = TrainingPlanSessionDraft.add(oldMixed, deriveDistance: true)
        check(delegated.requiresDistanceOmission, "COMPAT-01: omitted add requires capability")
        struct WireCommand: Encodable { let draft: TrainingPlanSessionDraft }
        let delegatedWire = try JSONEncoder().encode(WireCommand(draft: delegated))
        check(TrainingPlanSessionDraft.payloadRequiresDistanceOmission(delegatedWire),
              "COMPAT-01: durable omitted add cannot replay to a downgraded server")
        let reasonOnly = TrainingPlanSessionDraft.edit(sessionId: "s", sessionRevision: 1,
            patch: .init(reason: "legacy legal patch", updatesReason: true))
        let reasonWire = try JSONEncoder().encode(WireCommand(draft: reasonOnly))
        check(!reasonOnly.requiresDistanceOmission &&
              !TrainingPlanSessionDraft.payloadRequiresDistanceOmission(reasonWire),
              "COMPAT-01: old reason-only patches remain compatible without new capability")
        check(TrainingPlanSessionEditorPolicy.structureDistance(mixed) == .mixed,
              "mixed dose is not mislabelled as its 4,200 m distance-step subtotal")
        check(TrainingPlanSessionEditorPolicy.resolveDistance("5.822", structure: mixed) == .serverMeasured,
              "D-02: a server-measured mixed total can reach preview")
        check(TrainingPlanSessionEditorPolicy.resolveDistance("", structure: mixed) == .serverMeasured,
              "a mixed draft can ask the server to measure without inventing a total")
        for invalid in ["0", "-1", "NaN", "infinity", "abc", "80.001"] {
            if case .failure = TrainingPlanSessionEditorPolicy.resolveDistance(invalid, structure: mixed) {
                check(true, "mixed draft rejects invalid explicit distance: \(invalid)")
            } else { check(false, "invalid mixed distance cannot become zero or reach preview") }
        }
        check(TrainingPlanSessionEditorPolicy.structureDistance(nil) == .invalid,
              "a legacy structure-less prescription is not misread as time-only")
        let blank = TrainingPlanSessionEditorPolicy.blankStructure()
        check(TrainingPlanSessionEditorPolicy.structureDistance(blank) == .invalid &&
              blank.blocks.count == 1 && blank.blocks[0].steps.count == 1 &&
              blank.blocks[0].steps[0].goal == .open,
              "the editor starts without a fabricated 5 km dose; the blank open step must be filled by the user")
        if case .failure = TrainingPlanSessionEditorPolicy.resolveDistance("5", structure: blank) {
            check(true, "the blank/open structure cannot silently become a 5 km prescription")
        } else {
            check(false, "the blank/open structure cannot silently become a 5 km prescription")
        }
        let openLegacy = structure(blocks: [.init(iterations: 1, steps: [.init(purpose: "work", goal: .open, alert: nil)])])
        check(TrainingPlanSessionEditorPolicy.structureDistance(openLegacy) == .invalid,
              "legacy open steps stay readable but cannot back a new editable dose")

        // Whole-meter display values must round-trip losslessly. A 8.05 km
        // prescription is 8,050 m; %.1f ("8.1") would fail its own structure.
        let eightPointZeroFive = structure(blocks: [.init(iterations: 1, steps: [distance(8_050)])])
        let exactText = TrainingPlanSessionEditorPolicy.distanceText(8.05)
        check(exactText == "8.05" &&
              TrainingPlanSessionEditorPolicy.resolveDistance(exactText, structure: eightPointZeroFive) == .value(8.05),
              "the editor seeds 8.05 km losslessly, and the seeded text matches the 8,050 m structure")
        check(TrainingPlanSessionEditorPolicy.distanceText(8) == "8",
              "whole kilometres omit the decimal part")
        let eightThousand = structure(blocks: [.init(iterations: 1, steps: [distance(8_000)])])
        check(TrainingPlanSessionEditorPolicy.resolveDistance(
                TrainingPlanSessionEditorPolicy.distanceText(8), structure: eightThousand) == .value(8),
              "a whole-kilometre display value resolves against its 8,000 m structure")
        check(TrainingPlanSessionEditorPolicy.distanceText(8.001) == "8.001" &&
              TrainingPlanSessionEditorPolicy.distanceText(nil) == "" &&
              TrainingPlanSessionEditorPolicy.distanceText(-1) == "",
              "distance text keeps the minimal exact fraction and treats absent/invalid values as empty")
        check(TrainingPlanSessionEditorPolicy.structureDistance(
                structure(blocks: [.init(iterations: 1, steps: [distance(100_000)])])) == .meters(100_000) &&
              TrainingPlanSessionEditorPolicy.structureDistance(
                structure(blocks: [.init(iterations: 1, steps: [distance(100_001)])])) == .invalid,
              "a single step is capped at the server's MAX_STEP_METERS=100000")

        let eightSteps = structure(blocks: [.init(iterations: 1, steps: Array(repeating: distance(100), count: 8))])
        let nineSteps = structure(blocks: [.init(iterations: 1, steps: Array(repeating: distance(100), count: 9))])
        check(TrainingPlanSessionEditorPolicy.structureDistance(eightSteps) == .meters(800), "D-03: eight steps are editable")
        check(TrainingPlanSessionEditorPolicy.structureDistance(nineSteps) == .invalid, "D-03: nine steps cannot reach preview")
        check(TrainingPlanSessionEditorPolicy.structureDistance(structure(blocks:
            Array(repeating: .init(iterations: 1, steps: [distance(100)]), count: 8))) == .meters(800), "D-03: eight blocks are editable")
        check(TrainingPlanSessionEditorPolicy.structureDistance(structure(blocks:
            Array(repeating: .init(iterations: 1, steps: [distance(100)]), count: 9))) == .invalid, "D-03: nine blocks cannot reach preview")
        check(TrainingPlanSessionEditorPolicy.structureDistance(structure(blocks: [.init(iterations: 20, steps: [distance(100)])])) == .meters(2000), "D-03: twenty iterations are editable")
        check(TrainingPlanSessionEditorPolicy.structureDistance(structure(blocks: [.init(iterations: 21, steps: [distance(100)])])) == .invalid, "D-03: twenty-one iterations cannot reach preview")
        let historical = MobilePlannedDay(localDate: "2026-10-28", kind: "easy", distanceKm: 0.9, structure: nineSteps, reason: nil)
        if case .failure = TrainingPlanSessionEditorPolicy.resolveDistance("0.9", structure: nineSteps, original: historical, kind: "easy") {
            check(true, "D-03: an unchanged historical over-limit structure cannot be resubmitted as content")
        } else { check(false, "D-03: history is not a write-validation exemption") }
        let decoded = try JSONDecoder().decode(MobilePlannedDay.self, from: JSONEncoder().encode(historical))
        check(decoded.structure == nineSteps, "D-03: history decoding preserves every step")

        struct DistanceFixture: Decodable {
            struct Course: Decodable {
                struct Measurement: Decodable { let distanceKm: Double; let durationSeconds: Double }
                let id: String
                let prescription: MobilePlannedDay
                let measured: Measurement
                let editorDistanceMode: String
            }
            let cases: [Course]
        }
        let fixture = try JSONDecoder().decode(DistanceFixture.self, from: Data(contentsOf:
            URL(fileURLWithPath: "apps/ios/tests/fixtures/training-session-distance-v1.json")))
        for item in fixture.cases {
            let day = item.prescription
            let text = TrainingPlanSessionEditorPolicy.distanceText(day.distanceKm)
            let result = TrainingPlanSessionEditorPolicy.resolveDistance(text, structure: day.structure, original: day, kind: day.kind)
            let updatesDistance: Bool, distanceKm: Double?
            switch result {
            case let .value(value): updatesDistance = true; distanceKm = value
            case .serverMeasured: updatesDistance = false; distanceKm = nil
            case .failure: preconditionFailure("fixed legal course rejected: \(item.id)")
            }
            check(updatesDistance == (item.editorDistanceMode != "omit"), "shared \(item.id): editor measurement authority matches server contract")
            if updatesDistance {
                check(distanceKm == day.distanceKm, "shared \(item.id): persisted total is not rounded or invented")
            }
            let patch = TrainingPlanSessionPatch(kind: day.kind, distanceKm: distanceKm, updatesDistance: updatesDistance,
                structure: day.structure, reason: day.reason, updatesReason: true)
            let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as! [String: Any]
            check((wire["distanceKm"] != nil) == updatesDistance, "shared \(item.id): patch encodes omission distinctly from null")
            if item.editorDistanceMode == "null" { check(wire["distanceKm"] is NSNull, "pure time has explicit null distance") }
            let add = TrainingPlanSessionDraft.add(day, deriveDistance: !updatesDistance)
            let addWire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(add)) as! [String: Any]
            check(((addWire["prescription"] as! [String: Any])["distanceKm"] != nil) == updatesDistance,
                  "shared \(item.id): add can delegate to the server without encoding a fake null/zero distance")
            if item.id == "mixed" {
                check(item.measured.distanceKm > 4.2 && item.measured.durationSeconds > 0,
                      "shared mixed baseline includes time-step distance; native code does not reproduce its pace model")
            }
            if item.id == "historical-distance-only" {
                let original = day.structure!
                let changed = MobileSessionStructure(warmup: original.warmup,
                    blocks: original.blocks.map { .init(iterations: $0.iterations + 1, steps: $0.steps) },
                    cooldown: original.cooldown)
                if case .failure = TrainingPlanSessionEditorPolicy.resolveDistance(text, structure: changed, original: day, kind: day.kind) {
                    check(true, "changed distance structure cannot reuse historical rounded total")
                } else { check(false, "changed distance structure must revalidate") }
            }
        }
        print("TrainingPlanSessionEditor regression: \(count) checks passed")
    }
}
