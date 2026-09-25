// SPaaS Universal Edge Compute Fabric - Management Console Frontend Logic

const API_BASE = window.location.origin.includes('3000') ? 'http://127.0.0.1:8080' : '';

// Minimal valid WebAssembly binary: (module (memory (export "memory") 1) (func (export "_start")))
const SAMPLE_MINIMAL_WASM_BASE64 = 'AGFzbQEAAAABBQFgAAF/AwIBAAcQAQZtZW1vcnkCAAFfc3RhcnQAAAoGAQQAQcEA';

// State
let currentTab = 'overview';
let cachedNodes = [];
let cachedJobs = [];

// DOM Elements
const tabBtns = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');
const tabTitle = document.getElementById('tab-title');
const tabSubtitle = document.getElementById('tab-subtitle');
const btnRefresh = document.getElementById('btn-refresh');
const btnSubmitWorkload = document.getElementById('btn-submit-workload');
const modalSubmit = document.getElementById('modal-submit');
const modalClose = document.getElementById('modal-close');
const btnCancelModal = document.getElementById('btn-cancel-modal');
const formSubmitWorkload = document.getElementById('form-submit-workload');
const modalLogs = document.getElementById('modal-logs');
const logsModalClose = document.getElementById('logs-modal-close');
const logStdout = document.getElementById('log-stdout');
const logStderr = document.getElementById('log-stderr');
const nodeSearch = document.getElementById('node-search');

// Setup Navigation
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-tab');
    switchTab(target);
  });
});

function switchTab(tabId) {
  currentTab = tabId;
  tabBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tabId));
  tabPanes.forEach(p => p.classList.toggle('active', p.id === `tab-view-${tabId}`));

  switch (tabId) {
    case 'overview':
      tabTitle.textContent = 'Cluster Overview';
      tabSubtitle.textContent = 'Real-time distributed edge compute metrics and node fleet health';
      break;
    case 'nodes':
      tabTitle.textContent = 'Edge Compute Nodes';
      tabSubtitle.textContent = 'Voluntarily enrolled smartphone and desktop workers';
      break;
    case 'jobs':
      tabTitle.textContent = 'Distributed Jobs';
      tabSubtitle.textContent = 'WebAssembly/WASI sandboxed workloads and logs';
      break;
    case 'metering':
      tabTitle.textContent = 'Metering & Marketplace Ledger';
      tabSubtitle.textContent = 'Dual-entry verifiable compute credits and fuel consumption';
      break;
    case 'audit':
      tabTitle.textContent = 'Security & Audit Trail';
      tabSubtitle.textContent = 'Zero-trust registration, attestation, and signature records';
      break;
  }
}

// Fetch and Render Telemetry
async function fetchSystemHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/system/health`);
    if (!res.ok) throw new Error('Health endpoint returned error');
    const data = await res.json();

    document.getElementById('metric-active-nodes').textContent = data.active_nodes;
    document.getElementById('metric-idle-nodes').textContent = data.idle_nodes;
    document.getElementById('metric-queued-jobs').textContent = data.queue_depth;
    document.getElementById('metric-running-jobs').textContent = data.running_jobs;
    document.getElementById('metric-completed-jobs').textContent = data.completed_jobs;
    document.getElementById('metric-failed-jobs').textContent = data.failed_jobs;
    document.getElementById('metric-uptime').textContent = `${data.uptime_secs}s`;
    document.getElementById('metric-latency').textContent = `${data.average_scheduling_latency_ms.toFixed(1)}ms`;

    const statusEl = document.getElementById('metric-health-status');
    statusEl.textContent = data.status;
    statusEl.className = `status-badge status-${data.status.toLowerCase()}`;

    document.getElementById('connection-label').textContent = 'Control Plane Connected';
    document.getElementById('status-pulse').style.backgroundColor = '#10B981';
  } catch (err) {
    document.getElementById('connection-label').textContent = 'Control Plane Disconnected';
    document.getElementById('status-pulse').style.backgroundColor = '#F43F5E';
  }
}

async function fetchNodes() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/nodes`);
    if (!res.ok) return;
    const data = await res.json();
    cachedNodes = data.nodes || [];

    document.getElementById('badge-nodes').textContent = cachedNodes.length;
    document.getElementById('node-list-count').textContent = cachedNodes.length;

    renderNodesTable(cachedNodes);
  } catch (err) {
    console.error('Failed to fetch nodes', err);
  }
}

