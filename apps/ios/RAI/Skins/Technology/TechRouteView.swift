#if os(iOS)
import CoreLocation
import MapKit
import MAMapKit
import SwiftUI

/// GPS presentation only. The trace remains available when AMap tiles/rendering
/// are unavailable; it never presents a synthetic street map as real geography.
struct TechRouteView: View, Equatable {
    let route: [RoutePoint]
    let splits: [WorkoutSplit]
    let startedAt: String
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.startedAt == rhs.startedAt && lhs.splits.elementsEqual(rhs.splits) {
            $0.distanceMeters == $1.distanceMeters && $0.durationSeconds == $1.durationSeconds
        } && lhs.route.elementsEqual(rhs.route) {
            $0.latitude == $1.latitude && $0.longitude == $1.longitude && $0.timestamp == $1.timestamp
        }
    }
    var body: some View {
        TechPreparedRoute(geometry: TechRouteGeometry(route: route, splits: splits, startedAt: startedAt))
    }
}

/// Prepared once per changed route, not once for each Canvas read / map toggle.
private struct TechRouteGeometry {
    let coordinates: [CLLocationCoordinate2D]
    let points: [MKMapPoint]
    let rect: MKMapRect
    let kilometerMarkers: [TechRouteKilometerMarker]
    init(route: [RoutePoint], splits: [WorkoutSplit], startedAt: String) {
        let displayRoute = techRoutePointsForRendering(route)
        kilometerMarkers = techRouteKilometerMarkers(route: displayRoute, splits: splits, startedAt: startedAt)
        coordinates = displayRoute.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) }
            .filter { $0.latitude.isFinite && $0.longitude.isFinite && CLLocationCoordinate2DIsValid($0) }
        points = coordinates.map(MKMapPoint.init).filter { $0.x.isFinite && $0.y.isFinite }
        let bounds = points.reduce(MKMapRect.null) {
            $0.union(MKMapRect(x: $1.x, y: $1.y, width: 1, height: 1))
        }
        rect = bounds.isNull ? .world : bounds.insetBy(dx: -max(bounds.width * 0.12, 20),
                                                       dy: -max(bounds.height * 0.12, 20))
    }
}

private struct TechPreparedRoute: View {
    let geometry: TechRouteGeometry
    // Show the map card only after privacy consent; gestures stay locked until the
    // card is tapped — the offline trace stays available either way.
    @State private var showingSystemMap = true
    /// One-shot signal that the next map update should fit the entire route.
    /// Reset back to false on the first consume so it doesn't refit whenever
    /// SwiftUI happens to redraw.
    @State private var fitRequest = false
    /// 地图手势是否解锁。默认 **false**：训练详情整体是一个 `ScrollView`，而
    /// `MAMapView` 会吃掉落在它身上的拖动 —— 于是"往下翻页"变成"把地图划走"
    /// （2026-10-01 用户反馈）。锁定时地图只是一张静态图，纵向滑动照常翻页。
    @State private var mapInteractive = false
    /// 高德底图是否已获得用户同意（未同意时不创建 MAMapView，见 MapPrivacy）。
    @AppStorage(MapPrivacy.storageKey) private var mapPrivacyState = MapPrivacy.State.ask.rawValue

    private var mapAllowed: Bool { mapPrivacyState == MapPrivacy.State.agreed.rawValue }

