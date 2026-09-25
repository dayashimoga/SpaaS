use crate::error::RuntimeError;
use async_trait::async_trait;
use spaas_protocol::job::JobResult;
use spaas_protocol::workload::{RuntimeType, WorkloadSpec};
use spaas_security::keys::KeyPair;

/// Common execution context passed to all runtime implementations
pub struct ExecutionContext<'a> {
    pub spec: &'a WorkloadSpec,
    pub wasm_bytes: &'a [u8],
    pub node_id: uuid::Uuid,
    pub node_keypair: &'a KeyPair,
}

#[async_trait]
pub trait WorkloadRuntime: Send + Sync {
    /// Returns the type identifier of this runtime
    fn runtime_type(&self) -> RuntimeType;

    /// Validates if this runtime can execute the given workload spec
    fn validate_spec(&self, spec: &WorkloadSpec) -> Result<(), RuntimeError>;

    /// Executes the sandboxed workload deterministically and returns cryptographically signed JobResult
    async fn execute(&self, ctx: ExecutionContext<'_>) -> Result<JobResult, RuntimeError>;
}
