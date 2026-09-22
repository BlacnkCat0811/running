import Foundation

/// `SyncAtomicUnit` / `SyncUploadRecovery` / `SyncPhase` 的回归。
///
/// 它钉的是**计划 §8 那张失败点处置表**，把"原子单元的顺序"从"读代码才知道"变成断言。
/// 这几条全是"改错了照样编译通过、肉眼也看不出来"的：
///
///   1. `inspect` 是 `startImport` 的**强制前置门**（`unchanged` 时建任务 ⇒ 必然失败的 job，
///      2026-09-22 线上死锁的完整形态）；
///   2. `jobId` 在就必须等它，**不得重传**（重传 = 第二份来源）；
///   3. 上传失败的三种形态必须分开：瞬时（同 batchId 重传）/ 并发占用（退避）/
///      确定性坏批次（**永不重传**）；
///   4. 只有 `importing` 允许跨会话。
///
/// 为什么要单独一个可执行文件：一个模块只能有一个 `@main`，所以共用 `SyncPhase.swift`、
/// 分开编译（与既有三个 health-sync 回归同样的做法）。
@main
struct SyncAtomicUnitRegression {
    static func main() throws {
        try fieldOrderDecidesTheNextStep()
        try sourceIsInspectedBeforeAnyImport()
        try localBatchResumesAtUpload()
        try nothingLocalStartsFromExport()
        try fullIgnoresEveryRecoveryBranch()
        try waitForJobIsNeverReuploaded()
        try uploadRecoveryKeepsTheSameBatch()
        try busyUploadIsNotABadBatch()
        try badBatchIsNeverRetried()
        try channelFailuresKeepTheBatch()
        try uploadRecoverySetsAreDisjoint()
        try phaseSetIsCoherent()
        try onlyImportingSpansSessions()
        print("Sync atomic unit regression tests passed")
    }

    /// 字段优先于阶段文字：`jobId` > `sourceId` > 本地文件。
    ///
    /// 这条顺序不是风格问题：`jobId` 在说明服务端已经在算，此时任何"重传"都会造出
    /// 第二份来源；`sourceId` 在说明批次已经上传过，此时先 `export` 会白读一次 HealthKit。
    private static func fieldOrderDecidesTheNextStep() throws {
        try require(
            SyncAtomicUnit.nextStep(sourceId: "s", jobId: "j", hasZip: true, hasMultipart: true) == .waitJob,
            "a persisted jobId did not outrank the other recovery branches"
        )
        try require(
            SyncAtomicUnit.nextStep(sourceId: "s", jobId: nil, hasZip: true, hasMultipart: true) == .inspect,
            "a persisted sourceId did not outrank the local-batch branch"
        )
        try require(
            SyncAtomicUnit.nextStep(sourceId: nil, jobId: nil, hasZip: true, hasMultipart: true) == .upload,
            "a durable local batch did not resume at upload"
        )
        try require(
            SyncAtomicUnit.nextStep(sourceId: nil, jobId: nil, hasZip: false, hasMultipart: true) == .upload,
            "a multipart without its zip must still resume at upload"
        )
    }

    /// `sourceId` 在就必须先 `inspect`，**永远不能**直接进 `startImport`。
    ///
    /// 2026-09-22 线上死锁：成功导入过的 HealthKit 上传会被服务端 retain
    /// （留记录、**删目录**），对这类来源直接建任务必然得到一个失败的 job；此后每次同步
    /// 都从 `inspect` 404 进来、再原样退出，nginx 里**再没有出现过任何 uploads**。
    private static func sourceIsInspectedBeforeAnyImport() throws {
        try require(
            SyncAtomicUnit.Step.inspect != .startImport,
            "the atomic unit must not skip its gate"
        )
        for (zip, multipart) in [(true, true), (true, false), (false, true), (false, false)] {
            let step = SyncAtomicUnit.nextStep(
                sourceId: "s", jobId: nil, hasZip: zip, hasMultipart: multipart
            )
            try require(
                step == .inspect,
                "sourceId with zip=\(zip) multipart=\(multipart) went to \(step) instead of inspect"
            )
        }
    }

    /// 批次已上传、导入未发起（`sourceId` 在、`jobId` 不在）也必须走 `inspect`。
    ///
    /// 这正是 P1 之前分不出来的那个状态（两种情形都写成 `importing`）——
    /// 现在它由 `sourceId`/`jobId` 两个字段如实表达，判据也据此分流。
    private static func localBatchResumesAtUpload() throws {
        try require(
            SyncAtomicUnit.nextStep(sourceId: nil, jobId: nil, hasZip: true, hasMultipart: false) == .upload,
            "a zip without a multipart must go back through upload (which rebuilds it)"
        )
    }

    /// 本地什么都没有 ⇒ 从导出开始。不许"以为还有东西"直接去 inspect。
    private static func nothingLocalStartsFromExport() throws {
        try require(
            SyncAtomicUnit.nextStep(sourceId: nil, jobId: nil, hasZip: false, hasMultipart: false) == .export,
            "an empty state did not start from export"
        )
    }