    private var coordinates: [CLLocationCoordinate2D] { geometry.coordinates }
    private var mapPoints: [MKMapPoint] { geometry.points }
    private var mapRect: MKMapRect { geometry.rect }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
        ZStack(alignment: .bottomLeading) {
            if mapPoints.count < 2 {
                TechColor.background
                Text("有效路线坐标不足").font(.footnote).foregroundStyle(TechColor.muted).padding(16)
            } else if showingSystemMap, mapAllowed {
                NativeRouteMap(coordinates: coordinates, kilometerMarkers: geometry.kilometerMarkers,
                               triggerFit: fitRequest, isInteractive: mapInteractive)
                    .accessibilityIdentifier("workout.route.map")
                    .onChange(of: fitRequest) { _, newValue in
                        if newValue { fitRequest = false }
                    }
                // 屏蔽层始终挂载、只切换命中测试：结构不变 ⇒ 地图不会被重建，
                // 相机也就不会因为开关手势而重新 fit 回完整路线。
                gestureShield
                    .allowsHitTesting(!mapInteractive)
                    .accessibilityHidden(mapInteractive)
            } else {
                trace
            }
        }
        .frame(height: 220)
        .clipShape(TechSurfaceShape())
        .overlay(alignment: .topTrailing) {
            Menu {
                Button("轨迹图（离线可用）") { showingSystemMap = false }
                if mapAllowed {
                    Button("加载互动地图") { showingSystemMap = true; mapInteractive = false }
                    Button("显示完整路线") {
                        showingSystemMap = true
                        mapInteractive = false
                        fitRequest = true
                    }
                } else {
                    Button("启用高德底图（需同意隐私说明）") { MapPrivacy.resetToAsk() }
                }
            } label: {
                Image(systemName: "map").font(.system(size: 18))
                    .foregroundStyle(TechColor.cyan).frame(width: 44, height: 44)
                    .background(TechColor.paper, in: TechSurfaceShape())
            }.padding(8).accessibilityLabel("路线显示方式")
        }
        .overlay(alignment: .bottomTrailing) {
            if showingSystemMap, mapAllowed, mapInteractive { lockButton }
        }
        Text(captionText)
            .font(.caption).foregroundStyle(TechColor.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityValue("公里标记：\(geometry.kilometerMarkers.map { "\($0.kilometer) km" }.joined(separator: "、"))")
    }

    /// 触摸屏蔽层：锁定时把整块地图变成"只响应轻点"的静态图，纵向滑动完全交给
    /// 外层 `ScrollView`，而不是被 `MAMapView` 的平移手势截获；轻点即解锁。
    private var gestureShield: some View {
        Color.clear
            .contentShape(Rectangle())
            .onTapGesture { mapInteractive = true }
            .accessibilityIdentifier("workout.route.map.lock")
            .accessibilityElement()
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("地图已锁定，轻点解锁缩放与拖动")
    }

    /// 解锁后必须能一键收回手势，否则用户又要靠运气才能往下滑。
    private var lockButton: some View {
        Button { mapInteractive = false } label: {
            HStack(spacing: 5) {
                Image(systemName: "lock.fill").font(.system(size: 11, weight: .semibold))
                Text("锁定").techScaledFont(13, weight: .semibold)
            }
            .foregroundStyle(TechColor.ink)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(TechColor.elevated.opacity(0.92), in: TechSurfaceShape())
        }
        .padding(8)
        .accessibilityLabel("锁定地图，恢复上下滑动翻页")
    }

    private var captionText: String {
        guard showingSystemMap, mapAllowed else {
            return mapAllowed ? "真实 GPS 轨迹 · 离线" : "真实 GPS 轨迹 · 未启用高德底图"
        }
        return mapInteractive
            ? "高德底图 · 已解锁"
            : "高德底图 · 已锁定"
    }

