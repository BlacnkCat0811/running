#if os(iOS)
import SwiftUI

struct TechLockSheet: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let today = native.today {
                        TechSectionHeader(title: "推荐课程")
                        TechPanel {
                            HStack {
                                TechRunnerIcon()
                                Text(today.nextSession.title).font(.headline)
                                Spacer()
                                Text(nativeKilometers(today.nextSession.distanceKm)).font(.headline.monospacedDigit())
                            }
                        }
                        TechSectionHeader(title: "推荐原因")
                        Text(today.verdict.reason).font(.subheadline).foregroundStyle(TechColor.muted)
                        if today.verdict.stale {
                            Label("建议已过期，请刷新后再锁定", systemImage: "clock.badge.exclamationmark")
                                .foregroundStyle(TechColor.yellow)
                        }
                        if let failure {
                            Label(failure, systemImage: "exclamationmark.circle")
                                .font(.footnote).foregroundStyle(TechColor.coral)
                        }
                        TechPrimaryButton(title: today.lock.present ? "今日安排已锁定" : "锁定课程",
                                          systemName: "lock", isBusy: native.isLockingSession,
                                          isDisabled: native.isOffline || today.verdict.stale || today.lock.present) {
                            Task {
                                if await native.lockNextSession() { dismiss() }
                                else { failure = native.errorMessage ?? "锁定未完成，请刷新后重试。" }
                            }
                        }
                        Button("暂不锁定") { dismiss() }
                            .font(.subheadline).foregroundStyle(TechColor.cyan)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        TechEmptyState(title: "暂无训练建议", message: "请返回首页刷新数据。")
                    }
                }.padding(24)
            }
            .background(TechColor.background).foregroundStyle(TechColor.ink)
            .navigationTitle("锁定课程").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .preferredColorScheme(.dark).tint(TechColor.cyan)
    }
}
#endif
