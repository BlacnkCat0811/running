import Foundation
import SQLite3

/// R2（2026-10-19 复核）：观察者意图的**单一原子存储边界**。
///
/// ## 为什么不能再只放 `UserDefaults`
///
/// A8 之后观察者回调在 HealthKit 私有队列上**先落耐久意图、再 `completion()`**；而确认
/// （`acknowledge`）仍在 MainActor。旧实现是三步：
///
/// ```text
/// 读 currentGeneration → 比较本次观察到的旧代次 → removeObject(key)
/// ```
///
/// `UserDefaults` 的单个方法线程安全，但**这三步不是原子的**：observer 可以在"读"与"删"
/// 之间写入新代次，旧确认随后按旧快照把新代次删掉 —— 结果是 `ack=true`、新意图不存在。
/// 现象是进程若在那次 `Task { @MainActor }` 派发之前被挂起/结束，这一代投递就彻底消失
/// （HealthKit 收到 completion 后不会重放）。
///
/// ## 本实现的边界
///
/// - 与 `SyncTaskStore` **同库、不同受控连接**（同一份本地同步存储，不新增后台机制）；
/// - 进程唯一实例持有一条**专用串行队列**：MainActor 与 observer 回调都只能经它访问；
/// - 写入在一个短事务里 UPSERT + 回读校验；确认是**条件删除**
///   （`DELETE … WHERE url_scope = ? AND generation = ?`）—— 比较与删除在同一句 SQL 里，
///   两种交错顺序都安全：
///
/// ```text
/// 旧确认先提交 → 新记录随后插入 → 新记录保留
/// 新记录先提交 → 旧确认条件不匹配（changes=0）→ 不删，返回 false
/// ```
///
/// - 失败（磁盘满 / 库不可达 / 有限重试耗尽）返回 `false` 并保留 `lastError`：
///   `changes=0` **不允许**随后无条件删除，也不把失败说成"队列已清空"。
///
/// ## 不承诺的边界（必须如实保留）
///
/// 存储持续不可写、且进程随后退出时，**不能承诺这条通知已耐久保存**。日志与后台请求都
/// 不能冒充持久队列；这里只保证"写入成功 = 同库可读回"，以及"失败 = 明确分类、不静默"。
nonisolated final class HealthSyncIntentJournal: @unchecked Sendable {
    /// 一次确认的结果。
    enum AcknowledgeResult: Equatable, Sendable {
        /// 条件删除命中：恰好确认了观察到的那个代次。
        case acknowledged
        /// 没有可确认的代次，或没有耐久检查点（调用方传 `.none`）。
        case notEligible
        /// 代次已被覆盖或已被确认：合法无操作，**没有**删除任何东西。
        case superseded
        /// 读写失败：不可确认，意图原样保留（或无法读取）。
        case failed
    }

    private let databaseURL: URL
    private let legacyUserDefaults: UserDefaults
    private let legacyBaseKey: String?
    /// 所有 SQL 与旧键迁移都在这条串行队列上执行。与 `SyncTaskStore` 的连接彼此独立，
    /// 靠 SQLite 的 WAL + `busy_timeout` 协调。
    private let queue = DispatchQueue(label: "app.rai.sync.intent-journal")
    private var database: OpaquePointer?
    private(set) var unavailableReason: String?

    /// SQLite 忙等上限（毫秒）。取一个短值：回调路径上的耐久写必须是**有界**的，
    /// 不能把 `completion()` 拖到秒级。
    /// 短 busy timeout：MainActor 的读/写与观察者回调共用这把写锁，250ms 是**上界**，
    /// 不是期望值。设成秒级会让一次锁竞争直接卡住主线程（并发审查实测过 6.2s 的形态）。
    private static let busyTimeoutMilliseconds: Int32 = 250
    /// 事务开始遇到 `SQLITE_BUSY` 的有限重试次数（不是无限重试）。
    private static let beginRetries = 2

    /// - Parameters:
    ///   - databaseURL: 与 `SyncTaskStore` 相同的 `sync.sqlite`。
    ///   - legacyUserDefaults: 旧版本意图的迁移来源；只读一次、迁移成功后删除旧键。
    ///   - legacyBaseKey: 旧键前缀（生产是 `rai.hk.backgroundIntent`）。`nil` 表示不做迁移。
    init(
        databaseURL: URL,
        legacyUserDefaults: UserDefaults = .standard,
        legacyBaseKey: String? = nil
    ) {
        self.databaseURL = databaseURL
        self.legacyUserDefaults = legacyUserDefaults
        self.legacyBaseKey = legacyBaseKey
        queue.sync { openLocked() }
    }

    deinit {
        queue.sync {
            if let database { sqlite3_close(database) }
            database = nil
        }
    }

    /// 受控重开（R2 §9.4）：意图库在冷启动/受保护数据未就绪时可能打不开；解锁或回到前台后
    /// 由单飞入口重试一次。**只在单飞所有权内调用**（与 `SyncTaskStore.reopenIfUnavailable`
    /// 同一条纪律）：观察者回调不许自己重开数据库。
    @discardableResult
    func reopenIfUnavailable() -> Bool {
        queue.sync {
            if database != nil { return true }
            openLocked()
            return database != nil
        }
    }

    /// 供回归/诊断使用：关闭连接后可在同一路径上重建一个实例验证耐久性。
    func close() {
        queue.sync {
            if let database { sqlite3_close(database) }
            database = nil
        }
    }

    // MARK: - 生产 API（与旧 `HealthSyncBackgroundIntentStore` 同形，便于调用点平滑替换）

    /// 写入一条后台意图，并在同一事务里**回读校验**。
    ///
    /// 一次 `set` + 一次 `get` 的旧实现只能证明"本进程默认域里读得回来"；这里证明的是
    /// "已 COMMIT 到同步存储、同库另一条连接也能读到"。失败返回 `false`（不抛错 ——
    /// 回调路径必须能继续走 `completion()`）。
    /// 同步写入（**观察者回调路径**用：`completion()` 之前必须完成耐久交接）。
    ///
    /// ⚠️ 它会在当前线程上等 SQLite 写事务，因此有**上界**（busy timeout 250ms × 2 次尝试）。
    /// MainActor 不许调用它：那条路径用 `recordInBackground`（排进同一条串行队列，失败只记
    /// 诊断 —— 丢掉一条意图的代价远小于卡住主线程）。
    @discardableResult
    func record(scope: String, generation: String = UUID().uuidString) -> Bool {
        queue.sync { recordLocked(scope: scope, generation: generation) }
    }

    /// MainActor 路径的写入：只入队，不等结果。串行队列保证"先入队先执行"。
    func recordInBackground(scope: String) {
        queue.async { [weak self] in
            guard let self else { return }
            if !self.recordLocked(scope: scope, generation: UUID().uuidString) {
                NSLog("[RAI] background intent write was not verified for scope %@", scope)
            }
        }
    }

    private func recordLocked(scope: String, generation: String) -> Bool {
        guard !scope.isEmpty, !generation.isEmpty else { return false }
        guard let database else { return false }
        guard beginImmediateLocked(database: database, operation: "record") else { return false }
        var committed = false
        defer {
            if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) }
        }
        guard executeLocked(
            "INSERT INTO sync_observer_intents(url_scope, generation, updated_at) "
                + "VALUES (?1, ?2, ?3) "
                + "ON CONFLICT(url_scope) DO UPDATE SET "
                + "generation = excluded.generation, updated_at = excluded.updated_at",
            bind: { statement in
                SQLiteSupport.bind(scope, to: statement, at: 1)
                    && SQLiteSupport.bind(generation, to: statement, at: 2)
                    && sqlite3_bind_double(statement, 3, Date().timeIntervalSince1970) == SQLITE_OK
            },
            operation: "record"
        ) else { return false }
        let readBack = readGenerationLocked(scope: scope)
        guard readBack == generation else {
            unavailableReason = "intent write was not readable back"
            return false
        }
        guard SQLiteSupport.execute("COMMIT", database: database) else {
            unavailableReason = "intent record commit failed"
            return false
        }
        committed = true
        removeLegacyKeyLocked(scope: scope)
        return true
    }

    /// 读取当前代次。`nil` = 没有意图，或读不出来（`unavailableReason` 说明后者）。
    ///
    /// 读事务在 WAL 下不阻塞写者；这里保留同步形态，让**只读探针**不必变成 async。
    func observe(scope: String) -> HealthSyncBackgroundRecovery.IntentObservation? {
        guard !scope.isEmpty else { return nil }
        return queue.sync {
            guard let database else { return nil }
            if let generation = readGenerationLocked(scope: scope) {
                return .init(scope: scope, generation: generation)
            }
            guard unavailableReason == nil else { return nil }
            // R2 §9.5：旧版本 UserDefaults 意图按 scope **惰性迁移**。顺序是
            // "事务内导入 + 回读 → COMMIT → 删旧键"：旧键在成功前绝不先删。
            guard let migrated = migrateLegacyLocked(database: database, scope: scope) else {
                return nil
            }
            return .init(scope: scope, generation: migrated)
        }
    }

    func hasIntent(scope: String) -> Bool { observe(scope: scope) != nil }

    /// 启动/切换目标时显式迁移该 scope 的旧意图（与 `observe` 的惰性迁移同一条路径）。
    ///
    /// MainActor 启动路径用 `migrateLegacyInBackground`：迁移失败可以下一轮重试，
    /// 不值得让界面等一次写事务。
    func migrateLegacy(scope: String) {
        guard !scope.isEmpty else { return }
        _ = queue.sync {
            guard let database else { return false }
            return migrateLegacyLocked(database: database, scope: scope) != nil
        }
    }

    func migrateLegacyInBackground(scope: String) {
        guard !scope.isEmpty else { return }
        queue.async { [weak self] in
            guard let self, let database = self.database else { return }
            _ = self.migrateLegacyLocked(database: database, scope: scope)
        }
    }

    /// **原子条件确认**：只有"当前代次 == 本轮观察到的代次"才删除。
    ///
    /// - `changes == 1`：恰好确认了观察到的那个代次。
    /// - `changes == 0`：新代次已经覆盖旧代次，或旧代次已被确认。**合法无操作** ——
    ///   绝不能随后无条件删除（那正是 R2 的缺陷形态）。
    /// - 任何 SQL/提交失败：返回 `.failed`，意图原样保留。
    @discardableResult
    func acknowledge(
        _ observed: HealthSyncBackgroundRecovery.IntentObservation?,
        checkpoint: HealthSyncBackgroundRecovery.DurableCheckpoint
    ) -> Bool {
        acknowledgeResult(observed, checkpoint: checkpoint) == .acknowledged
    }

    func acknowledgeResult(
        _ observed: HealthSyncBackgroundRecovery.IntentObservation?,
        checkpoint: HealthSyncBackgroundRecovery.DurableCheckpoint
    ) -> AcknowledgeResult {
        guard checkpoint != .none, let observed else { return .notEligible }
        guard !observed.scope.isEmpty, !observed.generation.isEmpty else { return .notEligible }
        return queue.sync { acknowledgeResultLocked(observed) }
    }

    /// MainActor 收尾路径的确认：只入队。条件删除的语义不变 —— 旧确认永远删不掉新代次；
    /// 失败只记诊断（意图留在库里，下一轮再确认）。
    func acknowledgeInBackground(
        _ observed: HealthSyncBackgroundRecovery.IntentObservation?,
        checkpoint: HealthSyncBackgroundRecovery.DurableCheckpoint
    ) {
        guard checkpoint != .none, let observed,
              !observed.scope.isEmpty, !observed.generation.isEmpty else { return }
        queue.async { [weak self] in
            guard let self else { return }
            if self.acknowledgeResultLocked(observed) == .failed {
                NSLog("[RAI] background intent acknowledgement failed; the intent was left in place")
            }
        }
    }

    private func acknowledgeResultLocked(
        _ observed: HealthSyncBackgroundRecovery.IntentObservation
    ) -> AcknowledgeResult {
        guard let database else { return .failed }
        guard beginImmediateLocked(database: database, operation: "acknowledge") else {
            return .failed
        }
        var committed = false
        defer {
            if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) }
        }
        // 🔴 比较与删除在同一条 SQL 里：`UserDefaults` 的三步读删在这里被合成一次
        // 条件删除，任何交错顺序都不会误删新代次。
        let changes = executeChangesLocked(
            "DELETE FROM sync_observer_intents WHERE url_scope = ?1 AND generation = ?2",
            bind: { statement in
                SQLiteSupport.bind(observed.scope, to: statement, at: 1)
                    && SQLiteSupport.bind(observed.generation, to: statement, at: 2)
            },
            operation: "acknowledge"
        )
        guard let changes else { return .failed }
        guard SQLiteSupport.execute("COMMIT", database: database) else {
            unavailableReason = "intent acknowledge commit failed"
            return .failed
        }
        committed = true
        return changes == 1 ? .acknowledged : .superseded
    }

    /// 供测试/诊断读取实际生效的 journal mode（WAL 配置失败不能伪装成成功）。
    var journalMode: String? {
        queue.sync {
            guard let database,
                  let statement = SQLiteSupport.prepare("PRAGMA journal_mode", database: database)
            else { return nil }
            defer { sqlite3_finalize(statement) }
            guard sqlite3_step(statement) == SQLITE_ROW,
                  let pointer = sqlite3_column_text(statement, 0) else { return nil }
            return String(cString: pointer)
        }
    }

    // MARK: - 连接与事务

    private func openLocked() {
        unavailableReason = nil
        try? FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var handle: OpaquePointer?
        let result = databaseURL.path.withCString { path in
            sqlite3_open_v2(
                path,
                &handle,
                SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX,
                nil
            )
        }
        guard result == SQLITE_OK, let handle else {
            if let handle { sqlite3_close(handle) }
            unavailableReason = "intent journal open failed (sqlite \(result))"
            return
        }
        database = handle
        sqlite3_busy_timeout(handle, Self.busyTimeoutMilliseconds)
        // 与任务行连接同一套耐久配置：WAL + FULL。意图日志承载"completion 前已耐久交接"的
        // 承诺，不能退回默认的 rollback journal / NORMAL；WAL 配置失败要在诊断里说出来，
        // 不能伪装成"配置成功"（`journalMode` 供回归核对）。
        _ = SQLiteSupport.execute(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
            database: handle
        )
        // 表由 `SyncTaskStore` v5 迁移创建；这里再建一次是**幂等兜底**：
        // 回归/诊断会单独打开一个只有意图表的新库，而 v5 迁移没跑完的老库上也不能让
        // 观察者路径静默失败。
        guard SQLiteSupport.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_observer_intents (
                url_scope TEXT PRIMARY KEY,
                generation TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            """,
            database: handle
        ) else {
            unavailableReason = "intent journal schema failed"
            sqlite3_close(handle)
            database = nil
            return
        }
    }

    private func beginImmediateLocked(database: OpaquePointer, operation: String) -> Bool {
        for attempt in 0..<Self.beginRetries {
            if SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) { return true }
            if attempt == Self.beginRetries - 1 { break }
            // 有限退避（毫秒级）：不把回调路径拖成秒级等待。
            Thread.sleep(forTimeInterval: 0.005)
        }
        unavailableReason = "intent journal \(operation) could not begin a transaction"
        return false
    }

    private func executeLocked(
        _ sql: String,
        bind: (OpaquePointer) -> Bool,
        operation: String
    ) -> Bool {
        guard let database, let statement = SQLiteSupport.prepare(sql, database: database) else {
            unavailableReason = "intent journal \(operation) prepare failed"
            return false
        }
        defer { sqlite3_finalize(statement) }
        guard bind(statement) else {
            unavailableReason = "intent journal \(operation) bind failed"
            return false
        }
        guard sqlite3_step(statement) == SQLITE_DONE else {
            unavailableReason = "intent journal \(operation) step failed"
            return false
        }
        return true
    }

    /// 条件删除的 `changes()`。`nil` = SQL 执行失败（与"删 0 行"必须分开）。
    private func executeChangesLocked(
        _ sql: String,
        bind: (OpaquePointer) -> Bool,
        operation: String
    ) -> Int32? {
        guard let database, let statement = SQLiteSupport.prepare(sql, database: database) else {
            unavailableReason = "intent journal \(operation) prepare failed"
            return nil
        }
        defer { sqlite3_finalize(statement) }
        guard bind(statement) else {
            unavailableReason = "intent journal \(operation) bind failed"
            return nil
        }
        guard sqlite3_step(statement) == SQLITE_DONE else {
            unavailableReason = "intent journal \(operation) step failed"
            return nil
        }
        return sqlite3_changes(database)
    }

    private func readGenerationLocked(scope: String) -> String? {
        guard let database else { return nil }
        guard let statement = SQLiteSupport.prepare(
            "SELECT generation FROM sync_observer_intents WHERE url_scope = ?",
            database: database
        ) else {
            unavailableReason = "intent journal read prepare failed"
            return nil
        }
        defer { sqlite3_finalize(statement) }
        guard SQLiteSupport.bind(scope, to: statement, at: 1) else {
            unavailableReason = "intent journal read bind failed"
            return nil
        }
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW, let pointer = sqlite3_column_text(statement, 0) else {
            unavailableReason = "intent journal read failed"
            return nil
        }
        let generation = String(cString: pointer)
        return generation.isEmpty ? nil : generation
    }

    // MARK: - 旧 UserDefaults 意图迁移（R2 §9.5）

    /// 旧键名（与 `HealthSyncBackgroundIntentStore.storageKey(scope:)` 逐字相同）。
    private func legacyKey(scope: String) -> String? {
        guard let legacyBaseKey else { return nil }
        return "\(legacyBaseKey).\(scope)"
    }

    /// 把一个旧键导入 SQLite。返回导入后的代次；`nil` = 没有旧键 / 迁移失败。
    ///
    /// 顺序（崩溃安全）：事务内 `INSERT OR IGNORE`（新行优先）→ 回读 → COMMIT → 删旧键。
    /// 崩在删旧键之前：下一次启动 `INSERT OR IGNORE` 不会覆盖新代次，旧键再被删掉。
    /// 崩在 COMMIT 之前：事务回滚，旧键仍在，下一次重试。
    private func migrateLegacyLocked(database: OpaquePointer, scope: String) -> String? {
        guard let key = legacyKey(scope: scope) else { return nil }
        guard let stored = legacyUserDefaults.object(forKey: key),
              let generation = HealthSyncBackgroundRecovery.intentGeneration(from: stored)
        else { return nil }
        guard beginImmediateLocked(database: database, operation: "migrate") else { return nil }
        var committed = false
        defer {
            if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) }
        }
        guard executeLocked(
            "INSERT OR IGNORE INTO sync_observer_intents(url_scope, generation, updated_at) "
                + "VALUES (?1, ?2, ?3)",
            bind: { statement in
                SQLiteSupport.bind(scope, to: statement, at: 1)
                    && SQLiteSupport.bind(generation, to: statement, at: 2)
                    && sqlite3_bind_double(statement, 3, Date().timeIntervalSince1970) == SQLITE_OK
            },
            operation: "migrate"
        ) else { return nil }
        guard let current = readGenerationLocked(scope: scope) else {
            // 迁移事务内读不回来：必须放弃这次迁移，旧键原样保留（下一次重试）。
            return nil
        }
        guard SQLiteSupport.execute("COMMIT", database: database) else {
            unavailableReason = "intent journal migrate commit failed"
            return nil
        }
        committed = true
        legacyUserDefaults.removeObject(forKey: key)
        return current
    }

    private func removeLegacyKeyLocked(scope: String) {
        guard let key = legacyKey(scope: scope) else { return }
        // 新写入成功也意味着该 scope 的旧键已被更晚的代次取代：删掉它，避免下一次
        // `observe` 在 SQLite 行被确认后又把旧代次"复活"回来。
        legacyUserDefaults.removeObject(forKey: key)
    }
}
