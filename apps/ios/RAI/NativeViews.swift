#if os(iOS)
import Charts
import CoreLocation
import MapKit
import SwiftUI
import UIKit

struct NativeRootView: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(ServerSession.self) private var session
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                TodayView()
            }
            .tabItem { Label("今日", systemImage: "sun.max.fill") }
            .tag(0)

            NavigationStack {
                WorkoutsView()
            }
            .tabItem { Label("训练", systemImage: "figure.run") }
            .tag(1)

            NavigationStack {
                PlanView()
            }
            .tabItem { Label("计划", systemImage: "calendar") }
            .tag(2)

            NavigationStack {
                AnalysisView()
            }
            .tabItem { Label("分析", systemImage: "chart.xyaxis.line") }
            .tag(3)

            NavigationStack {
                NativeSettingsView()
            }
            .tabItem { Label("设置", systemImage: "gearshape.fill") }
            .tag(4)
        }
        .tint(.orange)
        .task {
            await native.bootstrap()
        }
        .onChange(of: session.serverURLString) { _, _ in
            native.serverConfigurationChanged()
        }
        .alert("请求未完成", isPresented: Binding(
            get: { native.errorMessage != nil },
            set: { if !$0 { native.errorMessage = nil } }
        )) {
            Button("知道了", role: .cancel) { native.errorMessage = nil }
        } message: {
            Text(native.errorMessage ?? "")
        }
    }
}

