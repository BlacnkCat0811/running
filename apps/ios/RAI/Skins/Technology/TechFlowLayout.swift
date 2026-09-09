#if os(iOS)
import SwiftUI

/// Wrap evidence badges without truncating their meaning at large text sizes.
struct TechFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 350
        return arrange(subviews, width: width).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(subviews, width: bounds.width)
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
