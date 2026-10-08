#if os(iOS)
import SwiftUI
import UIKit

struct TechWorkoutShareMenu: View {
    let detail: WorkoutDetailResponse
    var grade: WorkoutGradeSummary? = nil
    @State private var showingShareSheet = false

    var body: some View {
        Button {
            showingShareSheet = true
        } label: {
            Image(systemName: "square.and.arrow.up")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(TechColor.cyan)
                .frame(width: 44, height: 44)
        }
        .accessibilityLabel("分享训练卡片")
        .accessibilityIdentifier("workout.share")
        .sheet(isPresented: $showingShareSheet) {
            TechWorkoutShareSheet(detail: detail, grade: grade)
        }
    }
}

private struct TechWorkoutShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ServerSession.self) private var session
    @Environment(NativeAppModel.self) private var native
    let detail: WorkoutDetailResponse
    let grade: WorkoutGradeSummary?
    @State private var card: ShareCardResponse?
    @State private var image: UIImage?
    @State private var error: String?
    @State private var attempt = 0

    private var identity: String { native.feedbackSessionID }
    private var requestKey: String { identity + detail.id + String(attempt) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFit()
                            .accessibilityLabel("训练分享卡片")
                            .accessibilityIdentifier("workout.share.preview")
                        if let card {
                            Text(card.note ?? (card.privacy.unfiltered ? "未配置隐私区：卡片显示完整轨迹。" : "路线已按隐私区裁剪。"))
                                .font(.footnote).foregroundStyle(TechColor.muted)
                        }
                    } else if let error {
                        TechEmptyState(title: "卡片暂不可用", message: error, systemName: "exclamationmark.triangle")
                        TechPrimaryButton(title: "重新生成", systemName: "arrow.clockwise") { attempt += 1 }
                    } else if let card {
                        let key = requestKey
                        // Only the server-trimmed polylines reach the share map, never detail.route.
                        TechShareRouteMap(polylines: card.polylines) { snapshot in
                            guard key == requestKey else { return }
                            guard let snapshot else { error = "高德底图未加载完成，请检查网络后重试。"; return }
                            image = renderedImage(TechWorkoutCombinedShareImage(
                                detail: detail, grade: grade, card: card, snapshot: snapshot
                            ))
                            if image == nil { error = "无法生成训练分享图片，请重试。" }
                        }
                        .frame(height: 260)
                        .id(requestKey)
                        TechLoadingState(title: "正在生成训练分享卡片")
                    } else {
                        TechLoadingState(title: "正在读取训练路线")
                    }
                }
                .padding(TechMetrics.pageHorizontal)
            }
            .background(TechColor.background)
            .foregroundStyle(TechColor.ink)
            .navigationTitle("分享训练卡片")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    TechIconButton(systemName: "xmark", accessibilityLabel: "关闭") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if let image {
                        let item = Image(uiImage: image)
                        ShareLink(item: item, preview: SharePreview("训练分享卡片", image: item)) {
                            Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("分享训练卡片")
                        .accessibilityIdentifier("workout.share.send")
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .task(id: requestKey) { await prepare() }
        .onChange(of: identity) { _, _ in dismiss() }
    }

    @MainActor
    private func prepare() async {
        let key = requestKey
        card = nil; image = nil; error = nil
        guard MapPrivacy.mapEnabled else { error = "请先在设置中启用高德地图。"; return }
        guard let url = session.serverURL, !session.apiToken.isEmpty else {
            error = "请连接服务并配置访问令牌后分享路线。"; return
        }
        do {
            let result = try await RaiAPIClient().shareCard(id: detail.id, baseURL: url, token: session.apiToken)
            guard !Task.isCancelled, key == requestKey else { return }
            guard result.trainingSessionId == detail.id else { error = "训练记录不匹配，请重试。"; return }
            guard result.polylines.contains(where: { $0.count >= 2 }) else {
                error = result.note ?? "本次训练暂无可分享的 GPS 路线。"; return
            }
            card = result
        } catch {
            guard !Task.isCancelled, key == requestKey else { return }
            self.error = "无法读取分享路线，请检查服务连接后重试。"
        }
    }

    @MainActor
    private func renderedImage<Content: View>(_ content: Content) -> UIImage? {
        let renderer = ImageRenderer(content: content.frame(width: 390)
            .environment(\.dynamicTypeSize, .medium).environment(\.colorScheme, .dark))
        renderer.scale = 3
        return renderer.uiImage
    }
}

