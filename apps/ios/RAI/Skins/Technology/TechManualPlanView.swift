#if os(iOS)
import SwiftUI

struct TechManualPlanView: View {
    @State private var editing = false
    @State private var showingLock = false
    @State private var raceEditor: RaceGoalEditorContext?
    @State private var selectedDay: MobileWeekPlanDay?
    @Environment(NativeAppModel.self) private var native
    @State private var easyFloor = 0.8
    @State private var qualityCap = 2
    @State private var weekPlan: [MobileGoalsPlanItem] = []
    @State private var distanceDrafts: [String: String] = [:]
    @State private var isSaving = false
    @State private var saveMessage: String?
    @State private var saveSucceeded = false
    @State private var draftBase: MobileGoalsResponse?
    @State private var draftSessionID: String?
    @State private var discardDraft = false
    private var draftIsStale: Bool { draftBase?.revision != native.planPresentation.goals?.revision || draftSessionID != native.feedbackSessionID }
    private var areDistancesValid: Bool {
        NativeGoalWeekDraft.distancesAreValid(distanceDrafts, for: weekPlan)
    }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                // 托管时这里**不再**渲染第二套教练控件：训练页是唯一入口，
                // 手动周计划与手表排期也都由训练页/教练命令写入。这里只说明原因，
                // 不再提供"另一套教练按钮"。
                if native.isCoachLoopManaged {
                    managedPlanNotice
                } else if editing {
                    if draftIsStale {
                        TechPanel(tint: TechColor.yellow) {
                            Text("计划已更新，你的未保存修改仍保留。请查看最新计划后再编辑。")
                            if let latest = native.planPresentation.goals {
                                Text("最新：轻松训练时长 ≥\(nativePercent(latest.easyDurationFloorFraction))，质量课 ≤\(latest.qualitySessionCap)；你的草稿：轻松训练时长 ≥\(nativePercent(easyFloor))，质量课 ≤\(qualityCap)。")
                                    .font(.caption)
                            }
                            Button("放弃草稿并加载最新计划") { discardDraft = true }
                        }
                    }
                    goalEditor
                    if native.planPresentation.goals?.weekPlanReplanRequired == true {
                        Text("请先确认规则教练课表；训练设置仍可保存。")
                            .font(.footnote).foregroundStyle(TechColor.coral)
                    } else {
                        weekPlanPanel
                    }
                TechPrimaryButton(title: "保存计划", systemName: "checkmark", isBusy: isSaving, isDisabled: isSaving || native.isPlanBusy || draftIsStale || !areDistancesValid || native.isOffline || native.planPresentation.goals == nil) {
                    Task { await save() }
                }
                } else {
                    planOverview
                    if let days = native.planPresentation.today?.recentPlanExecution, !days.isEmpty {
                        TechPlanExecutionPanel(days: days)
                    }
                }
                if !native.isCoachLoopManaged {
                    if let today = native.planPresentation.today {
                        NavigationLink("成绩预测与依据") { TechBodyMetricsView(data: today) }
                    }
                    racePanel
                    if !editing {
                    TechPrimaryButton(title: native.planPresentation.goals?.weekPlanReplanRequired == true ? "编辑训练设置" : "编辑周计划", isDisabled: native.planPresentation.goals == nil || native.isOffline || native.isPlanBusy) {
                        loadDraft()
                        editing = true
                    }
                    if let today = native.planPresentation.today, !today.lock.present || today.lock.relockSuggested, today.sync.status != "failed" {
                        TechPrimaryButton(title: today.lock.relockSuggested ? "重新确认今日安排" : "锁定今日安排", systemName: "lock", isDisabled: native.isOffline || !native.canConfirmToday || native.isPlanBusy) {
                            showingLock = true
                        }
                    }
                }
                }
                if let saveMessage {
                    TechPanel(tint: saveSucceeded ? TechColor.green : TechColor.coral, fill: saveSucceeded ? TechColor.mint : TechColor.paleCoral) {
                        Text(saveMessage)
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(saveSucceeded ? TechColor.green : TechColor.coral)
                    }
                }
            }
            .id("plan.top")
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .techNavigation(editing ? "编辑周计划" : "训练计划", backDisabled: isSaving)
        .sheet(isPresented: $showingLock) { TechLockSheet() }
        .sheet(item: $raceEditor) { context in TechRaceGoalEditor(context: context) }
        .sheet(item: Binding(get: { native.planPreview }, set: { native.planPreview = $0 })) { preview in
            TechPlanPreviewSheet(preview: preview)
        }
        .sheet(item: $selectedDay) { day in
            NavigationStack { TechPlanDaySheet(day: day, isToday: day.localDate == native.planPresentation.today?.today.localDate) }
        }
        .toolbar {
            if editing {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("取消") { loadDraft(); editing = false }.disabled(isSaving)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("放弃未保存的修改？", isPresented: $discardDraft, titleVisibility: .visible) {
            Button("放弃并加载最新计划", role: .destructive) { loadDraft() }
        }
        .toolbar(.visible, for: .navigationBar)
        .modifier(TechKeyboardDismiss())
        .task {
            if native.planPresentation.goals == nil { await native.refreshAll() }
            // The watch panel lives on this page now, so it must be able to fill
            // itself even when the home screen never ran in this session.
            if native.currentWorkoutPlan == nil { _ = await native.refreshWorkoutPlan() }
        }
        .task(id: native.planPresentation.goals?.raceTarget) {
            if native.planPresentation.goals?.raceTarget != nil { await native.refreshRacePrediction() }
        }
        .onChange(of: editing) { _, _ in
            // Switching modes changes the entire content height. Keep the first
            // field / overview visible instead of preserving a deep old offset.
            proxy.scrollTo("plan.top", anchor: .top)
        }
        .onChange(of: native.feedbackSessionID) { _, _ in raceEditor = nil; selectedDay = nil; showingLock = false }
        }
    }

    /// 托管态说明：只有一个训练入口，手动周计划在托管期间是只读的。
    ///
    /// 之前这里渲染完整的 `TechCoachLoopSection`，于是手动页面成了**第二个**教练
    /// 界面（用户可以在两个页面看到两套按钮）。现在托管说明只解释原因，不存在
    /// 第二套创建/结束入口。
    private var managedPlanNotice: some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 8) {
                TechSectionHeader(title: "训练由统一训练页托管")
                Text("当前训练模式、暂停/恢复、比赛目标与设备排程都在训练页统一管理。手动周计划在托管期间是只读的，不构成第二套写入。")
                    .font(.footnote).foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityIdentifier("manual.managed-notice")
    }

    private var planOverview: some View {
        VStack(alignment: .leading, spacing: 20) {
            TechHeroCard {
                // The weekly-distance headline went away with the stored weekly goal,
                // so the two gauges are now the card's own content instead of a
                // second column beside it — and the adaptive stack no longer needs
                // an inner one to keep them paired on a narrow phone.
                TechAdaptiveStack(spacing: 16) {
                    TechGauge(progress: native.planPresentation.goals?.easyDurationFloorFraction ?? 0,
                              value: nativePercent(native.planPresentation.goals?.easyDurationFloorFraction), label: "轻松占比", size: 68)
                    TechGauge(progress: Double(native.planPresentation.goals?.qualitySessionCap ?? 0) / 4,
                              value: "\(native.planPresentation.goals?.qualitySessionCap ?? 0)", label: "质量课上限", size: 68)
                }
            }
            TechSectionHeader(title: "7 天训练安排", trailing: "自然周")
            if native.planPresentation.today?.weekPlan.isEmpty != false {
                Text("尚未取到本周安排").font(.footnote).foregroundStyle(TechColor.muted)
            } else {
                // The executable week, straight from `/v1/mobile/today` — the
                // same array the home screen draws its week card from, so the
                // two screens cannot name a different session for one date.
                // Building the chips from the *stored* plan instead read the
                // last saved prescription for every date: today showed a
                // session the recovery gate had already overruled, and a past
                // day showed "间歇跑 8.6 km" while the home screen showed what
                // was actually run. The server already resolves the three
                // tenses (`buildWeekPlan`), and that rule stays on the server.
                //
                // Equal-width day cards wrap with available space / Dynamic Type;
                // every day remains reachable without tiny seven-column hit targets.
                // Tapping a column opens that day's prescription, which is the
                // only place the interval breakdown is spelled out.
                TechMetricGrid(minimum: 76) {
                    ForEach(native.planPresentation.today?.weekPlan ?? []) { day in
                        Button { selectedDay = day } label: { weekChip(day) }
                            .buttonStyle(TechPressStyle())
                            .frame(maxWidth: .infinity)
                            .accessibilityLabel(weekChipLabel(day))
                    }
                }
                .frame(maxWidth: .infinity)
            }
            if native.isOffline {
                Label("离线时可查看计划，重新连接后可编辑", systemImage: "wifi.slash")
                    .font(.footnote).foregroundStyle(TechColor.yellow)
            }
            watchPlanPanel
        }
    }

    /// Equal-width day cards wrap at large sizes; labels never shrink below Dynamic Type.
    private func weekChip(_ day: MobileWeekPlanDay) -> some View {
        let isToday = day.localDate == native.planPresentation.today?.today.localDate
        return VStack(spacing: 11) {
            VStack(spacing: 4) {
                Text(nativeWeekday(day.localDate))
                Text(nativeDay(day.localDate))
            }
            .font(.caption2)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .foregroundStyle(isToday ? TechColor.actionInk : TechColor.muted)
            .background(isToday ? TechColor.action : TechColor.grid.opacity(0.25), in: TechSurfaceShape())
            Circle().fill(techSessionColor(day.kind)).frame(width: 8, height: 8)
            Text(nativeSessionName(day.kind))
                .font(.caption2)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(TechColor.ink)
            Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "—")
                .font(.caption2.weight(.bold).monospacedDigit())
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(TechColor.ink)
        }
        .padding(.horizontal, 2)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(isToday ? TechColor.mint : TechColor.paper, in: TechSurfaceShape())
        .overlay(TechSurfaceShape().stroke(isToday ? TechColor.cyan : TechColor.grid.opacity(0.45), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 9))
    }

    private func weekChipLabel(_ day: MobileWeekPlanDay) -> String {
        let distance = day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "无距离"
        // F03：过去一天"排了课但没有观测"不是休息。把观测状态念出来，避免
        // VoiceOver 用户只听到一个可能被误读的课型。
        let note = TrainingPlanUnifiedPolicy.observationNote(day).map { "，\($0)" } ?? ""
        return "\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(nativeSessionName(day.kind))，\(distance)\(note)，查看训练详情"
    }

    private var watchPlanPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            TechPlanWatchSection(allowsSynchronization: true)
            TechPrimaryButton(title: "预览未来 7 日课表", systemName: "calendar.badge.clock",
                isBusy: native.isRegeneratingPlan, isDisabled: native.isPlanBusy || native.isOffline) {
                Task { _ = await native.createWeeklyPlanPreview() }
            }
        }
    }

    private var goalEditor: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 13) {
                TechSectionHeader(title: "训练设置")
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text("轻松训练时长下限")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TechColor.green)
                        Spacer()
                        Text(nativePercent(easyFloor))
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TechColor.coral)
                    }
                    Slider(value: $easyFloor, in: 0.4...0.95, step: 0.05)
                        .tint(TechColor.cyan)
                }
                HStack {
                    Text("质量课上限")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TechColor.green)
                    Spacer()
                    Stepper("\(qualityCap) 次", value: $qualityCap, in: 0...4)
                        .labelsHidden()
                    Text("\(qualityCap) 次")
                        .font(.footnote.weight(.semibold).monospacedDigit())
                }

            }
        }
    }

    /// The rows of the stored plan this editor may change.
    ///
    /// Today remains read-only in this editor: preview/lock confirmation owns
    /// same-day changes. Future changes become the basis of that day's coach,
    /// subject to live recovery, load and race gates. Historical rows round-trip.
    ///
    /// When today's date is unknown — `/v1/mobile/today` failed while the goals
    /// request succeeded — nothing is offered. The editor cannot tell which row
    /// is the inert one, and guessing would restore exactly the edit this
    /// property exists to withhold.
    private var editablePlanIndexes: [Int] {
        guard native.planPresentation.goals?.weekPlanReplanRequired != true else { return [] }
        guard let today = native.planPresentation.today?.today.localDate else { return [] }
        return weekPlan.indices.filter { weekPlan[$0].localDate > today }
    }

    private var weekPlanPanel: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 8) {
                TechSectionHeader(title: "本周安排", trailing: "逐日计划")
                if !areDistancesValid {
                    Text("每日距离请输入 0–80 km，留空表示未设置。")
                        .font(.caption).foregroundStyle(TechColor.coral)
                }
                if weekPlan.isEmpty {
                    Text("服务端尚未保存逐日计划")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else if editablePlanIndexes.isEmpty {
                    Text(native.planPresentation.today == nil
                        ? "未能取到今日状态，无法确定哪一天由恢复状态决定，暂不可编辑。"
                        : "今天之前的日期由服务端置为休息，今天由恢复状态决定；本周没有可编辑的日期。")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    ForEach(editablePlanIndexes, id: \.self) { index in
                        let item = weekPlan[index]
                        TechAdaptiveStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(nativeWeekday(item.localDate)).font(.caption.weight(.semibold))
                                Text(nativeDay(item.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
                            }.frame(minWidth: 48, alignment: .leading)
                            Picker("训练类型", selection: $weekPlan[index].kind) {
                                Text("休息").tag("rest")
                                Text("恢复跑").tag("recovery")
                                Text("轻松跑").tag("easy")
                                Text("长距离").tag("long_run")
                                Text("节奏跑").tag("tempo")
                                Text("间歇跑").tag("interval")
                            }.pickerStyle(.menu).tint(TechColor.cyan).frame(maxWidth: .infinity, minHeight: 44)
                            if NativeGoalWeekDraft.canEditDistance(item.kind) {
                                TextField("km", text: Binding(
                                get: { distanceDrafts[item.id] ?? "" },
                                set: { distanceDrafts[item.id] = $0 }
                            )).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                                .font(.subheadline.monospacedDigit()).frame(minWidth: 70, minHeight: 44)
                                .accessibilityLabel("\(nativeWeekday(item.localDate))距离")
                                Text("km").font(.caption).foregroundStyle(TechColor.muted)
                            } else {
                                Text(item.kind == "rest" ? "无需跑量" : "按分段处方计算")
                                    .font(.caption).foregroundStyle(TechColor.muted)
                            }
                        }
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) { Rectangle().fill(TechColor.grid).frame(height: 1) }
                    }
                }
            }
        }
    }

    private var racePanel: some View {
        Group {
            if let goals = native.planPresentation.goals {
                TechPanel(tint: TechColor.cyan, fill: .clear) {
                    VStack(alignment: .leading, spacing: 8) {
                        TechSectionHeader(title: "比赛目标", trailing: goals.raceTarget == nil ? "未设置" : "已设置", trailingColor: TechColor.cyan)
                        if let race = goals.raceTarget {
                            Text("\(techRaceDistanceName(race.distance)) · \(race.date)")
                                .font(.headline.weight(.semibold))
                            Text(race.targetPaceSecondsPerKm.map { "目标配速：\(techPace($0))/km" } ?? "未设置目标配速")
                                .font(.footnote)
                                .foregroundStyle(TechColor.muted)
                        } else {
                            Text("尚未设置比赛目标。")
                                .font(.footnote)
                                .foregroundStyle(TechColor.muted)
                        }
                        Text("赛事准备度根据近 8 周跑量、长距离、频率、专项训练次数和训练时效计算，不是体型评分，也不是目标成绩达成概率。")
                            .font(.caption).foregroundStyle(TechColor.muted)
                        if let card = native.planPresentation.today?.race {
                            Text("跑量基础 \(nativePercent(card.volumeFraction)) · 长距离基础 \(nativePercent(card.longRunFraction))")
                                .font(.footnote)
                            Text(card.note).font(.caption).foregroundStyle(TechColor.muted)
                            if let days = card.daysUntil, days < 0 {
                                Text("比赛日期已过，不代表已参赛或完赛；赛后恢复按实际导入负荷判断。请更新或清除目标。")
                                    .font(.caption).foregroundStyle(TechColor.coral)
                            }
                        }
                        if let race = goals.raceTarget {
                            Text("目标完赛：\(NativeRaceGoalDraft.finishText(pace: race.targetPaceSecondsPerKm, distance: race.distance).isEmpty ? "未设置" : NativeRaceGoalDraft.finishText(pace: race.targetPaceSecondsPerKm, distance: race.distance))")
                                .font(.footnote)
                            if let prediction = native.predictions?.snapshot.races.first(where: { $0.distance == race.distance }) {
                                Text("模型估计 \(nativeDuration(prediction.predictedSeconds)) · 区间 \(nativeDuration(prediction.optimisticSeconds))–\(nativeDuration(prediction.pessimisticSeconds))")
                                    .font(.caption)
                                Text("预测置信度 \(nativePercent(prediction.confidence))；不是目标达成概率。")
                                    .font(.caption).foregroundStyle(TechColor.muted)
                                if prediction.predictedSeconds == nil {
                                    Text("有效训练数据不足，暂不能估计完赛时间。").font(.caption)
                                }
                                Text("估计基于当前训练数据，并非比赛成绩承诺；目标不会反向提高训练强度。")
                                    .font(.caption).foregroundStyle(TechColor.muted)
                            } else {
                                Text("暂未取得成绩预测，可刷新数据后查看；不以缺失值代替成绩。")
                                    .font(.caption).foregroundStyle(TechColor.muted)
                            }
                        }
                        if native.usesUnifiedTrainingPage {
                            // 统一训练页已经存在时，比赛目标是**同一个**模式的输入，
                            // 不再在手动页面另开一份独立目标编辑器；否则两个编辑器会
                            // 各写一半（统一状态 vs 旧 goals.raceTarget），又回到 PR5
                            // 要消灭的"两套开关"。
                            Text("比赛目标在训练页统一调整（模式选“比赛备赛”）；这里不再单独编辑。")
                                .font(.caption).foregroundStyle(TechColor.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Button(goals.raceTarget == nil ? "设置比赛目标" : "编辑比赛目标") {
                                raceEditor = RaceGoalEditorContext(goals: goals, editorSessionID: native.feedbackSessionID)
                            }
                            .disabled(native.isOffline || editing || native.isPlanBusy)
                            .accessibilityIdentifier("race-goal-edit")
                        }
                        if let locked = goals.lockedSession {
                            Text("锁定课程：\(locked.session.title) · \(nativeDate(locked.lockedAt))")
                                .font(.caption)
                                .foregroundStyle(TechColor.green)
                        }
                    }
                }
                .background { TechRaceLandscape().clipShape(TechSurfaceShape()) }
            }
        }
    }

    private func loadDraft() {
        guard let goals = native.planPresentation.goals else { return }
        draftBase = goals
        draftSessionID = native.feedbackSessionID
        easyFloor = goals.easyDurationFloorFraction
        qualityCap = goals.qualitySessionCap
        weekPlan = goals.weekPlan
        distanceDrafts = NativeGoalWeekDraft.drafts(from: goals.weekPlan)
    }

    private func save() async {
        guard !isSaving, !draftIsStale, let draftBase, areDistancesValid else { return }
        let plan = NativeGoalWeekDraft.normalized(
            weekPlan,
            drafts: distanceDrafts,
            loaded: draftBase.weekPlan
        )
        isSaving = true
        saveMessage = nil
        let success = await native.saveGoals(
            expectedRevision: draftBase.revision,
            easyDurationFloorFraction: easyFloor,
            qualitySessionCap: qualityCap,
            weekPlan: plan,
            editorSessionID: draftSessionID
        )
        saveMessage = success ? (native.planMessage ?? "已保存，服务端已确认。") : (native.errorMessage ?? "保存未完成，你的草稿已保留。")
        saveSucceeded = success
        if success { editing = false }
        isSaving = false
    }
}