    private var trace: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(TechColor.paper))
            var grid = Path()
            for x in stride(from: 0.0, through: size.width, by: 28) {
                grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: size.height))
            }
            for y in stride(from: 0.0, through: size.height, by: 28) {
                grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: size.width, y: y))
            }
            context.stroke(grid, with: .color(TechColor.grid.opacity(0.45)), lineWidth: 0.5)
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
            context.stroke(path, with: .color(TechColor.cyan), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            for (point, color) in [(projected[0], TechColor.cyan), (projected[projected.count - 1], TechColor.coral)] {
                // Circle, not a square: `RouteMapContainer` draws the same two
                // endpoints with `UIBezierPath(ovalIn:)`, and one route rendered
                // two ways is a needless inconsistency (2026-10-05).
                let dot = Path(ellipseIn: CGRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10))
                context.fill(dot, with: .color(color))
                context.stroke(dot, with: .color(TechColor.background), lineWidth: 1.5)
            }
            let markerPoints = geometry.kilometerMarkers.map { marker in
                let mapPoint = MKMapPoint(CLLocationCoordinate2D(latitude: marker.latitude, longitude: marker.longitude))
                return CGPoint(x: (mapPoint.x - rect.minX) * scale + offsetX,
                               y: (mapPoint.y - rect.minY) * scale + offsetY)
            }
            let frames = techRouteMarkerFrames(points: markerPoints, kilometers: geometry.kilometerMarkers.map(\.kilometer), size: size)
            var leaders = Path()
            for (index, frame) in frames.enumerated() {
                guard let frame, let leader = techRouteMarkerLeader(point: markerPoints[index], frame: frame) else { continue }
                leaders.move(to: leader.start)
                leaders.addLine(to: leader.end)
            }
            context.stroke(leaders, with: .color(TechColor.ink.opacity(0.7)), lineWidth: 1)
            for (index, marker) in geometry.kilometerMarkers.enumerated() {
                guard let frame = frames[index] else { continue }
                let badge = Path(frame)
                context.fill(badge, with: .color(TechColor.ink))
                context.stroke(badge, with: .color(TechColor.background), lineWidth: 1)
                context.draw(Text("\(marker.kilometer)").font(.system(size: 8, weight: .bold))
                    .foregroundStyle(TechColor.background), at: CGPoint(x: frame.midX, y: frame.midY))
            }
        }
        .accessibilityLabel("真实 GPS 轨迹，\(coordinates.count) 个坐标点；绿色标记起点，红色标记终点，无地图底图")
    }
}

/// Draw the trace in a UIKit overlay using AMap's coordinate conversion. This
/// keeps GPS visible even when the map's tile/Metal renderer is unavailable.
///
/// Coordinates arrive as raw WGS-84 (what Apple Watch records and what the
/// database stores). AMap basemaps and `convert(_:toPointTo:)` expect GCJ-02,
/// so the container converts once per update and only for rendering — the
/// stored data is never touched.
///
/// 手势策略：`isInteractive == false`（默认）时地图不接管任何拖动，落在卡片上的
/// 纵向滑动由上层的训练详情 `ScrollView` 消费 —— 详细原因见 `applyGesturePolicy`。
private struct NativeRouteMap: UIViewRepresentable {
    let coordinates: [CLLocationCoordinate2D]
    let kilometerMarkers: [TechRouteKilometerMarker]
    let triggerFit: Bool
    let isInteractive: Bool
    func makeUIView(context: Context) -> RouteMapContainer { RouteMapContainer() }
    static func dismantleUIView(_ view: RouteMapContainer, coordinator: ()) { view.stop() }
    func updateUIView(_ view: RouteMapContainer, context: Context) {
        view.update(coordinates: coordinates, kilometerMarkers: kilometerMarkers, triggerFit: triggerFit, interactive: isInteractive)
    }
}

