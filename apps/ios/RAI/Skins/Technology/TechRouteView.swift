#if os(iOS)
import CoreLocation
import MapKit
import SwiftUI

/// GPS presentation only. The trace remains available when MapKit tiles/rendering
/// are unavailable; it never presents a synthetic street map as real geography.
struct TechRouteView: View {
    let route: [RoutePoint]
    @State private var showingSystemMap = true
    @State private var resetToken = 0

    private var coordinates: [CLLocationCoordinate2D] {
        route.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) }
            .filter { CLLocationCoordinate2DIsValid($0) && $0.latitude.isFinite && $0.longitude.isFinite }
    }

    private var mapPoints: [MKMapPoint] {
        coordinates.map(MKMapPoint.init).filter { $0.x.isFinite && $0.y.isFinite }
    }

    private var mapRect: MKMapRect {
        let rect = mapPoints.reduce(MKMapRect.null) {
            $0.union(MKMapRect(x: $1.x, y: $1.y, width: 1, height: 1))
        }
        guard !rect.isNull else { return .world }
        return rect.insetBy(dx: -max(rect.width * 0.12, 20), dy: -max(rect.height * 0.12, 20))
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if mapPoints.count < 2 {
                TechColor.background
                Text("有效路线坐标不足").font(.footnote).foregroundStyle(TechColor.muted).padding(16)
            } else if showingSystemMap {
                NativeRouteMap(coordinates: coordinates, mapRect: mapRect, resetToken: resetToken)
                    .accessibilityIdentifier("workout.route.map")
            } else {
                trace
                Text("真实 GPS 轨迹 · 无地图底图")
                    .font(.caption2).foregroundStyle(TechColor.muted)
                    .padding(8).background(TechColor.background.opacity(0.9), in: Capsule())
                    .padding(10)
            }
        }
        .frame(height: 280)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(alignment: .topTrailing) {
            Menu {
                Button("轨迹图（离线可用）") { showingSystemMap = false }
                Button("地图与轨迹") { showingSystemMap = true; resetToken += 1 }
                Button("显示完整路线") { resetToken += 1; showingSystemMap = true }
            } label: {
                Image(systemName: "map").font(.system(size: 18))
                    .foregroundStyle(TechColor.cyan).frame(width: 44, height: 44)
                    .background(TechColor.paper, in: RoundedRectangle(cornerRadius: 12))
            }.padding(8).accessibilityLabel("路线显示方式")
        }
    }

    private var trace: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(TechColor.background))
            var grid = Path()
            for x in stride(from: 0.0, through: size.width, by: 28) {
                grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: size.height))
            }
            for y in stride(from: 0.0, through: size.height, by: 28) {
                grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: size.width, y: y))
            }
            context.stroke(grid, with: .color(TechColor.blue.opacity(0.10)), lineWidth: 0.5)
            let points = mapPoints
            guard points.count > 1 else { return }
            let rect = mapRect
            let scale = min(max(size.width - 36, 1) / max(rect.width, 1), max(size.height - 60, 1) / max(rect.height, 1))
            let offsetX = (size.width - rect.width * scale) / 2
            let offsetY = (size.height - rect.height * scale) / 2 - 8
            let projected = points.map {
                CGPoint(x: ($0.x - rect.minX) * scale + offsetX,
                        y: ($0.y - rect.minY) * scale + offsetY)
            }
            var path = Path()
            path.addLines(projected)
            context.stroke(path, with: .color(TechColor.cyan.opacity(0.15)), lineWidth: 8)
            context.stroke(path, with: .color(TechColor.cyan), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            for (point, color) in [(projected[0], TechColor.cyan), (projected[projected.count - 1], TechColor.coral)] {
                let dot = Path(ellipseIn: CGRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10))
                context.fill(dot, with: .color(color))
                context.stroke(dot, with: .color(.white), lineWidth: 1.5)
            }
        }
        .accessibilityLabel("真实 GPS 轨迹，\(coordinates.count) 个坐标点；青色标记起点，红色标记终点，无地图底图")
    }
}

/// Draw the trace in a UIKit overlay using MapKit's coordinate conversion. This
/// keeps GPS visible even when the map's tile/Metal renderer is unavailable.
private struct NativeRouteMap: UIViewRepresentable {
    let coordinates: [CLLocationCoordinate2D]
    let mapRect: MKMapRect
    let resetToken: Int
    func makeUIView(context: Context) -> RouteMapContainer { RouteMapContainer() }
    func updateUIView(_ view: RouteMapContainer, context: Context) {
        view.update(coordinates: coordinates, rect: mapRect, resetToken: resetToken)
    }
}

private final class RouteMapContainer: UIView, MKMapViewDelegate {
    private let map = MKMapView()
    private let trace = CAShapeLayer()
    private let start = CAShapeLayer()
    private let end = CAShapeLayer()
    private var coordinates: [CLLocationCoordinate2D] = []
    private var fittedRect = MKMapRect.null
    private var token = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        map.delegate = self
        map.overrideUserInterfaceStyle = .dark
        map.pointOfInterestFilter = .excludingAll
        map.isPitchEnabled = false
        map.isRotateEnabled = false
        addSubview(map)
        trace.strokeColor = UIColor.cyan.cgColor
        trace.fillColor = UIColor.clear.cgColor
        trace.lineWidth = 3
        trace.lineJoin = .round
        trace.lineCap = .round
        for shape in [trace, start, end] { layer.addSublayer(shape) }
        start.fillColor = UIColor.cyan.cgColor
        end.fillColor = UIColor.systemPink.cgColor
        for dot in [start, end] { dot.strokeColor = UIColor.white.cgColor; dot.lineWidth = 2 }
        clipsToBounds = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func update(coordinates: [CLLocationCoordinate2D], rect: MKMapRect, resetToken: Int) {
        self.coordinates = coordinates
        if token != resetToken || !MKMapRectEqualToRect(rect, fittedRect) {
            token = resetToken
            fittedRect = rect
            map.setVisibleMapRect(rect, edgePadding: UIEdgeInsets(top: 24, left: 24, bottom: 32, right: 24), animated: false)
            // The map applies the fitted rect on the next layout pass, so redraw
            // the trace after it settles instead of leaving the first paint empty.
            DispatchQueue.main.async { [weak self] in self?.drawTrace() }
        }
        drawTrace()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        let changed = map.frame.size != bounds.size
        map.frame = bounds
        if changed && !fittedRect.isNull {
            map.setVisibleMapRect(fittedRect, edgePadding: UIEdgeInsets(top: 24, left: 24, bottom: 32, right: 24), animated: false)
            DispatchQueue.main.async { [weak self] in self?.drawTrace() }
        }
        drawTrace()
    }
    func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) { drawTrace() }
    func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) { drawTrace() }
    func mapViewDidFinishRenderingMap(_ mapView: MKMapView, fullyRendered: Bool) { drawTrace() }
    private func drawTrace() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        let points = coordinates.map { map.convert($0, toPointTo: self) }.filter { $0.x.isFinite && $0.y.isFinite }
        let path = UIBezierPath()
        if let first = points.first {
            path.move(to: first)
            for point in points.dropFirst() { path.addLine(to: point) }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        trace.path = path.cgPath
        for (layer, point) in [(start, points.first), (end, points.last)] {
            layer.path = point.map { UIBezierPath(ovalIn: CGRect(x: $0.x - 5, y: $0.y - 5, width: 10, height: 10)).cgPath }
        }
        CATransaction.commit()
    }
}
#endif
