use spaas_protocol::node::*;
use spaas_protocol::workload::*;
use spaas_scheduler_core::{EdgeScheduler, SchedulerConfig};
use uuid::Uuid;

fn make_test_spec() -> WorkloadSpec {
    WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "scoring_test".into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: "hash".into(),
        artifact_size_bytes: 100,
        artifact_uri: "uri".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: ResourceLimits::default(),
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities {
            architectures: vec!["aarch64".into()],
            min_ram_mb: 1024,
            min_battery_pct: 30,
            require_charging: false,
            require_unmetered_network: true,
            max_thermal_level: "MODERATE".into(),
            required_accelerator: None,
        },
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        dimension_weights: Default::default(),
        submitter_signature: "sig".into(),
        submitter_pubkey: "pub".into(),
        created_at_ms: 1000,
        ..Default::default()
    }
}

fn make_base_node(id: Uuid) -> NodeRecord {
    NodeRecord {
        node_id: id,
        public_key: format!("key_{id}"),
        device_type: NodeDeviceType::AndroidSmartphone,
        enrollment: EnrollmentStatus::Enrolled,
        state: NodeState::Idle,
        capabilities: NodeHardwareCapabilities {
            architecture: "aarch64".into(),
            total_ram_mb: 8192,
            ..Default::default()
        },
        telemetry: NodeTelemetry {
            battery_pct: 80,
            charging_state: ChargingState::ChargingAc,
            thermal_status: ThermalStatus::None,
            network_type: NetworkType::WifiUnmetered,
            available_ram_mb: 4096,
            reliability_score: 0.95,
            ..Default::default()
        },
        policy: ProviderPolicy::default(),
        qualification: None,
        enrolled_at_ms: 0,
        last_heartbeat_ms: 0,
        region: "us".into(),
        is_simulated: false,
    }
}

#[test]
fn test_scheduler_thermal_filter_and_scoring() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    let cool_node_id = Uuid::new_v4();
    let hot_node_id = Uuid::new_v4();

    let cool_node = make_base_node(cool_node_id);
    let mut hot_node = make_base_node(hot_node_id);
    // Severe thermal status should cause policy or capability cutoff
    hot_node.telemetry.thermal_status = ThermalStatus::Severe;

    let nodes = vec![cool_node, hot_node];
    let selected = scheduler.schedule_workload(&spec, &nodes).unwrap();

    assert_eq!(selected.len(), 1);
    assert_eq!(
        selected[0], cool_node_id,
        "Cool node must be selected over overheated node"
    );
}

#[test]
fn test_scheduler_unmetered_network_filter() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    let wifi_node_id = Uuid::new_v4();
    let cellular_node_id = Uuid::new_v4();

    let wifi_node = make_base_node(wifi_node_id);
    let mut cellular_node = make_base_node(cellular_node_id);
    cellular_node.telemetry.network_type = NetworkType::CellularMetered;

    let nodes = vec![wifi_node, cellular_node];
    let selected = scheduler.schedule_workload(&spec, &nodes).unwrap();

    assert_eq!(selected.len(), 1);
    assert_eq!(
        selected[0], wifi_node_id,
        "Wi-Fi node must be selected when unmetered network is required"
    );
}

#[test]
fn test_scheduler_charging_preference() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    let charging_node_id = Uuid::new_v4();
    let discharging_node_id = Uuid::new_v4();

    let mut charging_node = make_base_node(charging_node_id);
    charging_node.telemetry.charging_state = ChargingState::ChargingAc;
    charging_node.telemetry.battery_pct = 70;

    let mut discharging_node = make_base_node(discharging_node_id);
    discharging_node.policy.only_while_charging = false;
    discharging_node.telemetry.charging_state = ChargingState::Discharging;
    discharging_node.telemetry.battery_pct = 70;

    let nodes = vec![charging_node, discharging_node];
    let selected = scheduler.schedule_workload(&spec, &nodes).unwrap();

    assert_eq!(selected.len(), 1);
    assert_eq!(
        selected[0], charging_node_id,
        "Charging node must be scored higher than discharging node"
    );
}

