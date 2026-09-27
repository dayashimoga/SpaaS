import XCTest
@testable import SPaaSNode

final class SPaaSNodeTests: XCTestCase {
    func testWasmEngineInitializationAndExecution() {
        let engine = WasmEngine()
        let dummyWasm = Data([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
        let result = engine.execute(wasmBytes: dummyWasm)
        XCTAssertEqual(result.exitCode, 0)
    }

    func testKeychainIdentityGeneration() {
        let identity = KeychainIdentity()
        XCTAssertFalse(identity.publicKeyHex.isEmpty)
        XCTAssertEqual(identity.publicKeyHex.count, 64) // 32-byte Ed25519 hex
    }
}
