use clap::Parser;
use spaas_scheduler_core::{EdgeScheduler, SchedulerConfig};
use std::time::Duration;
use tracing::info;

#[derive(Parser, Debug)]
#[command(
    name = "spaas-scheduler-daemon",
    author,
    version,
    about = "SPaaS Distributed Scheduler Daemon"
)]
struct Args {
    #[arg(short, long, default_value = "http://127.0.0.1:8080")]
    control_plane_url: String,

    #[arg(short, long, default_value_t = 1000)]
    poll_interval_ms: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    spaas_telemetry::init_telemetry("spaas-scheduler-daemon");
    let args = Args::parse();

    info!("Starting SPaaS Scheduler Daemon...");
    info!("Target Control Plane: {}", args.control_plane_url);

    let _scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let client = reqwest::Client::new();
    let mut interval = tokio::time::interval(Duration::from_millis(args.poll_interval_ms));

    loop {
        interval.tick().await;

        let health_url = format!("{}/api/v1/system/health", args.control_plane_url);
        if let Ok(resp) = client.get(&health_url).send().await {
            if let Ok(health) = resp
                .json::<spaas_protocol::rpc::SystemHealthResponse>()
                .await
            {
                if health.queue_depth > 0 {
                    info!(
                        queue_depth = health.queue_depth,
                        active_nodes = health.active_nodes,
                        "Scheduler inspecting cluster queue state"
                    );
                }
            }
        }
    }
}
