#if os(iOS)
import SwiftUI

/// Managed course review inside the existing Technology plan surface.
///
/// It deliberately lives in the course detail/editor sheet rather than a second
/// plan page: the prescription, association, actual workout and assessment are
/// one story about one `sessionId`.
struct TechTrainingExecutionReview: View {
    @Environment(NativeAppModel.self) private var native
    let session: TrainingPlanSessionsView.Session
    @State private var selectedCandidateId: String?
    @State private var showingSkip = false
    @State private var skipReason = ""
    @State private var localMessage: String?

    private var current: TrainingPlanSessionsView.Session {
        native.trainingPlanStore.unified?.sessions?.sessions.first {
            $0.sessionId == session.sessionId && $0.planInstanceId == session.planInstanceId
        } ?? session
    }
    private var execution: TrainingPlanSessionExecution? { native.sessionExecution(for: session.sessionId) }
    private var executionsKnown: Bool { native.sessionExecutionsKnown }
    private var page: TrainingPlanExecutionCandidatesResponse? { native.executionCandidates(for: session.sessionId) }
    private var capability: Bool { native.handshake?.trainingPlanExecutionCommandsSupported == true }
    private var selectedCandidate: TrainingPlanExecutionCandidate? {
        guard let selectedCandidateId else { return nil }
        return page?.candidates.first { $0.trainingSessionId == selectedCandidateId }
    }
    private var linkedCandidate: TrainingPlanExecutionCandidate? {
        guard let id = execution?.trainingSessionId else { return nil }
        return page?.candidates.first { $0.trainingSessionId == id }
    }
    private var review: TrainingPlanExecutionPolicy.Review {
        TrainingPlanExecutionPolicy.review(session: current, execution: execution,
            executionsKnown: executionsKnown, linkedCandidate: linkedCandidate)
    }
    private var taskKey: String {
        "\(session.sessionId)|\(current.sessionRevision)|\(execution?.executionRevision ?? 0)|\(capability)|\(native.canEditTrainingExecutions)|\(native.trainingPlanStore.unified?.stateRevision ?? 0)"
    }
    private var canSkip: Bool {
        TrainingPlanExecutionPolicy.canSkip(session: current, execution: execution,
            hasCandidates: !(page?.candidates.isEmpty ?? true))
    }

