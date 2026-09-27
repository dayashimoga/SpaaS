//! SPaaS Cross-Platform Benchmark Specification
//!
//! Provides canonical data structures, standard benchmark algorithm contracts,
//! deterministic qualification scoring formulas, and serialization schemas
//! shared across Rust desktop workers, Android Kotlin nodes, and iOS Swift companion nodes.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Version of the benchmark specification protocol
pub const BENCHMARK_SPEC_VERSION: &str = "1.0.0";

/// Canonical qualification tiers for voluntary compute workers
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum QualificationTier {
    /// Tier 0: Minimal compute capability (light telemetry, simple verifications, battery constrained)
    #[default]
    Tier0,
    /// Tier 1: Standard edge compute (single-threaded WASM jobs, low memory footprint)
    Tier1,
    /// Tier 2: Enhanced edge worker (multi-threaded compute, standard matrix/cryptography jobs)
    Tier2,
    /// Tier 3: High-performance workstation / server / flagship mobile edge worker
    Tier3,
}

/// Raw empirical metrics captured during qualification benchmark execution
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawBenchmarkMetrics {
    /// Single-threaded integer operations per second
    pub cpu_int_ops_per_sec: f64,
    /// Floating point operations per second (in MFLOPS)
    pub cpu_fp_mflops: f64,
    /// WASM instruction execution throughput (in Million Instructions Per Second / fuel MIPS)
    pub wasm_fuel_mips: f64,
    /// Sequential memory read/write throughput in MB/s
    pub memory_bandwidth_mb_s: f64,
    /// Multi-core scaling efficiency factor (e.g. 1.8x on 2 cores, 3.4x on 4 cores)
    #[serde(default = "default_scaling_factor")]
    pub multithread_scaling_factor: f64,
    /// Thermal stability ratio: sustained throughput / peak initial throughput (0.0 to 1.0)
    #[serde(default = "default_thermal_ratio")]
    pub thermal_throttling_ratio: f32,
}

fn default_scaling_factor() -> f64 {
    1.0
}

fn default_thermal_ratio() -> f32 {
    1.0
}

impl Default for RawBenchmarkMetrics {
    fn default() -> Self {
        Self {
            cpu_int_ops_per_sec: 10_000_000.0,
            cpu_fp_mflops: 50.0,
            wasm_fuel_mips: 25.0,
            memory_bandwidth_mb_s: 1_200.0,
            multithread_scaling_factor: 1.0,
            thermal_throttling_ratio: 1.0,
        }
    }
}

/// Canonical cross-platform benchmark configuration suite
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkSuiteConfig {
    pub spec_version: String,
    pub cpu_int_iterations: u64,
    pub cpu_fp_iterations: u64,
    pub memory_buffer_bytes: usize,
    pub thermal_sampling_intervals: usize,
}

impl Default for BenchmarkSuiteConfig {
    fn default() -> Self {
        Self {
            spec_version: BENCHMARK_SPEC_VERSION.to_string(),
            cpu_int_iterations: 100_000,
            cpu_fp_iterations: 80_000,
            memory_buffer_bytes: 4 * 1024 * 1024, // 4 MB
            thermal_sampling_intervals: 3,
        }
    }
}

/// Standard qualification profile produced by any edge node platform
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeBenchmarkReport {
    pub report_id: Uuid,
    pub spec_version: String,
    pub node_id: Uuid,
    pub platform: String,
    pub architecture: String,
    pub os_name: String,
    pub raw_metrics: RawBenchmarkMetrics,
    pub edge_score: u32,
    pub tier: QualificationTier,
    pub measured_at: DateTime<Utc>,
    pub profile_hash: String,
}

/// Deterministic EdgeScore computation formula:
/// Weighted combination of CPU integer (25%), Floating Point (20%),
/// Memory Bandwidth (20%), WASM Fuel Throughput (25%), and Thermal Stability (10%).
/// Normalized to a 1..100 scale.
pub fn calculate_edge_score(metrics: &RawBenchmarkMetrics) -> u32 {
    // Normalization baselines:
    // CPU Int: 50M ops/s = 100 points
    let int_score = (metrics.cpu_int_ops_per_sec / 50_000_000.0 * 100.0).clamp(0.0, 100.0);
    // CPU FP: 200 MFLOPS = 100 points
    let fp_score = (metrics.cpu_fp_mflops / 200.0 * 100.0).clamp(0.0, 100.0);
    // Memory: 5000 MB/s = 100 points
    let mem_score = (metrics.memory_bandwidth_mb_s / 5_000.0 * 100.0).clamp(0.0, 100.0);
    // WASM Fuel: 100 MIPS = 100 points
    let wasm_score = (metrics.wasm_fuel_mips / 100.0 * 100.0).clamp(0.0, 100.0);
    // Thermal Stability: 1.0 = 100 points (ratio below 0.8 heavily penalized)
    let thermal_score = (metrics.thermal_throttling_ratio as f64 * 100.0).clamp(0.0, 100.0);

    let composite = (int_score * 0.25)
        + (fp_score * 0.20)
        + (mem_score * 0.20)
        + (wasm_score * 0.25)
        + (thermal_score * 0.10);

    (composite.round() as u32).clamp(1, 100)
}

