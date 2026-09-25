// SPaaS Integration Test Suite
pub fn make_test_wat_bytes(wat: &str) -> Vec<u8> {
    wat::parse_str(wat).expect("failed to compile WAT to WASM bytes")
}
