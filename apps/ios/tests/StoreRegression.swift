import Foundation
import SQLite3

// `ServerSession` 的生产默认值需要的两个符号（本回归只调用它的 `canonicalURL`，是个
// nonisolated static，所以这两个替身不该被触达）。触发即失败，而不是悄悄去读真 Keychain。
enum Keychain {
    static func loadToken(for server: String?) -> String {
        preconditionFailure("StoreRegression touched the real Keychain path")
    }

    static func saveToken(_ token: String, for server: String?) {
        preconditionFailure("StoreRegression touched the real Keychain path")
    }
}

enum RaiURLSession {
    static func make(configuration: URLSessionConfiguration) -> URLSession {
        preconditionFailure("StoreRegression created a non-injected URLSession")
    }
}

/// `CacheStore` 与 `SyncTaskStore` 的**生产实现**回归。
///
/// 为什么需要它：在此之前这两个文件只被 `typecheck-ios.sh` 类型检查过，从未被执行。
/// `ModelRegression.swift` 里有一份 `CacheStore` 替身（`scope` 退化成字符串拼接），
/// 于是「缓存命名空间由什么决定」这条规则从来没被真实现跑过 —— 少算 `datasetEpoch`
/// 或漏掉 `athleteId` 都能全绿通过。两个 store 的构造器都写死了 Application Support
/// 路径，本回归因此只能连真缓存目录一起写；注入 `fileURL` / `directory` 之后，
/// 它在临时目录里跑的就是生产代码本身。
///
/// 明确不在这里测的：`ModelRegression.swift` 那份替身的行为（那是它的职责），
/// 以及 `HealthKitSync` 自己的 `urlScope`/`syncScope`（那两个只取 sha256 前 24 位，
/// 与本文件的 64 位版本不是同一条规则，需要模拟器才能跑）。
@main
struct StoreRegression {
    @MainActor
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-store-regression-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let base = URL(string: "http://192.168.1.10:8790")!
        func handshake(server: String = "srv-a", athlete: String = "ath-a", epoch: String = "epoch-a") -> RaiHandshake {
            RaiHandshake(serverId: server, athleteId: athlete, datasetEpoch: epoch,
                         syncProtocolVersion: 1, apiVersion: "1")
        }
        func variant(server: String = "srv-a", athlete: String = "ath-a", epoch: String = "epoch-a",
                     url: String = "http://192.168.1.10:8790") -> String {
            CacheStore.scope(baseURL: URL(string: url)!,
                             handshake: handshake(server: server, athlete: athlete, epoch: epoch))
        }

        // ---- CacheStore.scope：缓存命名空间必须把「哪台服务器 / 哪个运动员 / 哪一代数据」
        //      全部算进去。少算任何一项，两台服务器（或同一台服务器的两代数据）就会互相
        //      读到对方的缓存，而缓存内容是 workout/today/trends 这类真实读数。
        let identityScope = variant()
        check(identityScope == variant(), "cache scope is stable for an identical identity")
        check(identityScope.count == 64, "cache scope is a full sha256 digest, not a truncated one")
        check(identityScope.allSatisfy { $0.isHexDigit && !$0.isUppercase }, "cache scope is lowercase hex")
        check(variant(server: "srv-b") != identityScope, "a different server must not share a cache namespace")
        check(variant(athlete: "ath-b") != identityScope, "a different athlete must not share a cache namespace")
        check(variant(epoch: "epoch-b") != identityScope, "a new dataset epoch must not read the previous epoch's cache")
        check(variant(url: "http://192.168.1.11:8790") != identityScope,
              "a different server address must not share a cache namespace")
        check(CacheStore.scope(baseURL: base, handshake: nil) != identityScope,
              "a missing handshake must not collide with a known identity")

        // ---- CacheStore.urlScope：只认规范化之后的地址身份，与书写形式无关。
        //      它决定「握手应答缓存」这类键，写错就会在换端口/换大小写后读到旧服务器的应答。
        let canonicalScope = CacheStore.urlScope(baseURL: URL(string: "http://Host.Example:80/rai?x=1#frag")!)
        check(canonicalScope == CacheStore.urlScope(baseURL: URL(string: "http://host.example")!),
              "url scope ignores host case, the default port, path, query and fragment")
        check(canonicalScope != CacheStore.urlScope(baseURL: URL(string: "https://host.example")!),
              "url scope still separates http from https")
        check(canonicalScope.count == 64, "url scope is a full sha256 digest")

        // ---- read / write / clear：缓存的实际读写路径。
        let cache = CacheStore(fileURL: root.appendingPathComponent("cache.sqlite"))
        let writtenAt = cache.write(["hello": "world"], scope: "s1", key: "k1")
        let stored = cache.read([String: String].self, scope: "s1", key: "k1")
        check(stored?.value == ["hello": "world"], "a written value reads back")
        check(abs((stored?.cachedAt.timeIntervalSince(writtenAt!) ?? 999)) < 5,
              "a read reports when the value was written")
        check(cache.read([String: String].self, scope: "s2", key: "k1") == nil,
              "the same key under another scope is a miss, not the other scope's value")
        check(cache.read([String: String].self, scope: "s1", key: "k2") == nil, "an unwritten key is a miss")
        _ = cache.write(["hello": "second"], scope: "s1", key: "k1")
        check(cache.read([String: String].self, scope: "s1", key: "k1")?.value == ["hello": "second"],
              "rewriting a key replaces its value")
        _ = cache.write(["keep": "1"], scope: "s2", key: "k1")
        cache.clear(scope: "s1")
        check(cache.read([String: String].self, scope: "s1", key: "k1") == nil, "clear(scope:) drops that scope")
        check(cache.read([String: String].self, scope: "s2", key: "k1")?.value == ["keep": "1"],
              "clear(scope:) leaves other scopes alone")
        cache.clearAll()
        check(cache.read([String: String].self, scope: "s2", key: "k1") == nil, "clearAll() drops every scope")

