#if os(iOS)
import CoreLocation
import MapKit
import MAMapKit
import SwiftUI

/// GPS presentation only. The trace remains available when AMap tiles/rendering
/// are unavailable; it never presents a synthetic street map as real geography.
struct TechRouteView: View {
    let route: [RoutePoint]
    @State private var showingSystemMap = true
    /// One-shot signal that the next map update should fit the entire route.
    /// Reset back to false on the first consume so it doesn't refit whenever
    /// SwiftUI happens to redraw.
    @State private var fitRequest = false
    /// 高德底图是否已获得用户同意（未同意时不创建 MAMapView，见 MapPrivacy）。
    @AppStorage(MapPrivacy.storageKey) private var mapPrivacyState = MapPrivacy.State.ask.rawValue

    private var mapAllowed: Bool { mapPrivacyState == MapPrivacy.State.agreed.rawValue }

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
            } else if showingSystemMap, mapAllowed {
                NativeRouteMap(coordinates: coordinates, triggerFit: fitRequest)
                    .accessibilityIdentifier("workout.route.map")
                    .onChange(of: fitRequest) { _, newValue in
                        if newValue { fitRequest = false }
                    }
            } else {
                trace
                Text(mapAllowed ? "真实 GPS 轨迹 · 无地图底图" : "真实 GPS 轨迹 · 未启用高德底图（可在设置中开启）")
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
                if mapAllowed {
                    Button("地图与轨迹") { showingSystemMap = true }
                    Button("显示完整路线") {
                        showingSystemMap = true
                        fitRequest = true
                    }
                } else {
                    Button("启用高德底图（需同意隐私说明）") { MapPrivacy.resetToAsk() }
                }
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

/// Draw the trace in a UIKit overlay using AMap's coordinate conversion. This
/// keeps GPS visible even when the map's tile/Metal renderer is unavailable.
///
/// Coordinates arrive as raw WGS-84 (what Apple Watch records and what the
/// database stores). AMap basemaps and `convert(_:toPointTo:)` expect GCJ-02,
/// so the container converts once per update and only for rendering — the
/// stored data is never touched.
private struct NativeRouteMap: UIViewRepresentable {
    let coordinates: [CLLocationCoordinate2D]
    let triggerFit: Bool
    func makeUIView(context: Context) -> RouteMapContainer { RouteMapContainer() }
    func updateUIView(_ view: RouteMapContainer, context: Context) {
        view.update(coordinates: coordinates, triggerFit: triggerFit)
    }
}

private final class RouteMapContainer: UIView, MAMapViewDelegate {
    private let map = MAMapView()
    private let trace = CAShapeLayer()
    private let start = CAShapeLayer()
    private let end = CAShapeLayer()
    /// GCJ-02 coordinates, converted from the incoming WGS-84 route for display.
    private var coordinates: [CLLocationCoordinate2D] = []
    /// Symmetric padding keeps the route's bounding-box center at the card's
    /// exact center while leaving room for the line and endpoint markers.
    private static let fitInsets = UIEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
    /// The last route bounds used for auto-fit. SwiftUI may call updateUIView
    /// repeatedly for unrelated state changes; refitting only when this key
    /// changes preserves normal map gestures while still fitting a new workout.
    private var lastFitKey: RouteFitKey?
    /// True while the card still owes the route a fit. It survives until the
    /// map's visible rect actually covers the route — see fitIfNeeded — and the
    /// attempt counter keeps a map that never settles from re-fitting forever.
    private var needsFit = false
    private var fitAttempts = 0
    private static let maxFitAttempts = 12
    /// AMap's renderer blocks the main thread while it starts up (~1.3 s), so
    /// this is the shortest retry gap that can still land on a live run loop.
    private static let fitRetryDelay: TimeInterval = 0.2

    private struct RouteFitKey: Equatable {
        let count: Int
        let minX: Double
        let maxX: Double
        let minY: Double
        let maxY: Double
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        map.delegate = self
        // Night basemap matches the dark technology skin (the MapKit version
        // forced .dark the same way). Labels/buildings stay visible.
        map.mapType = .standardNight
        map.isShowsBuildings = true
        map.isShowsLabels = true
        map.isRotateEnabled = false
        map.isRotateCameraEnabled = false
        map.showsCompass = false
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
    func update(coordinates wgsCoordinates: [CLLocationCoordinate2D], triggerFit: Bool) {
        coordinates = wgsCoordinates.map(GCJ02.fromWGS84)
        let fitKey = Self.fitKey(for: coordinates)
        if triggerFit || fitKey != lastFitKey {
            lastFitKey = fitKey
            requestFit()
        }
        fitIfNeeded()
        drawTrace()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        let changed = map.frame.size != bounds.size
        map.frame = bounds
        // The card's size can change after the first fit (rotation, split view,
        // a wider device), which changes how much of the route fits.
        if changed && lastFitKey != nil { requestFit() }
        fitIfNeeded()
        drawTrace()
    }
    func mapView(_ mapView: MAMapView, regionDidChangeAnimated animated: Bool) { drawTrace() }
    func mapViewRegionChanged(_ mapView: MAMapView) { drawTrace() }
    func mapViewDidFinishLoadingMap(_ mapView: MAMapView) { fitIfNeeded(); drawTrace() }
    func mapInitComplete(_ mapView: MAMapView) { fitIfNeeded(); drawTrace() }

    private func requestFit() {
        needsFit = true
        fitAttempts = 0
    }

    /// Fit the whole trace into the card, centred, and keep retrying until the
    /// camera really moves. `MAMapView` is created with a zero frame and AMap
    /// silently ignores `setVisibleMapRect` while its renderer is starting up,
    /// so the fit from the first layout pass alone leaves the default
    /// city-wide camera (and a trace shrunk to a speck) on screen. Retries run
    /// on a short timer — the map's own load callbacks can wait on tile
    /// downloads that never finish offline — and the fit only counts as done
    /// once the visible rect covers the route.
    private func fitIfNeeded() {
        guard needsFit, fitAttempts < Self.maxFitAttempts else {
            needsFit = false
            return
        }
        // AMap needs a laid-out frame to resolve a visible rect; updates can
        // arrive before the first layout pass.
        guard bounds.width > 0, bounds.height > 0,
              let rect = Self.boundingRect(of: coordinates) else { return }
        fitAttempts += 1
        // AMap derives the zoom from the complete route bounds: a long run zooms
        // out until every point fits inside the card, and the symmetric insets
        // put the bounding-box centre exactly on the card's centre.
        map.setVisibleMapRect(rect, edgePadding: Self.fitInsets, animated: false)
        if Self.covers(map.visibleMapRect, rect) {
            needsFit = false
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.fitRetryDelay) { [weak self] in
                guard let self else { return }
                self.fitIfNeeded()
                self.drawTrace()
            }
        }
        DispatchQueue.main.async { [weak self] in self?.drawTrace() }
    }

    /// Whether the camera ended up showing the whole route, tolerating the
    /// rounding AMap applies when it converts a rect into a camera.
    private static func covers(_ visible: MAMapRect, _ rect: MAMapRect) -> Bool {
        let eps = 1e-6
        return visible.origin.x <= rect.origin.x + eps
            && visible.origin.y <= rect.origin.y + eps
            && visible.origin.x + visible.size.width >= rect.origin.x + rect.size.width - eps
            && visible.origin.y + visible.size.height >= rect.origin.y + rect.size.height - eps
    }

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

    private static func boundingRect(of coordinates: [CLLocationCoordinate2D]) -> MAMapRect? {
        let mapPoints = coordinates.map(MAMapPointForCoordinate)
        guard let first = mapPoints.first else { return nil }
        var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
        for point in mapPoints {
            minX = min(minX, point.x); maxX = max(maxX, point.x)
            minY = min(minY, point.y); maxY = max(maxY, point.y)
        }
        // At least 1 projected point in each direction so a single coordinate
        // or a perfectly axis-aligned segment still yields a visible region.
        return MAMapRect(origin: MAMapPoint(x: minX, y: minY),
                         size: MAMapSize(width: max(maxX - minX, 1), height: max(maxY - minY, 1)))
    }

    private static func fitKey(for coordinates: [CLLocationCoordinate2D]) -> RouteFitKey? {
        guard let rect = boundingRect(of: coordinates) else { return nil }
        return RouteFitKey(
            count: coordinates.count,
            minX: MAMapRectGetMinX(rect),
            maxX: MAMapRectGetMaxX(rect),
            minY: MAMapRectGetMinY(rect),
            maxY: MAMapRectGetMaxY(rect)
        )
    }
}
#endif
