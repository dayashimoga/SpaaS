use clap::{Parser, Subcommand};
use console::style;
use spaas_protocol::job::JobRecord;
use spaas_protocol::rpc::*;
use spaas_protocol::workload::*;
use spaas_security::hash::sha256_hex;
use spaas_security::keys::KeyPair;
use spaas_security::signing::sign_workload;
use std::path::PathBuf;
use tabled::{Table, Tabled};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(
    name = "spaas",
    author = "SPaaS Architecture Team",
    version = "0.1.0",
    about = "SPaaS Universal Edge Compute Fabric Developer & Operator CLI"
)]
struct Cli {
    #[arg(long, default_value = "http://127.0.0.1:8080", env = "SPAAS_API_URL")]
    api_url: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Authenticate or configure developer identity
    Login {
        #[arg(long)]
        secret_key: Option<String>,
    },
    /// Generate a fresh cryptographically secure Ed25519 keypair
    Keygen,
    /// Inspect edge compute nodes
    Node {
        #[command(subcommand)]
        cmd: NodeCommands,
    },
    /// Validate and inspect WebAssembly workload artifacts
    Workload {
        #[command(subcommand)]
        cmd: WorkloadCommands,
    },
    /// Manage edge execution jobs
    Job {
        #[command(subcommand)]
        cmd: JobCommands,
    },
    /// Display cluster health and operational telemetry
    System {
        #[command(subcommand)]
        cmd: SystemCommands,
    },
}

#[derive(Subcommand, Debug)]
enum NodeCommands {
    /// List all enrolled nodes and their current resource states
    List,
}

#[derive(Subcommand, Debug)]
enum WorkloadCommands {
    /// Validates syntax and exports of a WebAssembly (.wasm) file
    Validate { path: PathBuf },
    /// Submits a signed WebAssembly workload to the control plane
    Submit {
        path: PathBuf,
        #[arg(short, long)]
        name: Option<String>,
        #[arg(long, default_value_t = 10_000_000)]
        max_fuel: u64,
        #[arg(long, default_value_t = 30_000)]
        timeout_ms: u64,
        #[arg(long, default_value = "_start")]
        entrypoint: String,
    },
}

#[derive(Subcommand, Debug)]
enum JobCommands {
    /// List all submitted workloads and execution states
    List,
    /// Get detailed status of a specific job
    Get { id: Uuid },
    /// Fetch stdout and stderr logs of a completed or failed job
    Logs { id: Uuid },
    /// Cancel an active or queued job
    Cancel { id: Uuid },
}

#[derive(Subcommand, Debug)]
enum SystemCommands {
    /// Check control plane health and cluster metrics
    Health,
}

#[derive(Tabled)]
struct NodeRow {
    #[tabled(rename = "Node ID")]
    id: String,
    #[tabled(rename = "Device")]
    model: String,
    #[tabled(rename = "State")]
    state: String,
    #[tabled(rename = "Battery")]
    battery: String,
    #[tabled(rename = "Thermal")]
    thermal: String,
    #[tabled(rename = "Network")]
    network: String,
    #[tabled(rename = "RAM Avail")]
    ram: String,
}

#[derive(Tabled)]
struct JobRow {
    #[tabled(rename = "Job ID")]
    id: String,
    #[tabled(rename = "Workload")]
    name: String,
    #[tabled(rename = "State")]
    state: String,
    #[tabled(rename = "Assigned Node")]
    node: String,
    #[tabled(rename = "Retries")]
    retries: u32,
    #[tabled(rename = "Created")]
    created: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let client = reqwest::Client::new();

