mod archetypes;
mod cluster;

use clap::Parser;
use cluster::SimulatorCluster;
use std::time::Duration;
use tracing::info;

#[derive(Parser, Debug)]
#[command(
    name = "spaas-node-simulator",
    author,
    version,
    about = "SPaaS Heterogeneous Node Simulation Lab"
)]
struct Args {
    #[arg(short, long, default_value = "http://127.0.0.1:8080")]
    control_plane_url: String,

    #[arg(short, long, default_value_t = 10)]
    nodes: usize,

    #[arg(short, long, default_value_t = 60)]
    duration_secs: u64,

    #[arg(short, long, default_value_t = 0.1)]
    adversarial_ratio: f64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    spaas_telemetry::init_telemetry("spaas-node-simulator");

    let args = Args::parse();
    info!("===========================================================");
    info!(" SPaaS Heterogeneous Node Simulation Lab");
    info!(" EVIDENCE LEVEL: SIMULATION-PROVEN (Always labelled)");
    info!(" Nodes to simulate:       {}", args.nodes);
    info!(" Control Plane URL:       {}", args.control_plane_url);
    info!(
        " Adversarial Node Ratio:  {:.1}%",
        args.adversarial_ratio * 100.0
    );
    if args.duration_secs == 0 {
        info!(" Simulation Run Duration: Indefinite (Continuous mode)");
    } else {
        info!(" Simulation Run Duration: {}s", args.duration_secs);
    }
    info!("===========================================================");

    let cluster = SimulatorCluster::new(args.control_plane_url, args.nodes, args.adversarial_ratio);

    let registered = cluster.register_all().await?;
    info!(
        "Registered {} / {} nodes successfully",
        registered, args.nodes
    );

    if registered > 0 {
        cluster
            .run_simulation_loop(Duration::from_secs(args.duration_secs))
            .await;
    } else {
        info!("No nodes registered (Control Plane may be offline). Exiting simulation test.");
    }

    info!("Simulation lab session finished.");
    Ok(())
}
