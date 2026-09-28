import Foundation
import Security
import CryptoKit

enum Keychain {
    private static let service = "app.rai.token"
    private static let account = "api-token"

    static func loadToken() -> String {
        loadToken(for: nil)
    }

    static func loadToken(for server: String?) -> String {
        // Retire legacy plaintext credentials, including on Keychain failures.
        // Existing plaintext-only installations must enter their token again.
        UserDefaults.standard.removeObject(forKey: "rai.apiToken")
        let scopedAccount = account(for: server)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: scopedAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data, let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text
    }

    /// 保存是否**真的落进钥匙串**。
    ///
    /// 不能返回 `Void` 并丢弃 `SecItemAdd` 的 `OSStatus`：钥匙串满、设备正在恢复、
    /// 托管配置或授权被拒时写入会失败，而调用方会把"没存上"当成"存上了" ——
    /// 用户下次打开 App 被要求重新输入 token，且没有任何日志能解释为什么。
    @discardableResult
    static func saveToken(_ token: String) -> Bool {
        saveToken(token, for: nil)
    }

    /// 返回 `true` 表示"钥匙串现在就是调用方要的状态"：写入成功，或调用方要求的
    /// 本来就是清空。只有 `SecItemAdd` 真的失败才返回 `false`。
    @discardableResult
    static func saveToken(_ token: String, for server: String?) -> Bool {
        let data = Data(token.utf8)
        let scopedAccount = account(for: server)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: scopedAccount
        ]
        // 忽略返回值是**有意**的：这是 delete-then-add 的 upsert，条目不存在时
        // `errSecItemNotFound` 是预期路径。显式 `_ =` 让这个意图可见，并避免
        // 一条与真实风险无关的编译告警去掩盖下面 `SecItemAdd` 的处理。
        _ = SecItemDelete(query as CFDictionary)
        guard !token.isEmpty else {
            if server == nil { UserDefaults.standard.removeObject(forKey: "rai.apiToken") }
            return true
        }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess {
            NSLog("RAI Keychain: SecItemAdd failed (OSStatus %d); the token was not persisted", status)
        }
        if server == nil { UserDefaults.standard.removeObject(forKey: "rai.apiToken") }
        return status == errSecSuccess
    }

    private static func account(for server: String?) -> String {
        guard let server, !server.isEmpty else { return account }
        let normalized = URL(string: server).map(ServerSession.canonicalURL)?.absoluteString ?? server
        let digest = SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
        return "api-token-\(digest.prefix(32))"
    }
}
