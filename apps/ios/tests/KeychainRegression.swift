import Foundation
import Security

// In-memory doubles ensure this executable never accesses real credentials or preferences.
final class UserDefaults {
    static let standard = UserDefaults()
    var plaintext: String? = "legacy-secret"
    func removeObject(forKey key: String) {
        precondition(key == "rai.apiToken")
        plaintext = nil
    }
}
enum ServerSession {
    static func canonicalURL(_ url: URL) -> URL { url }
}
var copyStatus = errSecSuccess
var copyValue: CFTypeRef? = Data("keychain-secret".utf8) as CFData
var lastAccount = ""
func SecItemCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    lastAccount = (query as NSDictionary)[kSecAttrAccount] as? String ?? ""
    result?.pointee = copyValue
    return copyStatus
}
func SecItemDelete(_ query: CFDictionary) -> OSStatus { errSecSuccess }
var addStatus = errSecSuccess
func SecItemAdd(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus { addStatus }

@main struct KeychainRegression {
    static func main() {
        for server: String? in [nil, "https://rai.example"] {
            copyStatus = errSecSuccess
            copyValue = Data("keychain-secret".utf8) as CFData
            UserDefaults.standard.plaintext = "legacy-secret"
            precondition(Keychain.loadToken(for: server) == "keychain-secret")
            precondition(UserDefaults.standard.plaintext == nil)
            precondition(server == nil ? lastAccount == "api-token" : lastAccount.hasPrefix("api-token-"))
            for status in [errSecItemNotFound, errSecInteractionNotAllowed, errSecAuthFailed] {
                copyStatus = status
                UserDefaults.standard.plaintext = "legacy-secret"
                precondition(Keychain.loadToken(for: server).isEmpty)
                precondition(UserDefaults.standard.plaintext == nil)
            }
            copyStatus = errSecSuccess
            copyValue = Data([0xff]) as CFData
            UserDefaults.standard.plaintext = "legacy-secret"
            precondition(Keychain.loadToken(for: server).isEmpty)
            precondition(UserDefaults.standard.plaintext == nil)

            // 写入失败必须能被调用方看见。`saveToken` 过去返回 `Void` 并丢弃
            // `SecItemAdd` 的 `OSStatus`，于是钥匙串被拒（钥匙串满 / 设备恢复中 /
            // 托管配置）时调用方一律当成"存上了"，用户下次启动才发现要重新输入，
            // 且没有任何日志能解释 —— 这正是本仓「失败态被映射到宽松分支」的 iOS 样本。
            addStatus = errSecSuccess
            precondition(Keychain.saveToken("fresh-token", for: server), "a successful add must report success")
            addStatus = errSecDuplicateItem
            precondition(!Keychain.saveToken("fresh-token", for: server), "a rejected add must not report success")
            // 清空 token 不需要落盘，所以即使 add 会失败也不算写入失败。
            addStatus = errSecDuplicateItem
            precondition(Keychain.saveToken("", for: server), "clearing the token is not a storage failure")
            addStatus = errSecSuccess
        }
        print("PASS: scoped and legacy Keychain reads clear plaintext and fail closed on missing, locked, denied or invalid credentials; a rejected write is reported to the caller instead of looking like success")
    }
}
