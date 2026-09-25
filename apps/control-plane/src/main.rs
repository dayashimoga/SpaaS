mod handlers;
mod reconciler;
mod router;
mod state;

use clap::Parser;
use reconciler::run_reconciler_loop;
use router::build_router;
use state::AppState;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "spaas-control-plane", author, version, about = "SPaaS Control Plane Orchestration Service")]
struct Args {
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    #[arg(short, long, default_value_t = 8080)]
    port: u16,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    spaas_telemetry::init_telemetry("spaas-control-plane");

    let args = Args::parse();
    let addr = format!("{}:{}", args.host, args.port);

    let state = AppState::new();

    // Spawn autonomous recovery reconciler loop
    let reconciler_state = state.clone();
    tokio::spawn(async move {
        run_reconciler_loop(reconciler_state).await;
    });

    let app = build_router(state);

    info!("SPaaS Control Plane listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
