#if os(iOS)
import SwiftUI

/// A draft has no execution authority. Closing the form discards only previews;
/// the shared publisher owns any submitted journal across dismissal/restart.
struct TechTrainingSessionEditor: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    let session: TrainingPlanSessionsView.Session?
    let initialDate: String
    @State private var action = "move"
    @State private var date = ""
    @State private var kind = "easy"
    @State private var distance = ""
    @State private var reason = ""
    @State private var blocks: [EditorBlock] = []
    @State private var warmup: EditorStep?
    @State private var cooldown: EditorStep?
    @State private var originalSession: TrainingPlanSessionsView.Session?
    @State private var editorIdentity: TrainingPlanSessionEditorPolicy.DraftIdentity?
    @State private var initialized = false
    @State private var localMessage: String?
    private enum InputField: Hashable { case date, distance, reason, amount(UUID), lower(UUID), upper(UUID) }
    @FocusState private var focusedField: InputField?

    private struct EditorStep: Identifiable, Equatable {
        let id = UUID()
        var purpose: String
        var goal: String
        var amount: String
        var target: String
        var lower: String
        var upper: String
        init(_ step: MobileWorkoutStep) {
            purpose = step.purpose
            switch step.goal {
            case let .distance(meters): goal = "distance"; amount = String(format: "%.0f", meters)
            case let .time(seconds): goal = "time"; amount = String(format: "%.0f", seconds)
            case .open: goal = "open"; amount = ""
            }
            target = step.alert?.kind ?? "none"
            lower = step.alert?.lower.map { String(format: "%.0f", $0) } ?? ""
            upper = step.alert?.upper.map { String(format: "%.0f", $0) } ?? ""
        }
        func value() -> MobileWorkoutStep? {
            guard goal != "open", let amount = Double(amount), amount >= 1, amount.rounded() == amount else { return nil }
            let alert: MobileStepAlert?
            if target == "none" { alert = nil }
            else {
                let lo = Double(lower), hi = Double(upper)
                guard lo != nil || hi != nil, lower.isEmpty || lo != nil, upper.isEmpty || hi != nil else { return nil }
                alert = .init(kind: target, lower: lo, upper: hi)
            }
            return .init(purpose: purpose, goal: goal == "distance" ? .distance(meters: amount) : .time(seconds: amount), alert: alert)
        }
    }
    private struct EditorBlock: Identifiable, Equatable {
        let id = UUID()
        var iterations: Int
        var steps: [EditorStep]
    }
    private var currentSession: TrainingPlanSessionsView.Session? {
        guard let session else { return nil }
        return native.trainingPlanStore.unified?.sessions?.sessions.first { $0.sessionId == session.sessionId && $0.planInstanceId == session.planInstanceId }
    }
    private var draft: TrainingPlanSessionDraft? {
        guard let editorIdentity, editorIdentity.issue(in: native.trainingPlanStore.unified) == nil else { return nil }
        let id = editorIdentity.sessionId ?? "", revision = editorIdentity.sessionRevision ?? 0
        switch action {
        case "move": return session == nil ? nil : .move(sessionId: id, sessionRevision: revision, localDate: date)
        case "cancel": return session == nil ? nil : .cancel(sessionId: id, sessionRevision: revision)
        case "unlock": return session == nil ? nil : .unlock(sessionId: id, sessionRevision: revision)
        case "set_rest": return .setRest(localDate: date)
        default:
            guard let structure = currentStructure else { return nil }
            let distanceKm: Double?, updatesDistance: Bool
            switch distanceResolution(structure) {
            case let .value(value): distanceKm = value; updatesDistance = true
            case .serverMeasured: distanceKm = nil; updatesDistance = false
            case .failure: return nil
            }
            if action == "add" {
                return .add(.init(localDate: date, kind: kind, distanceKm: distanceKm,
                    structure: structure, reason: reason.isEmpty ? nil : reason), deriveDistance: !updatesDistance)
            }
            return .edit(sessionId: id, sessionRevision: revision, patch: .init(kind: kind, distanceKm: distanceKm,
                updatesDistance: updatesDistance, structure: structure, reason: reason.isEmpty ? nil : reason, updatesReason: true))
        }
    }
    private func distanceResolution(_ structure: MobileSessionStructure) -> TrainingPlanSessionEditorPolicy.DistanceResolution {
        TrainingPlanSessionEditorPolicy.compatibleDistance(
            TrainingPlanSessionEditorPolicy.resolveDistance(distance, structure: structure,
                original: originalSession?.prescription, kind: kind),
            omissionSupported: native.handshake?.trainingPlanSessionDistanceOmissionSupported == true,
            original: originalSession?.prescription, structure: structure, kind: kind)
    }
    private var currentStructure: MobileSessionStructure? {
        guard !blocks.isEmpty else { return nil }
        let values = blocks.compactMap { block -> MobileIntervalBlock? in
            let steps = block.steps.compactMap { $0.value() }
            guard steps.count == block.steps.count, !steps.isEmpty else { return nil }
            return .init(iterations: block.iterations, steps: steps)
        }
        guard values.count == blocks.count, warmup == nil || warmup?.value() != nil,
              cooldown == nil || cooldown?.value() != nil else { return nil }
        return MobileSessionStructure(warmup: warmup?.value(), blocks: values, cooldown: cooldown?.value())
    }
    private var draftIssue: String? {
        guard let editorIdentity else { return "请先读取训练安排。" }
        if let issue = editorIdentity.issue(in: native.trainingPlanStore.unified) { return issue }
        switch action {
        case "add", "edit":
            guard let structure = currentStructure else {
                return "请填写完整的分段剂量；纯时间课程也需要明确的时间剂量。"
            }
            if case let .failure(message) = distanceResolution(structure) {
                return message
            }
            return nil
        default:
            return nil
        }
    }
    var body: some View {
        NavigationStack {
            Form {
                if let session {
                    TechTrainingExecutionReview(session: session)
                        .disabled(native.trainingPlanPublisher.isBusy)
                }
                actionSection.disabled(native.trainingPlanPublisher.isBusy)
                if action == "add" || action == "edit" {
                    contentSection.disabled(native.trainingPlanPublisher.isBusy)
                    doseSections.disabled(native.trainingPlanPublisher.isBusy)
                }
                submissionSection
            }
            .scrollDismissesKeyboard(.interactively)
            .tint(TechColor.cyan)
            .navigationTitle(session == nil ? "新增课程 / 休息" : "调整课程")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.accessibilityIdentifier("training.session.close") }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("完成输入") { focusedField = nil }.accessibilityIdentifier("training.session.done-editing")
                }
            }
            .onAppear { initialize() }
            .onChange(of: draft) { _, _ in native.trainingPlanPublisher.cancelPreview(); localMessage = nil }
            .onChange(of: TrainingPlanSessionEditorPolicy.structureDistance(currentStructure)) { _, measurement in
                // Mixed courses have no editable total field. Discard stale
                // input from a previous distance-only draft before hiding it.
                if measurement == .mixed { distance = "" }
            }
            .onDisappear { native.trainingPlanPublisher.cancelPreview() }
            .onChange(of: native.feedbackSessionID) { _, _ in dismiss() }
        }
    }
    private var actionSection: some View {
                Section("调整课程") {
                    Picker("操作", selection: $action) {
                        if session != nil {
                            Text("改期").tag("move"); Text("修改内容").tag("edit")
                            Text("取消课程").tag("cancel"); Text("解除保护").tag("unlock")
                        } else { Text("新增课程").tag("add"); Text("指定休息").tag("set_rest") }
                    }
                    if ["move", "add", "set_rest"].contains(action) {
                        HStack {
                            TextField("日期（年-月-日）", text: $date).textInputAutocapitalization(.never)
                                .focused($focusedField, equals: .date)
                                .accessibilityIdentifier("training.session.date")
                            if !date.isEmpty {
                                Button { date = ""; focusedField = .date } label: { Image(systemName: "xmark.circle.fill") }
                                    .buttonStyle(.borderless).foregroundStyle(TechColor.muted)
                                    .frame(minWidth: 44, minHeight: 44)
                                    .accessibilityLabel("清空日期").accessibilityIdentifier("training.session.clear-date")
                            }
                        }
                    }
                    if action == "unlock" { Text("解除后交由自动安排；预览会列出释放的改期抑制。已完成历史不会修改。").font(.footnote) }
                    if action == "cancel" { Text("取消后该日期不自动补课；已有设备排期仍需撤回。").font(.footnote) }
                }
    }
    private var contentSection: some View {
                    Section("训练内容") {
                        Picker("类型 / 强度", selection: $kind) {
                            Text("轻松").tag("easy"); Text("恢复").tag("recovery"); Text("节奏").tag("tempo")
                            Text("间歇").tag("interval"); Text("长距离").tag("long_run")
                        }
                        if TrainingPlanSessionEditorPolicy.structureDistance(currentStructure) == .mixed {
                            Text("总距离由服务端按完整分段计算，请在预览中确认。").font(.footnote)
                        } else if TrainingPlanSessionEditorPolicy.structureDistance(currentStructure) != .none {
                            TextField("总距离（公里）", text: $distance).keyboardType(.decimalPad).focused($focusedField, equals: .distance)
                        }
                        TextField("说明（留空清除）", text: $reason, axis: .vertical).focused($focusedField, equals: .reason)
                        Text("新建或调整纯时间课程不填写总距离；时间与距离混合课程由服务端测量。原样编辑保留历史距离，纯距离课程总量须与分段一致。配速填写秒/公里；心率填写次/分钟。目标留空的一侧表示不限制。").font(.footnote)
                    }
    }
    @ViewBuilder private var doseSections: some View {
                    if warmup != nil { Section("热身") { stepFields(Binding(get: { warmup! }, set: { warmup = $0 })) } }
                    ForEach($blocks) { $block in
                        Section("训练段") {
                            Stepper("重复 \(block.iterations) 次", value: $block.iterations, in: 1...TrainingPlanSessionEditorPolicy.maximumBlockIterations)
                            ForEach($block.steps) { $step in stepFields($step) }
                        }
                    }
                    if cooldown != nil { Section("放松") { stepFields(Binding(get: { cooldown! }, set: { cooldown = $0 })) } }
    }
    private var submissionSection: some View {
                Section {
                    Button("预览调整") {
                        focusedField = nil
                        guard let draft, let editorIdentity else { localMessage = draftIssue ?? "请检查日期、距离和分段剂量。"; return }
                        Task { _ = await native.previewTrainingSession(draft, editorIdentity: editorIdentity) }
                    }
                    .disabled(!native.canEditTrainingSessions || draft == nil)
                    .accessibilityIdentifier("training.session.preview")
                    previewContent
                    Button("重新读取并重建草稿") {
                        Task { if await native.refreshUnifiedTrainingPlan() { initialize(reload: true) } }
                    }
                        .disabled(native.isPlanBusy || native.isOffline)
                    Text("后台刷新不会改写草稿。重新读取会用最新课程重建表单，请重新编辑、预览和确认。").font(.footnote)
                    if session != nil && (currentSession == nil || currentSession?.lifecycle != "pending" || currentSession?.supersededBySessionId != nil) {
                        Text("当前课程已结束、取消或被替换，不能继续修改；草稿仍可查看。").font(.footnote)
                    }
                    if native.hasPendingPlanPublication {
                        Button("查询原操作") { Task { _ = await native.resolvePlanPublication() } }.disabled(native.isPlanBusy || native.isOffline)
                    }
                    if let message = native.trainingPlanPublisher.message { Text(message).font(.footnote).fixedSize(horizontal: false, vertical: true) }
                    if let localMessage { Text(localMessage).font(.footnote) }
                    if let draftIssue { Text(draftIssue).font(.footnote).accessibilityIdentifier("training.session.draft-issue") }
                }
    }
    @ViewBuilder private var previewContent: some View {
        if let preview = native.trainingPlanPublisher.sessionPreview, let draft, let editorIdentity,
           native.trainingPlanPublisher.matchesSessionPreview(draft) {
                        if let before = preview.impact.before {
                            sessionSummary("原课程", session: before)
                            DisclosureGroup("查看原课程分段与目标") { prescriptionLines(before.prescription) }
                        }
                        if let after = preview.impact.after {
                            sessionSummary("有效课程", session: after)
                            prescriptionLines(after.prescription)
                        }
                        ForEach(preview.impact.suppressions, id: \.localDate) { item in Text("\(item.localDate)：\(item.reason == "explicit_rest" ? "指定休息" : "不自动补课")") }
                        if preview.impact.deviceWithdrawalRequired { Label("已有设备排期需先撤回再重新下发。", systemImage: "applewatch") }
                        ForEach(preview.impact.warnings, id: \.self) { Text($0).font(.footnote) }
                        Button("确认保存") { Task { if await native.confirmTrainingSession(draft, editorIdentity: editorIdentity) { dismiss() } } }
                            .disabled(!native.canEditTrainingSessions).accessibilityIdentifier("training.session.save")
        }
    }
    private func sessionSummary(_ label: String, session: TrainingPlanSessionsView.Session) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(label)：\(session.prescription.localDate) · \(nativeSessionName(session.prescription.kind)) · \(nativeKilometers(session.prescription.distanceKm))")
            Text("\(session.protection == "user_protected" ? "用户保护" : "自动安排") · \(session.lifecycle == "cancelled" ? "已取消" : "待执行")")
                .font(.footnote)
        }.fixedSize(horizontal: false, vertical: true)
    }
    @ViewBuilder private func prescriptionLines(_ day: MobilePlannedDay) -> some View {
        if day.structure == nil { Text("原处方缺少分段信息；不会自动补写结构。").font(.footnote) }
        ForEach(nativeStructureLines(day.structure)) { line in
            Text("\(line.title)：\(line.detail)").font(.footnote).fixedSize(horizontal: false, vertical: true)
        }
        if let reason = day.reason, !reason.isEmpty { Text(reason).font(.footnote).fixedSize(horizontal: false, vertical: true) }
    }
    @ViewBuilder private func stepFields(_ step: Binding<EditorStep>) -> some View {
        Picker("分段用途", selection: step.purpose) {
            Text("热身").tag("warmup"); Text("工作段").tag("work"); Text("恢复段").tag("recovery"); Text("放松").tag("cooldown")
        }
        Picker("剂量单位", selection: step.goal) {
            Text("米").tag("distance"); Text("秒").tag("time")
            if step.wrappedValue.goal == "open" { Text("请填写明确剂量").tag("open") }
        }
        TextField("分段剂量", text: step.amount).keyboardType(.numberPad).focused($focusedField, equals: .amount(step.wrappedValue.id))
        Picker("强度目标", selection: step.target) {
            Text("无目标").tag("none"); Text("配速（秒/公里）").tag("pace"); Text("心率").tag("heart_rate")
        }
        if step.wrappedValue.target != "none" {
            TextField("目标下限", text: step.lower).keyboardType(.numberPad).focused($focusedField, equals: .lower(step.wrappedValue.id))
            TextField("目标上限", text: step.upper).keyboardType(.numberPad).focused($focusedField, equals: .upper(step.wrappedValue.id))
        }
    }
    private func initialize(reload: Bool = false) {
        guard !initialized || reload, let snapshot = native.trainingPlanStore.unified,
              let sessions = snapshot.sessions else { return }
        let source = reload ? currentSession : session
        guard session == nil || source != nil else {
            localMessage = "课程已不在当前计划中，请关闭并重新打开。"
            return
        }
        initialized = true
        originalSession = source
        editorIdentity = .init(scope: snapshot.scope, planInstanceId: source?.planInstanceId ?? sessions.planInstanceId,
            stateRevision: snapshot.stateRevision, sessionId: source?.sessionId, sessionRevision: source?.sessionRevision)
        native.trainingPlanPublisher.cancelPreview(); localMessage = nil
        date = source?.prescription.localDate ?? initialDate
        action = session == nil ? "add" : "move"
        kind = source?.prescription.kind ?? "easy"
        reason = source?.prescription.reason ?? ""
        // Never invent a 5 km structure for a missing dose. The blank structure
        // contains one open work step, which the editor rejects until the user
        // chooses an explicit distance or time dose.
        let structure = source?.prescription.structure ?? TrainingPlanSessionEditorPolicy.blankStructure()
        distance = TrainingPlanSessionEditorPolicy.distanceText(source?.prescription.distanceKm)
        warmup = structure.warmup.map(EditorStep.init); cooldown = structure.cooldown.map(EditorStep.init)
        blocks = structure.blocks.map { EditorBlock(iterations: $0.iterations, steps: $0.steps.map(EditorStep.init)) }
    }
}
#endif
