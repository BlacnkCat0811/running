import Foundation

/// 校准是否还需要在界面上提示。
///
/// 取值域严格来自 `packages/api-contracts` 的 `MobileCalibrationCard.status`：
/// `not_started | calibrating | completed`。**只有 `completed` 算完成**，其余
/// （含未来新增取值与 `nil`）一律保持提示 —— 未知态不许被映射到宽松分支。
///
/// 单独成文件不是因为判据短，而是为了让 `run-model-tests.sh` 能在 macOS 上直接
/// 编译并钉住它：`NativeFormat.swift` 整个依赖 `PixelColor`（iOS 专属），判据住在
/// 那里就永远进不了那扇秒级闸门 —— 这正是它曾被写成 `!= "ready"`（契约里根本不存在
/// 的取值，于是对任何输入都恒为真，把"校准完成"渲染成黄色告警框）却一路溜到真机的
/// 原因。两皮肤共用这一个判据，避免再次只改一半。
func calibrationNeedsAttention(_ status: String?) -> Bool {
    status != "completed"
}