private final class RouteMapContainer: UIView, MAMapViewDelegate {
    private let map = MAMapView()
    private let trace = CAShapeLayer()
    private let start = CAShapeLayer()
    private let end = CAShapeLayer()
    private let kilometerLeaders = CAShapeLayer()
    /// GCJ-02 coordinates, converted from the incoming WGS-84 route for display.
    private var coordinates: [CLLocationCoordinate2D] = []
    private var sourceCoordinates: [CLLocationCoordinate2D] = []
    private var sourceKilometerMarkers: [TechRouteKilometerMarker] = []
    private var kilometerCoordinates: [CLLocationCoordinate2D] = []
    private var kilometerBadges: [UILabel] = []
    private var drawScheduled = false
    private var stopped = false
    /// 见 `applyGesturePolicy`：默认锁定，纵向滑动留给外层滚动视图。
    private var isInteractive = false
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
        // Use the installed SDK's night basemap; route and camera inputs are unchanged.
        map.mapType = .standardNight
        map.isShowsBuildings = true
        map.isShowsLabels = true
        map.isRotateEnabled = false
        map.isRotateCameraEnabled = false
        map.showsCompass = false
        // 手势默认关闭，直到 SwiftUI 侧显式解锁（见 applyGesturePolicy）。
        map.isScrollEnabled = false
        map.isZoomEnabled = false
        addSubview(map)
        trace.strokeColor = UIColor(TechColor.cyan).cgColor
        trace.fillColor = UIColor.clear.cgColor
        trace.lineWidth = 3
        trace.lineJoin = .round
        trace.lineCap = .round
        for shape in [trace, kilometerLeaders, start, end] { layer.addSublayer(shape) }
        kilometerLeaders.strokeColor = UIColor(TechColor.ink).withAlphaComponent(0.7).cgColor
        kilometerLeaders.fillColor = UIColor.clear.cgColor
        kilometerLeaders.lineWidth = 1
        start.fillColor = UIColor(TechColor.cyan).cgColor
        end.fillColor = UIColor(TechColor.coral).cgColor
        for dot in [start, end] { dot.strokeColor = UIColor(TechColor.background).cgColor; dot.lineWidth = 2 }
        clipsToBounds = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func update(coordinates wgsCoordinates: [CLLocationCoordinate2D], kilometerMarkers: [TechRouteKilometerMarker],
                triggerFit: Bool, interactive: Bool) {
        if interactive != isInteractive {
            isInteractive = interactive
            applyGesturePolicy()
        }
        let changed = !sourceCoordinates.elementsEqual(wgsCoordinates) {
            $0.latitude == $1.latitude && $0.longitude == $1.longitude
        }
        let markersChanged = sourceKilometerMarkers != kilometerMarkers
        guard changed || markersChanged || triggerFit else { return }
        if changed {
            sourceCoordinates = wgsCoordinates
            coordinates = wgsCoordinates.map(GCJ02.fromWGS84)
        }
        if markersChanged {
            sourceKilometerMarkers = kilometerMarkers
            kilometerCoordinates = kilometerMarkers.map {
                GCJ02.fromWGS84(CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude))
            }
            for badge in kilometerBadges { badge.removeFromSuperview() }
            kilometerBadges = kilometerMarkers.map { marker in
                let badge = UILabel()
                badge.text = String(marker.kilometer)
                badge.font = UIFont.monospacedDigitSystemFont(ofSize: 9, weight: .bold)
                badge.textAlignment = .center
                badge.textColor = UIColor(TechColor.background)
                badge.backgroundColor = UIColor(TechColor.ink)
                badge.layer.borderColor = UIColor(TechColor.background).cgColor
                badge.layer.borderWidth = 1
                badge.layer.cornerRadius = TechMetrics.corner
                badge.clipsToBounds = true
                badge.isUserInteractionEnabled = false
                badge.isAccessibilityElement = true
                badge.accessibilityLabel = "\(marker.kilometer) 公里"
                addSubview(badge)
                return badge
            }
        }
        let fitKey = Self.fitKey(for: coordinates)
        if triggerFit || fitKey != lastFitKey {
            lastFitKey = fitKey
            requestFit()
        }
        fitIfNeeded()
        drawTrace()
    }
    func stop() {
        stopped = true
        needsFit = false
        map.delegate = nil
    }
    /// 训练详情整体是一个 `ScrollView`，而 `MAMapView` 会吃掉落在它身上的拖动：
    /// 手指压在路线卡片上往下滑，被划走的是地图而不是页面（2026-10-01 用户反馈）。
    /// 这里是第二层防护 —— SwiftUI 侧的触摸屏蔽层已经让触摸到不了地图，但地图自己
    /// 的平移/缩放手势开关也要跟着关，否则任何绕过屏蔽层的路径（指针、辅助功能、
    /// 未来的布局改动）都会把老问题带回来。旋转与俯仰在 `init` 里已永久关闭。
    private func applyGesturePolicy() {
        map.isScrollEnabled = isInteractive
        map.isZoomEnabled = isInteractive
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
        guard !stopped, needsFit, fitAttempts < Self.maxFitAttempts else {
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
        guard !stopped, !drawScheduled else { return }
        drawScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.drawScheduled = false
            if !self.stopped { self.renderTrace() }
        }
    }

    private func renderTrace() {
        // 🔴 防御性守卫（2026-09-24，OOM 崩溃溯源）：`map` 以零 frame 创建（见
        // fitIfNeeded 注释），真实 frame 要等 layoutSubviews；`update(coordinates:)`
        // 经 drawTrace 到达这里时布局可能还没跑。对一个零尺寸的 view 做
        // `convert(_:toPointTo:)` 会把退化矩阵交给系统（控制台可见
        // "Conversion error! {{0, 926}, {428, 0}}"，全屏宽、高度 0），严禁放行。
        // 调用方就是 update() 的这条路径：updateUIView 先于首帧布局到达。
        guard bounds.width > 0, bounds.height > 0,
              map.frame.width > 0, map.frame.height > 0 else { return }
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
        let markerPoints = kilometerCoordinates.map { map.convert($0, toPointTo: self) }
        let frames = techRouteMarkerFrames(points: markerPoints, kilometers: sourceKilometerMarkers.map(\.kilometer), size: bounds.size)
        let leaders = UIBezierPath()
        for (index, badge) in kilometerBadges.enumerated() {
            badge.isHidden = frames[index] == nil
            guard let frame = frames[index] else { continue }
            badge.frame = frame
            badge.layer.cornerRadius = frame.height / 2
            if let leader = techRouteMarkerLeader(point: markerPoints[index], frame: frame) {
                leaders.move(to: leader.start)
                leaders.addLine(to: leader.end)
            }
        }
        kilometerLeaders.path = leaders.cgPath
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

/// A separate, consent-gated map for sharing. Its input cannot contain the raw
/// detail route, and every privacy-trimmed polyline remains a separate stroke.
struct TechShareRouteMap: UIViewRepresentable {
    let polylines: [[ShareCardRoutePoint]]
    let onSnapshot: (UIImage?) -> Void

    func makeUIView(context: Context) -> TechShareRouteMapContainer {
        TechShareRouteMapContainer(polylines: polylines, onSnapshot: onSnapshot)
    }
    func updateUIView(_ view: TechShareRouteMapContainer, context: Context) {}
    static func dismantleUIView(_ view: TechShareRouteMapContainer, coordinator: ()) { view.stop() }
}

final class TechShareRouteMapContainer: UIView, MAMapViewDelegate {
    private var map: MAMapView?
    private let lines: [[CLLocationCoordinate2D]]
    private let trace = CAShapeLayer()
    private var completion: ((UIImage?) -> Void)?
    private var snapshotScheduled = false
    private var stopped = false
    private var fitAttempts = 0
    private var snapshotAttempts = 0

    private static let maxSnapshotAttempts = 3
    private static let snapshotRetryDelay: TimeInterval = 1

    init(polylines: [[ShareCardRoutePoint]], onSnapshot: @escaping (UIImage?) -> Void) {
        lines = techShareRoutePolylinesForRendering(polylines).map { line in
            line.map { GCJ02.fromWGS84(CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)) }
        }
        completion = onSnapshot
        super.init(frame: .zero)
        guard MapPrivacy.mapEnabled, !lines.isEmpty else {
            DispatchQueue.main.async { [weak self] in self?.finish(nil) }
            return
        }
        MapPrivacy.configureIfAgreed()
        let map = MAMapView(frame: .zero)
        self.map = map
        map.delegate = self
        map.mapType = .standardNight
        map.isShowsBuildings = true
        map.isShowsLabels = true
        map.isScrollEnabled = false
        map.isZoomEnabled = false
        map.isRotateEnabled = false
        map.isRotateCameraEnabled = false
        map.showsCompass = false
        addSubview(map)
        trace.strokeColor = UIColor(TechColor.cyan).cgColor
        trace.fillColor = UIColor.clear.cgColor
        trace.lineWidth = 4
        trace.lineCap = .round
        trace.lineJoin = .round
        layer.addSublayer(trace)
        clipsToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard !stopped, let map, bounds.width > 0, bounds.height > 0 else { return }
        map.frame = bounds
        drawTrace()
        guard !snapshotScheduled else { return }
        snapshotScheduled = true
        scheduleFit()
    }

    func stop() {
        stopped = true
        completion = nil
        map?.delegate = nil
    }

    func mapViewRegionChanged(_ mapView: MAMapView) { drawTrace() }
    func mapView(_ mapView: MAMapView, regionDidChangeAnimated animated: Bool) { drawTrace() }

    private func scheduleFit() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.fitAndCapture() }
    }

    private func fitAndCapture() {
        guard !stopped, let map, bounds.width > 0, bounds.height > 0,
              MapPrivacy.mapEnabled, let rect = routeRect else { finish(nil); return }
        fitAttempts += 1
        map.setVisibleMapRect(rect, edgePadding: UIEdgeInsets(top: 28, left: 28, bottom: 28, right: 28), animated: false)
        let visible = map.visibleMapRect
        let expectedWidth = max(rect.size.width, rect.size.height * bounds.width / bounds.height)
        let expectedHeight = max(rect.size.height, rect.size.width * bounds.height / bounds.width)
        let fitted = visible.origin.x <= rect.origin.x && visible.origin.y <= rect.origin.y
            && visible.origin.x + visible.size.width >= rect.origin.x + rect.size.width
            && visible.origin.y + visible.size.height >= rect.origin.y + rect.size.height
            && visible.size.width <= expectedWidth * 4 && visible.size.height <= expectedHeight * 4
        guard fitted else {
            if fitAttempts < 12 { scheduleFit() } else { finish(nil) }
            return
        }
        drawTrace()
        // The SDK owns the tile-ready timeout; a partial/blank basemap must not
        // be exported as an AMap card. The snapshot keeps its attribution intact.
        snapshotAttempts += 1
        map.takeSnapshot(in: map.bounds, timeoutInterval: 8) { [weak self] image, state in
            guard let self, !self.stopped, MapPrivacy.mapEnabled else {
                self?.finish(nil); return
            }
            guard state == 1, let image, image.size.width > 0, image.size.height > 0 else {
                guard self.snapshotAttempts < Self.maxSnapshotAttempts else {
                    self.finish(nil)
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.snapshotRetryDelay) { [weak self] in
                    guard let self, !self.stopped else { return }
                    self.fitAndCapture()
                }
                return
            }
            self.finish(self.drawRoute(on: image))
        }
    }

    private var routeRect: MAMapRect? {
        let points = lines.flatMap { $0 }.map(MAMapPointForCoordinate)
        guard let first = points.first else { return nil }
        var minY = first.y, maxY = first.y
        for point in points {
            minY = min(minY, point.y); maxY = max(maxY, point.y)
        }
        guard let xBounds = techCircularInterval(values: points.map(\.x), period: MAMapSizeWorld.width) else {
            return nil
        }
        return MAMapRect(origin: MAMapPoint(x: xBounds.start, y: minY),
                         size: MAMapSize(width: max(xBounds.width, 1), height: max(maxY - minY, 1)))
    }

    private func routePath() -> UIBezierPath {
        let path = UIBezierPath()
        guard let map, map.bounds.width > 0, map.bounds.height > 0 else { return path }
        for line in lines {
            let points = line.map { map.convert($0, toPointTo: map) }
            guard let first = points.first, points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { continue }
            path.move(to: first)
            for point in points.dropFirst() { path.addLine(to: point) }
        }
        return path
    }

    private func drawTrace() {
        guard !stopped else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        trace.path = routePath().cgPath
        CATransaction.commit()
    }

    private func drawRoute(on image: UIImage) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        return renderer.image { context in
            image.draw(in: CGRect(origin: .zero, size: image.size))
            context.cgContext.scaleBy(x: image.size.width / bounds.width, y: image.size.height / bounds.height)
            let path = routePath()
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            UIColor(TechColor.background).withAlphaComponent(0.7).setStroke()
            path.lineWidth = 7
            path.stroke()
            UIColor(TechColor.cyan).setStroke()
            path.lineWidth = 3
            path.stroke()
        }
    }

    private func finish(_ image: UIImage?) {
        guard !stopped, let completion else { return }
        self.completion = nil
        completion(image)
    }
}
#endif