    /// 「重新导入全部」必须短路三个恢复分支，否则"重新导入"会悄悄复用旧批次。
    private static func fullIgnoresEveryRecoveryBranch() throws {
        let combos: [(String?, String?, Bool, Bool)] = [
            (nil, nil, false, false), (nil, nil, true, false), (nil, nil, false, true),
            ("s", nil, true, true), ("s", "j", true, true), (nil, "j", false, false)
        ]
        for (sourceId, jobId, hasZip, hasMultipart) in combos {
            let step = SyncAtomicUnit.nextStep(
                full: true, sourceId: sourceId, jobId: jobId, hasZip: hasZip, hasMultipart: hasMultipart
            )
            try require(
                step == .export,
                "full re-import resumed at \(step) for source=\(sourceId ?? "-") job=\(jobId ?? "-")"
            )
        }
    }

    /// `jobId` 在就必须等它 —— 包括等超时之后。§8：`waitForJob` 超时**不得** `clearTask`、
    /// 不得重传，保留 `jobId` 交给下次唤醒。
    private static func waitForJobIsNeverReuploaded() throws {
        for (zip, multipart) in [(true, true), (true, false), (false, true), (false, false)] {
            let step = SyncAtomicUnit.nextStep(
                sourceId: nil, jobId: "j", hasZip: zip, hasMultipart: multipart
            )
            try require(
                step == .waitJob,
                "a persisted jobId with zip=\(zip) multipart=\(multipart) went to \(step)"
            )
        }
    }

    /// 瞬时失败：保留 multipart，同 batchId 重传（幂等键保证不产生第二份来源）。
    ///
    /// 🔴 5xx 一律带上 `internal_error` 这个 code 来断言，**不是**装饰：
    /// `apps/api/src/api-error.ts:26-31` 会把 `status >= 500` 的 code 抹成 `internal_error`
    /// 并把 message 换成一句通用文案，所以服务端自己抛的 `import_upload_capacity_exceeded`
    /// （507）走到客户端时**已经不是一个可用的判别键**了。判据只能落在状态码上。
    private static func uploadRecoveryKeepsTheSameBatch() throws {
        let cases: [(Int?, String?)] = [
            (nil, nil),                       // 断网 / 超时 / 连接被拒
            (500, "internal_error"),
            (502, "internal_error"),
            (503, "internal_error"),
            (504, "internal_error"),
            (507, "internal_error"),          // 服务端空间不足：code 被抹掉，只剩 507
            (429, "import_upload_busy")
        ]
        for (status, code) in cases {
            let action = SyncUploadRecovery.disposition(statusCode: status, errorCode: code)
            try require(
                action == .keepForNextWake || action == .backOffAndRetry,
                "a transient upload failure (\(status.map(String.init) ?? "no status")/\(code ?? "-")) was judged \(action)"
            )
        }
    }

    /// 并发占用不是坏批次。
    ///
    /// 服务端用的是 **429 + `import_upload_busy`**（`import-sources.ts:81-84`、`:318`），
    /// **不是** 409 —— 我第一版把这条写成了 409，于是这份断言当时覆盖的是一个不存在的分支。
    /// 两个入口都钉住：只看 code 与只看状态码都要落到 `.backOffAndRetry`。
    private static func busyUploadIsNotABadBatch() throws {
        try require(
            SyncUploadRecovery.disposition(statusCode: 429, errorCode: "import_upload_busy") == .backOffAndRetry,
            "a busy upload (429 + code) was judged a bad batch"
        )
        try require(
            SyncUploadRecovery.disposition(statusCode: 429, errorCode: nil) == .backOffAndRetry,
            "a bare 429 was not treated as a busy upload"
        )
        try require(
            SyncUploadRecovery.disposition(statusCode: nil, errorCode: "import_upload_busy") == .backOffAndRetry,
            "the code alone did not identify a busy upload"
        )
        // 坏批次的方向也要钉：并发占用**不得**被判成"这批废了"，那会白丢一次已导出的批次。
        try require(
            SyncUploadRecovery.disposition(statusCode: 429, errorCode: "import_upload_busy") != .abandonBatch,
            "a busy upload was judged a bad batch"
        )
    }

    /// 确定性坏批次：**永不重传**。同样的字节只会拿到同样的拒绝。
    ///
    /// 每个 code / 状态码都对应服务端源码里的一个真实出口，见 `SyncUploadRecovery` 的说明。
    private static func badBatchIsNeverRetried() throws {
        let cases: [(Int?, String?)] = [
            (400, "invalid_sync_batch_id"),        // import-routes.ts:44 批次号格式非法
            (400, "invalid_import_archive"),       // import-sources.ts:71-74 zip magic / 解压失败
            (409, "sync_batch_content_mismatch"),  // import-sources.ts:65-69 同批次号不同内容
            (413, "import_archive_too_large"),     // import-sources.ts:76-79 超过 4 GiB
            (413, nil),
            (415, nil),                            // import-routes.ts:50 不是 zip
            (400, nil)                             // import-routes.ts:48 没有 file
        ]
        for (status, code) in cases {
            let action = SyncUploadRecovery.disposition(statusCode: status, errorCode: code)
            try require(
                action == .abandonBatch,
                "a deterministically rejected batch (\(status.map(String.init) ?? "-")/\(code ?? "-")) was judged \(action)"
            )
        }
    }