/// The prescription one column of the week strip opens into.
///
/// The strip can only carry a kind, a colour and a distance; the interval
/// breakdown, the warmup and the pace band are what actually make the day
/// executable, and the stored plan is the only thing that carries them.
private struct TechPlanDaySheet: View {
    let day: MobileWeekPlanDay
    let isToday: Bool

    private var statusText: String {
        // F03：观测字段优先。过去一天有原处方、没有观测时，页面必须说"尚无训练
        // 观测"，而不是把"没有证据"印成"休息日"。
        if let note = TrainingPlanUnifiedPolicy.observationNote(day) { return note }
        // The word is a statement about the data, so it lives next to the mapper's
        // other day judgments; only the colour below is a skin decision.
        return WorkoutPlanMapper.weekStripStatus(
            completed: day.completedWorkoutId != nil,
            isRest: day.kind == "rest",
            isToday: isToday
        )
    }

    private var statusColor: Color {
        if day.completedWorkoutId != nil { return TechColor.green }
        if day.kind == "rest" { return TechColor.muted }
        return isToday ? TechColor.cyan : TechColor.ink
    }

    private var lines: [NativeStructureLine] { nativeStructureLines(day.structure) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(nativeWeekday(day.localDate)) · \(nativeDay(day.localDate))")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(TechColor.ink)
                        Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                            .font(.subheadline)
                            .foregroundStyle(TechColor.muted)
                    }
                    Spacer(minLength: 0)
                    Circle().fill(techSessionColor(day.kind))
                        .frame(width: 12, height: 12)
                        .padding(.top, 7)
                }
                TechMetricGrid(minimum: 140) {
                    TechMetricTile(title: "距离", value: day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "—")
                    TechMetricTile(title: "状态", value: statusText, accent: statusColor)
                }
                if lines.isEmpty {
                    TechPanel {
                        Text(day.completedWorkoutId != nil || day.kind == "completed" ? "这一天已导入训练。历史实际记录不会通过重新生成计划补写处方。" : day.kind == "rest"
                            ? "这一天没有训练安排。"
                            : "这一天还没有结构化处方；生成课表后，热身、主课与放松的步骤会显示在这里。")
                            .font(.footnote)
                            .foregroundStyle(TechColor.muted)
                    }
                } else {
                    TechPanel {
                        VStack(alignment: .leading, spacing: 12) {
                            TechSectionHeader(title: "训练内容", trailing: "\(lines.count) 步")
                            ForEach(lines) { line in
                                TechAdaptiveStack(spacing: 12) {
                                    Text(line.title)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(TechColor.cyan)
                                        .frame(minWidth: 80, alignment: .leading)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Text(line.detail)
                                        .font(.caption)
                                        .foregroundStyle(TechColor.ink)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
                if let workoutId = day.completedWorkoutId {
                    NavigationLink("查看已记录训练") { TechWorkoutDetailView(workoutId: workoutId) }
                        .font(.footnote.weight(.semibold)).foregroundStyle(TechColor.cyan)
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.vertical, TechMetrics.pageVertical)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .presentationDragIndicator(.visible)
    }
}

#endif