    var body: some View {
        Section("计划与实际") {
            TechPanel(tint: toneColor, fill: TechColor.paper) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(review.statusTitle).font(.headline).foregroundStyle(toneColor)
                        Spacer(minLength: 4)
                        TechBadge(title: TrainingPlanExecutionPolicy.lifecycleText(current.lifecycle),
                            color: toneColor, fill: TechColor.mint)
                    }
                    Text(review.statusDetail).font(.footnote).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(review.planSummary).font(.subheadline)
                    ForEach(review.actualLines, id: \.self) { line in
                        Text(line).font(.subheadline).foregroundStyle(TechColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(review.doseText).font(.footnote)
                    Text(review.stimulusText).font(.footnote)
                    Text(review.completionText).font(.footnote)
                    if !review.reasonTexts.isEmpty {
                        ForEach(review.reasonTexts, id: \.self) { reason in
                            Label(reason, systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(TechColor.coral)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if !executionsKnown {
                        Text("执行视图缺位表示“未知”，不是空历史；不会据此把课程标成未完成。")
                            .font(.caption2).foregroundStyle(TechColor.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            capability ? AnyView(candidateSection) : AnyView(readOnlySection)
            if let note = localMessage { Text(note).font(.footnote).foregroundStyle(TechColor.yellow) }
            if let issue = native.executionCandidateIssue(for: session.sessionId) {
                Text(issue).font(.footnote).foregroundStyle(TechColor.coral)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let message = native.trainingPlanPublisher.message {
                Text(message).font(.footnote).foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: taskKey) {
            guard capability, native.canEditTrainingExecutions else { return }
            _ = await native.loadExecutionCandidates(for: session.sessionId)
        }
    }

    private var candidateSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("候选实际训练").font(.subheadline.weight(.semibold))
                Spacer(minLength: 6)
                if let page {
                    Text("\(page.rangeStart)…\(page.rangeEnd)").font(.caption2).foregroundStyle(TechColor.muted)
                }
            }
            HStack(spacing: 8) {
                Button("刷新候选") {
                    Task { _ = await native.loadExecutionCandidates(for: session.sessionId) }
                }.disabled(native.isExecutionCandidateLoading(session.sessionId) || !native.canEditTrainingExecutions)
                    .accessibilityIdentifier("training.execution.refresh")
                Button("扩大范围") {
                    Task { _ = await native.loadExecutionCandidates(for: session.sessionId, widened: true) }
                }.disabled(native.isExecutionCandidateLoading(session.sessionId) || !native.canEditTrainingExecutions)
                    .accessibilityIdentifier("training.execution.widen")
            }
            if !native.canEditTrainingExecutions {
                Text("当前课程/计划状态尚未确认，或正有写入待处理；恢复在线并刷新后才能确认、纠错、撤回或跳过。")
                    .font(.caption).foregroundStyle(TechColor.yellow)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if native.isExecutionCandidateLoading(session.sessionId) { ProgressView("正在读取候选") }
            if let page, page.candidates.isEmpty {
                Text("默认窗口内没有候选。这不等于没有跑步，可扩大范围后再选择。")
                    .font(.caption).foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(page?.candidates ?? []) { candidate in
                Button {
                    selectedCandidateId = candidate.trainingSessionId
                    localMessage = nil
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: selectedCandidateId == candidate.trainingSessionId ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selectedCandidateId == candidate.trainingSessionId ? TechColor.cyan : TechColor.muted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(nativeDate(candidate.startedAt)) → \(nativeDate(candidate.endedAt))").font(.subheadline)
                            Text("\(nativeKilometers(candidate.distanceMeters.map { $0 / 1_000 })) · \(nativeDuration(candidate.durationSeconds)) · \(TrainingPlanExecutionPolicy.candidateEvidenceText(candidate.evidence))")
                                .font(.caption).foregroundStyle(TechColor.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
                .disabled(!native.canEditTrainingExecutions)
                .accessibilityIdentifier("training.execution.candidate.\(candidate.trainingSessionId)")
            }
            if let cursor = page?.nextCursor, !cursor.isEmpty {
                Button("加载更多候选") {
                    Task { _ = await native.loadExecutionCandidates(for: session.sessionId, cursor: cursor) }
                }.disabled(native.isExecutionCandidateLoading(session.sessionId) || !native.canEditTrainingExecutions)
                    .accessibilityIdentifier("training.execution.more")
            }
            if let selectedCandidate {
                Button(TrainingPlanExecutionPolicy.candidateActionTitle(association: execution?.association, session: current)) {
                    Task {
                        if await native.confirmExecutionLink(sessionId: session.sessionId, candidate: selectedCandidate) {
                            localMessage = "关联已保存，正在重读计划与实际。"
                            selectedCandidateId = nil
                        }
                    }
                }
                .disabled(!native.canEditTrainingExecutions)
                .accessibilityIdentifier(execution?.association == "confirmed" ? "training.execution.correct" : "training.execution.confirm")
            }
            if TrainingPlanExecutionPolicy.canRetract(execution) {
                Button("撤回当前关联", role: .destructive) {
                    Task {
                        if await native.retractExecutionLink(sessionId: session.sessionId) {
                            localMessage = "撤回已保存，原完成历史仍保留。"
                        }
                    }
                }
                .disabled(!native.canEditTrainingExecutions)
                .accessibilityIdentifier("training.execution.retract")
            }
            if canSkip {
                if showingSkip {
                    TextField("跳过原因（必填）", text: $skipReason, axis: .vertical)
                        .accessibilityIdentifier("training.execution.skip-reason")
                    HStack {
                        Button("确认跳过") {
                            Task {
                                if await native.skipTrainingSession(sessionId: session.sessionId, reason: skipReason) {
                                    localMessage = "已明确跳过；不会把一次真实完成改成跳过。"
                                    showingSkip = false
                                }
                            }
                        }
                        .disabled(skipReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !native.canEditTrainingExecutions)
                        .accessibilityIdentifier("training.execution.skip-confirm")
                        Button("取消") { showingSkip = false }
                    }
                } else {
                    Button("明确跳过这节待执行课程") { showingSkip = true }
                        .disabled(!native.canEditTrainingExecutions)
                        .accessibilityIdentifier("training.execution.skip")
                }
            }
            Text("候选不会自动确认：同日多跑和一跑多课都保留给你选择；确认一次跑步最多认领一堂课。")
                .font(.caption2).foregroundStyle(TechColor.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var readOnlySection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("执行关联只读").font(.subheadline.weight(.semibold))
            Text("当前服务未宣告执行关联能力，或有待确认的写入；本页只展示已有计划与执行评价，不会拉取候选、确认、纠错或跳过。")
                .font(.caption).foregroundStyle(TechColor.muted)
                .fixedSize(horizontal: false, vertical: true)
        }.accessibilityIdentifier("training.execution.readonly")
    }

    private var toneColor: Color {
        switch review.tone {
        case .positive: return TechColor.success
        case .warning: return TechColor.yellow
        case .danger: return TechColor.coral
        case .neutral: return TechColor.muted
        }
    }
}
#endif