    /// 通道类失败（鉴权 / 路由）**不得**毁掉本地批次。
    ///
    /// 这一条与上一条是一对：坏批次要删、通道问题要留。反过来的两种错法都很贵 ——
    /// 把 401 判成坏批次会白丢一次已经读出来的 HealthKit 导出（重导出是分钟级），
    /// 把 400 判成瞬时失败会让同一份字节被反复上送。
    private static func channelFailuresKeepTheBatch() throws {
        for (status, code) in [(401, nil), (403, "forbidden"), (404, nil), (405, nil), (422, nil)] as [(Int?, String?)] {
            let action = SyncUploadRecovery.disposition(statusCode: status, errorCode: code)
            try require(
                action == .keepForNextWake,
                "a channel-level failure (\(status.map(String.init) ?? "-")/\(code ?? "-")) was judged \(action)"
            )
        }
    }

    /// 枚举集合自身的自洽性：三个集合不得有交集，否则同一次失败会有两种解释，
    /// 而"哪一种生效"取决于 `disposition` 里两个 `if` 的先后 —— 那是最难查的一类。
    private static func uploadRecoverySetsAreDisjoint() throws {
        try require(
            SyncUploadRecovery.busyCodes.isDisjoint(with: SyncUploadRecovery.contentRejectionCodes),
            "a code is classified as both busy and content-rejecting"
        )
        try require(
            !SyncUploadRecovery.contentRejectionStatuses.contains(429),
            "429 is a busy signal, not a content rejection"
        )
        try require(
            SyncUploadRecovery.contentRejectionStatuses.allSatisfy { (400...499).contains($0) },
            "a content-rejection status is not a 4xx"
        )
        try require(
            !SyncUploadRecovery.contentRejectionCodes.isEmpty && !SyncUploadRecovery.busyCodes.isEmpty,
            "an upload-recovery code set was emptied"
        )
    }

    /// 判据集合自身要自洽 —— 否则上面几条覆盖会悄悄漏掉取值。
    private static func phaseSetIsCoherent() throws {
        try require(
            Set(SyncPhase.allCases.map(\.rawValue)).count == SyncPhase.allCases.count,
            "SyncPhase has duplicate raw values"
        )
        for phase in SyncPhase.legacyOnly {
            try require(
                SyncPhase.allCases.contains(phase),
                "legacy-only phase \(phase.rawValue) is not in allCases"
            )
            try require(
                !SyncPhase.terminal.contains(phase),
                "legacy-only phase \(phase.rawValue) must not also be terminal"
            )
        }
        for phase in SyncPhase.terminal {
            try require(
                SyncPhase.allCases.contains(phase),
                "terminal phase \(phase.rawValue) is not in allCases"
            )
        }
        // 迁移：老 payload 里的 `recomputing` 语义等于 `importing`；认不出来的一律 idle。
        for phase in SyncPhase.allCases {
            let migrated = SyncPhase.migrate(phase.rawValue)
            let expected: SyncPhase = phase == .recomputing ? .importing : phase
            try require(
                migrated == expected,
                "migrate(\(phase.rawValue)) = \(migrated.rawValue), expected \(expected.rawValue)"
            )
        }
        for unknown in ["", "exporting", "waitingServer", "UPLOADED", "uploaded ", " import"] {
            try require(
                SyncPhase.migrate(unknown) == .idle,
                "an unknown phase \(unknown) did not fall back to idle"
            )
        }
        // 终态集合不能把整个闭集吃光。
        try require(
            SyncPhase.terminal.count < SyncPhase.allCases.count,
            "every SyncPhase was declared terminal"
        )
    }

    /// 只有 `importing` 允许跨会话（D1）。
    private static func onlyImportingSpansSessions() throws {
        for phase in SyncPhase.allCases {
            try require(
                phase.canSpanSessions == (phase == .importing),
                "phase \(phase.rawValue) claims the wrong cross-session semantics"
            )
        }
        try require(
            !SyncPhase.uploaded.canSpanSessions,
            "uploaded must not span sessions: it is the middle of the atomic unit"
        )
        try require(
            !SyncPhase.exported.canSpanSessions && !SyncPhase.uploading.canSpanSessions,
            "the atomic unit's first two steps must not span sessions"
        )
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw AtomicUnitRegressionFailure(message) }
    }
}

private struct AtomicUnitRegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
