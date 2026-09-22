import Foundation

/// 2026-09-22 线上事故的回归：服务端删掉暂存上传之后，iOS 的恢复分支必须**放弃那个 task**。
///
/// 事故形态（nginx 日志 + `/var/lib/rai/var/runtime.sqlite` 实测）：
///
/// ```
/// 08:57:57  POST /v1/imports/uploads   200      ← 唯一一次上传
/// 08:57:57  POST /v1/import-jobs       202
/// 08:58:04  GET  /v1/import-jobs/<id>  200      ← 任务 failed
/// 08:58:25… POST /v1/imports/inspect   404 ×N   ← 此后**再无任何 uploads**
/// ```
///
/// 成因是两侧各一半：任务失败时服务端就地删除那份暂存上传
/// （`apps/api/src/import-source-finalization.ts:35-39`），而 iOS 的恢复分支在收到 404 时
/// 只把 `phase` 置成 `failed` 就 `return`，把持久化的 task（含那个已失效的 `sourceId`）留着
/// ⇒ 每次同步都从同一句 `inspect(sourceId:)` 进来、拿到同一个 404、再原样退出。
///
/// 本文件钉住的是**判据**本身（纯函数）。`performSync` 里那段 `#if os(iOS)` 依赖 URLSession
/// 与 HealthKit，本机跑不了；所以判据被拆成 `HealthSyncResumePolicy`，由这里直接覆盖。
///
/// 突变验证（改完必须亲跑，跑绿 ≠ 断言有效）：
/// 把 `HealthSyncResumePolicy.disposition` 的第一行改成 `return .keepTask`
/// ⇒ `staleSourceIsAbandoned` 与 `terminalJobIsAbandoned` 必须变红。
@main
struct HealthSyncResumeRegression {
    static func main() throws {
        try staleSourceIsAbandoned()
        try terminalJobIsAbandoned()
        try transientFailuresKeepTheTask()
        try pollingAndResumeAgreeOnTheSourceGoneStatus()
        print("Health sync resume regression tests passed")
    }

    /// 服务端说「没有这个暂存上传」⇒ 这个 task 不可能恢复。
    private static func staleSourceIsAbandoned() throws {
        // 🔴 这个 404 是契约值，另一头在 TS：`ImportSourceNotFoundError.statusCode = 404`
        // （`apps/api/src/import-sources.ts:55-58`），由 `/v1/imports/inspect` 抛出。
        try require(
            HealthSyncResumePolicy.sourceGoneStatusCode == 404,
            "the source-gone status drifted away from the API's import_source_not_found"
        )
        try require(
            HealthSyncResumePolicy.disposition(statusCode: 404, errorCode: nil) == .abandonTask,
            "a 404 from inspect must abandon the task — the staging upload is gone for good"
        )
    }

    /// 任务已终结（`waitForJob` 观察到 failed/cancelled/interrupted）⇒ 拿同一个 `jobId`
    /// 再等只是重放同一个错误，task 同样必须被放弃。
    private static func terminalJobIsAbandoned() throws {
        try require(
            HealthSyncResumePolicy.disposition(
                statusCode: nil,
                errorCode: HealthSyncResumePolicy.terminalJobCode
            ) == .abandonTask,
            "a terminal job must abandon the task: re-waiting the same jobId replays the same error"
        )
    }

    /// 瞬时失败**必须**保留 task —— 恢复分支存在的意义就是这条路径，
    /// 把这里一起改掉就等于把"断点续传"删了。
    private static func transientFailuresKeepTheTask() throws {
        for status in [400, 401, 403, 409, 413, 429, 500, 502, 503] as [Int] {
            try require(
                HealthSyncResumePolicy.disposition(statusCode: status, errorCode: nil) == .keepTask,
                "a transient \(status) must keep the task for the next attempt"
            )
        }
        try require(
            HealthSyncResumePolicy.disposition(statusCode: nil, errorCode: nil) == .keepTask,
            "an unclassified failure must keep the task"
        )
        for code in ["mutation_conflict", "unauthorized", "request_error"] as [String] {
            try require(
                HealthSyncResumePolicy.disposition(statusCode: nil, errorCode: code) == .keepTask,
                "error code \(code) must keep the task"
            )
        }
    }

    /// 交叉不变量：同一个状态码在两条判据里必须同向 —— 轮询不再重试它，恢复分支也要放弃 task。
    /// 两边分开演化时，最容易出现的就是"这里当瞬时、那里当终结"。
    private static func pollingAndResumeAgreeOnTheSourceGoneStatus() throws {
        let status = HealthSyncResumePolicy.sourceGoneStatusCode
        try require(
            !HealthSyncPolling.shouldRetryHTTP(statusCode: status),
            "a source-gone \(status) must not be retried by the polling policy either"
        )
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw ResumeRegressionFailure(message) }
    }
}

private struct ResumeRegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
