#if os(iOS)
import SwiftUI

struct TechPlanView: View {
    @State private var editing = false
    @State private var showingLock = false
    @State private var raceEditor: RaceGoalEditorContext?
    @State private var isSyncingPlan = false
    @State private var planSyncMessage: String?
    @State private var selectedDay: MobileWeekPlanDay?
    @Environment(NativeAppModel.self) private var native
    @State private var weeklyText = "30"
    @State private var easyFloor = 0.8
    @State private var qualityCap = 2
    @State private var weekPlan: [MobileGoalsPlanItem] = []
    @State private var distanceDrafts: [String: String] = [:]
    @State private var isSaving = false
    @State private var saveMessage: String?
    @State private var saveSucceeded = false
    @State private var draftBase: MobileGoalsResponse?
    @State private var discardDraft = false
    private var draftIsStale: Bool { draftBase?.revision != native.goals?.revision }

    // The bounds, the parsing rule and the "clear a stale structure" rule are
    // shared with the pixel skin through `NativeGoalWeekDraft`; none of them is a
    // skin decision, and keeping a copy per skin is how the 2026-09-13 fix ended
    // up in one skin only.
    private var weeklyValue: Double? { NativeGoalWeekDraft.parsedDistance(weeklyText) }
    private var areDistancesValid: Bool {
        NativeGoalWeekDraft.distancesAreValid(distanceDrafts, for: weekPlan)
    }
    private var isWeeklyValid: Bool { NativeGoalWeekDraft.weeklyDistanceIsValid(weeklyText) }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                if editing {
                    if draftIsStale {
                        TechPanel(tint: TechColor.yellow) {
                            Text("计划已更新，你的未保存修改仍保留。请查看最新计划后再编辑。")
                            if let latest = native.goals {
                                Text("最新：\(nativeKilometers(latest.weeklyDistanceKm)) / 周，质量课 ≤\(latest.qualitySessionCap)；你的草稿：\(weeklyText) km / 周，质量课 ≤\(qualityCap)。")
                                    .font(.caption)
                            }
                            Button("放弃草稿并加载最新计划") { discardDraft = true }
                        }
                    }
                    goalEditor
                    weekPlanPanel
                TechPrimaryButton(title: "保存计划", systemName: "checkmark", isBusy: isSaving, isDisabled: isSaving || native.isPlanBusy || draftIsStale || !isWeeklyValid || !areDistancesValid || native.isOffline || native.goals == nil) {
                    Task { await save() }
                }
                } else {
                    planOverview
                    rollingPlanPanel
                    if let days = native.today?.recentPlanExecution, !days.isEmpty {
                        TechPlanExecutionPanel(days: days)
                    }
                }
                racePanel
                if !editing {
                    TechPrimaryButton(title: "编辑周计划", isDisabled: native.goals == nil || native.isOffline || native.isPlanBusy) {
                        loadDraft()
                        editing = true
                    }
                    if let today = native.today, !today.lock.present || today.lock.relockSuggested, today.sync.status != "failed" {
                        TechPrimaryButton(title: today.lock.relockSuggested ? "重新确认今日安排" : "锁定今日安排", systemName: "lock", isDisabled: native.isOffline || native.isPlanBusy) {
                            showingLock = true
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
        .techNavigation(editing ? "编辑周计划" : "训练计划")
        .sheet(isPresented: $showingLock) { TechLockSheet() }
        .sheet(item: $raceEditor) { context in TechRaceGoalEditor(context: context) }
        .sheet(item: Binding(get: { native.planPreview }, set: { native.planPreview = $0 })) { preview in
            TechPlanPreviewSheet(preview: preview)
        }
        .sheet(item: $selectedDay) { day in
            NavigationStack { TechPlanDaySheet(day: day, isToday: day.localDate == native.today?.today.localDate) }
        }
        .toolbar {
            if editing {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("取消") { loadDraft(); editing = false }.disabled(isSaving)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(isSaving)
        .confirmationDialog("放弃未保存的修改？", isPresented: $discardDraft, titleVisibility: .visible) {
            Button("放弃并加载最新计划", role: .destructive) { loadDraft() }
        }
        .toolbar(.visible, for: .navigationBar)
        .modifier(TechKeyboardDismiss())
        .task {
            if native.goals == nil { await native.refreshAll() }
            // The watch panel lives on this page now, so it must be able to fill
            // itself even when the home screen never ran in this session.
            if native.workoutPlan == nil { _ = await native.refreshWorkoutPlan() }
            if !editing { loadDraft() }
        }
        .onChange(of: native.goals?.revision) { _, _ in if !editing { loadDraft() } }
        .task(id: native.goals?.raceTarget) {
            if native.goals?.raceTarget != nil { await native.refreshRacePrediction() }
        }
        .onChange(of: editing) { _, _ in
            // Switching modes changes the entire content height. Keep the first
            // field / overview visible instead of preserving a deep old offset.
            proxy.scrollTo("plan.top", anchor: .top)
        }
        }
    }

    private var planOverview: some View {
        VStack(alignment: .leading, spacing: 20) {
            TechHeroCard {
                TechAdaptiveStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("本周总里程").font(.subheadline).foregroundStyle(TechColor.muted)
                        Text(nativeNumber(native.goals?.weeklyDistanceKm) + " km")
                            .techScaledFont(34, weight: .bold).foregroundStyle(TechColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    // Keep the two related gauges together when the mileage
                    // moves to its own row on a smaller phone.
                    TechAdaptiveStack(spacing: 16) {
                        TechGauge(progress: native.goals?.easyDurationFloorFraction ?? 0,
                                  value: nativePercent(native.goals?.easyDurationFloorFraction), label: "轻松占比", size: 68)
                        TechGauge(progress: Double(native.goals?.qualitySessionCap ?? 0) / 4,
                                  value: "\(native.goals?.qualitySessionCap ?? 0)", label: "质量课上限", size: 68)
                    }
                }

            }
            TechSectionHeader(title: "7 天训练安排", trailing: "本周")
            if native.today?.weekPlan.isEmpty != false {
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
                    ForEach(native.today?.weekPlan ?? []) { day in
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
        let isToday = day.localDate == native.today?.today.localDate
        return VStack(spacing: 11) {
            VStack(spacing: 4) {
                Text(nativeWeekday(day.localDate))
                Text(nativeDay(day.localDate))
            }
            .font(.caption2)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .foregroundStyle(isToday ? TechColor.background : TechColor.muted)
            .background(isToday ? TechColor.action : TechColor.grid.opacity(0.25), in: RoundedRectangle(cornerRadius: 6))
            Circle().fill(techSessionColor(day.kind)).frame(width: 8, height: 8)
            Text(nativeSessionName(day.kind))
                .font(.caption2)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(TechColor.ink)
            Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "—")
                .font(.caption2.monospacedDigit())
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(TechColor.muted)
        }
        .padding(.horizontal, 2)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(isToday ? TechColor.blue.opacity(0.17) : TechColor.paper, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(isToday ? TechColor.cyan : TechColor.grid.opacity(0.45), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 9))
    }

    private func weekChipLabel(_ day: MobileWeekPlanDay) -> String {
        let distance = day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "无距离"
        return "\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(nativeSessionName(day.kind))，\(distance)，查看训练详情"
    }

    /// Generation and sync stay two separate actions, and they live here now:
    /// the home screen no longer carries the watch panel, so this page is the
    /// only place that can rewrite the stored week or mirror it onto the watch.
    private var watchPlanPanel: some View {
        let plan = native.workoutPlan
        // The panel used to count the server's `executable` flag, which is a
        // looser question than "did this day survive mapping" — a week could read
        // "5 项可上表" while the watch received four. Counting with the bridge's
        // own predicate keeps the sentence and the sync in agreement, and that
        // predicate now also leaves out the days the watch is no longer owed — over,
        // or already trained — which the sentence below has always promised
        // ("已完成的日期不会重复下发").
        //
        // Reading the offer rather than recomputing a count is what lets the zero
        // case say *why* it is zero: a week that is finished or already run is not a
        // shortfall, and the old copy told the runner to regenerate it anyway, while
        // the sync itself reported "本周没有还需要上表的训练". One classification,
        // two surfaces.
        let now = Date()
        let offer = plan.map {
            WorkoutPlanMapper.weekOffer(in: $0, now: now, completedLocalDates: native.completedWeekDates)
        }
        let schedulableCount = offer?.offered.count ?? 0
        let unoffered = plan.map {
            WorkoutPlanMapper.unofferedDays(in: $0, completedLocalDates: native.completedWeekDates)
        } ?? []
        return TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(
                    title: "手表课表",
                    trailing: plan == nil ? "未生成" : "\(schedulableCount) 项可上表",
                    trailingColor: TechColor.cyan
                )
                if plan == nil {
                    Text("还没有本周课表。生成后即可一键同步到手表「体能训练」。")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else if schedulableCount == 0 {
                    // The fallback is the same string the classifier would return for
                    // a week with nothing usable in it, so "no plan to ask" and "plan
                    // with nothing to send" stay one sentence rather than two copies.
                    Text(offer?.emptyOfferMessage ?? WorkoutPlanMapper.WeekOffer.unusableWeekMessage)
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    Text("将把 \(schedulableCount) 天训练写入手表「体能训练」，已完成的日期不会重复下发。")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                }
                if !unoffered.isEmpty {
                    // "N 项可上表" already implies something was left out; naming
                    // which days, and why, is the only part the runner can act on.
                    Text("以下日期不会上表：" + unoffered
                        .map { "\(nativeDay($0.localDate)) \($0.reason)" }
                        .joined(separator: "、"))
                        .font(.caption)
                        .foregroundStyle(TechColor.coral)
                }
                if let audit = plan?.audit {
                    Text(
                        audit.generatedBy == "llm"
                            ? "由 \(audit.model ?? "大模型") 生成 · \(nativeDate(audit.generatedAt ?? ""))"
                            : "由保守模板生成 · \(nativeDate(audit.generatedAt ?? ""))"
                    )
                    .font(.caption2)
                    .foregroundStyle(TechColor.muted)
                }
                if let message = native.planMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(TechColor.ink)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TechColor.paleYellow, in: RoundedRectangle(cornerRadius: 12))
                }
                if let message = planSyncMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(TechColor.ink)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TechColor.mint, in: RoundedRectangle(cornerRadius: 12))
                }
                TechPrimaryButton(
                    title: schedulableCount == 0 ? "撤回手表旧课表" : "一键同步到手表",
                    systemName: "applewatch",
                    isBusy: isSyncingPlan,
                    isDisabled: native.isOffline || plan == nil || native.isPlanBusy
                ) {
                    syncPlanToWatch()
                }
                Button {
                    Task { _ = await native.regenerateWeeklyPlan() }
                } label: {
                    HStack(spacing: 6) {
                        if native.isRegeneratingPlan {
                            ProgressView().tint(TechColor.cyan).scaleEffect(0.7)
                        } else {
                            Image(systemName: "wand.and.stars")
                        }
                        Text(native.isRegeneratingPlan ? "生成中…" : "预览未来七日课表")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(TechColor.cyan)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background {
                        Capsule().stroke(TechColor.cyan, lineWidth: 1)
                    }
                }
                .buttonStyle(TechPressStyle())
                .disabled(native.isPlanBusy || native.isOffline)
            }
        }
    }

    private func syncPlanToWatch() {
        guard !isSyncingPlan, let syncID = native.beginPlanSync() else { return }
        isSyncingPlan = true
        planSyncMessage = nil
        Task {
            defer { isSyncingPlan = false; native.endPlanSync(syncID) }
            guard await native.refreshPlanState(), let plan = native.workoutPlan else {
                planSyncMessage = "未能确认最新计划，未改动手表排期。请刷新后重试。"
                return
            }
            // Permission is asked for only when the user actually tries to sync, so
            // the system prompt arrives with an obvious reason attached to it.
            let outcome = await WorkoutKitBridge.syncRequestingAuthorization(
                plan: plan,
                completedLocalDates: native.completedWeekDates,
                isCurrent: {
                    native.isCurrentPlanSync(syncID) && native.goals?.revision == plan.planRevision &&
                        native.workoutPlan?.days == plan.days && native.workoutPlan?.timezone == plan.timezone
                }
            )
            guard native.isCurrentPlanSync(syncID) else { return }
            if outcome.verified && outcome.authorized {
                native.recordWatchAcknowledgement(plan: plan)
            }
            // Receipts are registered only for the days the bridge read back off
            // the scheduler: the row means "the watch received this day", and a
            // plan that never got there must not be allowed to label a later run.
            let receipt = outcome.scheduledLocalDates.isEmpty
                ? nil
                : await native.recordPlanSync(plan, localDates: outcome.scheduledLocalDates)
            isSyncingPlan = false
            planSyncMessage = [outcome.report, receipt].compactMap { $0 }.joined(separator: "；")
        }
    }

    private var rollingPlanPanel: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "未来七日 · 手表排期", trailing: native.workoutPlan.map { "v\($0.planRevision)" } ?? "未加载")
                Text("上方为周一至周日的自然周；此处从今天起连续七日，与生成窗口一致。")
                    .font(.caption).foregroundStyle(TechColor.muted)
                Text("执行窗口按当前预算、比赛与负荷规则复核；调整后的处方以下列内容为准，保存的原计划不会被静默改写。")
                    .font(.caption).foregroundStyle(TechColor.muted)
                if let plan = native.workoutPlan {
                    ForEach(plan.days) { day in
                        TechExecutablePlanDay(day: day)
                    }
                }
                Text("已保存 v\(native.goals?.revision ?? 0) · " + (native.lastWatchRevision.map { "本次会话已核验手表 v\($0)" } ?? "本次会话尚未核验手表版本"))
                    .font(.caption).foregroundStyle(TechColor.muted)
                if native.watchNeedsUpdate {
                    Text("计划版本或有效处方已变化，请重新同步手表。").font(.caption).foregroundStyle(TechColor.coral)
                }
            }
        }
    }

    private var goalEditor: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 13) {
                TechSectionHeader(title: "周目标", trailing: "1–500 km")
                TechField("每周跑量") {
                    HStack {
                        TextField("30", text: $weeklyText)
                            .accessibilityIdentifier("plan.weeklyDistance")
                            .keyboardType(.decimalPad)
                            .textInputAutocapitalization(.never)
                        Text("km")
                            .foregroundStyle(TechColor.muted)
                    }
                }
                if !weeklyText.isEmpty && !isWeeklyValid {
                    Text("请输入 1 到 500 km 的目标。")
                        .font(.caption)
                        .foregroundStyle(TechColor.coral)
                }
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
        guard let today = native.today?.today.localDate else { return [] }
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
                    Text(native.today == nil
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
            if let goals = native.goals {
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
                        if let card = native.today?.race {
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
                        Button(goals.raceTarget == nil ? "设置比赛目标" : "编辑比赛目标") {
                            raceEditor = RaceGoalEditorContext(goals: goals)
                        }
                        .disabled(native.isOffline || editing || native.isPlanBusy)
                        .accessibilityIdentifier("race-goal-edit")
                        if let locked = goals.lockedSession {
                            Text("锁定课程：\(locked.session.title) · \(nativeDate(locked.lockedAt))")
                                .font(.caption)
                                .foregroundStyle(TechColor.green)
                        }
                    }
                }
                .background { TechRaceLandscape().clipShape(RoundedRectangle(cornerRadius: TechMetrics.corner)) }
            }
        }
    }

    private func loadDraft() {
        guard let goals = native.goals else { return }
        draftBase = goals
        weeklyText = nativeNumber(goals.weeklyDistanceKm)
        easyFloor = goals.easyDurationFloorFraction
        qualityCap = goals.qualitySessionCap
        weekPlan = goals.weekPlan
        distanceDrafts = NativeGoalWeekDraft.drafts(from: goals.weekPlan)
    }

    private func save() async {
        guard !isSaving, !draftIsStale, let draftBase, areDistancesValid, let weekly = weeklyValue,
              NativeGoalWeekDraft.weeklyDistanceIsValid(weeklyText) else { return }
        let plan = NativeGoalWeekDraft.normalized(
            weekPlan,
            drafts: distanceDrafts,
            loaded: draftBase.weekPlan
        )
        isSaving = true
        saveMessage = nil
        let success = await native.saveGoals(
            expectedRevision: draftBase.revision,
            weeklyDistanceKm: weekly,
            easyDurationFloorFraction: easyFloor,
            qualitySessionCap: qualityCap,
            weekPlan: plan
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
        // The word is a statement about the data, so it lives next to the mapper's
        // other day judgments; only the colour below is a skin decision.
        WorkoutPlanMapper.weekStripStatus(
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
                    NavigationLink("查看已完成训练") { TechWorkoutDetailView(workoutId: workoutId) }
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
