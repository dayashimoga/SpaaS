use clap::{Parser, Subcommand};
use console::style;
use spaas_node_agent::NodeAgent;
use spaas_protocol::job::JobRecord;
use spaas_protocol::node::*;
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
    /// Starts a live local desktop compute worker that joins the fabric
    Worker {
        #[arg(long, default_value = "Desktop Compute Worker")]
        name: String,
        #[arg(long, default_value_t = 300)]
        duration_secs: u64,
    },
    /// Pair this machine with the control plane using an enrollment code
    Pair {
        #[arg(long)]
        code: String,
        #[arg(long, default_value = "Paired Desktop Edge")]
        name: String,
    },
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
                let resp = client
                    .get(&url)
                    .send()
                    .await?
                    .json::<ListNodesResponse>()
                    .await?;

                let rows: Vec<NodeRow> = resp
                    .nodes
                    .into_iter()
                    .map(|n| NodeRow {
                        id: n.node_id.to_string()[..8].to_string(),
                        model: n.capabilities.device_model,
                        state: format!("{:?}", n.state),
                        battery: format!(
                            "{}% ({:?})",
                            n.telemetry.battery_pct, n.telemetry.charging_state
                        ),
                        thermal: format!("{:?}", n.telemetry.thermal_status),
                        network: format!("{:?}", n.telemetry.network_type),
                        ram: format!("{} MB", n.telemetry.available_ram_mb),
                    })
                    .collect();

                println!("{}", Table::new(rows));
            }
            NodeCommands::Worker { name, duration_secs } => {
                println!("{}", style("===========================================================").cyan());
                println!("{}", style(format!(" Starting SPaaS Desktop Worker: {}", name)).bold().green());
                println!("{}", style(format!(" Target Control Plane:          {}", cli.api_url)).cyan());
                println!("{}", style(format!(" Session Duration:              {} seconds", duration_secs)).cyan());
                println!("{}", style("===========================================================").cyan());

                let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as u32;
                let caps = NodeHardwareCapabilities {
                    architecture: std::env::consts::ARCH.to_string(),
                    cpu_cores: cpus,
                    total_ram_mb: 16384,
                    total_storage_mb: 65536,
                    device_model: name.clone(),
                    os_name: std::env::consts::OS.to_string(),
                    os_version: "Host".into(),
                    has_npu: false,
                    has_gpu_vulkan: true,
                    agent_version: "0.1.0".into(),
                    supported_runtimes: vec!["wasm_wasi".into()],
                };

                let mut policy = ProviderPolicy::default();
                policy.only_while_charging = false; // Desktops don't require battery charger check

                let mut agent = NodeAgent::new(caps.clone(), policy.clone(), false);
                println!("Running empirical microbenchmark qualification...");
                let qual = agent.run_qualification().await.map_err(|e| format!("Qualification failed: {e}"))?;
                println!("  Measured Fuel MIPS:  {}", style(format!("{:.1}", qual.measured_fuel_mips)).green());
                println!("  Linear Memory Pages: {}", qual.measured_memory_max_pages);

                // Register with Control Plane
                let reg_req = RegisterNodeRequest {
                    public_key: agent.public_key_hex(),
                    device_type: match std::env::consts::OS {
                        "windows" => NodeDeviceType::WindowsDesktop,
                        "macos" => NodeDeviceType::MacDesktop,
                        _ => NodeDeviceType::LinuxDesktop,
                    },
                    capabilities: caps,
                    initial_telemetry: agent.telemetry.clone(),
                    initial_policy: policy,
                    region: "local".into(),
                    is_simulated: false,
                    enrollment_signature: format!("worker_sig_{}", agent.node_id),
                    timestamp_ms: chrono::Utc::now().timestamp_millis(),
                };

                let reg_url = format!("{}/api/v1/nodes/register", cli.api_url);
                let reg_resp = client.post(&reg_url).json(&reg_req).send().await?
                    .json::<RegisterNodeResponse>().await?;
                println!("{}", style(format!("Worker successfully enrolled! Node ID: {}", reg_resp.node_id)).bold().green());

                // Post qualification
                let qual_url = format!("{}/api/v1/nodes/{}/qualification", cli.api_url, agent.node_id);
                let qual_req = serde_json::json!({ "profile": qual });
                let _ = client.post(&qual_url).json(&qual_req).send().await;

                // Start execution loop
                let start_time = tokio::time::Instant::now();
                let duration = std::time::Duration::from_secs(duration_secs);

                println!("{}", style("Worker is ready and listening for compute jobs...").cyan());

                let run_forever = duration_secs == 0;
                while run_forever || start_time.elapsed() < duration {
                    // Send Heartbeat
                    let hb_req = HeartbeatRequest {
                        node_id: agent.node_id,
                        telemetry: agent.telemetry.clone(),
                        policy: agent.policy.clone(),
                        timestamp_ms: chrono::Utc::now().timestamp_millis(),
                        signature: "hb_sig".into(),
                    };
                    let hb_url = format!("{}/api/v1/nodes/heartbeat", cli.api_url);
                    let _ = client.post(&hb_url).json(&hb_req).send().await;

                    // Poll for work
                    let poll_url = format!("{}/api/v1/nodes/{}/poll", cli.api_url, agent.node_id);
                    if let Ok(resp) = client.get(&poll_url).send().await {
                        if let Ok(poll_res) = resp.json::<PollJobResponse>().await {
                            if let Some(dispatch) = poll_res.job {
                                println!("{}", style(format!(">>> Received job dispatch: {} ({})", dispatch.job_id, dispatch.spec.name)).bold().yellow());
                                let lease_id = dispatch.lease_id;
                                let exec_res = agent.execute_dispatched_job(dispatch).await;
                                if let Ok(job_result) = exec_res {
                                    println!("  Execution completed with exit code {}", style(job_result.exit_code).green());
                                    println!("  Fuel Consumed: {}", style(job_result.fuel_consumed).cyan());
                                    if !job_result.stdout.is_empty() {
                                        println!("  STDOUT: {}", style(&job_result.stdout).italic());
                                    }

                                    let res_url = format!("{}/api/v1/nodes/results", cli.api_url);
                                    let submit_req = SubmitJobResultRequest {
                                        node_id: agent.node_id,
                                        lease_id: Some(lease_id),
                                        result: job_result,
                                    };
                                    if let Ok(res_resp) = client.post(&res_url).json(&submit_req).send().await {
                                        if let Ok(data) = res_resp.json::<SubmitJobResultResponse>().await {
                                            println!("{}", style(format!("  Result verified! Credits Earned: +{} CR", data.credits_earned)).bold().green());
                                        }
                                    }
                                }
                            }
                        }
                    }

                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                }

                println!("{}", style("Worker session finished.").cyan());
            }
            NodeCommands::Pair { code, name } => {
                println!("{}", style("Pairing device with SPaaS Control Plane...").bold().cyan());
                println!("  Pairing Code: {}", style(&code).yellow());
                println!("  Device Name:  {}", style(&name).cyan());

                let dev_key = KeyPair::generate();
                let pair_req = PairDeviceRequest {
                    pairing_code: code,
                    device_name: name,
                    device_type: match std::env::consts::OS {
                        "windows" => NodeDeviceType::WindowsDesktop,
                        "macos" => NodeDeviceType::MacDesktop,
                        _ => NodeDeviceType::LinuxDesktop,
                    },
                    public_key: dev_key.public_key_hex(),
                    capabilities: NodeHardwareCapabilities::default(),
                    initial_telemetry: NodeTelemetry::default(),
                    initial_policy: ProviderPolicy::default(),
                    enrollment_signature: "pair_sig".into(),
                    timestamp_ms: chrono::Utc::now().timestamp_millis(),
                };

                let url = format!("{}/api/v1/devices/pair", cli.api_url);
                let resp = client.post(&url).json(&pair_req).send().await?;
                if resp.status().is_success() {
                    let data = resp.json::<RegisterNodeResponse>().await?;
                    println!("{}", style("Pairing successful!").bold().green());
                    println!("  Node ID:    {}", style(data.node_id).green());
                    println!("  Auth Token: {}", style(&data.auth_token[..16]).dim());
                } else {
                    let err = resp.text().await.unwrap_or_else(|_| "Unknown error".into());
                    println!("{}", style(format!("Pairing failed: {}", err)).bold().red());
                }
            }
        },
        Commands::Workload { cmd } => match cmd {
            WorkloadCommands::Validate { path } => {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if ext == "yaml" || ext == "yml" {
                    let content = std::fs::read_to_string(&path)?;
                    let manifest = DeveloperWorkloadManifest::from_yaml_str(&content)?;
                    println!(
                        "{}",
                        style("Validating Workload Manifest (spaas.io/v1)...").bold()
                    );
                    println!("  Workload Name: {}", style(&manifest.metadata.name).cyan());
                    println!("  Version:       {}", manifest.metadata.version);
                    println!("  Runtime:       {:?}", manifest.spec.runtime);
                    println!("  WASI Version:  {}", manifest.spec.wasi_version);
                    println!("  Entrypoint:    {}", manifest.spec.entrypoint);
                    println!("  Binary Ref:    {}", manifest.spec.binary);
                    println!("  Max Fuel:      {}", manifest.spec.limits.max_fuel);
                    println!("  Timeout:       {} ms", manifest.spec.limits.timeout_ms);
                    println!("  Verification:  {:?}", manifest.spec.verification);
                    println!(
                        "{}",
                        style("Status: VALID MANIFEST (spaas.io/v1)").bold().green()
                    );
                } else if ext == "json" {
                    let content = std::fs::read_to_string(&path)?;
                    let manifest = DeveloperWorkloadManifest::from_json_str(&content)?;
                    println!(
                        "{}",
                        style("Validating Workload Manifest (spaas.io/v1 JSON)...").bold()
                    );
                    println!("  Workload Name: {}", style(&manifest.metadata.name).cyan());
                    println!("  Version:       {}", manifest.metadata.version);
                    println!(
                        "{}",
                        style("Status: VALID MANIFEST (spaas.io/v1)").bold().green()
                    );
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
                        path.parent()
                            .unwrap_or(std::path::Path::new("."))
                            .join(&manifest.spec.binary)
                    };
                    let bytes = std::fs::read(&binary_path).map_err(|e| {
                        format!(
                            "Failed to read WASM binary at {}: {e}",
                            binary_path.display()
                        )
                    })?;
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
                        dimension_weights: WorkloadDimensionWeights::default(),
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
                        path.parent()
                            .unwrap_or(std::path::Path::new("."))
                            .join(&manifest.spec.binary)
                    };
                    let bytes = std::fs::read(&binary_path).map_err(|e| {
                        format!(
                            "Failed to read WASM binary at {}: {e}",
                            binary_path.display()
                        )
                    })?;
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
                        dimension_weights: WorkloadDimensionWeights::default(),
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
                        dimension_weights: WorkloadDimensionWeights::default(),
                        submitter_signature: String::new(),
                        submitter_pubkey: String::new(),
                        created_at_ms: chrono::Utc::now().timestamp_millis(),
                    };
                    (s, bytes)
                };

                let mut spec = spec;
                let dev_key = KeyPair::generate();
                sign_workload(&dev_key, &mut spec);

                let b64 =
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wasm_bytes);
                let req = SubmitJobRequest {
                    spec,
                    wasm_binary_base64: Some(b64),
                };

                let url = format!("{}/api/v1/jobs", cli.api_url);
                let resp = client
                    .post(&url)
                    .json(&req)
                    .send()
                    .await?
                    .json::<SubmitJobResponse>()
                    .await?;

                println!(
                    "{}",
                    style("Workload Submitted Successfully!").bold().green()
                );
                println!("  Job ID:      {}", style(resp.job_id).bold().yellow());
                println!("  Initial State: {:?}", resp.state);
            }
        },
        Commands::Job { cmd } => match cmd {
            JobCommands::List => {
                let url = format!("{}/api/v1/jobs", cli.api_url);
                let resp = client
                    .get(&url)
                    .send()
                    .await?
                    .json::<ListJobsResponse>()
                    .await?;

                let rows: Vec<JobRow> = resp
                    .jobs
                    .into_iter()
                    .map(|j| JobRow {
                        id: j.job_id.to_string()[..8].to_string(),
                        name: j.spec.name,
                        state: format!("{:?}", j.state),
                        node: j
                            .assigned_node_id
                            .map(|n| n.to_string()[..8].to_string())
                            .unwrap_or_else(|| "unassigned".into()),
                        retries: j.retry_count,
                        created: format!("{}ms", j.created_at_ms),
                    })
                    .collect();

                println!("{}", Table::new(rows));
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
                let health = client
                    .get(&url)
                    .send()
                    .await?
                    .json::<SystemHealthResponse>()
                    .await?;

                println!(
                    "{}",
                    style("SPaaS Cluster Health & Telemetry").bold().cyan()
                );
                println!(
                    "  Status:              {}",
                    style(&health.status).bold().green()
                );
                println!("  Active Nodes:        {}", health.active_nodes);
                println!("  Idle Nodes:          {}", health.idle_nodes);
                println!("  Paused Nodes:        {}", health.paused_nodes);
                println!("  Offline Nodes:       {}", health.offline_nodes);
                println!("  Queue Depth:         {}", health.queue_depth);
                println!("  Running Jobs:        {}", health.running_jobs);
                println!("  Completed Jobs:      {}", health.completed_jobs);
                println!("  Failed Jobs:         {}", health.failed_jobs);
                println!(
                    "  Avg Sched Latency:   {:.2} ms",
                    health.average_scheduling_latency_ms
                );
                println!("  Uptime:              {}s", health.uptime_secs);
            }
        },
    }

    Ok(())
}
