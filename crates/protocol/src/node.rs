use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EnrollmentStatus {
    Enrolled,
    Unenrolled,
    PendingApproval,
    Suspended,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NodeState {
    Active,
    Idle,
    Paused,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeDeviceType {
    #[serde(alias = "AndroidPhone", alias = "AndroidSmartphone", alias = "android_phone")]
    AndroidSmartphone,
    #[serde(alias = "AndroidTablet", alias = "android_tablet")]
    AndroidTablet,
    #[serde(alias = "LinuxDesktop", alias = "linux_desktop")]
    LinuxDesktop,
    #[serde(alias = "ServerEdge", alias = "server_edge")]
    ServerEdge,
    #[serde(alias = "MacDesktop", alias = "mac_desktop")]
    MacDesktop,
    #[serde(alias = "WindowsDesktop", alias = "windows_desktop")]
    WindowsDesktop,
    #[serde(alias = "RaspberryPi", alias = "raspberry_pi")]
    RaspberryPi,
    #[serde(alias = "SimulatedNode", alias = "simulated_node")]
    SimulatedNode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChargingState {
    #[default]
    #[serde(alias = "Discharging", alias = "discharging")]
    Discharging,
    #[serde(alias = "ChargingAc", alias = "charging_ac")]
    ChargingAc,
    #[serde(alias = "ChargingUsb", alias = "charging_usb")]
    ChargingUsb,
    #[serde(alias = "ChargingWireless", alias = "charging_wireless")]
    ChargingWireless,
    #[serde(alias = "Full", alias = "full")]
    Full,
    #[serde(alias = "NotCharging", alias = "not_charging")]
    NotCharging,
    #[serde(alias = "Unknown", alias = "unknown")]
    Unknown,
}

impl ChargingState {
    pub fn is_charging(&self) -> bool {
        matches!(
            self,
            Self::ChargingAc | Self::ChargingUsb | Self::ChargingWireless | Self::Full
        )
    }
}

/// Android PowerManager / Linux Thermal Status
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ThermalStatus {
    #[default]
    #[serde(alias = "None", alias = "none")]
    None = 0,
    #[serde(alias = "Light", alias = "light")]
    Light = 1,
    #[serde(alias = "Moderate", alias = "moderate")]
    Moderate = 2,
    #[serde(alias = "Severe", alias = "severe")]
    Severe = 3,
    #[serde(alias = "Critical", alias = "critical")]
    Critical = 4,
    #[serde(alias = "Emergency", alias = "emergency")]
    Emergency = 5,
    #[serde(alias = "Shutdown", alias = "shutdown")]
    Shutdown = 6,
}

impl ThermalStatus {
    pub fn is_safe_for_compute(&self) -> bool {
        matches!(self, Self::None | Self::Light)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NetworkType {
    #[default]
    #[serde(alias = "WifiUnmetered", alias = "WIFI_UNMETERED")]
    WifiUnmetered,
    #[serde(alias = "Ethernet", alias = "ETHERNET")]
    Ethernet,
    #[serde(alias = "CellularMetered", alias = "CELLULAR_METERED")]
    CellularMetered,
    #[serde(alias = "Vpn", alias = "VPN")]
    Vpn,
    #[serde(alias = "Offline", alias = "OFFLINE")]
    Offline,
    #[serde(alias = "Unknown", alias = "UNKNOWN")]
    Unknown,
}

impl NetworkType {
    pub fn is_unmetered(&self) -> bool {
        matches!(self, Self::WifiUnmetered | Self::Ethernet)
    }
}

/// Static and quasi-static hardware capabilities discovered on node startup
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeHardwareCapabilities {
    pub architecture: String, // e.g. "aarch64", "x86_64"
    pub cpu_cores: u32,
    pub total_ram_mb: u64,
    pub total_storage_mb: u64,
    pub device_model: String, // e.g. "Pixel 8 Pro", "Samsung S24"
    pub os_name: String,      // e.g. "Android"
    pub os_version: String,   // e.g. "15 (API 35)"
    pub has_npu: bool,
    pub has_gpu_vulkan: bool,
    pub agent_version: String,
    pub supported_runtimes: Vec<String>, // e.g. ["wasm_wasi"]
}

impl Default for NodeHardwareCapabilities {
    fn default() -> Self {
        Self {
            architecture: "aarch64".into(),
            cpu_cores: 8,
            total_ram_mb: 8192,
            total_storage_mb: 128000,
            device_model: "Generic Android 15 Device".into(),
            os_name: "Android".into(),
            os_version: "15".into(),
            has_npu: false,
            has_gpu_vulkan: false,
            agent_version: "0.1.0".into(),
            supported_runtimes: vec!["wasm_wasi".into()],
        }
    }
}

/// Real-time reported node telemetry updated via heartbeat
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeTelemetry {
    #[serde(default = "default_battery")]
    pub battery_pct: u8,
    #[serde(default)]
    pub charging_state: ChargingState,
    #[serde(default)]
    pub thermal_status: ThermalStatus,
    #[serde(default)]
    pub temperature_celsius: Option<f32>,
    #[serde(default = "default_avail_ram")]
    pub available_ram_mb: u64,
    #[serde(default = "default_avail_storage")]
    pub available_storage_mb: u64,
    #[serde(default)]
    pub network_type: NetworkType,
    #[serde(default)]
    pub downlink_kbps: Option<u32>,
    #[serde(default)]
    pub uplink_kbps: Option<u32>,
    #[serde(default)]
    pub round_trip_ping_ms: Option<u32>,
    #[serde(default)]
    pub cpu_usage_pct: f32,
    #[serde(default)]
    pub active_job_count: u32,
    #[serde(default)]
    pub total_jobs_completed: u64,
    #[serde(default)]
    pub total_jobs_failed: u64,
    #[serde(default = "default_reliability_score")]
    pub reliability_score: f32, // 0.0 to 1.0 (decayed historical success rate)
    #[serde(default)]
    pub timestamp_ms: i64,
}

fn default_true() -> bool {
    true
}
fn default_battery() -> u8 {
    85
}
fn default_avail_ram() -> u64 {
    4096
}
fn default_avail_storage() -> u64 {
    32000
}
fn default_max_thermal() -> ThermalStatus {
    ThermalStatus::Moderate
}
fn default_reliability_score() -> f32 {
    1.0
}
fn default_max_concurrent_jobs() -> u32 {
    1
}
fn default_max_cpu_pct() -> u8 {
    60
}
fn default_max_memory_mb() -> u64 {
    512
}

impl Default for NodeTelemetry {
    fn default() -> Self {
        Self {
            battery_pct: 85,
            charging_state: ChargingState::ChargingAc,
            thermal_status: ThermalStatus::None,
            temperature_celsius: Some(31.5),
            available_ram_mb: 4096,
            available_storage_mb: 32000,
            network_type: NetworkType::WifiUnmetered,
            downlink_kbps: Some(50_000),
            uplink_kbps: Some(25_000),
            round_trip_ping_ms: Some(18),
            cpu_usage_pct: 5.2,
            active_job_count: 0,
            total_jobs_completed: 0,
            total_jobs_failed: 0,
            reliability_score: 1.0,
            timestamp_ms: 0,
        }
    }
}

/// User-controlled resource limits and safety policies configured in the mobile app
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "ProviderPolicyRaw")]
pub struct ProviderPolicy {
    /// Only accept workloads when plugged into AC / wireless charging
    pub only_while_charging: bool,
    /// Only accept workloads on unmetered Wi-Fi / Ethernet connections
    pub only_on_unmetered_network: bool,
    /// Minimum battery percentage required to accept work (e.g. 50%)
    pub min_battery_threshold_pct: u8,
    /// Cutoff thermal status; auto-pause if temperature exceeds this level
    pub max_thermal_threshold: ThermalStatus,
    /// Maximum concurrent jobs allowed on this device (default 1 for phones)
    pub max_concurrent_jobs: u32,
    /// Maximum percentage of CPU allowed for workloads (e.g. 50%)
    pub max_cpu_pct: u8,
    /// Maximum RAM allocated to workloads in MB (e.g. 512 MB)
    pub max_memory_mb: u64,
    /// User explicit pause switch
    pub is_user_paused: bool,
}

#[derive(Deserialize)]
struct ProviderPolicyRaw {
    #[serde(default = "default_true", alias = "onlyWhileCharging")]
    only_while_charging: bool,
    #[serde(
        default,
        alias = "only_on_wifi",
        alias = "only_on_unmetered_wifi",
        alias = "onlyOnUnmeteredWifi",
        alias = "onlyUnmeteredNetwork"
    )]
    only_on_unmetered_network: Option<bool>,
    #[serde(default)]
    only_unmetered_network: Option<bool>,
    #[serde(default, alias = "minBatteryThresholdPct", alias = "minBatteryPct")]
    min_battery_threshold_pct: Option<u8>,
    #[serde(default)]
    min_battery_pct: Option<u8>,
    #[serde(
        default = "default_max_thermal",
        alias = "max_thermal_status",
        alias = "maxThermalThreshold",
        alias = "maxThermalStatus"
    )]
    max_thermal_threshold: ThermalStatus,
    #[serde(default = "default_max_concurrent_jobs", alias = "maxConcurrentJobs")]
    max_concurrent_jobs: u32,
    #[serde(default = "default_max_cpu_pct", alias = "maxCpuPct")]
    max_cpu_pct: u8,
    #[serde(default = "default_max_memory_mb", alias = "maxMemoryMb")]
    max_memory_mb: u64,
    #[serde(default, alias = "isUserPaused")]
    is_user_paused: bool,
}

