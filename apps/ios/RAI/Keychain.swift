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
            return server == nil ? UserDefaults.standard.string(forKey: "rai.apiToken") ?? "" : ""
        }
        return text
    }

    static func saveToken(_ token: String) {
        saveToken(token, for: nil)
    }

    static func saveToken(_ token: String, for server: String?) {
        let data = Data(token.utf8)
        let scopedAccount = account(for: server)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: scopedAccount
        ]
        SecItemDelete(query as CFDictionary)
        guard !token.isEmpty else {
            if server == nil { UserDefaults.standard.removeObject(forKey: "rai.apiToken") }
            return
        }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
        if server == nil { UserDefaults.standard.removeObject(forKey: "rai.apiToken") }
    }

    private static func account(for server: String?) -> String {
        guard let server, !server.isEmpty else { return account }
        let digest = SHA256.hash(data: Data(server.utf8)).map { String(format: "%02x", $0) }.joined()
        return "api-token-\(digest.prefix(32))"
    }
}
