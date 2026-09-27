import Foundation
import CryptoKit
import Security

/// Cryptographic identity management for iOS edge compute node using Apple CryptoKit & Keychain
public final class KeychainIdentity {
    private static let keyTag = "dev.spaas.ios.node.signingKey"
    public let privateKey: Curve25519.Signing.PrivateKey
    public let publicKey: Curve25519.Signing.PublicKey

    public init() {
        if let existingKey = Self.loadKeyFromKeychain() {
            self.privateKey = existingKey
            self.publicKey = existingKey.publicKey
        } else {
            let newKey = Curve25519.Signing.PrivateKey()
            Self.saveKeyToKeychain(newKey)
            self.privateKey = newKey
            self.publicKey = newKey.publicKey
        }
    }

    public var publicKeyHex: String {
        return publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
    }

    public func sign(data: Data) -> String {
        guard let signature = try? privateKey.signature(for: data) else {
            return ""
        }
        return signature.map { String(format: "%02x", $0) }.joined()
    }

    private static func loadKeyFromKeychain() -> Curve25519.Signing.PrivateKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keyTag,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            return nil
        }

        return try? Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }

    private static func saveKeyToKeychain(_ key: Curve25519.Signing.PrivateKey) {
        let data = key.rawRepresentation
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keyTag,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }
}