/// Maps an EdgeScore (1..100) to a QualificationTier
pub fn determine_tier(edge_score: u32) -> QualificationTier {
    match edge_score {
        0..=24 => QualificationTier::Tier0,
        25..=49 => QualificationTier::Tier1,
        50..=74 => QualificationTier::Tier2,
        _ => QualificationTier::Tier3,
    }
}

/// Standard integer benchmark algorithm (matches Android Kotlin & iOS Swift implementations)
pub fn run_standard_cpu_integer_algorithm(iterations: u64) -> (f64, f64) {
    let start = std::time::Instant::now();
    let mut acc: u64 = 0x123456789ABCDEF0;
    for i in 0..iterations {
        acc = acc.wrapping_mul(6364136223846793005).wrapping_add(i);
        acc ^= acc >> 21;
        acc ^= acc << 35;
        acc ^= acc >> 4;
    }
    // Prevent compiler dead-code elimination
    if acc == 0 {
        std::hint::black_box(acc);
    }
    let elapsed = start.elapsed().as_secs_f64().max(0.00001);
    let ops_per_sec = (iterations as f64) / elapsed;
    let score = (ops_per_sec / 1_000_000.0).clamp(1.0, 100.0);
    (ops_per_sec, score)
}

/// Standard floating-point benchmark algorithm (matches Android Kotlin & iOS Swift implementations)
pub fn run_standard_cpu_fp_algorithm(iterations: u64) -> f64 {
    let start = std::time::Instant::now();
    let mut x = 1.0001f64;
    let mut y = 2.0002f64;
    for _ in 0..iterations {
        x = (x * 1.00001 + y * 0.99999).sin();
        y = (y * 1.00002 - x * 0.99998).cos();
    }
    if x == 0.0 {
        std::hint::black_box(x);
    }
    let elapsed = start.elapsed().as_secs_f64().max(0.00001);
    let flops = (iterations as f64 * 8.0) / elapsed;
    flops / 1_000_000.0
}

/// Standard memory bandwidth benchmark algorithm (sequential read/write)
pub fn run_standard_memory_bandwidth_algorithm(buffer_size: usize, rounds: usize) -> f64 {
    let mut buffer = vec![0u8; buffer_size];
    let start = std::time::Instant::now();
    for r in 0..rounds {
        let pattern = (r as u8).wrapping_mul(17);
        for b in buffer.iter_mut() {
            *b = b.wrapping_add(pattern);
        }
    }
    if buffer[0] == 255 {
        std::hint::black_box(&buffer[0]);
    }
    let elapsed = start.elapsed().as_secs_f64().max(0.00001);
    let total_bytes = (buffer_size * rounds) as f64;
    (total_bytes / (1024.0 * 1024.0)) / elapsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_edge_score_calculation_boundaries() {
        let low_metrics = RawBenchmarkMetrics {
            cpu_int_ops_per_sec: 1_000_000.0,
            cpu_fp_mflops: 5.0,
            wasm_fuel_mips: 2.0,
            memory_bandwidth_mb_s: 100.0,
            multithread_scaling_factor: 1.0,
            thermal_throttling_ratio: 0.5,
        };
        let low_score = calculate_edge_score(&low_metrics);
        assert!(low_score < 25);
        assert_eq!(determine_tier(low_score), QualificationTier::Tier0);

        let high_metrics = RawBenchmarkMetrics {
            cpu_int_ops_per_sec: 60_000_000.0,
            cpu_fp_mflops: 300.0,
            wasm_fuel_mips: 150.0,
            memory_bandwidth_mb_s: 8_000.0,
            multithread_scaling_factor: 3.8,
            thermal_throttling_ratio: 0.98,
        };
        let high_score = calculate_edge_score(&high_metrics);
        assert!(high_score >= 75);
        assert_eq!(determine_tier(high_score), QualificationTier::Tier3);
    }

    #[test]
    fn test_standard_algorithms_execution() {
        let (ops, score) = run_standard_cpu_integer_algorithm(10_000);
        assert!(ops > 0.0);
        assert!(score >= 1.0);

        let mflops = run_standard_cpu_fp_algorithm(5_000);
        assert!(mflops > 0.0);

        let mem_bw = run_standard_memory_bandwidth_algorithm(1024 * 64, 5);
        assert!(mem_bw > 0.0);
    }

    #[test]
    fn test_report_json_serialization() {
        let report = NodeBenchmarkReport {
            report_id: Uuid::new_v4(),
            spec_version: BENCHMARK_SPEC_VERSION.into(),
            node_id: Uuid::new_v4(),
            platform: "desktop-worker".into(),
            architecture: "x86_64".into(),
            os_name: "windows".into(),
            raw_metrics: RawBenchmarkMetrics::default(),
            edge_score: 45,
            tier: QualificationTier::Tier1,
            measured_at: Utc::now(),
            profile_hash: "abcd1234efgh".into(),
        };

        let json = serde_json::to_string(&report).expect("must serialize");
        assert!(json.contains("edge_score"));
        assert!(json.contains("Tier1") || json.contains("tier1"));

        let deserialized: NodeBenchmarkReport =
            serde_json::from_str(&json).expect("must deserialize");
        assert_eq!(deserialized.edge_score, 45);
        assert_eq!(deserialized.tier, QualificationTier::Tier1);
    }
}
