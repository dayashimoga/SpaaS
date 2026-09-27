use anyhow::Result;
use clap::{Parser, Subcommand};
use console::style;
use spaas_node_agent::qualification::NodeQualificationEngine;
use spaas_runtime::traits::{ExecutionContext, WorkloadRuntime};
use spaas_runtime::wasm_engine::WasmWasiRuntime;
use spaas_security::keys::KeyPair;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tabled::{Table, Tabled};
use tokio::time::sleep;
use tracing::{error, warn};

mod config;
mod enrollment;
mod identity;

use config::WorkerConfig;
use identity::WorkerIdentity;

#[derive(Parser, Debug)]
#[command(
    name = "spaas-desktop-worker",
    author = "SPaaS Universal Edge Compute Fabric",
    version = "0.2.0",
    about = "High-performance voluntary edge compute worker for Windows, Linux, and macOS"
)]
struct Cli {
    #[arg(short, long, help = "Path to custom configuration file")]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Enroll this computer into the SPaaS compute fabric using a pairing code
    Enroll {
        #[arg(short, long, help = "Single-use pairing code (e.g. SP-8492)")]
        code: String,

        #[arg(
            short,
            long,
            default_value = config::DEFAULT_ENDPOINT,
            help = "Control plane endpoint URL"
        )]
        endpoint: String,

        #[arg(short, long, help = "Friendly label for this compute node")]
        name: Option<String>,
    },

    /// Run hardware qualification microbenchmarks and display capability vector
    Benchmark,

    /// Show current node identity, enrollment status, and control plane endpoint
    Status,

    /// Start the worker agent daemon to execute distributed WASM jobs
    Run {
        #[arg(long, help = "Override control plane endpoint URL")]
        endpoint: Option<String>,

        #[arg(
            long,
            default_value_t = 0,
            help = "Max execution duration in seconds (0 = run indefinitely)"
        )]
        duration_secs: u64,
    },
}

#[derive(Tabled)]
struct BenchmarkRow {
    #[tabled(rename = "Capability Dimension")]
    dimension: String,
    #[tabled(rename = "Measured Score (0-100)")]
    score: String,
    #[tabled(rename = "Raw Measurement")]
    raw_metric: String,
}

#[derive(Tabled)]
struct StatusRow {
    #[tabled(rename = "Property")]
    key: String,
    #[tabled(rename = "Value")]
    val: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let config_path = cli.config.as_deref();

    match cli.command.unwrap_or(Commands::Run {
        endpoint: None,
        duration_secs: 0,
    }) {
        Commands::Enroll {
            code,
            endpoint,
            name,
        } => {
            handle_enroll(config_path, &code, &endpoint, name.as_deref()).await?;
        }
        Commands::Benchmark => {
            handle_benchmark().await?;
        }
        Commands::Status => {
            handle_status(config_path)?;
        }
        Commands::Run {
            endpoint,
            duration_secs,
        } => {
            handle_run(config_path, endpoint.as_deref(), duration_secs).await?;
        }
    }

    Ok(())
}

async fn handle_enroll(
    config_path: Option<&std::path::Path>,
    code: &str,
    endpoint: &str,
    name: Option<&str>,
) -> Result<()> {
    println!(
        "{}",
        style("=== SPaaS Universal Edge Compute — Node Enrollment ===")
            .cyan()
            .bold()
    );

    let mut cfg = WorkerConfig::load_or_default(config_path);
    let identity = WorkerIdentity::load_or_generate(None)?;

    let node_name = name.unwrap_or(&cfg.node_name);
    println!(
        "Enrolling node '{}' with endpoint '{}'...",
        style(node_name).green(),
        style(endpoint).yellow()
    );

    let (node_id, auth_token) = enrollment::enroll_node(
        endpoint,
        code,
        node_name,
        &identity.public_key_hex(),
        cfg.node_id.as_deref(),
    )
    .await?;

    cfg.node_id = Some(node_id.clone());
    cfg.auth_token = Some(auth_token);
    cfg.control_plane_url = endpoint.to_string();
    cfg.node_name = node_name.to_string();
    cfg.save(config_path)?;

    println!(
        "{} Node successfully enrolled with ID: {}",
        style("✓").green().bold(),
        style(&node_id).cyan().bold()
    );
    println!(
        "Configuration saved to: {:?}",
        WorkerConfig::default_config_path()
    );
    println!(
        "\nYou can now start computing jobs with: {}",
        style("spaas-desktop-worker run").yellow().bold()
    );

    Ok(())
}