impl From<ProviderPolicyRaw> for ProviderPolicy {
    fn from(raw: ProviderPolicyRaw) -> Self {
        Self {
            only_while_charging: raw.only_while_charging,
            only_on_unmetered_network: raw.only_on_unmetered_network
                .or(raw.only_unmetered_network)
                .unwrap_or(true),
            min_battery_threshold_pct: raw.min_battery_threshold_pct
                .or(raw.min_battery_pct)
                .unwrap_or(40),
            max_thermal_threshold: raw.max_thermal_threshold,
            max_concurrent_jobs: raw.max_concurrent_jobs,
            max_cpu_pct: raw.max_cpu_pct,
            max_memory_mb: raw.max_memory_mb,
            is_user_paused: raw.is_user_paused,
        }
    }
}

impl Default for ProviderPolicy {
    fn default() -> Self {
        Self {
            only_while_charging: true,
            only_on_unmetered_network: true,
            min_battery_threshold_pct: 40,
            max_thermal_threshold: ThermalStatus::Moderate,
            max_concurrent_jobs: 1,
            max_cpu_pct: 60,
            max_memory_mb: 512,
            is_user_paused: false,
        }
    }
}

/// Empirical qualification results produced by edge node sandbox microbenchmarks
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeQualificationProfile {
    pub qualified_at_ms: i64,
    pub wasm_conformance_passed: bool,
    pub wasi_preview1_passed: bool,
    pub measured_fuel_mips: f64,
    pub measured_memory_max_pages: u32,
    pub qualification_hash: String,
    pub qualification_signature: String,
}

