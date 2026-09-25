pub mod metrics;
pub mod trace;

pub use metrics::MetricsRegistry;
pub use trace::CorrelationContext;

/// Initializes tracing subscriber with JSON format or env filter
pub fn init_telemetry(service_name: &str) {
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,spaas=debug"));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(true))
        .try_init();

    tracing::info!(service = service_name, "Telemetry subsystem initialized");
}
