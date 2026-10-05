#if os(iOS)
import SwiftUI

/// Smooth surfaces keep the existing layout bounds and inset border behavior.
struct TechSurfaceShape: InsettableShape {
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
            .inset(by: insetAmount)
            .path(in: rect)
    }

    func inset(by amount: CGFloat) -> Self {
        var shape = self
        shape.insetAmount += amount
        return shape
    }
}

#endif
