#if os(iOS)
import SwiftUI

/// 训练页的**唯一**入口。
///
/// 页面形态只由服务端能力决定：宣告教练闭环合同的服务器进入统一模式页（持续训练 /
/// 比赛备赛是同一个编辑器的两种模式），老服务器保留旧页面（否则它既没有统一状态
/// 也没有可用的写入协议）。这里没有"旧教练 / 新教练"选择器，用户看不到两个引擎，
/// 也不会被要求"先结束一个再创建另一个"。
struct TechPlanView: View {
    @Environment(NativeAppModel.self) private var native

    var body: some View {
        if native.usesUnifiedTrainingPage { TechUnifiedTrainingView() } else { TechRunCoachView() }
    }
}

/// 模式驱动的统一训练页。
///
/// 页面只做三件事：显示**统一状态**（模式/运行状态/准入/比赛目标/七日意图）、
/// 提供**唯一**的配置与暂停/结束动作、把执行部分的展示交给 `TechCoachLoopSection`
/// （`.page` 上下文）。执行授权不在这里产生 —— `TrainingPlanUnifiedView.executionGranted`
/// 恒为 false，可执行处方仍只能来自执行快照。
private struct TechUnifiedTrainingView: View {
    @Environment(NativeAppModel.self) private var native
    @State private var showingPreferences = false
    @State private var showingLock = false
    @State private var showingCommands = false
    private struct SessionEditorTarget: Identifiable {
        let session: TrainingPlanSessionsView.Session?
        var id: String { session?.sessionId ?? "new-session" }
    }
    @State private var sessionEditorTarget: SessionEditorTarget?

    private var state: TrainingPlanUnifiedView { native.trainingPlanUnifiedView }
    private var businessDate: String? {
        native.trainingPlanStore.unified?.businessDate ?? native.planPresentation.today?.today.localDate
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                stateHeader
                // 只有协商到统一读合同的服务才显示 v2 命令入口；老服务继续用
                // TechRunCoachView 自己的既有协议，不能让“未启用训练编辑”的
                // 文案冒充旧服务的真实可用性。
                if native.handshake?.trainingPlanContractVersion == 2 || native.hasPendingPlanPublication {
                    commandPanel
                }
                if native.trainingPlanStore.unified?.update != nil { updatePanel }
                if !state.weekDays.isEmpty { weekPanel }
                reviewPanel
                TechCoachLoopSection(context: .page)
                racePanel
                manualPlanEntry
                TechPlanWatchSection(allowsSynchronization: native.coachLoop?.settings?.status == "active")
                notices
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .techNavigation("训练")
        .task { await native.refreshUnifiedTrainingPlan() }
        .refreshable {
            // 先刷新执行快照（它决定今天能不能练），再刷新统一状态（它决定页面
            // 怎么描述现在）。两条读各有自己的成功标准，不能互相冒充。
            await native.refreshAll()
            await native.refreshUnifiedTrainingPlan()
        }
        // 写操作（模式启用/更新/暂停、比赛目标、反馈）都会抬高 coach-loop 或 goals
        // 的 revision；统一状态与它们不是同一条读，必须跟着重读，否则页面会一直
        // 显示写入前的模式。这里只触发**读**，从不重放写。
        .onChange(of: native.coachLoop?.revision) { _, _ in
            Task { await native.refreshUnifiedTrainingPlan() }
        }
        .onChange(of: native.planPresentation.goals?.revision) { _, _ in
            Task { await native.refreshUnifiedTrainingPlan() }
        }
        .sheet(isPresented: $showingPreferences) {
            if let loop = native.coachLoop {
                TechCoachLoopPreferencesSheet(initial: loop, sessionID: native.feedbackSessionID)
            } else {
                TechPanel(tint: TechColor.yellow, fill: TechColor.paleYellow) {
                    Text("尚未读取到当前训练合同；请联网后重新打开训练页。")
                        .font(.footnote).foregroundStyle(TechColor.yellow)
                }
            }
        }
        .sheet(isPresented: $showingLock) { TechLockSheet() }
        .sheet(isPresented: $showingCommands) { TechTrainingCommandSheet() }
        .sheet(item: $sessionEditorTarget) { target in
            TechTrainingSessionEditor(session: target.session, initialDate: businessDate ?? "")
        }
        .onChange(of: native.feedbackSessionID) { _, _ in showingPreferences = false; showingLock = false; showingCommands = false; sessionEditorTarget = nil }
    }