function renderNodesTable(nodes) {
  const tbody = document.getElementById('nodes-table-body');
  const query = (nodeSearch?.value || '').toLowerCase();
  const filtered = nodes.filter(n =>
    n.capabilities.device_model.toLowerCase().includes(query) ||
    n.node_id.toLowerCase().includes(query) ||
    n.capabilities.architecture.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">No nodes found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(n => `
    <tr>
      <td><code>${n.node_id.substring(0, 8)}...</code></td>
      <td><strong>${n.capabilities.device_model}</strong> ${n.is_simulated ? '<span class="badge badge-sim">SIM</span>' : ''}</td>
      <td>${n.capabilities.architecture} / ${n.telemetry.available_ram_mb} MB</td>
      <td><span class="status-badge status-${n.state.toLowerCase()}">${n.state}</span></td>
      <td>${n.telemetry.battery_pct}% (${n.telemetry.charging_state.replace('CHARGING_', '')})</td>
      <td>${n.telemetry.thermal_status}</td>
      <td>${n.telemetry.network_type.replace('_UNMETERED', ' (Free)')}</td>
      <td>${n.telemetry.total_jobs_completed}</td>
    </tr>
  `).join('');
}

async function fetchJobs() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs`);
    if (!res.ok) return;
    const data = await res.json();
    cachedJobs = data.jobs || [];

    document.getElementById('badge-jobs').textContent = cachedJobs.length;
    document.getElementById('job-list-count').textContent = cachedJobs.length;

    renderJobsTable(cachedJobs);
  } catch (err) {
    console.error('Failed to fetch jobs', err);
  }
}