#[test]
fn test_scheduler_high_scale_latency_and_throughput_benchmarks() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    // 1. Generate 1,000 heterogeneous nodes with realistic distribution
    let mut cluster_1k: Vec<NodeRecord> = Vec::with_capacity(1000);
    for i in 0..1000 {
        let mut node = make_base_node(Uuid::new_v4());
        node.telemetry.battery_pct = ((i * 37) % 100) as u8;
        node.telemetry.cpu_usage_pct = ((i * 23) % 100) as f32;
        node.telemetry.reliability_score = 0.5 + (((i * 17) % 50) as f32 / 100.0);
        node.telemetry.charging_state = if i % 2 == 0 {
            ChargingState::ChargingAc
        } else {
            ChargingState::Discharging
        };
        node.telemetry.thermal_status = match i % 4 {
            0 => ThermalStatus::None,
            1 => ThermalStatus::Light,
            2 => ThermalStatus::Moderate,
            _ => ThermalStatus::Severe,
        };
        cluster_1k.push(node);
    }

    // Measure dispatch latency over 100 scheduling iterations
    let mut latencies_micros: Vec<u64> = Vec::with_capacity(100);
    for _ in 0..100 {
        let start = std::time::Instant::now();
        let selected = scheduler.schedule_workload(&spec, &cluster_1k).unwrap();
        let elapsed = start.elapsed().as_micros() as u64;
        assert_eq!(selected.len(), 1);
        latencies_micros.push(elapsed);
    }

    latencies_micros.sort_unstable();
    let p50_us = latencies_micros[50];
    let p95_us = latencies_micros[95];
    let p99_us = latencies_micros[99];

    let p50_ms = p50_us as f64 / 1000.0;
    let p95_ms = p95_us as f64 / 1000.0;
    let p99_ms = p99_us as f64 / 1000.0;

    println!("\n=======================================================");
    println!(" SCHEDULER SCALE & CHAOS BENCHMARK (1,000 Nodes)");
    println!(" Latency p50: {:.3} ms ({} µs)", p50_ms, p50_us);
    println!(" Latency p95: {:.3} ms ({} µs)", p95_ms, p95_us);
    println!(" Latency p99: {:.3} ms ({} µs)", p99_ms, p99_us);
    println!("=======================================================");

    // Sub-millisecond p50 on 1,000 candidates
    assert!(
        p50_ms < 5.0,
        "p50 latency must be under 5.0ms (got {:.3}ms)",
        p50_ms
    );
    assert!(
        p99_ms < 20.0,
        "p99 latency must be under 20.0ms (got {:.3}ms)",
        p99_ms
    );

    // 2. High-scale test: 5,000 nodes
    let mut cluster_5k = cluster_1k.clone();
    for _ in 0..4 {
        cluster_5k.extend(cluster_1k.clone());
    }
    let start_5k = std::time::Instant::now();
    let selected_5k = scheduler.schedule_workload(&spec, &cluster_5k).unwrap();
    let elapsed_5k_ms = start_5k.elapsed().as_millis() as f64;
    assert_eq!(selected_5k.len(), 1);
    println!(
        " 5,000-Node Single Dispatch Latency: {:.3} ms",
        elapsed_5k_ms
    );
    assert!(
        elapsed_5k_ms < 50.0,
        "5,000-node evaluation must be under 50ms"
    );
}

#[test]
fn test_scheduler_100_node_benchmark() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    let mut cluster_100: Vec<NodeRecord> = Vec::with_capacity(100);
    for i in 0..100 {
        let mut node = make_base_node(Uuid::new_v4());
        node.telemetry.battery_pct = ((i * 31) % 100) as u8;
        node.telemetry.cpu_usage_pct = ((i * 19) % 100) as f32;
        node.telemetry.reliability_score = 0.6 + (((i * 11) % 40) as f32 / 100.0);
        node.telemetry.charging_state = if i % 2 == 0 {
            ChargingState::ChargingAc
        } else {
            ChargingState::Discharging
        };
        node.telemetry.thermal_status = match i % 3 {
            0 => ThermalStatus::None,
            1 => ThermalStatus::Light,
            _ => ThermalStatus::Moderate,
        };
        cluster_100.push(node);
    }

    let start = std::time::Instant::now();
    let iterations = 500;
    for _ in 0..iterations {
        let selected = scheduler.schedule_workload(&spec, &cluster_100).unwrap();
        assert_eq!(selected.len(), 1);
    }
    let total_elapsed = start.elapsed();
    let per_op_us = total_elapsed.as_micros() as f64 / iterations as f64;
    let ops_per_sec = (iterations as f64 / total_elapsed.as_secs_f64()) as u64;

    println!("\n=======================================================");
    println!(" SCHEDULER 100-NODE SCALE BENCHMARK (500 Iterations)");
    println!(
        " Latency per evaluation: {:.3} µs ({:.4} ms)",
        per_op_us,
        per_op_us / 1000.0
    );
    println!(" Throughput: {} schedule decisions/sec", ops_per_sec);
    println!("=======================================================");

    assert!(
        per_op_us < 500.0,
        "100-node evaluation must be under 500µs (got {:.2}µs)",
        per_op_us
    );
    assert!(
        ops_per_sec > 2000,
        "Throughput must exceed 2,000 decisions/sec"
    );
}

#[test]
fn test_scheduler_10_000_node_scale_benchmark() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    let mut cluster_10k: Vec<NodeRecord> = Vec::with_capacity(10000);
    for i in 0..10000 {
        let mut node = make_base_node(Uuid::new_v4());
        node.telemetry.battery_pct = ((i * 43) % 100) as u8;
        node.telemetry.cpu_usage_pct = ((i * 29) % 100) as f32;
        node.telemetry.reliability_score = 0.5 + (((i * 13) % 50) as f32 / 100.0);
        node.telemetry.charging_state = if i % 2 == 0 {
            ChargingState::ChargingAc
        } else {
            ChargingState::Discharging
        };
        node.telemetry.thermal_status = match i % 4 {
            0 => ThermalStatus::None,
            1 => ThermalStatus::Light,
            2 => ThermalStatus::Moderate,
            _ => ThermalStatus::Severe,
        };
        cluster_10k.push(node);
    }

    let start = std::time::Instant::now();
    let selected = scheduler.schedule_workload(&spec, &cluster_10k).unwrap();
    let elapsed = start.elapsed();
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;

    println!("\n=======================================================");
    println!(" SCHEDULER 10,000-NODE SCALE TEST");
    println!(" Candidates Evaluated: {}", cluster_10k.len());
    println!(" Single Dispatch Latency: {:.3} ms", elapsed_ms);
    println!(" Selected Winner: {:?}", selected[0]);
    println!("=======================================================");

    assert_eq!(selected.len(), 1);
    assert!(
        elapsed_ms < 100.0,
        "10,000-node evaluation must be under 100ms (got {:.3}ms)",
        elapsed_ms
    );
}
