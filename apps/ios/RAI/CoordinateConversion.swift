#if os(iOS)
import CoreLocation

/// WGS-84 → GCJ-02 conversion, display-only.
///
/// Apple Watch GPS routes are recorded in WGS-84. AMap (高德) basemaps and
/// `MAMapView.convert(_:toPointTo:)` expect GCJ-02, the regulatory offset
/// coordinate system used on mainland Chinese basemaps. Plotting unconverted
/// coordinates shifts the entire trace by roughly 300–600 m — the trace shape
/// stays correct but lands on the wrong block, which reads as "inaccurate".
///
/// Scope rules:
/// - The database, the API, and the offline trace canvas keep raw WGS-84.
/// - Only the AMap-backed route map converts, right before rendering.
/// - Points outside mainland China are returned unchanged (no offset exists
///   there, and applying the transform would corrupt foreign runs).
///
/// `nonisolated`: this is stateless pure math, safe to call from any context.
/// Without it the target's Default Actor Isolation (MainActor) marks these
/// static methods as main-actor-isolated, which breaks passing them as
/// function values (e.g. `coordinates.map(GCJ02.fromWGS84)`).
nonisolated enum GCJ02 {
    private static let a = 6_378_245.0
    private static let ee = 0.006_693_421_622_965_943_23

    /// Rough mainland-China bounding box. Deliberately coarse: the transform is
    /// only meaningful inside it, and edge behavior at the boundary is
    /// irrelevant for a running-trace use case.
    static func isOutOfChina(_ coordinate: CLLocationCoordinate2D) -> Bool {
        coordinate.longitude < 72.004 || coordinate.longitude > 137.8347
            || coordinate.latitude < 0.8293 || coordinate.latitude > 55.8271
    }

    /// Convert a WGS-84 coordinate to GCJ-02. Invalid and out-of-China
    /// coordinates pass through unchanged.
    static func fromWGS84(_ coordinate: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
        guard coordinate.latitude.isFinite, coordinate.longitude.isFinite,
              CLLocationCoordinate2DIsValid(coordinate),
              !isOutOfChina(coordinate) else { return coordinate }
        let x = coordinate.longitude - 105.0
        let y = coordinate.latitude - 35.0
        var dLat = transformLat(x: x, y: y)
        var dLon = transformLon(x: x, y: y)
        let radLat = coordinate.latitude / 180.0 * .pi
        var magic = sin(radLat)
        magic = 1 - ee * magic * magic
        let sqrtMagic = sqrt(magic)
        dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * .pi)
        dLon = (dLon * 180.0) / (a / sqrtMagic * cos(radLat) * .pi)
        return CLLocationCoordinate2D(latitude: coordinate.latitude + dLat,
                                      longitude: coordinate.longitude + dLon)
    }

    private static func transformLat(x: Double, y: Double) -> Double {
        var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * sqrt(max(0, x))
        ret += (20.0 * sin(6.0 * x * .pi) + 20.0 * sin(2.0 * x * .pi)) * 2.0 / 3.0
        ret += (20.0 * sin(y * .pi) + 40.0 * sin(y / 3.0 * .pi)) * 2.0 / 3.0
        ret += (160.0 * sin(y / 12.0 * .pi) + 320.0 * sin(y * .pi / 30.0)) * 2.0 / 3.0
        return ret
    }

    private static func transformLon(x: Double, y: Double) -> Double {
        var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * sqrt(max(0, x))
        ret += (20.0 * sin(6.0 * x * .pi) + 20.0 * sin(2.0 * x * .pi)) * 2.0 / 3.0
        ret += (20.0 * sin(x * .pi) + 40.0 * sin(x / 3.0 * .pi)) * 2.0 / 3.0
        ret += (150.0 * sin(x / 12.0 * .pi) + 300.0 * sin(x / 30.0 * .pi)) * 2.0 / 3.0
        return ret
    }
}
#endif
