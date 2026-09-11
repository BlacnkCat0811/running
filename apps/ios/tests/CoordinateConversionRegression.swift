import CoreLocation
import Foundation

/// WGS-84 → GCJ-02 纯数学回归。
///
/// 锚点值由高德官方 SDK 自带转换 `AMapCoordinateConvert(_, .GPS)`（`AMapUtility.h`）
/// 在 iOS 模拟器上实测导出，不是自洽推导：`bash apps/ios/tests/run-coordinate-sdk-check.sh`
/// 可以随时重新对拍。
///
/// 判定用米而不是度：容差 1 m（实测 0.02–0.6 m）远小于消费者 GPS 精度，同时足以抓住
/// 常量/公式写错（写错会偏出数百米）。拉萨一项 7.7 m 是高德 SDK 自身在该区域与标准公式
/// 的差异，单独放宽容差并显式记录，避免把已知偏差当成回归。
@main struct CoordinateConversionRegression {
    static func main() {
        var failures = 0
        func check(_ condition: Bool, _ name: String) {
            if condition { return }
            failures += 1
            print("FAIL: \(name)")
        }
        func meters(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
            let dy = (a.latitude - b.latitude) * 111_320.0
            let dx = (a.longitude - b.longitude) * 111_320.0 * cos(b.latitude * .pi / 180)
            return (dx * dx + dy * dy).squareRoot()
        }
        func expect(_ name: String, wgs: (Double, Double), gcj: (Double, Double), tolerance: Double) {
            let converted = GCJ02.fromWGS84(CLLocationCoordinate2D(latitude: wgs.0, longitude: wgs.1))
            let target = CLLocationCoordinate2D(latitude: gcj.0, longitude: gcj.1)
            let delta = meters(converted, target)
            check(delta <= tolerance, "\(name) 偏离锚点 \(String(format: "%.3f", delta)) m（容差 \(tolerance) m）")
        }

        // 高德 SDK 实测锚点（WGS-84 → 高德坐标），偏差均为 SDK 与本地实现之差。
        expect("北京天安门", wgs: (39.90923, 116.397428), gcj: (39.9106326, 116.4036705), tolerance: 1.0)
        expect("上海人民广场", wgs: (31.230416, 121.473701), gcj: (31.2284736, 121.4782240), tolerance: 1.0)
        expect("深圳市民中心", wgs: (22.543099, 114.057868), gcj: (22.5403819, 114.0629820), tolerance: 1.0)
        expect("广州塔", wgs: (23.106470, 113.324460), gcj: (23.1038707, 113.3298839), tolerance: 1.0)
        expect("哈尔滨", wgs: (45.803775, 126.534967), gcj: (45.8057604, 126.5410129), tolerance: 1.0)
        expect("中国香港", wgs: (22.302711, 114.177216), gcj: (22.2999501, 114.1821601), tolerance: 1.0)
        // 拉萨：SDK 与标准公式在该点差 7.744 m，放宽到 10 m 并保留记录。
        expect("拉萨", wgs: (29.650000, 91.100000), gcj: (29.6473446, 91.1016189), tolerance: 10.0)

        // 境外点不做偏移：偏移会把国外跑步轨迹整体挪走。
        for (name, lat, lon) in [("东京", 35.658581, 139.745433), ("纽约", 40.7128, -74.0060)] {
            let wgs = CLLocationCoordinate2D(latitude: lat, longitude: lon)
            let converted = GCJ02.fromWGS84(wgs)
            check(converted.latitude == wgs.latitude && converted.longitude == wgs.longitude,
                  "\(name) 境外坐标必须原样通过")
            check(GCJ02.isOutOfChina(wgs), "\(name) 应判为境外")
        }

        // 边界与非法输入：非法坐标原样返回，不能产生 NaN。
        let invalid = CLLocationCoordinate2D(latitude: 999, longitude: 999)
        let invalidConverted = GCJ02.fromWGS84(invalid)
        check(invalidConverted.latitude == 999 && invalidConverted.longitude == 999, "非法坐标必须原样返回")
        let nan = CLLocationCoordinate2D(latitude: .nan, longitude: 116.4)
        check(GCJ02.fromWGS84(nan).latitude.isNaN, "NaN 纬度必须原样返回")

        // 偏移量级：中国大陆点必须产生百米级偏移（常量写错会掉到几十米或几公里）。
        let shift = meters(CLLocationCoordinate2D(latitude: 39.90923, longitude: 116.397428),
                           GCJ02.fromWGS84(CLLocationCoordinate2D(latitude: 39.90923, longitude: 116.397428)))
        check((400...800).contains(shift), "北京偏移应为百米级，实测 \(String(format: "%.1f", shift)) m")

        if failures > 0 {
            print("\(failures) 项坐标转换检查失败")
            exit(1)
        }
        print("All coordinate conversion checks passed.")
    }
}
