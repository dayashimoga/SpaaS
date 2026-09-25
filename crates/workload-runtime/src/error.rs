use thiserror::Error;

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    #[error("WebAssembly fuel exhaustion: workload exceeded maximum fuel of {fuel_limit} units")]
    OutOfFuel { fuel_limit: u64 },

    #[error("Execution timed out after {timeout_ms} ms")]
    Timeout { timeout_ms: u64 },

    #[error(
        "Memory limit exceeded: requested {requested_bytes} bytes, limit is {max_bytes} bytes"
    )]
    MemoryLimitExceeded {
        requested_bytes: u64,
        max_bytes: u64,
    },

    #[error("Output buffer limit exceeded: stdout/stderr exceeded {max_bytes} bytes quota")]
    OutputBufferExceeded { max_bytes: usize },

    #[error("Artifact verification failed: {0}")]
    ArtifactVerificationFailed(String),

    #[error("Module compilation / instantiation error: {0}")]
    CompilationFailed(String),

    #[error("WebAssembly trap occurred during execution: {0}")]
    Trap(String),

    #[error("Entrypoint function '{0}' not found or invalid signature")]
    EntrypointNotFound(String),

    #[error("Syscall access denied by sandbox policy: {0}")]
    SyscallDenied(String),

    #[error("Runtime internal error: {0}")]
    Internal(String),
}
