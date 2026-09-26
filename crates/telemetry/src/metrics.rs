use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Default, Clone)]
pub struct MetricsRegistry {
    pub active_nodes: Arc<AtomicUsize>,
    pub idle_nodes: Arc<AtomicUsize>,
    pub paused_nodes: Arc<AtomicUsize>,
    pub offline_nodes: Arc<AtomicUsize>,
    pub queue_depth: Arc<AtomicUsize>,
    pub running_jobs: Arc<AtomicUsize>,
    pub completed_jobs: Arc<AtomicU64>,
    pub failed_jobs: Arc<AtomicU64>,
    pub retried_jobs: Arc<AtomicU64>,
    pub node_churn_count: Arc<AtomicU64>,
    pub api_requests_total: Arc<AtomicU64>,
    pub api_errors_total: Arc<AtomicU64>,
    pub metering_events_total: Arc<AtomicU64>,
    pub credits_transferred_total: Arc<AtomicU64>,
}

impl MetricsRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Recomputes gauge metrics from recovered WAL state so dashboard
    /// shows correct counts immediately after restart (fixes GB-01).
    pub fn recompute_from_recovered_state<'a>(
        &self,
        node_states: impl Iterator<Item = (bool, &'a str)>, // (is_offline_or_revoked, state_label)
        job_states: impl Iterator<Item = &'a str>,
    ) {
        let mut active = 0usize;
        let mut idle = 0usize;
        let mut paused = 0usize;
        let mut offline = 0usize;

        for (is_dead, state) in node_states {
            if is_dead {
                offline += 1;
            } else {
                match state {
                    "IDLE" | "READY" => idle += 1,
                    "ACTIVE" | "RUNNING" => active += 1,
                    "PAUSED" => paused += 1,
                    _ => offline += 1,
                }
            }
        }

        self.active_nodes.store(active, Ordering::Relaxed);
        self.idle_nodes.store(idle, Ordering::Relaxed);
        self.paused_nodes.store(paused, Ordering::Relaxed);
        self.offline_nodes.store(offline, Ordering::Relaxed);

        let mut queue = 0usize;
        let mut running = 0usize;
        let mut completed = 0u64;
        let mut failed = 0u64;

        for state in job_states {
            match state {
                "Pending" | "Queued" => queue += 1,
                "Scheduled" | "Running" => running += 1,
                "Completed" | "Verified" => completed += 1,
                "Failed" | "TimedOut" | "Cancelled" => failed += 1,
                _ => {}
            }
        }

        self.queue_depth.store(queue, Ordering::Relaxed);
        self.running_jobs.store(running, Ordering::Relaxed);
        self.completed_jobs.store(completed, Ordering::Relaxed);
        self.failed_jobs.store(failed, Ordering::Relaxed);
    }

    /// Exports standard Prometheus metrics format exposition
    pub fn render_prometheus(&self) -> String {
        format!(
            "# HELP spaas_active_nodes Number of currently active edge nodes\n\
             # TYPE spaas_active_nodes gauge\n\
             spaas_active_nodes {}\n\n\
             # HELP spaas_idle_nodes Number of idle edge nodes ready for work\n\
             # TYPE spaas_idle_nodes gauge\n\
             spaas_idle_nodes {}\n\n\
             # HELP spaas_offline_nodes Number of disconnected edge nodes\n\
             # TYPE spaas_offline_nodes gauge\n\
             spaas_offline_nodes {}\n\n\
             # HELP spaas_queue_depth Pending jobs in scheduling queue\n\
             # TYPE spaas_queue_depth gauge\n\
             spaas_queue_depth {}\n\n\
             # HELP spaas_running_jobs Jobs currently executing in sandbox\n\
             # TYPE spaas_running_jobs gauge\n\
             spaas_running_jobs {}\n\n\
             # HELP spaas_completed_jobs_total Total successfully completed jobs\n\
             # TYPE spaas_completed_jobs_total counter\n\
             spaas_completed_jobs_total {}\n\n\
             # HELP spaas_failed_jobs_total Total unrecoverable job failures\n\
             # TYPE spaas_failed_jobs_total counter\n\
             spaas_failed_jobs_total {}\n\n\
             # HELP spaas_retried_jobs_total Total job retry attempts\n\
             # TYPE spaas_retried_jobs_total counter\n\
             spaas_retried_jobs_total {}\n\n\
             # HELP spaas_api_requests_total Total API requests served\n\
             # TYPE spaas_api_requests_total counter\n\
             spaas_api_requests_total {}\n\n\
             # HELP spaas_metering_events_total Total usage metering events processed\n\
             # TYPE spaas_metering_events_total counter\n\
             spaas_metering_events_total {}\n\n\
             # HELP spaas_credits_transferred_total Total compute credits awarded\n\
             # TYPE spaas_credits_transferred_total counter\n\
             spaas_credits_transferred_total {}\n",
            self.active_nodes.load(Ordering::Relaxed),
            self.idle_nodes.load(Ordering::Relaxed),
            self.offline_nodes.load(Ordering::Relaxed),
            self.queue_depth.load(Ordering::Relaxed),
            self.running_jobs.load(Ordering::Relaxed),
            self.completed_jobs.load(Ordering::Relaxed),
            self.failed_jobs.load(Ordering::Relaxed),
            self.retried_jobs.load(Ordering::Relaxed),
            self.api_requests_total.load(Ordering::Relaxed),
            self.metering_events_total.load(Ordering::Relaxed),
            self.credits_transferred_total.load(Ordering::Relaxed),
        )
    }
}
