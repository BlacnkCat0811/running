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
func SecItemAdd(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus { errSecSuccess }

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
        }
        print("PASS: scoped and legacy Keychain reads clear plaintext and fail closed on missing, locked, denied or invalid credentials")
    }
}