/// Complete node record maintained by Control Plane
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeRecord {
    pub node_id: Uuid,
    pub public_key: String, // Ed25519 hex
    pub device_type: NodeDeviceType,
    pub enrollment: EnrollmentStatus,
    pub state: NodeState,
    pub capabilities: NodeHardwareCapabilities,
    pub telemetry: NodeTelemetry,
    pub policy: ProviderPolicy,
    pub qualification: Option<NodeQualificationProfile>,
    pub enrolled_at_ms: i64,
    pub last_heartbeat_ms: i64,
    pub region: String,
    pub is_simulated: bool,
}

impl NodeRecord {
    /// Evaluates if this node can safely accept a compute task right now
    pub fn is_ready_for_workload(&self) -> bool {
        if self.enrollment != EnrollmentStatus::Enrolled {
            return false;
        }
        if self.state != NodeState::Idle && self.state != NodeState::Active {
            return false;
        }
        if self.policy.is_user_paused {
            return false;
        }
        if self.telemetry.active_job_count >= self.policy.max_concurrent_jobs {
            return false;
        }
        if self.policy.only_while_charging && !self.telemetry.charging_state.is_charging() {
            return false;
        }
        if self.policy.only_on_unmetered_network && !self.telemetry.network_type.is_unmetered() {
            return false;
        }
        if self.telemetry.battery_pct < self.policy.min_battery_threshold_pct {
            return false;
        }
        if self.telemetry.thermal_status > self.policy.max_thermal_threshold {
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_ready_for_workload_rules() {
        let mut node = NodeRecord {
            node_id: Uuid::new_v4(),
            public_key: "abc".into(),
            device_type: NodeDeviceType::AndroidSmartphone,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            capabilities: NodeHardwareCapabilities::default(),
            telemetry: NodeTelemetry::default(),
            policy: ProviderPolicy::default(),
            qualification: None,
            enrolled_at_ms: 1000,
            last_heartbeat_ms: 1000,
            region: "us-east".into(),
            is_simulated: false,
        };

        // Default: charging, unmetered, battery 85%, thermal none -> should be ready
        assert!(node.is_ready_for_workload());

        // Test 1: User paused
        node.policy.is_user_paused = true;
        assert!(!node.is_ready_for_workload());
        node.policy.is_user_paused = false;

        // Test 2: Unplugged while policy requires charging
        node.telemetry.charging_state = ChargingState::Discharging;
        assert!(!node.is_ready_for_workload());
        node.telemetry.charging_state = ChargingState::ChargingAc;

        // Test 3: Cellular data when policy requires unmetered
        node.telemetry.network_type = NetworkType::CellularMetered;
        assert!(!node.is_ready_for_workload());
        node.telemetry.network_type = NetworkType::WifiUnmetered;

        // Test 4: Low battery
        node.telemetry.battery_pct = 20; // below default threshold 40
        assert!(!node.is_ready_for_workload());
        node.telemetry.battery_pct = 85;

        // Test 5: Severe thermal state
        node.telemetry.thermal_status = ThermalStatus::Severe;
        assert!(!node.is_ready_for_workload());
        node.telemetry.thermal_status = ThermalStatus::None;

        // Test 6: Non-enrolled statuses
        node.enrollment = EnrollmentStatus::PendingApproval;
        assert!(!node.is_ready_for_workload());
        node.enrollment = EnrollmentStatus::Suspended;
        assert!(!node.is_ready_for_workload());
        node.enrollment = EnrollmentStatus::Unenrolled;
        assert!(!node.is_ready_for_workload());
        node.enrollment = EnrollmentStatus::Enrolled;

        // Test 7: Non-active states
        node.state = NodeState::Offline;
        assert!(!node.is_ready_for_workload());
        node.state = NodeState::Paused;
        assert!(!node.is_ready_for_workload());
        node.state = NodeState::Idle;

        // Test 8: Concurrency limit reached
        node.telemetry.active_job_count = 1;
        node.policy.max_concurrent_jobs = 1;
        assert!(!node.is_ready_for_workload());

        // Test 9: Network & charging variants
        assert!(ChargingState::ChargingWireless.is_charging());
        assert!(ChargingState::Full.is_charging());
        assert!(!ChargingState::NotCharging.is_charging());
        assert!(NetworkType::Ethernet.is_unmetered());
        assert!(!NetworkType::CellularMetered.is_unmetered());
        assert!(!NetworkType::Offline.is_unmetered());

        // Test 10: Qualification profile serde
        let q = NodeQualificationProfile {
            qualified_at_ms: 1000,
            wasm_conformance_passed: true,
            wasi_preview1_passed: true,
            measured_fuel_mips: 250.5,
            measured_memory_max_pages: 512,
            qualification_hash: "hash_qual".into(),
            qualification_signature: "sig_qual".into(),
        };
        let q_json = serde_json::to_string(&q).unwrap();
        let q_deser: NodeQualificationProfile = serde_json::from_str(&q_json).unwrap();
        assert_eq!(q_deser.qualification_hash, "hash_qual");
        assert_eq!(q_deser.measured_fuel_mips, 250.5);
    }
}