    /// B08 four-stage status. It reports facts/analysis/association/plan
    /// separately and never turns "sync succeeded" into "plan updated".
    @ViewBuilder
    private var updatePanel: some View {
        if let update = native.trainingPlanStore.unified?.update {
            TechPanel(tint: update.plan.status == "current" ? TechColor.success : TechColor.yellow,
                      fill: update.plan.status == "current" ? TechColor.mint : TechColor.paleYellow) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(updateTitle(update)).font(.subheadline.weight(.semibold))
                    Text("事实：" + stageText(update.facts.status) + " · 分析：" + stageText(update.analysis.status) +
                         " · 关联：" + stageText(update.association.status)).font(.caption).foregroundStyle(TechColor.muted)
                    if !update.plan.reasonCodes.isEmpty {
                        Text(reasonText(update.plan.reasonCodes)).font(.caption2).foregroundStyle(TechColor.coral)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text("更新状态只描述计划是否已消费最新输入；训练记录同步成功不等于计划已更新。")
                        .font(.caption2).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityIdentifier("training.update.status")
        }
    }
    private func updateTitle(_ update: TrainingPlanUpdateView) -> String {
        switch update.plan.status {
        case "current": return "计划已反映最新输入"
        case "blocked": return "计划更新暂不可用"
        default: return "计划等待更新"
        }
    }
    private func stageText(_ status: String) -> String {
        switch status {
        case "stored", "ready", "current": return "已就绪"
        case "failed", "blocked": return "失败"
        case "pending": return "等待中"
        default: return status
        }
    }
    private func reasonText(_ codes: [String]) -> String {
        codes.map { code in
            switch code {
            case "auto_publish_disabled": return "自动发布尚未启用（需后续发布授权）"
            case "analysis_pending": return "等待分析发布"
            case "input_changed": return "有新输入，等待重算"
            case "training_paused": return "训练已暂停或结束"
            case "execution_invalidated": return "执行关联已失效，需重新核对"
            default: return code
            }
        }.joined(separator: "；")
    }

    private var commandPanel: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                Button("编辑目标 / 暂停恢复 / 刷新") { showingCommands = true }
                    .disabled(!native.canEditTrainingPlanV2)
                    .accessibilityIdentifier("training.commands.open")
                if !native.v2CommandCapability {
                    Text("当前服务未启用训练编辑，已发布安排仍可只读查看。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                }
                if let message = native.trainingPlanPublisher.message { Text(message).font(.footnote) }
                if native.hasPendingPlanPublication {
                    Button("查询原操作结果") { Task { _ = await native.resolvePlanPublication() } }
                        .disabled(native.isPlanBusy || native.isOffline)
                        .accessibilityIdentifier("training.commands.recover")
                }
            }
        }
    }

    // MARK: - 统一状态