async fn handle_benchmark() -> Result<()> {
    println!(
        "{}",
        style("=== SPaaS Node Hardware Qualification Benchmark ===")
            .cyan()
            .bold()
    );
    println!("Running empirical microbenchmarks on CPU, memory, and WASM runtime...\n");

    let runtime = WasmWasiRuntime::new();
    let keypair = KeyPair::generate();
    let node_id = uuid::Uuid::new_v4();

    match NodeQualificationEngine::run_qualification(&runtime, node_id, &keypair).await {
        Ok(qual) => {
            let rows = vec![
                BenchmarkRow {
                    dimension: "CPU Single-Thread & Integer".to_string(),
                    score: format!("{:.1}", qual.capability_vector.cpu),
                    raw_metric: format!(
                        "{:.0} ops/sec",
                        qual.raw_metrics.cpu_single_thread_score * 100_000.0
                    ),
                },
                BenchmarkRow {
                    dimension: "WASM Preview 1 Fuel".to_string(),
                    score: format!("{:.1}", qual.capability_vector.wasm),
                    raw_metric: format!("{:.1} MIPS", qual.raw_metrics.wasm_fuel_mips),
                },
                BenchmarkRow {
                    dimension: "Floating-Point Arithmetic".to_string(),
                    score: format!("{:.1}", qual.capability_vector.fp),
                    raw_metric: format!("{:.1} MFLOPS", qual.raw_metrics.cpu_fp_mflops),
                },
                BenchmarkRow {
                    dimension: "Memory Bandwidth".to_string(),
                    score: format!("{:.1}", qual.capability_vector.memory),
                    raw_metric: format!("{:.1} MB/s", qual.raw_metrics.memory_bandwidth_mb_s),
                },
                BenchmarkRow {
                    dimension: "Energy Efficiency".to_string(),
                    score: format!("{:.1}", qual.capability_vector.energy_efficiency),
                    raw_metric: "Desktop AC Headroom".to_string(),
                },
            ];

            println!("{}", Table::new(rows));
            println!(
                "\nAssigned Qualification Tier: {}",
                style(format!("{:?}", qual.tier)).green().bold()
            );
        }
        Err(e) => {
            println!("Benchmark error: {}", e);
        }
    }

    Ok(())
}

fn handle_status(config_path: Option<&std::path::Path>) -> Result<()> {
    let cfg = WorkerConfig::load_or_default(config_path);
    let identity = WorkerIdentity::load_or_generate(None)?;

    println!(
        "{}",
        style("=== SPaaS Desktop Worker Status ===").cyan().bold()
    );

    let rows = vec![
        StatusRow {
            key: "Node Name".to_string(),
            val: cfg.node_name,
        },
        StatusRow {
            key: "Node ID".to_string(),
            val: cfg.node_id.unwrap_or_else(|| "Not enrolled".to_string()),
        },
        StatusRow {
            key: "Control Plane".to_string(),
            val: cfg.control_plane_url,
        },
        StatusRow {
            key: "Auth Token".to_string(),
            val: if cfg.auth_token.is_some() {
                "Configured (Ed25519 Bearer)".to_string()
            } else {
                "Missing (Run 'spaas-desktop-worker enroll')".to_string()
            },
        },
        StatusRow {
            key: "Public Key".to_string(),
            val: identity.public_key_hex(),
        },
        StatusRow {
            key: "Config Path".to_string(),
            val: format!("{:?}", WorkerConfig::default_config_path()),
        },
    ];

    println!("{}", Table::new(rows));
    Ok(())
}