        // ---- prune：淘汰策略。它是「缓存会不会无限增长」的唯一判据，此前从未被执行。
        //      `write` 每次都调用它，所以写坏它要么让缓存无界，要么把刚写进去的值删掉。
        let pruner = CacheStore(fileURL: root.appendingPathComponent("prune.sqlite"))
        for index in 0..<5 { _ = pruner.write(["i": index], scope: "p", key: "k\(index)") }
        pruner.prune(maxEntries: 1000, maxBytes: 100 * 1024 * 1024)
        check((0..<5).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "k\($0)") != nil },
              "prune keeps every entry while both limits are respected")
        pruner.prune(maxEntries: 2, maxBytes: 100 * 1024 * 1024)
        check((0..<3).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "k\($0)") == nil },
              "prune evicts the oldest entries first")
        check((3..<5).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "k\($0)") != nil },
              "prune stops at the entry limit instead of emptying the table")
        pruner.prune(maxEntries: 0, maxBytes: 100 * 1024 * 1024)
        check((3..<5).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "k\($0)") == nil },
              "an entry limit of zero empties the table")
        for index in 0..<3 { _ = pruner.write(["i": index], scope: "p", key: "b\(index)") }
        pruner.prune(maxEntries: 1000, maxBytes: 1)
        check((0..<3).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "b\($0)") == nil },
              "prune enforces the byte limit and terminates once the table is empty")

        // 开不出库时不允许崩、也不允许假装写成功。
        let brokenCache = CacheStore(fileURL: URL(fileURLWithPath: "/dev/null/not-a-directory/cache.sqlite"))
        check(brokenCache.write(["a": "b"], scope: "s", key: "k") == nil,
              "a failed cache write must not advance freshness")
        check(brokenCache.read([String: String].self, scope: "s", key: "k") == nil,
              "a cache that cannot open reports a miss instead of crashing")

        // ---- SyncTaskStore：健康同步的断点续传日志。它决定「重连后从哪继续」，
        //      而「没有任务」与「存了一个空任务」必须是可区分的；scope 之间也不能串。
        let journal = SyncTaskStore(directory: root.appendingPathComponent("sync"))
        check(journal.isAvailable, "a writable directory yields an available journal")
        check(journal.load(scope: "s1") == nil, "an empty journal reports no saved task")
        journal.save(Data([1, 2, 3]), scope: "s1")
        check(journal.load(scope: "s1") == Data([1, 2, 3]), "a saved task reads back byte for byte")
        journal.save(Data([9]), scope: "s1")
        check(journal.load(scope: "s1") == Data([9]), "saving the same scope replaces the previous task")
        journal.save(Data([7]), scope: "s2")
        check(journal.load(scope: "s1") == Data([9]), "saving another scope leaves the first task intact")
        journal.clear(scope: "s1")
        check(journal.load(scope: "s1") == nil, "clear(scope:) forgets that scope")
        check(journal.load(scope: "s2") == Data([7]), "clear(scope:) leaves other scopes alone")

        // Inject real SQLite write failures after a successful open: availability
        // alone cannot prove that a later update or clear was durable.
        var control: OpaquePointer?
        let journalPath = root.appendingPathComponent("sync/sync.sqlite").path
        precondition(sqlite3_open(journalPath, &control) == SQLITE_OK)
        precondition(sqlite3_exec(control, "CREATE TRIGGER fail_update BEFORE UPDATE ON sync_tasks BEGIN SELECT RAISE(ABORT, 'fixture'); END; CREATE TRIGGER fail_delete BEFORE DELETE ON sync_tasks BEGIN SELECT RAISE(ABORT, 'fixture'); END;", nil, nil, nil) == SQLITE_OK)
        check(!journal.save(Data([8]), scope: "s2"), "a rejected update reports failure")
        check(journal.lastError != nil, "journal write failure has an actionable state")
        check(journal.load(scope: "s2") == Data([7]), "a rejected update retains the last durable task")
        check(!journal.clear(scope: "s2"), "a rejected clear reports failure")
        check(journal.load(scope: "s2") == Data([7]), "a rejected clear retains the resume state")
        sqlite3_close(control)

        let brokenJournal = SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
        check(!brokenJournal.isAvailable, "a journal that cannot open reports itself unavailable")
        check(!brokenJournal.save(Data([1]), scope: "s1"), "an unavailable journal rejects writes")
        check(brokenJournal.load(scope: "s1") == nil, "an unavailable journal never pretends a save happened")
        brokenJournal.clear(scope: "s1")
        check(brokenJournal.load(scope: "s1") == nil, "clearing an unavailable journal is a no-op, not a crash")

        print("\(checks) store regression checks passed")
    }
}