struct TodayView: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(ServerSession.self) private var session
    @Environment(HealthKitSync.self) private var healthSync

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let today = native.today {
                    FreshnessBanner(today: today, isOffline: native.isOffline, cacheDate: native.lastCacheUpdate)
                    abilityPanel(today)
                    verdictPanel(today)
                    todayMetrics(today)
                    weekPanel(today)
                    recoveryPanel(today)
                    planPanel(today)
                    recentPanel(today)
                } else if native.isLoading {
                    ProgressView("正在读取 RAI 服务")
                        .frame(maxWidth: .infinity, minHeight: 260)
                } else {
                    emptyPanel
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .navigationTitle("RAI")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await native.refreshAll() }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(native.isRefreshing)
            }
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    Task {
                        await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                    }
                } label: {
                    Label("同步健康", systemImage: "heart.text.square")
                }
                .disabled(healthSync.isBusy || native.isOffline)
            }
        }
        .refreshable {
            await native.refreshAll()
        }
    }

    private func abilityPanel(_ data: MobileTodayResponse) -> some View {
        NativePanel {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("当前跑力")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(nativeNumber(data.ability.trueAbility, digits: 1))
                        .font(.system(size: 42, weight: .bold, design: .rounded))
                        .foregroundStyle(.orange)
                    Text(data.ability.explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 8) {
                    metricCaption("近 7 天", value: nativeNumber(data.ability.changeFrom7DaysAgo, digits: 1))
                    metricCaption("增长速度", value: nativeNumber(data.ability.growthVelocityPerWeek, digits: 1))
                    metricCaption("衰减", value: nativeNumber(data.ability.decayPoints, digits: 1))
                }
            }
        }
    }

    private func verdictPanel(_ data: MobileTodayResponse) -> some View {
        NativePanel {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: data.verdict.tone == "green" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.title2)
                    .foregroundStyle(nativeToneColor(data.verdict.tone))
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(data.verdict.title)
                            .font(.headline)
                        if data.verdict.stale {
                            Text("数据过期")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.red)
                        }
                    }
                    Text(data.verdict.reason)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if data.nextSession.kind != "rest" {
                        Text("下一课：\(data.nextSession.title) · \(nativeKilometers(data.nextSession.distanceKm))")
                            .font(.footnote.weight(.semibold))
                    }
                }
            }
            if data.lock.present {
                Label("今日安排已锁定", systemImage: "lock.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.orange)
                    .padding(.top, 8)
            } else if !data.verdict.stale {
                Button {
                    Task { _ = await native.lockNextSession() }
                } label: {
                    Label("锁定今日安排", systemImage: "lock.open")
                }
                .buttonStyle(.bordered)
                .padding(.top, 8)
            }
        }
    }

    private func todayMetrics(_ data: MobileTodayResponse) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            NativeMetricTile(title: "今日距离", value: nativeKilometers(data.today.distanceKm))
            NativeMetricTile(title: "时长", value: nativeDuration(data.today.durationSeconds))
            NativeMetricTile(title: "配速", value: nativePace(data.today.paceSecondsPerKm))
            NativeMetricTile(title: "训练次数", value: "\(data.today.workoutCount)")
            NativeMetricTile(title: "能量", value: data.today.energyKcal.map { "\(nativeNumber($0)) kcal" } ?? "--")
            NativeMetricTile(title: "今日日期", value: nativeDay(data.today.localDate))
        }
    }

    private func weekPanel(_ data: MobileTodayResponse) -> some View {
        NativePanel {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("本周进度")
                        .font(.headline)
                    Text("\(nativeKilometers(data.week.distanceKm)) / \(nativeKilometers(data.week.goalDistanceKm))")
                        .font(.title3.weight(.bold))
                }
                Spacer()
                Text(nativePercent(data.week.goalProgressFraction))
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.orange)
            }
            Chart(data.weekDaily) { day in
                BarMark(
                    x: .value("日期", nativeDay(day.localDate)),
                    y: .value("距离", day.distanceKm)
                )
                .foregroundStyle(.orange.gradient)
            }
            .frame(height: 150)
            .chartYAxis { AxisMarks(position: .leading) }
        }
    }

    private func recoveryPanel(_ data: MobileTodayResponse) -> some View {
        NativePanel {
            HStack {
                Text("恢复")
                    .font(.headline)
                Spacer()
                Text(nativeStatusName(data.recovery.state))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(nativeToneColor(data.recovery.state == "recovered" ? "green" : "yellow"))
            }
            HStack(spacing: 18) {
                metricCaption("睡眠", value: data.recovery.lastNightSleepMinutes.map { "\(nativeNumber($0, digits: 0)) 分" } ?? "无记录")
                metricCaption("HRV", value: data.recovery.morningHrvMs.map { "\(nativeNumber($0)) ms" } ?? "无记录")
                metricCaption("静息心率", value: data.recovery.restingHeartRateBpm.map { "\(nativeNumber($0, digits: 0))" } ?? "无记录")
            }
            Text(data.recovery.note)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 5)
        }
    }

    private func planPanel(_ data: MobileTodayResponse) -> some View {
        NativePanel {
            HStack {
                Text("本周计划")
                    .font(.headline)
                Spacer()
                Text("质量课 \(data.weekStructure.qualitySessionCount)/\(data.weekStructure.qualitySessionCap)")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ForEach(data.weekPlan) { day in
                HStack(spacing: 12) {
                    Text(nativeDay(day.localDate))
                        .font(.caption.monospacedDigit())
                        .frame(width: 44, alignment: .leading)
                    Image(systemName: day.completedWorkoutId == nil ? "circle" : "checkmark.circle.fill")
                        .foregroundStyle(day.completedWorkoutId == nil ? .secondary : .green)
                    Text(day.title)
                        .font(.subheadline)
                    Spacer()
                    Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "休息")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 3)
            }
        }
    }

    private func recentPanel(_ data: MobileTodayResponse) -> some View {
        NativePanel {
            Text("最近训练")
                .font(.headline)
            ForEach(data.recentWorkouts.prefix(5)) { workout in
                NavigationLink {
                    WorkoutDetailView(workoutId: workout.id)
                } label: {
                    WorkoutRow(workout: workout)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var emptyPanel: some View {
        NativePanel {
            ContentUnavailableView(
                "尚未连接 RAI 服务",
                systemImage: "server.rack",
                description: Text("请在设置中填写手机可访问的服务地址。")
            )
        }
        .padding(.top, 70)
    }
}

struct FreshnessBanner: View {
    let today: MobileTodayResponse
    let isOffline: Bool
    let cacheDate: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Image(systemName: isOffline ? "wifi.slash" : "clock")
                Text(isOffline ? "离线缓存" : "数据状态")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(nativeStatusName(today.freshness.state))
                    .font(.caption.weight(.semibold))
            }
            Text("健康数据截至 \(nativeDay(today.latestDataDate ?? "未知")) · 结果生成于 \(nativeDate(today.generatedAt))")
                .font(.footnote)
            if let cacheDate {
                Text("缓存更新于 \(nativeDate(ISO8601DateFormatter().string(from: cacheDate)))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(isOffline ? .orange : .secondary)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((isOffline ? Color.orange : Color.blue).opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct WorkoutsView: View {
    @Environment(NativeAppModel.self) private var native
    private let filters: [(String, String?)] = [
        ("全部", nil),
        ("轻松跑", "easy"),
        ("长距离", "long_run"),
        ("节奏跑", "tempo"),
        ("间歇跑", "interval")
    ]

    var body: some View {
        List {
            Section {
                Picker("训练类型", selection: Binding(
                    get: { native.workoutSessionType ?? "all" },
                    set: {
                        native.workoutSessionType = $0 == "all" ? nil : $0
                        Task { await native.refreshWorkouts() }
                    }
                )) {
                    ForEach(filters.indices, id: \.self) { index in
                        Text(filters[index].0).tag(filters[index].1 ?? "all")
                    }
                }
                .pickerStyle(.menu)
            }
            Section {
                if native.workouts.isEmpty {
                    ContentUnavailableView("暂无训练", systemImage: "figure.run.circle")
                } else {
                    ForEach(native.workouts) { workout in
                        NavigationLink {
                            WorkoutDetailView(workoutId: workout.id)
                        } label: {
                            WorkoutRow(workout: workout)
                        }
                    }
                    if native.workouts.count < native.workoutTotal {
                        Button {
                            Task { await native.loadMoreWorkouts() }
                        } label: {
                            HStack {
                                Spacer()
                                if native.isRefreshing {
                                    ProgressView()
                                } else {
                                    Label("加载更多", systemImage: "chevron.down")
                                }
                                Spacer()
                            }
                        }
                    }
                }
            } header: {
                Text("共 \(native.workoutTotal) 次")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("训练")
        .task {
            if native.workouts.isEmpty { await native.refreshWorkouts() }
        }
        .refreshable {
            await native.refreshWorkouts()
        }
    }
}

struct WorkoutRow: View {
    let workout: WorkoutListItem

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: workout.indoor == true ? "figure.run.circle" : "figure.run")
                .font(.title3)
                .foregroundStyle(.orange)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(nativeSessionName(workout.sessionType))
                    .font(.subheadline.weight(.semibold))
                Text(nativeDate(workout.startedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Text(nativeKilometers(workout.distanceKm))
                    Text(nativeDuration(workout.durationSeconds))
                    Text(nativePace(workout.averagePaceSecondsPerKm))
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 4) {
                Text(nativeStatusName(workout.assessmentStatus))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(workout.assessmentStatus == "excluded" ? .red : .green)
                if workout.hasRoute {
                    Image(systemName: "map")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct WorkoutDetailView: View {
    @Environment(NativeAppModel.self) private var native
    let workoutId: String

    var body: some View {
        ScrollView {
            if let detail = native.selectedWorkout, detail.workout.id == workoutId {
                VStack(alignment: .leading, spacing: 16) {
                    detailHeader(detail.workout)
                    detailMetrics(detail.workout)
                    if !detail.route.isEmpty {
                        routePanel(detail.route)
                    }
                    if let series = native.selectedSeries {
                        seriesPanel(series)
                    }
                    splitPanel(native.selectedSeries?.splits ?? [])
                    qualityPanel(detail)
                }
                .padding(16)
            } else {
                ProgressView("正在读取训练详情")
                    .frame(maxWidth: .infinity, minHeight: 260)
            }
        }
        .navigationTitle("训练详情")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await native.loadWorkout(id: workoutId)
        }
    }

    private func detailHeader(_ workout: WorkoutDetail) -> some View {
        NativePanel {
            Text(nativeSessionName(workout.sessionType))
                .font(.title2.weight(.bold))
            Text(nativeDate(workout.startedAt))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Text(nativeStimulusName(workout.stimulusType))
                Text("·")
                Text(nativeStatusName(workout.assessmentStatus))
                if workout.indoor == true { Text("· 室内") }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.orange)
        }
    }

    private func detailMetrics(_ workout: WorkoutDetail) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            NativeMetricTile(title: "距离", value: nativeKilometers(workout.distanceKm))
            NativeMetricTile(title: "时长", value: nativeDuration(workout.durationSeconds))
            NativeMetricTile(title: "配速", value: nativePace(workout.averagePaceSecondsPerKm))
            NativeMetricTile(title: "平均心率", value: workout.averageHeartRateBpm.map { "\(nativeNumber($0, digits: 0)) bpm" } ?? "--")
            NativeMetricTile(title: "步频", value: workout.averageCadenceSpm.map { "\(nativeNumber($0, digits: 0)) spm" } ?? "--")
            NativeMetricTile(title: "功率", value: workout.averagePowerWatts.map { "\(nativeNumber($0, digits: 0)) W" } ?? "--")
            NativeMetricTile(title: "步幅", value: workout.averageStrideLengthMeters.map { "\(nativeNumber($0)) m" } ?? "--")
            NativeMetricTile(title: "垂直振幅", value: workout.averageVerticalOscillationCm.map { "\(nativeNumber($0)) cm" } ?? "--")
            NativeMetricTile(title: "触地时间", value: workout.averageGroundContactTimeMs.map { "\(nativeNumber($0, digits: 0)) ms" } ?? "--")
        }
    }

    private func routePanel(_ route: [RoutePoint]) -> some View {
        NativePanel {
            Text("路线")
                .font(.headline)
            if route.count > 1 {
                Map {
                    MapPolyline(coordinates: route.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) })
                        .stroke(.orange, lineWidth: 4)
                }
                .frame(height: 230)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                Text("路线数据不足")
                    .foregroundStyle(.secondary)
            }
            Text("共 \(route.count) 个点")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func seriesPanel(_ series: WorkoutSeriesResponse) -> some View {
        NativePanel {
            Text("时序")
                .font(.headline)
            if series.series.heartRate.points.isEmpty {
                Text("没有可展示的心率样本")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Chart {
                    ForEach(series.series.heartRate.points) { point in
                        LineMark(
                            x: .value("时间", point.offsetSeconds),
                            y: .value("心率", point.value)
                        )
                        .foregroundStyle(.red)
                    }
                }
                .frame(height: 190)
                .chartXAxisLabel("秒")
                .chartYAxisLabel("bpm")
            }
        }
    }

    private func splitPanel(_ splits: [WorkoutSplit]) -> some View {
        NativePanel {
            Text("分段")
                .font(.headline)
            if splits.isEmpty {
                Text("没有分段数据")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(splits) { split in
                    HStack {
                        Text("\(split.index + 1) km")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(nativePace(split.averagePaceSecondsPerKm))
                        Text(split.averageHeartRateBpm.map { "\(nativeNumber($0, digits: 0)) bpm" } ?? "--")
                    }
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func qualityPanel(_ detail: WorkoutDetailResponse) -> some View {
        NativePanel {
            Text("质量说明")
                .font(.headline)
            HStack {
                metricCaption("心率覆盖", value: nativePercent(detail.workout.heartRateCoverage))
                metricCaption("来源可信度", value: nativePercent(detail.workout.sourceConfidence))
                metricCaption("模型版本", value: detail.workout.modelVersion)
            }
            if !detail.workout.missingReasons.isEmpty {
                Text("数据不足：\(detail.workout.missingReasons.joined(separator: "、"))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if !detail.workout.explanationCodes.isEmpty {
                Text(detail.workout.explanationCodes.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct PlanView: View {
    @Environment(NativeAppModel.self) private var native
    @State private var weeklyText = "30"
    @State private var easyFloor = 0.8
    @State private var qualityCap = 2
    @State private var weekPlan: [MobileGoalsPlanItem] = []
    @State private var isSaving = false
    @State private var saveMessage: String?

    var body: some View {
        Form {
            Section("周目标") {
                TextField("每周跑量（km）", text: $weeklyText)
                    .keyboardType(.decimalPad)
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("轻松训练时长下限")
                        Spacer()
                        Text(nativePercent(easyFloor))
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: $easyFloor, in: 0.4...0.95, step: 0.05)
                        .tint(.orange)
                }
                Stepper("质量课上限：\(qualityCap) 次", value: $qualityCap, in: 0...4)
            }

            Section("本周安排") {
                if weekPlan.isEmpty {
                    Text("服务端尚未保存逐日计划")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(weekPlan.indices, id: \.self) { index in
                        let item = weekPlan[index]
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Text(nativeDay(item.localDate))
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                TextField("距离 km", text: Binding(
                                    get: { weekPlan[index].distanceKm.map { nativeNumber($0) } ?? "" },
                                    set: { weekPlan[index].distanceKm = Double($0) }
                                ))
                                .keyboardType(.decimalPad)
                                .multilineTextAlignment(.trailing)
                                .frame(width: 84)
                            }
                            Picker("训练类型", selection: $weekPlan[index].kind) {
                                Text("休息").tag("rest")
                                Text("恢复跑").tag("recovery")
                                Text("轻松跑").tag("easy")
                                Text("长距离").tag("long_run")
                                Text("节奏跑").tag("tempo")
                                Text("间歇跑").tag("interval")
                            }
                            .pickerStyle(.menu)
                        }
                    }
                }
            }

            Section {
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        Spacer()
                        if isSaving {
                            ProgressView()
                        } else {
                            Label("保存到 RAI 服务", systemImage: "checkmark")
                        }
                        Spacer()
                    }
                }
                .disabled(isSaving || Double(weeklyText) == nil)
                if let saveMessage {
                    Text(saveMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("计划")
        .task {
            if native.goals == nil { await native.refreshAll() }
            loadDraft()
        }
        .onChange(of: native.goals?.revision) { _, _ in loadDraft() }
    }

    private func loadDraft() {
        guard let goals = native.goals else { return }
        weeklyText = nativeNumber(goals.weeklyDistanceKm)
        easyFloor = goals.easyDurationFloorFraction
        qualityCap = goals.qualitySessionCap
        weekPlan = goals.weekPlan
    }

    private func save() async {
        guard let weekly = Double(weeklyText) else { return }
        isSaving = true
        saveMessage = nil
        let success = await native.saveGoals(
            weeklyDistanceKm: weekly,
            easyDurationFloorFraction: easyFloor,
            qualitySessionCap: qualityCap,
            weekPlan: weekPlan
        )
        saveMessage = success ? "已保存，服务端已重新读取确认。" : "保存未完成，请重新读取后再试。"
        isSaving = false
    }
}

struct AnalysisView: View {
    @Environment(NativeAppModel.self) private var native
    @State private var mode = "trends"

    var body: some View {
        VStack(spacing: 0) {
            Picker("分析视图", selection: $mode) {
                Text("趋势").tag("trends")
                Text("统计").tag("statistics")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 12)

            ScrollView {
                if mode == "trends" {
                    trendsContent
                } else {
                    statisticsContent
                }
            }
        }
        .navigationTitle("分析")
        .task {
            if native.trends == nil || native.statistics == nil { await native.refreshAll() }
        }
    }

    @ViewBuilder
    private var trendsContent: some View {
        if let data = native.trends {
            VStack(alignment: .leading, spacing: 16) {
                NativePanel {
                    HStack {
                        metricCaption("四周跑量变化", value: nativePercent(data.distanceChangeFraction4Weeks))
                        Spacer()
                        metricCaption("增长速度", value: nativeNumber(data.growthVelocityPerWeek))
                        Spacer()
                        metricCaption("衰减", value: nativeNumber(data.decayPoints))
                    }
                    Chart {
                        ForEach(data.ability) { point in
                            if let value = point.trueAbility {
                                LineMark(
                                    x: .value("日期", nativeDay(point.date)),
                                    y: .value("跑力", value)
                                )
                                .foregroundStyle(.orange)
                                .interpolationMethod(.catmullRom)
                            }
                        }
                    }
                    .frame(height: 200)
                }
                NativePanel {
                    Text("12 周跑量")
                        .font(.headline)
                    Chart(data.weeks) { week in
                        BarMark(
                            x: .value("周", nativeDay(week.periodStart)),
                            y: .value("距离", week.distanceKm)
                        )
                        .foregroundStyle(week.isComplete ? Color.orange : Color.gray)
                    }
                    .frame(height: 180)
                }
                recordsPanel(data.records)
                if !data.insights.isEmpty {
                    NativePanel {
                        Text("洞察")
                            .font(.headline)
                        ForEach(data.insights) { insight in
                            Label {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(insight.title).font(.subheadline.weight(.semibold))
                                    Text(insight.detail).font(.footnote).foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: insight.kind == "positive" ? "arrow.up.right.circle.fill" : "exclamationmark.circle.fill")
                                    .foregroundStyle(nativeToneColor(insight.kind))
                            }
                        }
                    }
                }
            }
            .padding(16)
        } else {
            ProgressView("正在读取趋势")
                .frame(maxWidth: .infinity, minHeight: 280)
        }
    }

    private var statisticsContent: some View {
        Group {
            if let data = native.statistics {
                VStack(alignment: .leading, spacing: 16) {
                    NativePanel {
                        HStack {
                            metricCaption("总距离", value: nativeKilometers(data.totals.distanceKm))
                            Spacer()
                            metricCaption("训练次数", value: "\(data.totals.workoutCount)")
                            Spacer()
                            metricCaption("环比", value: nativePercent(data.totals.distanceChangeFraction))
                        }
                    }
                    NativePanel {
                        Text("近三个月")
                            .font(.headline)
                        Chart {
                            ForEach(data.months) { month in
                                BarMark(x: .value("月份", month.month), y: .value("距离", month.runningDistanceKm))
                                    .foregroundStyle(by: .value("类型", "跑步"))
                                BarMark(x: .value("月份", month.month), y: .value("距离", month.cyclingDistanceKm))
                                    .foregroundStyle(by: .value("类型", "骑行"))
                                BarMark(x: .value("月份", month.month), y: .value("距离", month.otherDistanceKm))
                                    .foregroundStyle(by: .value("类型", "其他"))
                            }
                        }
                        .frame(height: 190)
                    }
                    NativePanel {
                        Text("心率区间")
                            .font(.headline)
                        ForEach(data.heartRateZones) { zone in
                            HStack {
                                Text(zone.zone)
                                Spacer()
                                Text(nativeDuration(zone.durationSeconds))
                                    .foregroundStyle(.secondary)
                                Text(nativePercent(zone.fraction))
                                    .fontWeight(.semibold)
                            }
                            .font(.subheadline)
                        }
                    }
                }
                .padding(16)
            } else {
                ProgressView("正在读取统计")
                    .frame(maxWidth: .infinity, minHeight: 280)
            }
        }
    }

    private func recordsPanel(_ records: PersonalRecords) -> some View {
        NativePanel {
            Text("个人纪录")
                .font(.headline)
            recordRow("最快 5 km", value: records.fastest5k.map { "\(nativePace($0.paceSecondsPerKm)) · \(nativeDate($0.startedAt))" })
            recordRow("最快 10 km", value: records.fastest10k.map { "\(nativePace($0.paceSecondsPerKm)) · \(nativeDate($0.startedAt))" })
            recordRow("最长距离", value: records.longestDistance.map { "\(nativeKilometers($0.distanceKm)) · \(nativeDate($0.startedAt))" })
            recordRow("最大月跑量", value: records.biggestMonth.map { "\(nativeKilometers($0.distanceKm)) · \($0.month)" })
        }
    }

    private func recordRow(_ title: String, value: String?) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value ?? "暂无记录")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

struct NativeSettingsView: View {
    @Environment(ServerSession.self) private var session
    @Environment(HealthKitSync.self) private var healthSync
    @Environment(NativeAppModel.self) private var native
    @State private var showingClearCache = false

    var body: some View {
        @Bindable var session = session
        Form {
            Section("服务连接") {
                TextField("https://rai.example.com", text: $session.serverURLString)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("API Token（可选）", text: $session.apiToken)
                Button {
                    Task { await native.connect() }
                } label: {
                    Label(session.isReachable ? "重新检查连接" : "连接服务", systemImage: "network")
                }
                if let identity = native.handshake {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("服务：\(identity.serverId)")
                        Text("个人数据：\(identity.athleteId)")
                        Text("数据代际：\(identity.datasetEpoch)")
                        Text("协议：v\(identity.syncProtocolVersion)")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                if let error = session.lastError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Apple 健康") {
                HStack {
                    Label("读取权限与同步", systemImage: "heart.text.square")
                    Spacer()
                    Text(healthSync.isBusy ? healthSync.phase : (healthSync.lastSyncAt.map { nativeDate(ISO8601DateFormatter().string(from: $0)) } ?? "未同步"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button {
                    Task {
                        await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                    }
                } label: {
                    Label(healthSync.isBusy ? "同步中" : "同步健康数据", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(healthSync.isBusy || !session.isReachable)
                if let message = healthSync.message {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
            }

            Section("数据管理") {
                Button(role: .destructive) {
                    showingClearCache = true
                } label: {
                    Label("清除本机页面缓存", systemImage: "trash")
                }
                Text("只删除本机缓存，不删除服务端训练、目标或模型数据。同步任务和凭证会保留。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("版本") {
                LabeledContent("应用", value: "RAI 原生 iOS")
                LabeledContent("最低系统", value: "iOS 17")
                Text("跑力、恢复、负荷和预测均由 RAI 服务端计算。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("设置")
        .alert("清除本机缓存？", isPresented: $showingClearCache) {
            Button("清除", role: .destructive) { native.clearCache() }
            Button("取消", role: .cancel) { }
        } message: {
            Text("服务端数据不会受到影响。")
        }
    }
}

struct NativePanel<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct NativeMetricTile: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(10)
        .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
        .background(Color(uiColor: .tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 6))
    }
}

private func metricCaption(_ title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
        Text(title)
            .font(.caption)
            .foregroundStyle(.secondary)
        Text(value)
            .font(.footnote.weight(.semibold).monospacedDigit())
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }
}
#endif