private struct TechWorkoutCombinedShareImage: View {
    let detail: WorkoutDetailResponse
    let grade: WorkoutGradeSummary?
    let card: ShareCardResponse
    let snapshot: UIImage

    var body: some View {
        let workout = detail.workout
        let weather = TechWorkoutWeather(condition: workout.environment?.weatherCondition)
        let gradeAdjustedPace = techShareGradeAdjustedPace(card: card.workout, detailGrade: grade)
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text("RAI · 训练分享").font(.title3.weight(.bold))
                Text("\(nativeSessionName(workout.sessionType)) · \(nativeDate(workout.startedAt))")
                    .font(.caption).foregroundStyle(TechColor.muted)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 16)

            Text("路线").font(.headline.weight(.semibold))
                .padding(.horizontal, 24)
                .padding(.bottom, 10)
            Image(uiImage: snapshot).resizable().scaledToFit()
                .frame(maxWidth: .infinity)
            VStack(alignment: .leading, spacing: 8) {
                Text("\(nativeKilometers(card.workout.distanceKm)) · \(techDuration(card.workout.durationSeconds))")
                    .font(.title3.weight(.semibold).monospacedDigit())
                Text(card.privacy.unfiltered ? "未配置隐私区 · 完整轨迹" : "路线已按隐私区裁剪")
                    .font(.caption).foregroundStyle(TechColor.muted)
            }
            .padding(.horizontal, 24)
            .padding(.top, 14)
            .padding(.bottom, 22)

            Divider().overlay(TechColor.grid).padding(.horizontal, 24)

            VStack(alignment: .leading, spacing: 18) {
                Text("训练摘要").font(.headline.weight(.semibold))
                HStack(alignment: .top, spacing: 12) {
                    metric("距离", techKilometers(workout.distanceKm), prominent: true)
                    metric("运动时间", techDuration(workout.durationSeconds), prominent: true)
                }
                Divider().overlay(TechColor.grid)
                HStack(alignment: .top, spacing: 12) {
                    metric("平均配速", workout.averagePaceSecondsPerKm.map { "\(techPace($0))/km" } ?? "--")
                    metric("平均等强配速", gradeAdjustedPace.map { "\(techPace($0))/km" } ?? "--")
                }
                HStack(alignment: .top, spacing: 12) {
                    metric("平均心率", techValue(workout.averageHeartRateBpm, digits: 0, unit: " bpm"))
                    metric("累计上升", techValue(workout.elevationGainMeters, digits: 0, unit: " m"))
                }
                HStack(alignment: .top, spacing: 12) {
                    metric("能量消耗", techValue(workout.activeEnergyKcal, digits: 0, unit: " kcal"))
                    metric("训练负荷", nativeNumber(detail.trainingLoad?.load, digits: 0))
                }
                if let grade, grade.coveredSplits < grade.totalSplits {
                    Text("等强配速覆盖 \(grade.coveredSplits)/\(grade.totalSplits) 段")
                        .font(.caption2).foregroundStyle(TechColor.muted)
                }
                Divider().overlay(TechColor.grid)
                Label(weather.title, systemImage: weather.symbol)
                    .font(.caption).foregroundStyle(TechColor.muted)
                HStack(alignment: .top, spacing: 12) {
                    metric("温度", techValue(workout.environment?.temperatureC, digits: 1, unit: " °C"))
                    metric("湿度", techValue(workout.environment?.humidityPercent, digits: 0, unit: "%"))
                }
            }
            .padding(24)
        }
        .padding(.vertical, 24)
        .background(TechColor.paper)
        .foregroundStyle(TechColor.ink)
    }

    private func metric(_ title: String, _ value: String, prominent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value).font(.system(size: prominent ? 28 : 18, weight: .bold).monospacedDigit())
                .fixedSize(horizontal: false, vertical: true)
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
#endif