async fn handle_run(
    config_path: Option<&std::path::Path>,
    endpoint_override: Option<&str>,
    duration_secs: u64,
) -> Result<()> {
    let cfg = WorkerConfig::load_or_default(config_path);
    let identity = WorkerIdentity::load_or_generate(None)?;

    let node_id = match &cfg.node_id {
        Some(id) => id.clone(),
        None => {
            println!(
                "{}",
                style("Notice: This node is not yet enrolled with a control plane.")
                    .yellow()
                    .bold()
            );
            println!(
                "Run '{}' first or visit the Web Console to get a pairing code.",
                style("spaas-desktop-worker enroll --code <CODE>").cyan()
            );
            return Ok(());
        }
    };

    let auth_token = cfg.auth_token.unwrap_or_default();
    let endpoint = endpoint_override
        .unwrap_or(&cfg.control_plane_url)
        .trim_end_matches('/')
        .to_string();

    println!(
        "{}",
        style("=== SPaaS Desktop Edge Compute Worker Starting ===")
            .cyan()
            .bold()
    );
    println!("Node ID:       {}", style(&node_id).green());
    println!("Control Plane: {}", style(&endpoint).yellow());
    println!("Public Key:    {}", identity.public_key_hex());

    // 1. Initial Qualification Benchmark
    println!("\nQualifying node hardware capabilities...");
    let runtime = WasmWasiRuntime::new();
    let parsed_uuid = uuid::Uuid::parse_str(&node_id).unwrap_or_else(|_| uuid::Uuid::new_v4());
    if let Ok(qual) =
        NodeQualificationEngine::run_qualification(&runtime, parsed_uuid, &identity.keypair).await
    {
        println!(
            "Tier: {} (CPU: {:.1}, WASM: {:.1}, FP: {:.1})",
            style(format!("{:?}", qual.tier)).green().bold(),
            qual.capability_vector.cpu,
            qual.capability_vector.wasm,
            qual.capability_vector.fp
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;

    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();
    ctrlc_handler(r);

    let start_time = Instant::now();
    let mut jobs_executed = 0u64;
    let mut credits_earned = 0u64;

    println!("\nNode is online and actively polling for edge compute workloads...\n");

    let hb_interval = Duration::from_secs(cfg.heartbeat_interval_secs.max(3));
    let mut last_hb = Instant::now() - hb_interval;

    while running.load(Ordering::SeqCst) {
        if duration_secs > 0 && start_time.elapsed().as_secs() >= duration_secs {
            println!(
                "Target duration of {} seconds reached. Shutting down.",
                duration_secs
            );
            break;
        }

        // Heartbeat
        if last_hb.elapsed() >= hb_interval {
            let hb_url = format!("{}/api/v1/nodes/heartbeat", endpoint);
            let hb_payload = serde_json::json!({
                "node_id": node_id,
                "telemetry": {
                    "charging_state": "ChargingAc",
                    "battery_pct": 100,
                    "thermal_status": "None",
                    "network_type": "Ethernet",
                    "reliability_score": 1.0,
                    "round_trip_ping_ms": 15,
                    "cpu_usage_pct": 5.0
                }
            });

            let mut req = client.post(&hb_url).json(&hb_payload);
            if !auth_token.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", auth_token));
            }

            match req.send().await {
                Ok(res) if res.status().is_success() => {
                    last_hb = Instant::now();
                }
                Ok(res) => {
                    warn!("Heartbeat returned HTTP {}", res.status());
                }
                Err(err) => {
                    warn!("Heartbeat connection error: {}", err);
                }
            }
        }

        // Poll for assigned job
        let poll_url = format!("{}/api/v1/nodes/{}/poll", endpoint, node_id);
        let mut poll_req = client.get(&poll_url);
        if !auth_token.is_empty() {
            poll_req = poll_req.header("Authorization", format!("Bearer {}", auth_token));
        }

        match poll_req.send().await {
            Ok(res) if res.status().is_success() => {
                let body: serde_json::Value = res.json().await.unwrap_or_default();
                if let Some(job) = body.get("job") {
                    let job_id = job.get("job_id").and_then(|v| v.as_str()).unwrap_or("");
                    let workload_id = job
                        .get("workload_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("matrix_compute");
                    let fencing_token = job
                        .get("fencing_token")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if !job_id.is_empty() {
                        println!(
                            "{} Received job {}: workload='{}'",
                            style("⚡").yellow().bold(),
                            style(job_id).cyan(),
                            workload_id
                        );

                        // Execute WASM workload
                        let exec_res =
                            execute_wasm_workload(workload_id, parsed_uuid, &identity.keypair)
                                .await;
                        jobs_executed += 1;
                        credits_earned += 10;

                        // Submit execution result
                        let result_url = format!("{}/api/v1/nodes/results", endpoint);
                        let result_payload = serde_json::json!({
                            "job_id": job_id,
                            "node_id": node_id,
                            "fencing_token": fencing_token,
                            "exit_code": exec_res.0,
                            "stdout": exec_res.1,
                            "fuel_used": exec_res.2,
                            "duration_ms": exec_res.3
                        });

                        let mut res_req = client.post(&result_url).json(&result_payload);
                        if !auth_token.is_empty() {
                            res_req =
                                res_req.header("Authorization", format!("Bearer {}", auth_token));
                        }

                        match res_req.send().await {
                            Ok(r) if r.status().is_success() => {
                                println!(
                                    "{} Job {} verified & settled. Total earned: {} TEST CREDITS",
                                    style("✓").green().bold(),
                                    job_id,
                                    credits_earned
                                );
                            }
                            Ok(r) => {
                                warn!(
                                    "Result submission rejected (HTTP {}): {:?}",
                                    r.status(),
                                    r.text().await
                                );
                            }
                            Err(e) => {
                                error!("Failed to submit job result: {}", e);
                            }
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(_) => {}
        }

        sleep(Duration::from_millis(1500)).await;
    }

    println!(
        "\nWorker stopped. Completed {} jobs, earned {} credits.",
        jobs_executed, credits_earned
    );
    Ok(())
}

async fn execute_wasm_workload(
    workload_id: &str,
    node_id: uuid::Uuid,
    keypair: &KeyPair,
) -> (i32, String, u64, u64) {
    let runtime = WasmWasiRuntime::new();
    let wasm_bytes = match workload_id {
        "matrix_compute" => include_bytes!("../../../fixtures/matrix_compute.wasm").to_vec(),
        "sha256_hasher" => include_bytes!("../../../fixtures/sha256_hasher.wasm").to_vec(),
        "prime_sieve" => include_bytes!("../../../fixtures/prime_sieve.wasm").to_vec(),
        _ => include_bytes!("../../../fixtures/hello_wasi_clean.wasm").to_vec(),
    };

    let spec = spaas_protocol::workload::WorkloadSpec {
        workload_id: uuid::Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: workload_id.to_string(),
        runtime: spaas_protocol::workload::RuntimeType::WasmWasi,
        artifact_sha256: spaas_security::hash::sha256_hex(&wasm_bytes),
        artifact_size_bytes: wasm_bytes.len() as u64,
        artifact_uri: format!("catalog://{}", workload_id),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: spaas_protocol::workload::ResourceLimits::default(),
        network_policy: spaas_protocol::workload::NetworkPolicy::None,
        required_capabilities: spaas_protocol::workload::RequiredCapabilities::default(),
        dimension_weights: spaas_protocol::workload::WorkloadDimensionWeights::default(),
        retry_policy: spaas_protocol::workload::RetryPolicy::default(),
        verification_policy: spaas_protocol::workload::VerificationPolicy::SingleNode,
        priority: spaas_protocol::workload::WorkloadPriority::Normal,
        submitter_signature: "".into(),
        submitter_pubkey: "".into(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
        preferred_regions: vec![],
        deadline_ms: None,
        category: "compute".into(),
        max_cost_credits: Some(10),
        data_locality_hint: None,
    };

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes: &wasm_bytes,
        node_id,
        node_keypair: keypair,
    };

    match runtime.execute(ctx).await {
        Ok(res) => (
            res.exit_code,
            res.stdout,
            res.fuel_consumed,
            res.wall_time_ms,
        ),
        Err(err) => (1, format!("Runtime error: {}", err), 100_000, 10),
    }
}

fn ctrlc_handler(running: Arc<AtomicBool>) {
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            println!("\nShutdown signal received. Finishing active jobs...");
            running.store(false, Ordering::SeqCst);
        }
    });
}