    private var stateHeader: some View {
        TechPanel(tint: phaseTint) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text("训练").font(.title2.weight(.semibold))
                    Spacer(minLength: 8)
                    Text(phaseBadge).font(.caption.weight(.semibold))
                        .foregroundStyle(phaseTint)
                }
                Text(headline).font(.headline).fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail).font(.footnote).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if state.isReferenceOnly {
                    Label("上次参考状态：联网刷新后才算当前安排，不能据此执行或排表。",
                        systemImage: "clock.arrow.circlepath")
                        .font(.caption).foregroundStyle(TechColor.yellow)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if state.factsPending {
                    Label("训练事实新鲜度尚未评估：本版本不据此下发执行。",
                        systemImage: "waveform.path.ecg")
                        .font(.caption).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if state.deviceCoordinationPending {
                    Label("设备（手表）排程协调尚未完成：先核验/撤回旧排期，再下发新安排。",
                        systemImage: "applewatch")
                        .font(.caption).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let violation = state.contractViolation {
                    Text(violation).font(.caption).foregroundStyle(TechColor.coral)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // 只有"配置能解决"的状态才给配置按钮：合同升级与未迁移不是用户
                // 点两下就能修的，给一个按不动的按钮只会让人误以为是自己没配好。
                if state.phase == .needsConfiguration || state.phase == .needsConfirmation {
                    Button {
                        showingPreferences = true
                    } label: {
                        Label(configureButtonTitle, systemImage: "slider.horizontal.3")
                            .font(.subheadline.weight(.semibold))
                    }
                    .disabled(native.coachLoop == nil || native.isOffline || native.isPlanBusy)
                    .accessibilityIdentifier("training.configure")
                }
            }
        }
    }

    private var headline: String {
        switch state.phase {
        case .loading:
            return "正在读取统一训练状态"
        case .upgradeRequired:
            // 🔴 合同不认识时绝不能出现"休息"二字：那是把一个必须升级的问题
            // 伪装成一次正常的训练安排。
            return "训练数据合同版本需要升级"
        case .notMigrated:
            return "训练数据尚未迁移到统一状态"
        case .unavailable:
            return "统一训练状态暂不可读"
        case .notAssessable:
            return "无法判定今天的训练状态"
        case .needsConfiguration:
            return "还差一次训练配置"
        case .needsConfirmation:
            return "上次训练模式已结束"
        case .refreshRequired:
            return "训练状态需要刷新"
        case .ready:
            if state.isRaceDay { return "今天是比赛日" }
            if state.runState == "paused" { return "训练模式已暂停" }
            if state.isRest { return "今天是排定的休息日" }
            if let intent = state.todayIntent {
                return "今天：\(nativeSessionName(intent.kind))\(intent.distanceKm.map { " · \(nativeKilometers($0))" } ?? "")"
            }
            // 没有今天的意图 ≠ 今天休息：可能只是还没发布，或者这一行不在存储里。
            return "今天还没有已发布的训练意图"
        }
    }

    private var detail: String? {
        switch state.phase {
        case .loading:
            return "读取完成前不显示任何「今天练/今天休」结论。"
        case .upgradeRequired:
            return "服务端不支持训练读合同 v2。请升级 App 或服务端；本版本不会退回旧合同读取。"
        case .notMigrated:
            return "该数据域还没有统一训练状态。完成迁移前不会退回旧合同，也不会把未迁移当成没有训练。"
        case .unavailable(let message):
            return message
        case .notAssessable(let message):
            return message
        case .needsConfiguration:
            return state.mode == nil ? "先在同一个页面配置训练模式。" : "配置一次即可：有比赛目标按比赛备赛，否则按持续训练。"
        case .needsConfirmation:
            return "旧训练模式已结束，不会再自动复课；需要时在同一页面创建新的训练模式。"
        case .refreshRequired:
            return state.isReferenceOnly
                ? "当前只是上次参考状态；请下拉刷新或重新读取。"
                : "服务端的目标版本或业务日已变化；请刷新后再确认安排。"
        case .ready:
            var parts: [String] = []
            parts.append(state.mode == "race" ? "比赛备赛" : "持续训练")
            if let days = state.daysToRace, state.mode == "race" {
                parts.append(days >= 0 ? "距比赛 \(days) 天" : "比赛日期已过 \(abs(days)) 天")
            }
            if let goal = native.trainingPlanStore.unified?.raceGoal {
                if goal.support.preparation == "short" { parts.append("准备期偏短") }
                if goal.support.support == "limited" { parts.append("该距离只有有限骨架") }
            }
            return parts.joined(separator: " · ")
        }
    }

    private var phaseBadge: String {
        switch state.phase {
        case .loading: return "读取中"
        case .upgradeRequired, .notMigrated, .unavailable, .notAssessable: return "不可用"
        case .needsConfiguration: return "待配置"
        case .needsConfirmation: return "已结束"
        case .refreshRequired: return "需刷新"
        case .ready:
            if state.isRaceDay { return "比赛日" }
            if state.isRest { return "休息" }
            if state.runState == "paused" { return "已暂停" }
            return "进行中"
        }
    }

    private var phaseTint: Color {
        switch state.phase {
        case .ready where state.isRest: return TechColor.muted
        case .ready: return TechColor.cyan
        case .loading: return TechColor.grid
        case .needsConfiguration, .needsConfirmation: return TechColor.yellow
        case .refreshRequired: return TechColor.yellow
        case .upgradeRequired, .notMigrated, .unavailable, .notAssessable: return TechColor.coral
        }
    }

    private var configureButtonTitle: String {
        state.phase == .needsConfirmation ? "创建新的训练模式" : "配置训练模式"
    }

    // MARK: - 七日意图

    private var weekPanel: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "未来 7 日训练意图", trailing: "已发布计划")
                if state.weekDays.count < 7 {
                    Text("当前窗口已发布 \(state.weekDays.count)/7 天；未列出的日期尚未生成，不代表休息。")
                        .font(.caption).foregroundStyle(TechColor.yellow)
                }
                ForEach(state.weekDays, id: \.localDate) { day in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(nativeWeekday(day.localDate)).font(.caption.weight(.semibold))
                            Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
                        }
                        .frame(minWidth: 52, alignment: .leading)
                        Circle().fill(techSessionColor(day.kind)).frame(width: 8, height: 8)
                        Text(nativeSessionName(day.kind)).font(.subheadline)
                        Spacer(minLength: 8)
                        Text(nativeKilometers(day.distanceKm)).font(.caption.monospacedDigit())
                            .foregroundStyle(TechColor.muted)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }
                Text("这里只是已发布的意图；今天能否执行由执行快照与设备协调决定，两者不会互相代替。")
                    .font(.caption2).foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - 过去日期的回顾（F03 渲染侧）

    private var reviewPanel: some View {
        Group {
            if let businessDate, let identities = native.trainingPlanStore.unified?.sessions {
                let rows = TrainingPlanExecutionPolicy.historyRows(sessions: identities.sessions,
                    executions: identities.executions, businessDate: businessDate)
                if !rows.isEmpty {
                    TechPanel {
                        VStack(alignment: .leading, spacing: 8) {
                            TechSectionHeader(title: "执行回顾", trailing: "计划 / 关联 / 评价分开")
                            ForEach(rows) { row in
                                Button {
                                    sessionEditorTarget = .init(session: identities.sessions.first { $0.sessionId == row.sessionId })
                                } label: {
                                    HStack(alignment: .top, spacing: 8) {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text("\(nativeWeekday(row.localDate)) · \(nativeDay(row.localDate))")
                                                .font(.caption.weight(.semibold))
                                            Text(nativeSessionName(row.kind)).font(.caption)
                                        }
                                        Spacer(minLength: 8)
                                        VStack(alignment: .trailing, spacing: 2) {
                                            Text(row.statusTitle).font(.caption2.weight(.semibold))
                                                .foregroundStyle(row.tone == .positive ? TechColor.success :
                                                    row.tone == .warning ? TechColor.yellow :
                                                    row.tone == .danger ? TechColor.coral : TechColor.muted)
                                            Text(row.detail).font(.caption2).foregroundStyle(TechColor.muted)
                                                .multilineTextAlignment(.trailing)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("training.execution.review.\(row.sessionId)")
                                .padding(.vertical, 3)
                            }
                        }
                    }
                }
            } else if let businessDate {
                let rows = TrainingPlanUnifiedPolicy.weekReview(
                    from: native.planPresentation.today?.weekPlan ?? [], businessDate: businessDate)
                if !rows.isEmpty {
                    TechPanel {
                        VStack(alignment: .leading, spacing: 8) {
                            TechSectionHeader(title: "本周回顾", trailing: "观测与意图分开")
                            ForEach(rows) { row in
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 8) {
                                        Text("\(nativeWeekday(row.localDate)) · \(nativeDay(row.localDate))")
                                            .font(.caption.weight(.semibold))
                                        Text(nativeSessionName(row.displayKind)).font(.caption)
                                        Spacer(minLength: 0)
                                        Text(row.detail).font(.caption2).foregroundStyle(TechColor.muted)
                                    }
                                    if !row.title.isEmpty, row.title != nativeSessionName(row.displayKind) {
                                        Text(row.title).font(.caption2).foregroundStyle(TechColor.muted)
                                    }
                                }
                                .padding(.vertical, 3)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - 比赛目标

    private var racePanel: some View {
        TechPanel(tint: state.mode == "race" ? TechColor.cyan : TechColor.grid, fill: .clear) {
            VStack(alignment: .leading, spacing: 8) {
                TechSectionHeader(title: "比赛目标",
                    trailing: state.mode == "race" ? "比赛备赛" : "未启用",
                    trailingColor: state.mode == "race" ? TechColor.cyan : TechColor.muted)
                if let goal = native.trainingPlanStore.unified?.raceGoal {
                    let distance = goal.support.distance.map(techRaceDistanceName) ?? nativeKilometers(goal.distanceKm)
                    Text("\(distance) · \(goal.date) · \(goal.goal == "time" ? "目标成绩" : "完赛")")
                        .font(.headline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let seconds = goal.targetTimeSeconds {
                        Text("目标时间 \(nativeDuration(seconds))").font(.footnote)
                    }
                    Text("备赛窗口：\(goal.support.weeksToRace) 周 · 准备度\(goal.support.preparation == "short" ? "偏短" : "正常") · 距比赛 \(goal.support.daysToRace) 天")
                        .font(.caption).foregroundStyle(TechColor.muted)
                    if !goal.support.reasonCodes.isEmpty {
                        Text(goal.support.reasonCodes.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(TechColor.muted)
                    }
                } else if state.phase == .ready || state.phase == .needsConfiguration {
                    Text("尚未设置比赛目标。持续训练与比赛备赛是同一个模式的两种形态，配置时选定即可。")
                        .font(.footnote).foregroundStyle(TechColor.muted)
                } else {
                    Text("当前状态不可读取，比赛目标暂不展示。")
                        .font(.footnote).foregroundStyle(TechColor.muted)
                }
                Text("比赛目标在同一个配置里修改（模式选“比赛备赛”），不另开一份独立的目标编辑器；准备度不是目标成绩达成概率。")
                    .font(.caption2).foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    if native.canEditTrainingPlanV2 {
                        showingCommands = true
                    } else {
                        // v2 命令尚未真正可用（未宣告，或统一状态陈旧/失败）时
                        // 保留既有 coach-loop 配置入口；不能只剩一个禁用的按钮。
                        showingPreferences = true
                    }
                } label: {
                    Label(state.mode == "race" ? "调整比赛目标" : "设置比赛目标",
                        systemImage: "flag.checkered")
                        .font(.subheadline.weight(.semibold))
                }
                .disabled(!native.canEditTrainingPlanV2
                    && !(native.coachLoop != nil && !native.isOffline && !native.isPlanBusy))
                .accessibilityIdentifier("race-goal-edit")
            }
        }
    }

    // MARK: - 手动覆盖 / 提示

    /// The exact session capability opens the native editor. Older servers keep
    /// the read-only explanation; no legacy manual-plan write is reactivated.
    private var manualPlanEntry: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("课程与实际", systemImage: "calendar.badge.clock").font(.subheadline.weight(.medium))
            if let entities = native.trainingPlanStore.unified?.sessions {
                let listBusinessDate = native.trainingPlanStore.unified?.businessDate ?? ""
                let visible = TrainingPlanExecutionPolicy.visibleSessions(entities.sessions)
                if visible.isEmpty {
                    Text("当前服务没有返回稳定课程身份；只读展示已发布的安排。")
                        .font(.caption2).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(visible, id: \.sessionId) { session in
                    let execution = entities.executions?.first { $0.sessionId == session.sessionId }
                    let review = TrainingPlanExecutionPolicy.review(session: session, execution: execution,
                        executionsKnown: entities.executions != nil)
                    let listState = TrainingPlanExecutionPolicy.sessionListState(
                        session: session, businessDate: listBusinessDate)
                    Button {
                        sessionEditorTarget = .init(session: session)
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(session.prescription.localDate) · \(nativeSessionName(session.prescription.kind)) · \(nativeKilometers(session.prescription.distanceKm))")
                                Text(listState.caption)
                                    .font(.caption)
                                    .accessibilityIdentifier(listState.isReadOnly
                                        ? "training.session.readonly.\(session.sessionId)"
                                        : "training.session.editable.\(session.sessionId)")
                            }
                            Spacer(minLength: 8)
                            Text(review.statusTitle).font(.caption2.weight(.semibold))
                                .foregroundStyle(review.tone == .positive ? TechColor.success :
                                    review.tone == .warning ? TechColor.yellow :
                                    review.tone == .danger ? TechColor.coral : TechColor.muted)
                                .multilineTextAlignment(.trailing)
                        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("training.session.edit.\(session.sessionId)")
                }
                if native.handshake?.trainingPlanSessionCommandsSupported == true {
                    Button("新增课程 / 指定休息") { sessionEditorTarget = .init(session: nil) }
                        .disabled(!native.canEditTrainingSessions).accessibilityIdentifier("training.session.add")
                }
                if native.handshake?.trainingPlanExecutionCommandsSupported != true {
                    Text("当前服务未启用执行关联：可查看计划与执行评价，但不会拉取候选、确认、纠错或跳过。")
                        .font(.caption2).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("training.execution.readonly")
                }
            } else {
                Text("该服务端尚未提供稳定课程身份；该编辑方式尚未适配当前服务，本版只展示服务端已发布的安排，不把缺失当成空历史。")
                    .font(.caption2).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("training.manual-plan.retired")
            }
        }
        .foregroundStyle(TechColor.muted)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    private var notices: some View {
        Group {
            if native.isLoadingRunCoach || native.trainingPlanStore.isRefreshingUnified {
                ProgressView("正在更新训练安排")
            }
            if let message = native.runCoachError {
                TechPanel(tint: TechColor.coral, fill: TechColor.paleCoral) {
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(TechColor.coral)
                        Text(message).font(.footnote).foregroundStyle(TechColor.coral)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Button("重试") { Task { await native.refreshUnifiedTrainingPlan() } }
                            .font(.caption.weight(.semibold))
                    }
                }
            }
            if let message = native.errorMessage {
                Text(message).font(.caption).foregroundStyle(TechColor.coral)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if native.isOffline {
                Label("离线时只能显示上次参考状态；联网后才能确认安排。", systemImage: "wifi.slash")
                    .font(.footnote).foregroundStyle(TechColor.yellow)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct TechTrainingCommandSheet: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    @State private var action = TrainingPlanCommandAction.setRaceGoal
    @State private var date = ""
    @State private var distance = "10"
    @State private var goal = "finish"
    @State private var minutes = "60"
    @State private var refreshConfirmation = false
    @State private var previewTask: Task<Void, Never>?
    private var publisher: TrainingPlanPublisher { native.trainingPlanPublisher }
    private var draftKey: String { [action.rawValue, date, distance, goal, minutes].joined(separator: "|") }
    private var raceGoalDraft: TrainingPlanRaceGoalDraft? {
        action == .setRaceGoal ? .init(date: date, distanceKm: Double(distance) ?? 0, goal: goal,
            targetTimeSeconds: goal == "time" ? (Double(minutes) ?? 0) * 60 : nil) : nil
    }
    private var validDraft: Bool {
        action != .setRaceGoal || (!date.isEmpty && (Double(distance) ?? 0) > 0 && (goal != "time" || (Double(minutes) ?? 0) > 0))
    }
    private var canRefresh: Bool {
        native.canEditTrainingPlanV2 && native.trainingPlanStore.unified?.runState == "active"
    }
    private static func numberText(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
    }
    private func discardPreview() {
        previewTask?.cancel(); previewTask = nil
        publisher.cancelPreview()
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("训练配置") {
                    Picker("操作", selection: $action) {
                        Text("设置赛事目标").tag(TrainingPlanCommandAction.setRaceGoal)
                        Text("清除赛事目标").tag(TrainingPlanCommandAction.clearRaceGoal)
                        Text("暂停训练").tag(TrainingPlanCommandAction.pause)
                        Text("恢复训练").tag(TrainingPlanCommandAction.resume)
                    }.accessibilityIdentifier("training.commands.action")
                    Button("关闭编辑") { discardPreview(); dismiss() }
                        .accessibilityIdentifier("training.commands.close")
                    if action == .setRaceGoal {
                        TextField("比赛日期 YYYY-MM-DD", text: $date).accessibilityIdentifier("training.commands.date")
                        TextField("距离 km", text: $distance).keyboardType(.decimalPad)
                        Picker("目标", selection: $goal) { Text("完赛").tag("finish"); Text("成绩").tag("time") }
                        if goal == "time" { TextField("目标分钟", text: $minutes).keyboardType(.decimalPad) }
                    }
                    Button("预览配置变化") {
                        let requestedAction = action
                        let requestedGoal = raceGoalDraft
                        previewTask = Task {
                            _ = await native.previewTrainingPlanCommand(requestedAction, raceGoal: requestedGoal)
                        }
                    }.disabled(!validDraft || !native.canEditTrainingPlanV2)
                        .accessibilityIdentifier("training.commands.preview")
                }.disabled(publisher.isBusy)
                if let preview = publisher.preview {
                    Section("配置预览") {
                        Text("\(preview.before.mode) / \(preview.before.runState) → \(preview.after.mode) / \(preview.after.runState)")
                        if let target = preview.after.raceGoal {
                            let targetText = target.goal == "time" && target.targetTimeSeconds != nil
                                ? "成绩 \(Int((target.targetTimeSeconds ?? 0) / 60)) 分" : "完赛"
                            Text("\(target.date) · \(nativeKilometers(target.distanceKm)) · \(targetText)")
                        }
                        Text("这是配置变化预览。确认时按最新事实生成计划；不会自动同步手表。")
                        ForEach(preview.warnings, id: \.self) { Text($0).font(.footnote) }
                        Text("预览有效至 \(preview.expiresAt)").font(.caption)
                        Button("确认这次配置变化") { Task { _ = await native.confirmTrainingPlanCommand(action: action, raceGoal: raceGoalDraft) } }
                            .disabled(!native.canEditTrainingPlanV2 || !publisher.matchesPreview(action: action, raceGoal: raceGoalDraft) || native.isPlanBusy)
                            .accessibilityIdentifier("training.commands.confirm")
                    }
                }
                Section("按当前配置刷新") {
                    Text("重新生成会更新未来安排，需要单独确认。")
                    Button("刷新训练安排") { refreshConfirmation = true }
                        .disabled(!canRefresh)
                        .accessibilityIdentifier("training.commands.refresh")
                    if native.trainingPlanStore.unified?.runState != "active" {
                        Text("训练已暂停或结束；恢复后才能重新生成安排。")
                            .font(.caption).foregroundStyle(TechColor.muted)
                    }
                }
                if let message = publisher.message { Section { Text(message) } }
                if native.hasPendingPlanPublication {
                    Button("查询原操作结果") { Task { _ = await native.resolvePlanPublication() } }
                        .disabled(native.isPlanBusy || native.isOffline)
                }
                Button("重新读取当前状态") { Task { _ = await native.refreshUnifiedTrainingPlan() } }.disabled(native.isPlanBusy)
            }
            .navigationTitle("训练配置")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { discardPreview(); dismiss() } } }
            .confirmationDialog("确认按最新事实重新生成？", isPresented: $refreshConfirmation) {
                Button("确认刷新") { Task { _ = await native.confirmTrainingPlanCommand(refresh: true) } }
            }
            .onChange(of: draftKey) { _, _ in discardPreview() }
            .onDisappear { discardPreview() }
            .onChange(of: native.feedbackSessionID) { _, _ in publisher.invalidate(); dismiss() }
            .onAppear {
                discardPreview()
                guard let existing = native.trainingPlanStore.unified?.raceGoal else { return }
                date = existing.date
                distance = Self.numberText(existing.distanceKm)
                goal = existing.goal
                if existing.goal == "time", let seconds = existing.targetTimeSeconds {
                    minutes = Self.numberText(seconds / 60)
                }
            }
        }
    }
}
#endif