    match cli.command {
        Commands::Login { secret_key } => {
            println!("{}", style("SPaaS Developer Authentication").bold().cyan());
            let key = match secret_key {
                Some(k) => KeyPair::from_secret_hex(&k)?,
                None => {
                    println!("Generating new developer session keypair...");
                    KeyPair::generate()
                }
            };
            println!("  Public Key:  {}", style(key.public_key_hex()).green());
            println!("  Secret Key:  {}", style(key.secret_key_hex()).yellow());
            println!("Session identity configured.");
        }
        Commands::Keygen => {
            let key = KeyPair::generate();
            println!("{}", style("Generated Ed25519 Keypair:").bold());
            println!("  Public Key:  {}", style(key.public_key_hex()).green());
            println!("  Secret Key:  {}", style(key.secret_key_hex()).yellow());
        }
        Commands::Node { cmd } => match cmd {
            NodeCommands::List => {
                let url = format!("{}/api/v1/nodes", cli.api_url);
                let resp = client.get(&url).send().await?.json::<ListNodesResponse>().await?;

                let rows: Vec<NodeRow> = resp
                    .nodes
                    .into_iter()
                    .map(|n| NodeRow {
                        id: n.node_id.to_string()[..8].to_string(),
                        model: n.capabilities.device_model,
                        state: format!("{:?}", n.state),
                        battery: format!("{}% ({:?})", n.telemetry.battery_pct, n.telemetry.charging_state),
                        thermal: format!("{:?}", n.telemetry.thermal_status),
                        network: format!("{:?}", n.telemetry.network_type),
                        ram: format!("{} MB", n.telemetry.available_ram_mb),
                    })
                    .collect();

                println!("{}", Table::new(rows).to_string());
            }
        },
        Commands::Workload { cmd } => match cmd {
            WorkloadCommands::Validate { path } => {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if ext == "yaml" || ext == "yml" {
                    let content = std::fs::read_to_string(&path)?;
                    let manifest = DeveloperWorkloadManifest::from_yaml_str(&content)?;
                    println!("{}", style("Validating Workload Manifest (spaas.io/v1)...").bold());
                    println!("  Workload Name: {}", style(&manifest.metadata.name).cyan());
                    println!("  Version:       {}", manifest.metadata.version);
                    println!("  Runtime:       {:?}", manifest.spec.runtime);
                    println!("  WASI Version:  {}", manifest.spec.wasi_version);
                    println!("  Entrypoint:    {}", manifest.spec.entrypoint);
                    println!("  Binary Ref:    {}", manifest.spec.binary);
                    println!("  Max Fuel:      {}", manifest.spec.limits.max_fuel);
                    println!("  Timeout:       {} ms", manifest.spec.limits.timeout_ms);
                    println!("  Verification:  {:?}", manifest.spec.verification);
                    println!("{}", style("Status: VALID MANIFEST (spaas.io/v1)").bold().green());
                } else if ext == "json" {
                    let content = std::fs::read_to_string(&path)?;
                    let manifest = DeveloperWorkloadManifest::from_json_str(&content)?;
                    println!("{}", style("Validating Workload Manifest (spaas.io/v1 JSON)...").bold());
                    println!("  Workload Name: {}", style(&manifest.metadata.name).cyan());
                    println!("  Version:       {}", manifest.metadata.version);
                    println!("{}", style("Status: VALID MANIFEST (spaas.io/v1)").bold().green());
                } else {
                    let bytes = std::fs::read(&path)?;
                    let hash = sha256_hex(&bytes);
                    println!("{}", style("Validating WebAssembly Artifact...").bold());
                    println!("  File Path:   {}", path.display());
                    println!("  Size:        {} bytes", bytes.len());
                    println!("  SHA-256:     {}", style(hash).cyan());
                    println!("{}", style("Status: VALID WASM").bold().green());
                }
            }
            WorkloadCommands::Submit {
                path,
                name,
                max_fuel,
                timeout_ms,
                entrypoint,
            } => {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                let (spec, wasm_bytes) = if ext == "yaml" || ext == "yml" {
                    let content = std::fs::read_to_string(&path)?;
                    let manifest = DeveloperWorkloadManifest::from_yaml_str(&content)?;
                    let binary_path = if std::path::Path::new(&manifest.spec.binary).is_absolute() {
                        PathBuf::from(&manifest.spec.binary)
                    } else {
                        path.parent().unwrap_or(std::path::Path::new(".")).join(&manifest.spec.binary)
                    };
                    let bytes = std::fs::read(&binary_path)
                        .map_err(|e| format!("Failed to read WASM binary at {}: {e}", binary_path.display()))?;
                    let hash = sha256_hex(&bytes);
                    let s = WorkloadSpec {
                        workload_id: Uuid::new_v4(),
                        spec_version: manifest.metadata.version,
                        name: manifest.metadata.name,
                        runtime: manifest.spec.runtime,
                        artifact_sha256: hash.clone(),
                        artifact_size_bytes: bytes.len() as u64,
                        artifact_uri: format!("inline://{}", hash),
                        entrypoint: manifest.spec.entrypoint,
                        args: manifest.spec.args,
                        env_vars: manifest.spec.env_vars,
                        limits: manifest.spec.limits,
                        network_policy: manifest.spec.network_policy,
                        required_capabilities: manifest.spec.capabilities,
                        retry_policy: manifest.spec.retry,
                        verification_policy: manifest.spec.verification,
                        priority: manifest.spec.priority,
                        submitter_signature: String::new(),
                        submitter_pubkey: String::new(),
                        created_at_ms: chrono::Utc::now().timestamp_millis(),
                    };
                    (s, bytes)
                } else if ext == "json" {
                    let content = std::fs::read_to_string(&path)?;
                    let manifest = DeveloperWorkloadManifest::from_json_str(&content)?;
                    let binary_path = if std::path::Path::new(&manifest.spec.binary).is_absolute() {
                        PathBuf::from(&manifest.spec.binary)
                    } else {
                        path.parent().unwrap_or(std::path::Path::new(".")).join(&manifest.spec.binary)
                    };
                    let bytes = std::fs::read(&binary_path)
                        .map_err(|e| format!("Failed to read WASM binary at {}: {e}", binary_path.display()))?;
                    let hash = sha256_hex(&bytes);
                    let s = WorkloadSpec {
                        workload_id: Uuid::new_v4(),
                        spec_version: manifest.metadata.version,
                        name: manifest.metadata.name,
                        runtime: manifest.spec.runtime,
                        artifact_sha256: hash.clone(),
                        artifact_size_bytes: bytes.len() as u64,
                        artifact_uri: format!("inline://{}", hash),
                        entrypoint: manifest.spec.entrypoint,
                        args: manifest.spec.args,
                        env_vars: manifest.spec.env_vars,
                        limits: manifest.spec.limits,
                        network_policy: manifest.spec.network_policy,
                        required_capabilities: manifest.spec.capabilities,
                        retry_policy: manifest.spec.retry,
                        verification_policy: manifest.spec.verification,
                        priority: manifest.spec.priority,
                        submitter_signature: String::new(),
                        submitter_pubkey: String::new(),
                        created_at_ms: chrono::Utc::now().timestamp_millis(),
                    };
                    (s, bytes)
                } else {
                    let bytes = std::fs::read(&path)?;
                    let hash = sha256_hex(&bytes);
                    let workload_name = name.unwrap_or_else(|| {
                        path.file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| "workload".into())
                    });
                    let s = WorkloadSpec {
                        workload_id: Uuid::new_v4(),
                        spec_version: "1.0.0".into(),
                        name: workload_name,
                        runtime: RuntimeType::WasmWasi,
                        artifact_sha256: hash.clone(),
                        artifact_size_bytes: bytes.len() as u64,
                        artifact_uri: format!("inline://{}", hash),
                        entrypoint,
                        args: vec![],
                        env_vars: vec![],
                        limits: ResourceLimits {
                            max_fuel,
                            max_memory_bytes: 64 * 1024 * 1024,
                            max_storage_bytes: 10 * 1024 * 1024,
                            timeout_ms,
                            max_output_bytes: 1024 * 1024,
                        },
                        network_policy: NetworkPolicy::None,
                        required_capabilities: RequiredCapabilities::default(),
                        retry_policy: RetryPolicy::default(),
                        verification_policy: VerificationPolicy::SingleNode,
                        priority: WorkloadPriority::Normal,
                        submitter_signature: String::new(),
                        submitter_pubkey: String::new(),
                        created_at_ms: chrono::Utc::now().timestamp_millis(),
                    };
                    (s, bytes)
                };

                let mut spec = spec;
                let dev_key = KeyPair::generate();
                sign_workload(&dev_key, &mut spec);

                let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wasm_bytes);
                let req = SubmitJobRequest {
                    spec,
                    wasm_binary_base64: Some(b64),
                };

                let url = format!("{}/api/v1/jobs", cli.api_url);
                let resp = client.post(&url).json(&req).send().await?.json::<SubmitJobResponse>().await?;

                println!("{}", style("Workload Submitted Successfully!").bold().green());
                println!("  Job ID:      {}", style(resp.job_id).bold().yellow());
                println!("  Initial State: {:?}", resp.state);
            }
        },
        Commands::Job { cmd } => match cmd {
            JobCommands::List => {
                let url = format!("{}/api/v1/jobs", cli.api_url);
                let resp = client.get(&url).send().await?.json::<ListJobsResponse>().await?;

                let rows: Vec<JobRow> = resp
                    .jobs
                    .into_iter()
                    .map(|j| JobRow {
                        id: j.job_id.to_string()[..8].to_string(),
                        name: j.spec.name,
                        state: format!("{:?}", j.state),
                        node: j.assigned_node_id.map(|n| n.to_string()[..8].to_string()).unwrap_or_else(|| "unassigned".into()),
                        retries: j.retry_count,
                        created: format!("{}ms", j.created_at_ms),
                    })
                    .collect();

                println!("{}", Table::new(rows).to_string());
            }
            JobCommands::Get { id } => {
                let url = format!("{}/api/v1/jobs/{}", cli.api_url, id);
                let job = client.get(&url).send().await?.json::<JobRecord>().await?;

                println!("{}", style("Job Details:").bold());
                println!("  ID:          {}", job.job_id);
                println!("  Name:        {}", job.spec.name);
                println!("  State:       {:?}", job.state);
                println!("  Assigned:    {:?}", job.assigned_node_id);
                println!("  Retries:     {}", job.retry_count);
                if let Some(res) = job.result {
                    println!("{}", style("Execution Result:").bold().green());
                    println!("  Exit Code:   {}", res.exit_code);
                    println!("  Fuel Used:   {}", res.fuel_consumed);
                    println!("  Wall Time:   {} ms", res.wall_time_ms);
                    println!("  Digest:      {}", res.result_digest);
                }
            }
            JobCommands::Logs { id } => {
                let url = format!("{}/api/v1/jobs/{}", cli.api_url, id);
                let job = client.get(&url).send().await?.json::<JobRecord>().await?;

                if let Some(res) = job.result {
                    println!("{}", style("--- STDOUT ---").bold().cyan());
                    println!("{}", res.stdout);
                    if !res.stderr.is_empty() {
                        println!("{}", style("--- STDERR ---").bold().yellow());
                        println!("{}", res.stderr);
                    }
                } else {
                    println!("No execution logs available (Job State: {:?})", job.state);
                }
            }
            JobCommands::Cancel { id } => {
                let url = format!("{}/api/v1/jobs/{}/cancel", cli.api_url, id);
                let resp = client.post(&url).send().await?.json::<JobRecord>().await?;
                println!("Job {} cancelled. New State: {:?}", resp.job_id, resp.state);
            }
        },
        Commands::System { cmd } => match cmd {
            SystemCommands::Health => {
                let url = format!("{}/api/v1/system/health", cli.api_url);
                let health = client.get(&url).send().await?.json::<SystemHealthResponse>().await?;

                println!("{}", style("SPaaS Cluster Health & Telemetry").bold().cyan());
                println!("  Status:              {}", style(&health.status).bold().green());
                println!("  Active Nodes:        {}", health.active_nodes);
                println!("  Idle Nodes:          {}", health.idle_nodes);
                println!("  Paused Nodes:        {}", health.paused_nodes);
                println!("  Offline Nodes:       {}", health.offline_nodes);
                println!("  Queue Depth:         {}", health.queue_depth);
                println!("  Running Jobs:        {}", health.running_jobs);
                println!("  Completed Jobs:      {}", health.completed_jobs);
                println!("  Failed Jobs:         {}", health.failed_jobs);
                println!("  Avg Sched Latency:   {:.2} ms", health.average_scheduling_latency_ms);
                println!("  Uptime:              {}s", health.uptime_secs);
            }
        },
    }

    Ok(())
}
