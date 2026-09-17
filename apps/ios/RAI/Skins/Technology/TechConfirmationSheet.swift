#if os(iOS)
import SwiftUI

struct TechConfirmationSheet: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let title: String
    let message: String
    var symbol = "exclamationmark.circle"
    let confirmTitle: String
    var destructive = false
    let confirm: () -> Void
    let cancel: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: symbol)
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(TechColor.coral)
                    .frame(height: 48)
                Text(title).font(.headline).foregroundStyle(TechColor.ink)
                    .multilineTextAlignment(.center)
                Text(message).font(.subheadline).foregroundStyle(TechColor.muted)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                if destructive {
                    cancelButton
                    Button(action: confirm) {
                        Text(confirmTitle).font(.subheadline.weight(.semibold))
                            .foregroundStyle(TechColor.background).padding(12).frame(maxWidth: .infinity, minHeight: 44)
                            .background(TechColor.coral, in: Capsule())
                    }.buttonStyle(TechPressStyle())
                } else {
                    TechPrimaryButton(title: confirmTitle, action: confirm)
                    cancelButton
                }
            }.padding(22)
        }
        .background(TechColor.paper)
        .presentationDetents(typeSize >= .xxxLarge ? [.large] : [.height(360), .large])
        .presentationCornerRadius(24)
        .presentationDragIndicator(.visible)
        .presentationBackground(TechColor.elevated)
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("technology.confirmation")
    }

    private var cancelButton: some View {
        Button("取消", action: cancel).font(.subheadline.weight(.medium))
            .foregroundStyle(destructive ? TechColor.ink : TechColor.cyan)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(destructive ? TechColor.grid.opacity(0.5) : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(destructive ? .clear : TechColor.cyan.opacity(0.6), lineWidth: 1))
            .buttonStyle(TechPressStyle())
    }
}

struct TechRequestFailure: View {
    @Environment(NativeAppModel.self) private var native
    let message: String
    // Match the existing API's revision error; ordinary failures never offer plan reload.
    private var isPlanConflict: Bool { message.contains("训练目标已在其他页面更新") }
    var body: some View {
        TechConfirmationSheet(
            title: isPlanConflict ? "计划已在其他设备更新" : "请求未完成",
            message: message,
            confirmTitle: isPlanConflict ? "加载最新计划" : "知道了"
        ) {
            native.errorMessage = nil
            if isPlanConflict { Task { await native.refreshAll(requestHandshake: false) } }
        } cancel: { native.errorMessage = nil }
    }
}
#endif
