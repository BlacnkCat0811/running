import Foundation
import SQLite3

/// Shared low-level operations. Callers decide whether a failure is a cache miss
/// or a blocking journal error; neither layer silently reports a successful write.
nonisolated enum SQLiteSupport {
    static var transient: sqlite3_destructor_type {
        unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    }

    static func prepare(_ sql: String, database: OpaquePointer?) -> OpaquePointer? {
        guard let database else { return nil }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
            if let statement { sqlite3_finalize(statement) }
            return nil
        }
        return statement
    }

    @discardableResult
    static func bind(_ value: String, to statement: OpaquePointer, at index: Int32) -> Bool {
        value.withCString { sqlite3_bind_text(statement, index, $0, -1, transient) == SQLITE_OK }
    }

    @discardableResult
    static func execute(_ sql: String, database: OpaquePointer?) -> Bool {
        guard let database else { return false }
        return sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK
    }

    static func report(_ operation: String, database: OpaquePointer?) {
        // Codes only: SQL values and health-data paths stay out of release logs.
        let code = database.map { sqlite3_extended_errcode($0) } ?? SQLITE_CANTOPEN
        NSLog("[RAI] SQLite %@ failed (code %d)", operation, code)
    }
}
