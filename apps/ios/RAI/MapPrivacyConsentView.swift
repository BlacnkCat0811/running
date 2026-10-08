#if os(iOS)
import SwiftUI

/// 高德底图的隐私说明与同意入口。
///
/// 保留系统表面与系统控件；填充按钮显式配对行动色和反色文字，
/// 避免继承全局强调色后仍使用系统白字，降低隐私选择的可读性。
struct MapPrivacyConsentView: View {
    enum Context {
        /// 首启门控：必须先做选择，第二个按钮表示只用离线轨迹。
        case firstRun
        /// 设置页主动打开：第二个按钮是取消。
        case settings
    }

    let context: Context
    let onAgree: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            if context == .firstRun {
                Color.black.opacity(0.35).ignoresSafeArea()
            }
            VStack(alignment: .leading, spacing: 16) {
                Label("训练详情的地图底图", systemImage: "map")
                    .font(.headline)
                // 本页挂在 App 根部，首启就会看到，因此按"整个 App 的底图能力"措辞。
                Text("训练详情页可以用高德地图作为中文底图，地名与道路更准确。启用后训练详情页使用该底图；不启用时保持纯轨迹图。")
                    .font(.subheadline)
                VStack(alignment: .leading, spacing: 8) {
                    row("显示底图时会向高德服务器请求所在区域的瓦片，这会暴露大致地图区域、设备与网络信息。")
                    row("跑步轨迹坐标本身只在手机上用于绘制，不会发送给高德。")
                    row("心率、训练记录等健康数据不会提供给高德；不同意也能正常使用离线轨迹图。")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                Link("查看高德隐私政策", destination: MapPrivacy.policyURL)
                    .font(.footnote)
                HStack(spacing: 12) {
                    Button("同意并启用地图", action: onAgree)
                        .buttonStyle(.borderedProminent)
                        .tint(TechColor.action)
                        .foregroundStyle(TechColor.actionInk)
                    Button(context == .firstRun ? "仅使用离线轨迹" : "取消", action: onDismiss)
                        .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(20)
            .frame(maxWidth: 420)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
            .padding(24)
        }
    }

    private func row(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "circle.fill").font(.system(size: 5)).padding(.top, 5)
            Text(text)
        }
    }
}
#endif