function renderJobsTable(jobs) {
  const tbody = document.getElementById('jobs-table-body');
  if (jobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">No jobs submitted yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = jobs.map(j => `
    <tr>
      <td><code>${j.job_id.substring(0, 8)}...</code></td>
      <td><strong>${j.spec.name}</strong></td>
      <td><span class="status-badge status-${j.state.toLowerCase()}">${j.state}</span></td>
      <td>${j.assigned_node_id ? `<code>${j.assigned_node_id.substring(0, 8)}...</code>` : '<span class="text-muted">Unassigned</span>'}</td>
      <td>${j.retry_count}</td>
      <td>${j.result ? `${j.result.wall_time_ms} ms` : '-'}</td>
      <td>${j.result ? j.result.fuel_consumed.toLocaleString() : '-'}</td>
      <td>
        ${j.result ? `<button class="btn btn-secondary btn-sm" onclick="window.viewJobLogs('${j.job_id}')">Logs</button>` : ''}
        ${j.state === 'QUEUED' || j.state === 'SCHEDULED' ? `<button class="btn btn-secondary btn-sm text-rose" onclick="window.cancelJob('${j.job_id}')">Cancel</button>` : ''}
      </td>
    </tr>
  `).join('');
}

async function fetchMetering() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/metering`);
    if (!res.ok) return;
    const records = await res.json();

    const tbody = document.getElementById('metering-table-body');
    if (!records || records.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No metering records logged yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = records.map(r => `
      <tr>
        <td><code>${r.record_id.substring(0, 8)}...</code></td>
        <td><code>${r.idempotency_key.substring(0, 12)}...</code></td>
        <td><code>${r.job_id.substring(0, 8)}...</code></td>
        <td><strong class="text-emerald">+${r.credits_earned_by_node} CU</strong></td>
        <td>${r.usage.fuel_consumed.toLocaleString()}</td>
        <td>${r.usage.wall_time_ms} ms</td>
        <td><span class="status-badge status-active">VERIFIED</span></td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to fetch metering', err);
  }
}

async function fetchAuditLog() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/audit`);
    if (!res.ok) return;
    const entries = await res.json();

    const tbody = document.getElementById('audit-table-body');
    if (!entries || entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No audit events recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.slice().reverse().map(e => `
      <tr>
        <td>${new Date(e.timestamp_ms).toLocaleTimeString()}</td>
        <td><span class="status-badge status-idle">${e.event_type}</span></td>
        <td><code>${e.entity_id.substring(0, 16)}</code></td>
        <td>${e.details}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to fetch audit log', err);
  }
}

// Global actions attached to window for HTML table buttons
window.viewJobLogs = function(jobId) {
  const job = cachedJobs.find(j => j.job_id === jobId);
  if (!job || !job.result) return;

  document.getElementById('logs-modal-title').textContent = `Logs: ${job.spec.name} (${job.job_id.substring(0, 8)})`;
  logStdout.textContent = job.result.stdout || '(no stdout output)';
  logStderr.textContent = job.result.stderr || '(no stderr output)';
  modalLogs.classList.remove('hidden');
};

window.cancelJob = async function(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs/${jobId}/cancel`, { method: 'POST' });
    if (res.ok) {
      fetchJobs();
    }
  } catch (err) {
    alert(`Failed to cancel job: ${err}`);
  }
};

// Modal Handling
btnSubmitWorkload.addEventListener('click', () => modalSubmit.classList.remove('hidden'));
modalClose.addEventListener('click', () => modalSubmit.classList.add('hidden'));
btnCancelModal.addEventListener('click', () => modalSubmit.classList.add('hidden'));
logsModalClose.addEventListener('click', () => modalLogs.classList.add('hidden'));

// Workload Submission Form Handler
formSubmitWorkload.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('workload-name').value;
  const maxFuel = parseInt(document.getElementById('max-fuel').value, 10);
  const timeoutMs = parseInt(document.getElementById('timeout-ms').value, 10);

  const payload = {
    spec: {
      workload_id: crypto.randomUUID(),
      spec_version: "1.0.0",
      name: name,
      runtime: "wasm_wasi",
      artifact_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      artifact_size_bytes: 48,
      artifact_uri: "inline://wasm",
      entrypoint: "_start",
      args: [],
      env_vars: [],
      limits: {
        max_fuel: maxFuel,
        max_memory_bytes: 67108864,
        max_storage_bytes: 10485760,
        timeout_ms: timeoutMs,
        max_output_bytes: 1048576
      },
      network_policy: "none",
      required_capabilities: {
        architectures: ["aarch64", "x86_64"],
        min_ram_mb: 256,
        min_battery_pct: 30,
        require_charging: false,
        require_unmetered_network: true,
        max_thermal_level: "MODERATE",
        required_accelerator: null
      },
      retry_policy: {
        max_retries: 3,
        initial_backoff_ms: 1000
      },
      verification_policy: {
        type: "single_node"
      },
      priority: 10,
      submitter_signature: "web_console_sim_signature",
      submitter_pubkey: "web_console_dev_key",
      created_at_ms: Date.now()
    },
    wasm_binary_base64: SAMPLE_MINIMAL_WASM_BASE64
  };

  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      modalSubmit.classList.add('hidden');
      switchTab('jobs');
      fetchJobs();
      fetchSystemHealth();
    } else {
      const err = await res.text();
      alert(`Submission error: ${err}`);
    }
  } catch (err) {
    alert(`Network error: ${err}`);
  }
});

// Periodic Refresh
btnRefresh.addEventListener('click', () => {
  fetchSystemHealth();
  fetchNodes();
  fetchJobs();
  fetchMetering();
  fetchAuditLog();
});

nodeSearch?.addEventListener('input', () => renderNodesTable(cachedNodes));

// Initial Load & Heartbeat Polling
fetchSystemHealth();
fetchNodes();
fetchJobs();
fetchMetering();
fetchAuditLog();
setInterval(fetchSystemHealth, 3000);
setInterval(fetchNodes, 5000);
setInterval(fetchJobs, 3000);
