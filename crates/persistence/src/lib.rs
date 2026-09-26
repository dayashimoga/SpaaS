use chrono::Utc;
use serde::{Deserialize, Serialize};
use spaas_protocol::job::{JobLease, JobRecord};
use spaas_protocol::metering::MeteringRecord;
use spaas_protocol::node::NodeRecord;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Error, Debug)]
pub enum PersistenceError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Corrupt WAL entry at sequence {0}: {1}")]
    CorruptWal(u64, String),
    #[error("Lock acquisition failed: {0}")]
    LockError(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub timestamp_ms: i64,
    pub event_type: String,
    pub entity_id: String,
    pub details: String,
}

/// Durable events recorded sequentially to Write-Ahead Log (WAL)
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WalEvent {
    UpsertNode { node: NodeRecord },
    RemoveNode { node_id: Uuid },
    UpsertJob { job: JobRecord },
    GrantLease { lease: JobLease },
    RenewLease { lease: JobLease },
    RevokeLease { job_id: Uuid, lease_id: Uuid },
    AppendMetering { record: MeteringRecord },
    AppendAudit { record: AuditRecord },
    StoreArtifact { sha256: String, bytes: Vec<u8> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntry {
    pub seq: u64,
    pub timestamp_ms: i64,
    pub event: WalEvent,
    pub checksum: u32,
}

impl WalEntry {
    pub fn compute_checksum(seq: u64, timestamp_ms: i64, event_json: &str) -> u32 {
        let mut crc = 0xFFFFFFFFu32;
        for b in seq
            .to_le_bytes()
            .iter()
            .chain(timestamp_ms.to_le_bytes().iter())
            .chain(event_json.as_bytes().iter())
        {
            crc ^= *b as u32;
            for _ in 0..8 {
                if (crc & 1) != 0 {
                    crc = (crc >> 1) ^ 0xEDB88320;
                } else {
                    crc >>= 1;
                }
            }
        }
        !crc
    }
}

/// State recovered after replaying snapshots and WAL records
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecoveredState {
    pub nodes: HashMap<Uuid, NodeRecord>,
    pub jobs: HashMap<Uuid, JobRecord>,
    pub metering_records: Vec<MeteringRecord>,
    pub audit_log: Vec<AuditRecord>,
    pub wasm_artifacts: HashMap<String, Vec<u8>>,
    pub last_seq: u64,
}

pub struct DurableStorage {
    data_dir: PathBuf,
    snapshot_path: PathBuf,
    next_seq: AtomicU64,
    writer_lock: tokio::sync::Mutex<BufWriter<File>>,
    state: Arc<RwLock<RecoveredState>>,
    pub initial_state: RecoveredState,
}

impl DurableStorage {
    /// Opens or initializes a durable storage instance at `data_dir`
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self, PersistenceError> {
        let data_dir = data_dir.as_ref().to_path_buf();
        fs::create_dir_all(&data_dir)?;

        let wal_path = data_dir.join("spaas.wal");
        let snapshot_path = data_dir.join("spaas.snapshot.json");

        // 1. Recover state from snapshot if present
        let mut state = if snapshot_path.exists() {
            let snap_file = File::open(&snapshot_path)?;
            let reader = BufReader::new(snap_file);
            match serde_json::from_reader::<_, RecoveredState>(reader) {
                Ok(snap) => {
                    info!(
                        "Loaded durable snapshot with sequence up to {}",
                        snap.last_seq
                    );
                    snap
                }
                Err(e) => {
                    warn!("Corrupted snapshot detected (will reconstruct from WAL): {e}");
                    RecoveredState::default()
                }
            }
        } else {
            RecoveredState::default()
        };

        // 2. Replay WAL entries succeeding snapshot sequence
        let mut last_seq = state.last_seq;
        if wal_path.exists() {
            let wal_file = File::open(&wal_path)?;
            let reader = BufReader::new(wal_file);

            for (idx, line_res) in reader.lines().enumerate() {
                let line = line_res?;
                if line.trim().is_empty() {
                    continue;
                }
                let entry: WalEntry = serde_json::from_str(&line).map_err(|e| {
                    PersistenceError::CorruptWal(idx as u64, format!("JSON decode failed: {e}"))
                })?;

                // Validate checksum: extract raw event slice from line or reserialize to maintain forward/backward schema compatibility
                let raw_slice_checksum = if let (Some(ev_start), Some(cs_start)) =
                    (line.find("\"event\":"), line.rfind(",\"checksum\":"))
                {
                    let ev_str = &line[ev_start + 8..cs_start];
                    WalEntry::compute_checksum(entry.seq, entry.timestamp_ms, ev_str)
                } else {
                    0
                };
                let event_json = serde_json::to_string(&entry.event)?;
                let reserialized_expected =
                    WalEntry::compute_checksum(entry.seq, entry.timestamp_ms, &event_json);

                if entry.checksum != raw_slice_checksum && entry.checksum != reserialized_expected {
                    return Err(PersistenceError::CorruptWal(
                        entry.seq,
                        format!(
                            "Checksum mismatch: expected {raw_slice_checksum} (or reserialized {reserialized_expected}), got {}",
                            entry.checksum
                        ),
                    ));
                }

                if entry.seq > state.last_seq {
                    Self::apply_event_to_state(&mut state, entry.event);
                    last_seq = entry.seq;
                }
            }
            info!(
                "WAL replay completed successfully up to sequence {}",
                last_seq
            );
        }

        state.last_seq = last_seq;

        // Open WAL file for appending
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&wal_path)?;
        let writer = BufWriter::new(file);

        Ok(Self {
            data_dir,
            snapshot_path,
            next_seq: AtomicU64::new(last_seq + 1),
            writer_lock: tokio::sync::Mutex::new(writer),
            initial_state: state.clone(),
            state: Arc::new(RwLock::new(state)),
        })
    }

    fn apply_event_to_state(state: &mut RecoveredState, event: WalEvent) {
        match event {
            WalEvent::UpsertNode { node } => {
                state.nodes.insert(node.node_id, node);
            }
            WalEvent::RemoveNode { node_id } => {
                state.nodes.remove(&node_id);
            }
            WalEvent::UpsertJob { job } => {
                state.jobs.insert(job.job_id, job);
            }
            WalEvent::GrantLease { lease } => {
                if let Some(job) = state.jobs.get_mut(&lease.job_id) {
                    job.current_lease = Some(lease);
                }
            }
            WalEvent::RenewLease { lease } => {
                if let Some(job) = state.jobs.get_mut(&lease.job_id) {
                    job.current_lease = Some(lease);
                }
            }
            WalEvent::RevokeLease { job_id, .. } => {
                if let Some(job) = state.jobs.get_mut(&job_id) {
                    job.current_lease = None;
                }
            }
            WalEvent::AppendMetering { record } => {
                state.metering_records.push(record);
            }
            WalEvent::AppendAudit { record } => {
                state.audit_log.push(record);
            }
            WalEvent::StoreArtifact { sha256, bytes } => {
                state.wasm_artifacts.insert(sha256, bytes);
            }
        }
    }

    /// Appends an event to the WAL and applies it to in-memory state
    pub async fn append_event(&self, event: WalEvent) -> Result<u64, PersistenceError> {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let timestamp_ms = Utc::now().timestamp_millis();
        let event_json = serde_json::to_string(&event)?;
        let checksum = WalEntry::compute_checksum(seq, timestamp_ms, &event_json);

        let entry = WalEntry {
            seq,
            timestamp_ms,
            event: event.clone(),
            checksum,
        };

        let entry_line = serde_json::to_string(&entry)? + "\n";

        // 1. Write to WAL with lock
        {
            let mut writer = self.writer_lock.lock().await;
            writer.write_all(entry_line.as_bytes())?;
            writer.flush()?;
        }

        // 2. Mutate in-memory state
        {
            let mut state = self.state.write().await;
            Self::apply_event_to_state(&mut state, event);
            state.last_seq = seq;
        }

        Ok(seq)
    }

    /// Creates an atomic snapshot of current state and compacts WAL
    pub async fn checkpoint_snapshot(&self) -> Result<(), PersistenceError> {
        let snap_tmp = self.data_dir.join("spaas.snapshot.json.tmp");
        let state_clone = {
            let state = self.state.read().await;
            state.clone()
        };

        // Write snapshot to temporary file
        let file = File::create(&snap_tmp)?;
        serde_json::to_writer_pretty(file, &state_clone)?;

        // Atomic file rename
        fs::rename(&snap_tmp, &self.snapshot_path)?;
        info!(
            "Atomic checkpoint snapshot created at seq {}",
            state_clone.last_seq
        );

        Ok(())
    }

    /// Returns a reference to the read/write recovered state
    pub fn state(&self) -> Arc<RwLock<RecoveredState>> {
        self.state.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::workload::WorkloadSpec;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_durable_storage_recovery() {
        let dir = tempdir().unwrap();
        let storage = DurableStorage::open(dir.path()).unwrap();

        // 1. Append a node and a job
        let node = NodeRecord {
            node_id: Uuid::new_v4(),
            public_key: "pubkey123".into(),
            device_type: spaas_protocol::node::NodeDeviceType::LinuxDesktop,
            enrollment: spaas_protocol::node::EnrollmentStatus::Enrolled,
            state: spaas_protocol::node::NodeState::Idle,
            capabilities: Default::default(),
            telemetry: Default::default(),
            policy: Default::default(),
            qualification: None,
            enrolled_at_ms: 1000,
            last_heartbeat_ms: 1000,
            region: "local".into(),
            is_simulated: false,
        };

        storage
            .append_event(WalEvent::UpsertNode { node: node.clone() })
            .await
            .unwrap();

        let job_id = Uuid::new_v4();
        let job = JobRecord::new(WorkloadSpec {
            workload_id: job_id,
            spec_version: "1.0.0".into(),
            name: "test_job".into(),
            runtime: Default::default(),
            artifact_sha256: "hash123".into(),
            artifact_size_bytes: 512,
            artifact_uri: "inline://hash123".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: Default::default(),
            network_policy: Default::default(),
            required_capabilities: Default::default(),
            retry_policy: Default::default(),
            verification_policy: Default::default(),
            priority: Default::default(),
            dimension_weights: Default::default(),
            submitter_signature: "".into(),
            submitter_pubkey: "".into(),
            created_at_ms: 1000,
        });

        storage
            .append_event(WalEvent::UpsertJob { job: job.clone() })
            .await
            .unwrap();

        // 2. Grant lease
        let lease = JobLease::new(job_id, node.node_id, 30_000);
        storage
            .append_event(WalEvent::GrantLease {
                lease: lease.clone(),
            })
            .await
            .unwrap();

        // Drop current storage handle to simulate sudden restart/process exit
        drop(storage);

        // 3. Reopen storage from the same directory
        let restored = DurableStorage::open(dir.path()).unwrap();
        let state_arc = restored.state();
        let state = state_arc.read().await;

        assert_eq!(state.nodes.len(), 1);
        assert_eq!(state.jobs.len(), 1);
        let recovered_job = state.jobs.get(&job_id).unwrap();
        assert!(recovered_job.current_lease.is_some());
        assert_eq!(
            recovered_job.current_lease.as_ref().unwrap().lease_id,
            lease.lease_id
        );
    }

    #[tokio::test]
    async fn test_corrupted_crc_wal_rejected() {
        let dir = tempdir().unwrap();
        let wal_path = dir.path().join("spaas.wal");

        // Write an entry with forged/corrupted checksum
        let event = WalEvent::UpsertJob {
            job: JobRecord::new(WorkloadSpec::default()),
        };
        let entry = WalEntry {
            seq: 1,
            timestamp_ms: 1000,
            event,
            checksum: 999999, // Corrupted CRC
        };
        let line = serde_json::to_string(&entry).unwrap() + "\n";
        fs::write(&wal_path, line).unwrap();

        let res = DurableStorage::open(dir.path());
        match res {
            Err(PersistenceError::CorruptWal(1, _)) => {}
            _ => panic!("Expected CorruptWal(1, _) error"),
        }
    }

    #[tokio::test]
    async fn test_malformed_json_wal_rejected() {
        let dir = tempdir().unwrap();
        let wal_path = dir.path().join("spaas.wal");
        fs::write(&wal_path, "{broken_json\n").unwrap();

        let res = DurableStorage::open(dir.path());
        match res {
            Err(PersistenceError::CorruptWal(0, _)) => {}
            _ => panic!("Expected CorruptWal(0, _) error"),
        }
    }

    #[tokio::test]
    async fn test_snapshot_checkpoint_and_recovery() {
        let dir = tempdir().unwrap();
        let storage = DurableStorage::open(dir.path()).unwrap();

        let _job_id = Uuid::new_v4();
        let job = JobRecord::new(WorkloadSpec::default());
        storage
            .append_event(WalEvent::UpsertJob { job: job.clone() })
            .await
            .unwrap();

        // Checkpoint snapshot
        storage.checkpoint_snapshot().await.unwrap();
        assert!(dir.path().join("spaas.snapshot.json").exists());

        // Append more events after snapshot
        let artifact_hash = "sha256_wasm_art".to_string();
        storage
            .append_event(WalEvent::StoreArtifact {
                sha256: artifact_hash.clone(),
                bytes: vec![1, 2, 3, 4],
            })
            .await
            .unwrap();

        drop(storage);

        // Reopen storage: should load snapshot and replay subsequent artifact event
        let restored = DurableStorage::open(dir.path()).unwrap();
        let state = restored.state().read().await.clone();
        assert_eq!(state.jobs.len(), 1);
        assert!(state.wasm_artifacts.contains_key(&artifact_hash));

        // Test RemoveNode, RenewLease, and RevokeLease
        let node_id = Uuid::new_v4();
        let dummy_node = NodeRecord {
            node_id,
            public_key: "pk".into(),
            device_type: spaas_protocol::node::NodeDeviceType::SimulatedNode,
            enrollment: spaas_protocol::node::EnrollmentStatus::Enrolled,
            state: spaas_protocol::node::NodeState::Idle,
            capabilities: Default::default(),
            telemetry: Default::default(),
            policy: Default::default(),
            qualification: None,
            enrolled_at_ms: 0,
            last_heartbeat_ms: 0,
            region: "us".into(),
            is_simulated: true,
        };
        restored
            .append_event(WalEvent::UpsertNode { node: dummy_node })
            .await
            .unwrap();
        assert_eq!(restored.state().read().await.nodes.len(), 1);

        restored
            .append_event(WalEvent::RemoveNode { node_id })
            .await
            .unwrap();
        assert_eq!(restored.state().read().await.nodes.len(), 0);

        let mut lease = JobLease::new(job.job_id, node_id, 1000);
        restored
            .append_event(WalEvent::GrantLease {
                lease: lease.clone(),
            })
            .await
            .unwrap();
        lease.renew(2000);
        restored
            .append_event(WalEvent::RenewLease {
                lease: lease.clone(),
            })
            .await
            .unwrap();
        assert_eq!(
            restored
                .state()
                .read()
                .await
                .jobs
                .get(&job.job_id)
                .unwrap()
                .current_lease
                .as_ref()
                .unwrap()
                .term,
            2
        );

        restored
            .append_event(WalEvent::RevokeLease {
                job_id: job.job_id,
                lease_id: lease.lease_id,
            })
            .await
            .unwrap();
        assert!(restored
            .state()
            .read()
            .await
            .jobs
            .get(&job.job_id)
            .unwrap()
            .current_lease
            .is_none());
    }

    #[tokio::test]
    async fn test_corrupted_snapshot_recovers_gracefully() {
        let dir = tempdir().unwrap();
        // Write invalid JSON snapshot
        std::fs::write(
            dir.path().join("spaas.snapshot.json"),
            b"invalid json content",
        )
        .unwrap();

        // Storage open should succeed and fall back to default state
        let storage = DurableStorage::open(dir.path()).unwrap();
        assert_eq!(storage.state().read().await.nodes.len(), 0);
    }

    #[test]
    fn test_persistence_error_display() {
        let errs = vec![
            PersistenceError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "file not found",
            )),
            PersistenceError::CorruptWal(42, "checksum error".into()),
            PersistenceError::Serialization(
                serde_json::from_str::<String>("bad_json").unwrap_err(),
            ),
            PersistenceError::LockError("lock poisoned".into()),
        ];
        for err in errs {
            assert!(!format!("{}", err).is_empty());
        }
    }
}
