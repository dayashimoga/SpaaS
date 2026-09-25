use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrelationContext {
    pub trace_id: Uuid,
    pub request_id: Uuid,
}

impl CorrelationContext {
    pub fn new() -> Self {
        Self {
            trace_id: Uuid::new_v4(),
            request_id: Uuid::new_v4(),
        }
    }

    pub fn with_trace_id(trace_id: Uuid) -> Self {
        Self {
            trace_id,
            request_id: Uuid::new_v4(),
        }
    }
}

impl Default for CorrelationContext {
    fn default() -> Self {
        Self::new()
    }
}
