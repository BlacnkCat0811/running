#if os(iOS)
import SwiftUI

struct TechLockSheet: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    @State private var failure: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let today = native.today {
                        let session = today.lock.relockSuggested ? today.lock.candidate ?? today.nextSession : today.nextSession
                        TechSectionHeader(title: "推荐课程")
                        TechPanel {
                            TechAdaptiveStack {
                                TechRunnerIcon()
                                Text(session.title).font(.headline)
                                Spacer()
                                Text(nativeKilometers(session.distanceKm)).font(.headline.monospacedDigit())
                            }
                        }
                        TechSectionHeader(title: "推荐原因")
                        Text(session.reason).font(.subheadline).foregroundStyle(TechColor.muted)
                        if today.lock.relockSuggested {
                            Text("原锁定：\(today.nextSession.title) → 新建议：\(session.title)。确认后请重新同步手表。")
                                .font(.footnote).foregroundStyle(TechColor.coral)
                        }
                        TechPanel {
                            TechSectionHeader(title: "课程目标")
                            TechMetricGrid(minimum: 140) {
                                techMetricCaption("目标配速", value: techPaceRange(session.paceSecondsPerKmLower, session.paceSecondsPerKmUpper))
                                techMetricCaption("预计用时", value: session.durationMinutes.map { nativeNumber($0, digits: 0) + " min" } ?? "待评估")
                            }
                        }
                        // 只有真正失败的刷新才挡住锁定。没有今天的恢复记录不再是理由：
                        // 那是缺一份监测信息，不是"建议过期"。
                        if today.sync.status == "failed" {
                            Label("上次同步未完成，请重新同步后再锁定", systemImage: "exclamationmark.triangle")
                                .foregroundStyle(TechColor.coral)
                        }
                        if let failure {
                            Label(failure, systemImage: "exclamationmark.circle")
                                .font(.footnote).foregroundStyle(TechColor.coral)
                        }
                        TechPrimaryButton(title: today.lock.relockSuggested ? "按最新建议重新锁定" : today.lock.present ? "今日安排已锁定" : "锁定课程",
                                          systemName: "lock", isBusy: native.isLockingSession,
                                          isDisabled: native.isOffline || today.sync.status == "failed" || (today.lock.present && !today.lock.relockSuggested) || native.isPlanBusy) {
                            Task {
                                if await native.lockNextSession(relock: today.lock.relockSuggested) { dismiss() }
                                else { failure = native.errorMessage ?? "锁定未完成，请刷新后重试。" }
                            }
                        }
                        Button("暂不锁定") { dismiss() }
                            .font(.subheadline).foregroundStyle(TechColor.cyan)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .overlay(Capsule().stroke(TechColor.cyan.opacity(0.7), lineWidth: 1))
                            .buttonStyle(TechPressStyle()).disabled(native.isLockingSession)
                    } else {
                        TechEmptyState(title: "暂无训练建议", message: "请返回首页刷新数据。")
                    }
                }.padding(18)
            }
            .background(TechColor.paper).foregroundStyle(TechColor.ink)
            .navigationTitle("锁定课程").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(TechColor.paper, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .topBarTrailing) {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").foregroundStyle(TechColor.muted).frame(width: 44, height: 44)
                }
                    .accessibilityLabel("关闭")
                    .disabled(native.isLockingSession)
            } }
        }
        .presentationDetents(typeSize >= .xxxLarge ? [.large] : [.medium, .large]).presentationDragIndicator(.visible)
        .interactiveDismissDisabled(native.isLockingSession)
        .presentationCornerRadius(24).presentationBackground(TechColor.paper)
        .preferredColorScheme(.dark).tint(TechColor.cyan)
    }
}
#endif
