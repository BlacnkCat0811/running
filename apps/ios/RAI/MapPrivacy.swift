#if os(iOS)
import AMapFoundationKit
import Foundation
import MAMapKit

/// 高德 SDK 合规门控。
///
/// 高德要求 App 在用户同意隐私政策后才初始化地图 SDK：`MAMapView.updatePrivacyAgree(.didAgree)`
/// 表示"用户已授权"，必须在任何 `MAMapView` 实例化之前调用。因此 Key 与隐私声明都延迟到
/// 用户同意之后才设置；未同意时路线页只显示离线轨迹，不会创建 `MAMapView`。
@MainActor
enum MapPrivacy {
    enum State: String {
        /// 尚未做出选择：首启展示说明。
        case ask
        /// 已同意：启用高德底图。
        case agreed
        /// 已选择只用离线轨迹：不再打扰，可在设置里重新开启。
        case declined
    }

    /// 同时作为 `@AppStorage` 的键，让各视图能响应状态变化。
    static let storageKey = "rai.privacy.amap.state"
    /// 高德开放平台的隐私政策与合规说明。
    static let policyURL = URL(string: "https://lbs.amap.com/pages/privacy/")!

    static var state: State {
        State(rawValue: UserDefaults.standard.string(forKey: storageKey) ?? "") ?? .ask
    }

    /// 底图是否可用（= 用户已同意）。
    static var mapEnabled: Bool { state == .agreed }

    private static var configured = false

    /// 启动时调用：只有已同意过的用户才初始化地图 SDK。
    static func configureIfAgreed() {
        guard mapEnabled else { return }
        configure()
    }

    /// 用户在说明页点「同意并启用地图」。
    static func agree() {
        UserDefaults.standard.set(State.agreed.rawValue, forKey: storageKey)
        configure()
    }

    /// 用户选择只使用离线轨迹。
    static func decline() {
        UserDefaults.standard.set(State.declined.rawValue, forKey: storageKey)
    }

    /// 从设置里重新打开说明页（例如之前拒绝过、或想确认当前状态）。
    static func resetToAsk() {
        UserDefaults.standard.set(State.ask.rawValue, forKey: storageKey)
    }

    private static func configure() {
        guard !configured else { return }
        configured = true
        MAMapView.updatePrivacyShow(.didShow, privacyInfo: .didContain)
        MAMapView.updatePrivacyAgree(.didAgree)
        // Key 由构建变量 $(RAI_AMAP_API_KEY) 注入 Info.plist（Podfile 从本地
        // Configs/AmapKey.xcconfig 读取），仓库不含明文；见 apps/ios/README.md。
        let key = (Bundle.main.object(forInfoDictionaryKey: "AMapApiKey") as? String) ?? ""
        if key.isEmpty {
            // NSLog, not print: this is the only signal that the basemap will be
            // blank, and it has to survive into a release build's device log.
            NSLog("[RAI] 高德 Key 为空：底图不会加载（路线仍可用离线轨迹）。"
                  + "请在 apps/ios/Configs/AmapKey.xcconfig 填入 Key 后重新 pod install。")
        } else {
            AMapServices.shared().apiKey = key
        }
    }
}
#endif
