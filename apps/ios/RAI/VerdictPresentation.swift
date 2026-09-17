import Foundation

/// 训练判定的图标名。
///
/// 契约 `MobileVerdictTone` 是闭集 `"green" | "yellow" | "red"`（`api-contracts`），
/// 这里采用**白名单**：只有明确的 `green` 才渲染「通过」，其他一切取值 —— 包括
/// 服务端将来新增、当前客户端还不认识的取值 —— 一律落到警示侧。
///
/// 为什么必须是白名单：项目规则是「未知一律归未知/拒绝，不许归通过」。此前的实现
/// 是一份手写的「坏值」名单（`red`/`warning`/`stale`/`injury`/`yellow`/`caution`/
/// `insufficient`），名单**外**的取值会被渲染成对勾 —— 一个未知 tone 因此会显示成
/// 「一切正常」。名单还和 `techToneColor` 各存一份、需要一起维护。改成白名单后既与
/// 像素风 `NativeViews.swift`（`tone == "green" ? checkmark : exclamation`）同判据，
/// 也让「新增一个域外 tone」的默认行为变成失败关闭。
///
/// 这个文件刻意保持纯 Foundation：它要进 `run-model-tests.sh` 的本地快闸门，
/// 就不能拖进 SwiftUI/`PixelColor`（`NativeFormat.swift` 正是因此进不去）。
func verdictIconName(tone: String) -> String {
    tone == "green" ? "checkmark.shield" : "exclamationmark.shield"
}
