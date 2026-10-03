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
var deleteStatus = errSecSuccess
var addCalls = 0
func SecItemDelete(_ query: CFDictionary) -> OSStatus {
    if deleteStatus == errSecSuccess { copyValue = nil; copyStatus = errSecItemNotFound }
    return deleteStatus
}
var addStatus = errSecSuccess
func SecItemAdd(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    addCalls += 1
    return addStatus
}

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
            // 清空必须确实删除；不存在是成功，锁定或拒绝是失败。
            addStatus = errSecDuplicateItem
            precondition(Keychain.saveToken("", for: server), "clearing the token is not a storage failure")
            deleteStatus = errSecItemNotFound
            precondition(Keychain.saveToken("", for: server))
            for status in [errSecInteractionNotAllowed, errSecAuthFailed] {
                deleteStatus = status
                copyStatus = errSecSuccess
                copyValue = Data("old-secret".utf8) as CFData
                let before = addCalls
                precondition(!Keychain.saveToken("", for: server), "a rejected delete must not report success")
                precondition(Keychain.loadToken(for: server) == "old-secret", "failed deletion leaves the old credential persisted")
                precondition(!Keychain.saveToken("new-secret", for: server))
                precondition(addCalls == before, "failed deletion must not attempt a replacement add")
            }
            deleteStatus = errSecSuccess
            precondition(Keychain.saveToken("", for: server))
            precondition(Keychain.loadToken(for: server).isEmpty)
            addStatus = errSecSuccess
        }
        print("PASS: scoped and legacy Keychain reads clear plaintext and fail closed on missing, locked, denied or invalid credentials; a rejected write is reported to the caller instead of looking like success")
    }
}
