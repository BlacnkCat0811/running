#if os(iOS)
import SwiftUI

/// Share card for one run (docs/DECISIONS.md D9).
///
/// The route is trimmed **on the server**: this view draws each polyline as its own
/// stroke and never joins them, so a privacy zone becomes a visible break instead
/// of a chord through the house. The view never receives the removed coordinates —
/// that is the whole reason the card is built server-side rather than here.
///
/// The image is rendered with `ImageRenderer` and handed to `ShareLink`, so the
/// runner can send it through any app they already use without this project
/// uploading anything anywhere.
struct TechShareCardView: View {
    @Environment(ServerSession.self) private var session
    let trainingSessionId: String

    @State private var card: ShareCardResponse?
    @State private var status: String?
    @State private var failed = false

    private var requestKey: String { session.serverURLString + session.apiToken + trainingSessionId }

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(
                    title: "分享卡片",
                    trailing: card.map { $0.privacy.unfiltered ? "未过滤" : "已按隐私区裁剪" } ?? "读取中",
                    trailingColor: card?.privacy.unfiltered == true ? TechColor.yellow : TechColor.green
                )
                if failed {
                    Text("无法生成分享卡片（需要令牌或网络）。")
                        .font(.footnote).foregroundStyle(TechColor.coral)
                } else if let card {
                    preview(card)
                    Text(card.note ?? "卡片只包含服务端允许的坐标。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("隐私区 \(card.privacy.zonesApplied) 个 · 隐藏 \(card.privacy.redactedPoints) 点 · 断点 \(card.privacy.gaps)")
                        .font(.caption2).foregroundStyle(TechColor.muted)
                    if let image = renderedImage(card) {
                        ShareLink(item: image, preview: SharePreview("训练卡片", image: image)) {
                            Label("分享图片", systemImage: "square.and.arrow.up")
                        }
                        .frame(minHeight: 44)
                    } else {
                        Text("当前设备无法渲染图片，可用上面的文字摘要分享。")
                            .font(.caption2).foregroundStyle(TechColor.muted)
                    }
                    if let status { Text(status).font(.caption2).foregroundStyle(TechColor.muted) }
                } else {
                    Text("正在生成分享卡片…").font(.footnote).foregroundStyle(TechColor.muted)
                }
            }
        }
        .task(id: requestKey) { await load() }
    }

    @ViewBuilder private func preview(_ card: ShareCardResponse) -> some View {
        // A fixed 2:1 canvas; the polylines are drawn in their own coordinate space so
        // a break stays a break regardless of how many pieces survive.
        Canvas { context, size in
            let bounds = card.polylines.flatMap { $0 }
            guard let first = bounds.first else { return }
            let minLat = bounds.map(\.latitude).min() ?? first.latitude
            let maxLat = bounds.map(\.latitude).max() ?? first.latitude
            let minLon = bounds.map(\.longitude).min() ?? first.longitude
            let maxLon = bounds.map(\.longitude).max() ?? first.longitude
            let spanLat = max(maxLat - minLat, 1e-6)
            let spanLon = max(maxLon - minLon, 1e-6)
            let inset: CGFloat = 12
            for line in card.polylines where line.count >= 2 {
                var path = Path()
                for (index, point) in line.enumerated() {
                    let x = inset + CGFloat((point.longitude - minLon) / spanLon) * (size.width - inset * 2)
                    let y = inset + CGFloat(1 - (point.latitude - minLat) / spanLat) * (size.height - inset * 2)
                    if index == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
                }
                context.stroke(path, with: .color(TechColor.cyan), lineWidth: 2.4)
            }
        }
        .frame(height: 160)
        .frame(maxWidth: .infinity)
        .background(TechColor.elevated)
        .overlay(Rectangle().stroke(TechColor.grid, lineWidth: 1))
        .accessibilityLabel("分享卡片预览")
    }

    @MainActor private func renderedImage(_ card: ShareCardResponse) -> Image? {
        let renderer = ImageRenderer(content: cardImage(card).frame(width: 800, height: 420))
        renderer.scale = 2
        guard let uiImage = renderer.uiImage else { return nil }
        return Image(uiImage: uiImage)
    }

    private func cardImage(_ card: ShareCardResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            preview(card).frame(height: 300)
            Text("\(nativeDate(card.workout.startedAt)) · \(nativeKilometers(card.workout.distanceKm)) · \(nativeDuration(card.workout.durationSeconds))")
                .font(.headline).foregroundStyle(TechColor.ink)
            if !card.privacy.unfiltered {
                Text("已按隐私区裁剪").font(.caption).foregroundStyle(TechColor.muted)
            }
        }
        .padding(24)
        .background(TechColor.paper)
    }

    private func load() async {
        failed = false
        guard let url = session.serverURL else { failed = true; return }
        do {
            let result = try await RaiAPIClient().shareCard(
                id: trainingSessionId, baseURL: url, token: session.apiToken
            )
            card = result
        } catch {
            failed = true
        }
    }
}
#endif
