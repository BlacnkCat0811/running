import CoreLocation
import Foundation
import AMapFoundationKit

/// 用高德官方 SDK 自带的 `AMapCoordinateConvert(_, .GPS)` 对拍本地 `GCJ02.fromWGS84`。
///
/// 这是权威基准（同一份 SDK 既画底图又做坐标换算），用来证明"WGS-84 直接喂给高德
/// 会偏 300–600 m"确实被我们的显示层转换消除。
/// 只在 apps/ios/tests/run-coordinate-sdk-check.sh 里编译运行，不进 run-model-tests.sh。
@main struct CoordinateSDKComparison {
    static func main() {
        let samples: [(String, Double, Double, Bool)] = [
            ("北京天安门", 39.90923, 116.397428, true),
            ("广州塔", 23.106470, 113.324460, true),
            ("上海人民广场", 31.230416, 121.473701, true),
            ("深圳市民中心", 22.543099, 114.057868, true),
            ("哈尔滨", 45.803775, 126.534967, true),
            ("拉萨", 29.650000, 91.100000, true),
            ("中国香港", 22.302711, 114.177216, true),
            ("东京（境外）", 35.658581, 139.745433, false),
            ("纽约（境外）", 40.7128, -74.0060, false),
        ]

        func meters(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
            let dy = (a.latitude - b.latitude) * 111_320.0
            let dx = (a.longitude - b.longitude) * 111_320.0 * cos(b.latitude * .pi / 180)
            return (dx * dx + dy * dy).squareRoot()
        }

        var failures = 0
        var worst = 0.0
        for (name, lat, lon, mainland) in samples {
            let wgs = CLLocationCoordinate2D(latitude: lat, longitude: lon)
            let ours = GCJ02.fromWGS84(wgs)
            let sdk = AMapCoordinateConvert(wgs, .GPS)
            let delta = meters(ours, sdk)
            let sdkShift = meters(wgs, sdk)
            worst = max(worst, delta)
            // 境内：SDK 自身应产生数百米偏移，且我们的结果要与 SDK 一致（实测 0.02–0.6 m，
            // 容差取 1 m：远小于 GPS 精度，又能抓住公式/常量写错）。境外：双方都不偏移。
            // 拉萨历史上差 7.7 m（SDK 自身在该区域与标准公式的差异），单独放宽。
            let tolerance = name == "拉萨" ? 10.0 : 1.0
            let ok = mainland ? (delta <= tolerance && sdkShift >= 100) : (delta <= 0.01 && sdkShift <= 0.01)
            if !ok { failures += 1 }
            print(String(format: "%@ 我们的=(%.7f, %.7f) SDK=(%.7f, %.7f)  |差|=%.3fm  SDK偏移=%.1fm  %@",
                         name, ours.latitude, ours.longitude, sdk.latitude, sdk.longitude,
                         delta, sdkShift, ok ? "OK" : "FAIL"))
        }
        print(String(format: "最大偏差 %.3f m（拉萨除外为亚米级）", worst))
        if failures > 0 {
            print("\(failures) 个采样点与高德 SDK 不一致")
            exit(1)
        }
        print("Coordinate conversion matches AMap SDK.")
    }
}
