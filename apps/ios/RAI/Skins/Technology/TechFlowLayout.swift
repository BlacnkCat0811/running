#if os(iOS)
import SwiftUI

/// Wrap evidence badges without truncating their meaning at large text sizes.
struct TechFlowLayout: Layout {
    var spacing: CGFloat = 8

    struct Cache {
        var width: CGFloat?
        var result: (size: CGSize, origins: [CGPoint], widths: [CGFloat])?
    }
    func makeCache(subviews: Subviews) -> Cache { Cache() }
    func updateCache(_ cache: inout Cache, subviews: Subviews) { cache = Cache() }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let width = max(0, proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 350)
        if cache.width != width || cache.result == nil {
            cache.width = width
            cache.result = arrange(subviews, width: width)
        }
        return cache.result!.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        _ = sizeThatFits(proposal: ProposedViewSize(width: bounds.width, height: nil), subviews: subviews, cache: &cache)
        guard let result = cache.result else { return }
        for (index, point) in result.origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                                  proposal: ProposedViewSize(width: result.widths[index], height: nil))
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> (size: CGSize, origins: [CGPoint], widths: [CGFloat]) {
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var origins: [CGPoint] = []
        var widths: [CGFloat] = []
        for subview in subviews {
            let natural = subview.sizeThatFits(.unspecified)
            let itemWidth = min(natural.width, width)
            let size = subview.sizeThatFits(ProposedViewSize(width: itemWidth, height: nil))
            if x > 0, x + itemWidth > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            origins.append(CGPoint(x: x, y: y)); widths.append(itemWidth)
            x += itemWidth + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: width, height: y + rowHeight), origins, widths)
    }
}
#endif
