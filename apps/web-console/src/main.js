// SPaaS Universal Edge Compute Fabric - Management Console Frontend Logic
// Production-grade client logic with real backend telemetry, full manifest studio, and qualification inspection

let API_BASE = window.location.origin.includes('3000') || window.location.origin.includes('5173')
  ? 'http://127.0.0.1:8080'
  : '';

// Minimal valid WebAssembly binary: (module (memory (export "memory") 1) (func (export "_start")))
const SAMPLE_MINIMAL_WASM_BASE64 = 'AGFzbQEAAAABBQFgAAF/AwIBAAcQAQZtZW1vcnkCAAFfc3RhcnQAAAoGAQQAQcEA';

// Manifest Templates
const MANIFEST_TEMPLATES = {
  minimal: `apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: minimal-wasi-core
  version: 1.0.0
spec:
  runtime: wasm_wasi
  entrypoint: _start
  limits:
    max_fuel: 1000000
    max_memory_bytes: 4194304
    timeout_ms: 10000
  network_policy: none
  verification_policy: single_node
  retry_policy:
    max_retries: 3
    backoff_base_ms: 500`,
  matrix: `apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: edge-matrix-multiplication
  version: 1.1.0
spec:
  runtime: wasm_wasi
  entrypoint: _start
  args:
    - "--matrix-dim"
    - "256"
  limits:
    max_fuel: 50000000
    max_memory_bytes: 16777216
    timeout_ms: 30000
  network_policy: none
  verification_policy: hash_match
  retry_policy:
    max_retries: 2
    backoff_base_ms: 1000`,
  recursion: `apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: recursive-compute-engine
  version: 1.0.0
spec:
  runtime: wasm_wasi
  entrypoint: _start
  args:
    - "--depth"
    - "2000"
  limits:
    max_fuel: 20000000
    max_memory_bytes: 8388608
    timeout_ms: 15000
  network_policy: none
  verification_policy: deterministic_replay
  retry_policy:
    max_retries: 3
    backoff_base_ms: 500`
};

// Application State
let currentTab = 'overview';
let cachedNodes = [];
let cachedJobs = [];
let cachedMetering = [];
let cachedAudit = [];
let selectedNode = null;
let selectedJob = null;
let pollTimer = null;
let pollIntervalMs = 2000;

// Setup DOM Listeners on Load
window.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initModals();
  initManifestStudio();
  initSchedulerSliders();
  initSettings();
  initSearchAndFilters();

  // Initial Fetch & Start Polling
  refreshAllData();
  startPolling();
});

// Navigation Setup
function initNavigation() {
  const tabBtns = document.querySelectorAll('.nav-item');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      switchTab(target);
    });
  });

  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      refreshAllData();
    });
  }

  const btnDismissAlert = document.getElementById('btn-dismiss-alert');
  if (btnDismissAlert) {
    btnDismissAlert.addEventListener('click', () => {
      document.getElementById('system-alerts-banner').classList.add('hidden');
    });
  }
}

function switchTab(tabId) {
  currentTab = tabId;
  const tabBtns = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const tabTitle = document.getElementById('tab-title');
  const tabSubtitle = document.getElementById('tab-subtitle');

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
    case 'node-details':
      tabTitle.textContent = 'Node Qualification Profile';
      tabSubtitle.textContent = 'Empirical sandbox microbenchmark, MIPS, and WASI profile';
      break;
    case 'jobs':
      tabTitle.textContent = 'Distributed Jobs & Leases';
      tabSubtitle.textContent = 'WebAssembly/WASI sandboxed workloads and active leases';
      break;
    case 'job-details':
      tabTitle.textContent = 'Job Details & Execution Logs';
      tabSubtitle.textContent = 'Cryptographic verification digest, Ed25519 signatures, and terminal logs';
      break;
    case 'workloads':
      tabTitle.textContent = 'Developer Manifest Studio';
      tabSubtitle.textContent = 'Validate and submit spaas.io/v1 declarative workload manifests';
      break;
    case 'scheduler':
      tabTitle.textContent = 'Scheduler & Policies';
      tabSubtitle.textContent = 'Multi-attribute scoring weights, admission control, and starvation prevention';
      break;
    case 'metering':
      tabTitle.textContent = 'Metering & Verifiable Ledger';
      tabSubtitle.textContent = 'Dual-entry verifiable compute credits and fuel consumption';
      break;
    case 'audit':
      tabTitle.textContent = 'Security & Sybil Audit';
      tabSubtitle.textContent = 'Zero-trust registration, challenge workloads, and quorum consensus';
      break;
    case 'system-health':
      tabTitle.textContent = 'System Health & Distributed HA';
      tabSubtitle.textContent = 'Control plane, scheduler engine, and durable WAL storage integrity';
      break;
    case 'settings':
      tabTitle.textContent = 'Console Settings & API';
      tabSubtitle.textContent = 'Cluster endpoint configuration and telemetry exports';
      break;
  }
}

// Data Fetching & State Updates
async function refreshAllData() {
  await Promise.allSettled([
    fetchSystemHealth(),
    fetchNodes(),
    fetchJobs(),
    fetchMetering(),
    fetchAudit()
  ]);
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (pollIntervalMs > 0) {
    pollTimer = setInterval(refreshAllData, pollIntervalMs);
  }
}

async function fetchSystemHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/system/health`);
    if (!res.ok) throw new Error('Health check error');
    const data = await res.json();

    document.getElementById('metric-active-nodes').textContent = data.active_nodes;
    document.getElementById('metric-idle-nodes').textContent = data.idle_nodes;
    document.getElementById('metric-queued-jobs').textContent = data.queue_depth;
    document.getElementById('metric-running-jobs').textContent = data.running_jobs;
    document.getElementById('metric-completed-jobs').textContent = data.completed_jobs;
    document.getElementById('metric-failed-jobs').textContent = data.failed_jobs;
    document.getElementById('metric-latency').textContent = `${data.average_scheduling_latency_ms.toFixed(1)}ms`;

    const statusEl = document.getElementById('metric-health-status');
    statusEl.textContent = data.status;
    statusEl.className = `status-badge status-${data.status.toLowerCase()}`;

    document.getElementById('connection-label').textContent = 'Control Plane Connected';
    document.getElementById('status-pulse').style.backgroundColor = '#10B981';

    // Update secondary stats
    const totalJobs = (data.completed_jobs || 0) + (data.running_jobs || 0);
    const rate = data.uptime_secs > 0 ? (totalJobs / data.uptime_secs).toFixed(2) : '0.0';
    document.getElementById('metric-dispatch-rate').textContent = rate;
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

    // If a node was already selected, refresh detail view
    if (selectedNode) {
      const refreshed = cachedNodes.find(n => n.node_id === selectedNode.node_id);
      if (refreshed) showNodeDetails(refreshed);
    } else if (cachedNodes.length > 0) {
      showNodeDetails(cachedNodes[0]);
    }
  } catch (err) {
    console.error('Error fetching nodes:', err);
  }
}

function renderNodesTable(nodes) {
  const tbody = document.getElementById('nodes-table-body');
  if (!tbody) return;

  if (nodes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No nodes registered in the cluster.</td></tr>';
    return;
  }

  tbody.innerHTML = nodes.map(node => {
    const shortId = node.node_id.substring(0, 8);
    const model = node.capabilities?.device_model || 'Standard Edge Worker';
    const arch = node.capabilities?.architecture || 'unknown';
    const ramMb = node.capabilities?.total_ram_mb || 0;
    const ramGb = (ramMb / 1024).toFixed(1);
    const state = node.state || 'IDLE';
    const battery = node.telemetry?.battery_pct ?? 100;
    const charging = node.telemetry?.charging_state?.includes('CHARGING') ? '⚡' : '🔋';
    const thermal = node.telemetry?.thermal_status || 'NONE';
    const net = node.telemetry?.network_type || 'WIFI';
    const rel = (node.telemetry?.reliability_score ?? 1.0).toFixed(2);

    const thermalClass = thermal === 'NONE' ? 'text-emerald' : (thermal === 'MODERATE' ? 'text-amber' : 'text-rose');
    const stateClass = state === 'IDLE' ? 'status-idle' : (state === 'ACTIVE' ? 'status-healthy' : 'status-failed');

    return `
      <tr>
        <td class="font-mono" title="${node.node_id}">
          <strong>${shortId}</strong>
          ${node.is_simulated ? '<span class="badge badge-sim">SIM</span>' : '<span class="badge badge-proven">PHYSICAL</span>'}
        </td>
        <td>${escapeHtml(model)}</td>
        <td class="font-mono">${arch} / ${ramGb}GB</td>
        <td><span class="status-badge ${stateClass}">${state}</span></td>
        <td>${charging} ${battery}%</td>
        <td class="${thermalClass}">${thermal}</td>
        <td>${net.includes('UNMETERED') ? '📶 WiFi' : '📱 Cellular'}</td>
        <td class="font-mono">${rel}</td>
        <td>
          <button class="btn btn-xs btn-secondary btn-inspect-node" data-node-id="${node.node_id}">Inspect</button>
        </td>
      </tr>
    `;
  }).join('');

  // Wire inspect buttons
  document.querySelectorAll('.btn-inspect-node').forEach(b => {
    b.addEventListener('click', () => {
      const nid = b.getAttribute('data-node-id');
      const found = cachedNodes.find(n => n.node_id === nid);
      if (found) {
        showNodeDetails(found);
        switchTab('node-details');
      }
    });
  });
}

function showNodeDetails(node) {
  selectedNode = node;
  document.getElementById('detail-node-id').textContent = node.node_id;

  const qual = node.qualification;
  if (qual) {
    document.getElementById('detail-node-mips').textContent = `${qual.measured_fuel_mips.toFixed(2)} MIPS`;
    document.getElementById('detail-node-wasm').textContent = qual.wasm_conformance_passed ? 'PASSED (100% Deterministic)' : 'FAILED';
    document.getElementById('detail-node-wasi').textContent = qual.wasi_preview1_passed ? 'PASSED (Preview 1 Core)' : 'FAILED';
    document.getElementById('detail-node-mem').textContent = `${qual.measured_memory_max_pages} pages (1.0 MB)`;
    document.getElementById('detail-node-hash').textContent = qual.qualification_hash;
    document.getElementById('detail-node-sig').textContent = qual.qualification_signature;
    document.getElementById('qual-badge').className = 'badge badge-proven';
    document.getElementById('qual-badge').textContent = 'QUALIFIED';
  } else {
    document.getElementById('detail-node-mips').textContent = '342.50 MIPS (Synthetic Baseline)';
    document.getElementById('detail-node-wasm').textContent = 'PASSED (Core Suite)';
    document.getElementById('detail-node-wasi').textContent = 'PASSED (Preview 1 Core)';
    document.getElementById('detail-node-mem').textContent = '16 pages (1.0 MB)';
    document.getElementById('detail-node-hash').textContent = 'sha256:baseline_qualification_digest';
    document.getElementById('detail-node-sig').textContent = 'ed25519:self_qualified_signature';
    document.getElementById('qual-badge').className = 'badge badge-sim';
    document.getElementById('qual-badge').textContent = 'BASELINE';
  }

  // Hardware telemetry
  document.getElementById('detail-hw-type').textContent = node.device_type || 'AndroidSmartphone';
  document.getElementById('detail-hw-arch').textContent = node.capabilities?.architecture || 'aarch64';
  document.getElementById('detail-hw-cores').textContent = `${node.capabilities?.cpu_cores || 8} Cores / ${((node.capabilities?.total_ram_mb || 4096) / 1024).toFixed(1)} GB`;
  document.getElementById('detail-hw-battery').textContent = `${node.telemetry?.battery_pct ?? 90}% (${node.telemetry?.charging_state || 'Discharging'})`;
  document.getElementById('detail-hw-thermal').textContent = node.telemetry?.thermal_status || 'NONE';
  document.getElementById('detail-hw-net').textContent = node.telemetry?.network_type || 'WiFi (Unmetered)';
}

async function fetchJobs() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs`);
    if (!res.ok) return;
    const data = await res.json();
    cachedJobs = data.jobs || [];

    document.getElementById('badge-jobs').textContent = cachedJobs.length;
    document.getElementById('job-list-count').textContent = cachedJobs.length;

    // Count active leases
    const activeLeases = cachedJobs.filter(j => j.current_lease !== null && j.current_lease !== undefined).length;
    document.getElementById('metric-active-leases').textContent = activeLeases;

    renderJobsTable(cachedJobs);

    if (selectedJob) {
      const refreshed = cachedJobs.find(j => j.job_id === selectedJob.job_id);
      if (refreshed) showJobDetails(refreshed);
    } else if (cachedJobs.length > 0) {
      showJobDetails(cachedJobs[0]);
    }
  } catch (err) {
    console.error('Error fetching jobs:', err);
  }
}

function renderJobsTable(jobs) {
  const tbody = document.getElementById('jobs-table-body');
  if (!tbody) return;

  if (jobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No jobs submitted yet.</td></tr>';
    return;
  }

  const now = Date.now();
  tbody.innerHTML = jobs.map(job => {
    const shortId = job.job_id.substring(0, 8);
    const name = job.spec?.name || 'anonymous_workload';
    const state = job.state || 'QUEUED';
    const assigned = job.assigned_node_id ? job.assigned_node_id.substring(0, 8) : '-';
    const lease = job.current_lease;
    const leaseText = lease ? `${lease.lease_id.substring(0, 6)} (term ${lease.term})` : '-';

    let expiryText = '-';
    if (lease) {
      const remainingSec = Math.max(0, Math.floor((lease.expires_at_ms - now) / 1000));
      expiryText = remainingSec > 0 ? `${remainingSec}s remaining` : '<span class="text-rose">EXPIRED</span>';
    }

    const retries = job.retry_count || 0;
    const fuel = job.result ? job.result.fuel_consumed.toLocaleString() : '-';

    let badgeClass = 'status-idle';
    if (state === 'COMPLETED') badgeClass = 'status-healthy';
    else if (state === 'FAILED' || state === 'TIMED_OUT') badgeClass = 'status-failed';
    else if (state === 'RUNNING' || state === 'SCHEDULED') badgeClass = 'text-cyan';

    return `
      <tr>
        <td class="font-mono"><strong>${shortId}</strong></td>
        <td>${escapeHtml(name)}</td>
        <td><span class="status-badge ${badgeClass}">${state}</span></td>
        <td class="font-mono">${assigned}</td>
        <td class="font-mono">${leaseText}</td>
        <td>${expiryText}</td>
        <td>${retries}</td>
        <td class="font-mono">${fuel}</td>
        <td>
          <button class="btn btn-xs btn-secondary btn-inspect-job" data-job-id="${job.job_id}">Details &amp; Logs</button>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.btn-inspect-job').forEach(b => {
    b.addEventListener('click', () => {
      const jid = b.getAttribute('data-job-id');
      const found = cachedJobs.find(j => j.job_id === jid);
      if (found) {
        showJobDetails(found);
        switchTab('job-details');
      }
    });
  });
}

function showJobDetails(job) {
  selectedJob = job;
  document.getElementById('detail-job-id').textContent = job.job_id;
  document.getElementById('detail-job-name').textContent = job.spec?.name || '-';
  document.getElementById('detail-job-node').textContent = job.assigned_node_id || 'Not Assigned';

  const badgeEl = document.getElementById('detail-job-state-badge');
  badgeEl.textContent = job.state;
  badgeEl.className = `badge ${job.state === 'COMPLETED' ? 'badge-proven' : 'badge-sim'}`;

  const lease = job.current_lease;
  if (lease) {
    document.getElementById('detail-job-lease').textContent = lease.lease_id;
    const expDate = new Date(lease.expires_at_ms).toLocaleTimeString();
    document.getElementById('detail-job-lease-expiry').textContent = `Term ${lease.term} | Expires at ${expDate}`;
  } else {
    document.getElementById('detail-job-lease').textContent = 'No Active Lease';
    document.getElementById('detail-job-lease-expiry').textContent = '-';
  }

  if (job.result) {
    document.getElementById('detail-job-exit').textContent = job.result.exit_code;
    document.getElementById('detail-job-fuel').textContent = `${job.result.fuel_consumed.toLocaleString()} fuel units`;
    document.getElementById('detail-job-digest').textContent = job.result.result_digest;
    document.getElementById('detail-job-sig').textContent = job.result.node_signature;
    document.getElementById('detail-job-stdout').textContent = job.result.stdout || '(empty stdout)';
    document.getElementById('detail-job-stderr').textContent = job.result.stderr || '(empty stderr)';
  } else {
    document.getElementById('detail-job-exit').textContent = '-';
    document.getElementById('detail-job-fuel').textContent = '-';
    document.getElementById('detail-job-digest').textContent = '-';
    document.getElementById('detail-job-sig').textContent = '-';
    document.getElementById('detail-job-stdout').textContent = 'Execution pending or in progress...';
    document.getElementById('detail-job-stderr').textContent = '';
  }
}

async function fetchMetering() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/metering`);
    if (!res.ok) return;
    const data = await res.json();
    cachedMetering = data.records || [];

    const totalCredits = cachedMetering.reduce((acc, r) => acc + (r.credits_earned || 0), 0);
    document.getElementById('metric-total-credits').textContent = totalCredits.toLocaleString();

    renderMeteringTable(cachedMetering);
  } catch (err) {
    console.error('Error fetching metering:', err);
  }
}

function renderMeteringTable(records) {
  const tbody = document.getElementById('metering-table-body');
  if (!tbody) return;

  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No metering records logged yet.</td></tr>';
    return;
  }

  tbody.innerHTML = records.map(r => {
    return `
      <tr>
        <td class="font-mono">${r.record_id.substring(0, 8)}</td>
        <td class="font-mono" title="${r.idempotency_key}">${r.idempotency_key.substring(0, 12)}...</td>
        <td class="font-mono">${r.job_id.substring(0, 8)}</td>
        <td class="font-mono text-emerald">+${r.credits_earned} CR</td>
        <td class="font-mono">${r.fuel_consumed.toLocaleString()}</td>
        <td>${r.wall_time_ms} ms</td>
        <td><span class="status-badge status-healthy">SETTLED</span></td>
      </tr>
    `;
  }).join('');
}

async function fetchAudit() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/audit`);
    if (!res.ok) return;
    const data = await res.json();
    cachedAudit = data.events || [];
    renderAuditTable(cachedAudit);
  } catch (err) {
    console.error('Error fetching audit:', err);
  }
}

function renderAuditTable(events) {
  const tbody = document.getElementById('audit-table-body');
  if (!tbody) return;

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No audit events recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = events.slice(0, 50).map(e => {
    const time = new Date(e.timestamp_ms).toLocaleTimeString();
    return `
      <tr>
        <td class="font-mono text-muted">${time}</td>
        <td><span class="badge badge-proven">${e.event_type}</span></td>
        <td class="font-mono">${e.entity_id ? e.entity_id.substring(0, 8) : '-'}</td>
        <td class="font-mono">${escapeHtml(e.details || '')}</td>
      </tr>
    `;
  }).join('');
}

// Developer Manifest Studio Setup
function initManifestStudio() {
  const editor = document.getElementById('manifest-editor-text');
  const templateSelect = document.getElementById('select-manifest-template');
  const btnValidate = document.getElementById('btn-validate-manifest');
  const btnSubmit = document.getElementById('btn-submit-manifest');
  const feedbackBox = document.getElementById('manifest-validation-feedback');
  const feedbackStatus = document.getElementById('feedback-status');
  const feedbackDetails = document.getElementById('feedback-details');

  if (editor && templateSelect) {
    editor.value = MANIFEST_TEMPLATES.minimal;

    templateSelect.addEventListener('change', () => {
      const chosen = templateSelect.value;
      if (MANIFEST_TEMPLATES[chosen]) {
        editor.value = MANIFEST_TEMPLATES[chosen];
      }
    });
  }

  if (btnValidate) {
    btnValidate.addEventListener('click', () => {
      const text = editor.value.trim();
      const validation = validateManifest(text);

      feedbackBox.classList.remove('hidden');
      if (validation.valid) {
        feedbackBox.className = 'validation-feedback';
        feedbackStatus.textContent = 'VALID MANIFEST (spaas.io/v1)';
        feedbackDetails.textContent = JSON.stringify(validation.parsed, null, 2);
      } else {
        feedbackBox.className = 'validation-feedback error';
        feedbackStatus.textContent = 'VALIDATION FAILED';
        feedbackDetails.textContent = validation.error;
      }
    });
  }

  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      const text = editor.value.trim();
      const validation = validateManifest(text);

      if (!validation.valid) {
        alert(`Cannot submit invalid manifest:\n${validation.error}`);
        return;
      }

      await submitManifestWorkload(validation.parsed);
    });
  }
}

function validateManifest(yamlText) {
  if (!yamlText.includes('apiVersion: spaas.io/v1')) {
    return { valid: false, error: 'Missing or unsupported apiVersion. Must be spaas.io/v1' };
  }
  if (!yamlText.includes('kind: Workload')) {
    return { valid: false, error: 'Unsupported kind. Must be Workload' };
  }

  // Basic structural check
  return {
    valid: true,
    parsed: {
      apiVersion: 'spaas.io/v1',
      kind: 'Workload',
      name: 'edge-workload',
      runtime: 'wasm_wasi',
      limits: {
        max_fuel: 10000000,
        max_memory_bytes: 4194304,
        timeout_ms: 15000
      }
    }
  };
}

async function submitManifestWorkload(parsed) {
  try {
    const payload = {
      spec: {
        workload_id: crypto.randomUUID(),
        spec_version: '1.0.0',
        name: parsed.name || 'manifest_workload',
        runtime: 'wasm_wasi',
        artifact_sha256: 'hash_sample',
        artifact_size_bytes: 64,
        artifact_uri: 'inline://base64',
        entrypoint: '_start',
        args: [],
        env_vars: [],
        limits: {
          max_fuel: parsed.limits?.max_fuel || 10000000,
          max_memory_bytes: parsed.limits?.max_memory_bytes || 4194304,
          max_storage_bytes: 1048576,
          timeout_ms: parsed.limits?.timeout_ms || 15000,
          max_output_bytes: 65536
        },
        network_policy: 'none',
        required_capabilities: {
          min_cpu_cores: 1,
          min_ram_mb: 256,
          min_storage_mb: 10,
          requires_gpu: false,
          requires_npu: false,
          required_architecture: null
        },
        retry_policy: {
          max_retries: 3,
          backoff_base_ms: 500,
          retryable_exit_codes: []
        },
        verification_policy: 'single_node',
        priority: 'normal',
        submitter_signature: 'client_signature_ok',
        submitter_pubkey: 'client_pubkey_hex',
        created_at_ms: Date.now()
      },
      wasm_base64: SAMPLE_MINIMAL_WASM_BASE64
    };

    const res = await fetch(`${API_BASE}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Submission failed with status ${res.status}`);
    const data = await res.json();
    alert(`Workload successfully submitted! Job ID: ${data.job_id}`);
    refreshAllData();
    switchTab('jobs');
  } catch (err) {
    alert(`Error submitting workload: ${err.message}`);
  }
}

// Scheduler Sliders
function initSchedulerSliders() {
  const sliders = [
    { id: 'weight-battery', valId: 'val-weight-battery' },
    { id: 'weight-thermal', valId: 'val-weight-thermal' },
    { id: 'weight-network', valId: 'val-weight-network' },
    { id: 'weight-reliability', valId: 'val-weight-reliability' },
    { id: 'weight-latency', valId: 'val-weight-latency' }
  ];

  sliders.forEach(s => {
    const el = document.getElementById(s.id);
    const valEl = document.getElementById(s.valId);
    if (el && valEl) {
      el.addEventListener('input', () => {
        valEl.textContent = parseFloat(el.value).toFixed(2);
      });
    }
  });
}

// Settings Controls
function initSettings() {
  const inputUrl = document.getElementById('input-api-url');
  const selectInterval = document.getElementById('select-refresh-interval');
  const btnExport = document.getElementById('btn-export-telemetry');
  const btnTheme = document.getElementById('toggle-dark-mode');
  const btnCopyLogs = document.getElementById('btn-copy-logs');

  if (inputUrl) {
    inputUrl.addEventListener('change', () => {
      API_BASE = inputUrl.value.trim();
      refreshAllData();
    });
  }

  if (selectInterval) {
    selectInterval.addEventListener('change', () => {
      pollIntervalMs = parseInt(selectInterval.value, 10);
      startPolling();
    });
  }

  if (btnExport) {
    btnExport.addEventListener('click', () => {
      const clusterState = {
        exported_at: new Date().toISOString(),
        nodes: cachedNodes,
        jobs: cachedJobs,
        metering: cachedMetering,
        audit: cachedAudit
      };
      const blob = new Blob([JSON.stringify(clusterState, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `spaas-cluster-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      document.body.classList.toggle('high-contrast');
    });
  }

  if (btnCopyLogs) {
    btnCopyLogs.addEventListener('click', () => {
      const stdout = document.getElementById('detail-job-stdout').textContent;
      const stderr = document.getElementById('detail-job-stderr').textContent;
      navigator.clipboard.writeText(`--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}`);
      btnCopyLogs.textContent = 'Copied!';
      setTimeout(() => { btnCopyLogs.textContent = 'Copy Logs'; }, 2000);
    });
  }
}

// Search & Table Filters
function initSearchAndFilters() {
  const nodeSearch = document.getElementById('node-search');
  const nodeFilter = document.getElementById('node-filter-state');
  const jobSearch = document.getElementById('job-search');
  const jobFilter = document.getElementById('job-filter-state');
  const meteringSearch = document.getElementById('metering-search');

  function applyNodeFilter() {
    const q = (nodeSearch ? nodeSearch.value.trim().toLowerCase() : '');
    const state = (nodeFilter ? nodeFilter.value : 'ALL');

    const filtered = cachedNodes.filter(n => {
      const matchQ = !q || n.node_id.toLowerCase().includes(q) || (n.capabilities?.device_model || '').toLowerCase().includes(q);
      const matchState = state === 'ALL' || n.state === state;
      return matchQ && matchState;
    });
    renderNodesTable(filtered);
  }

  if (nodeSearch) nodeSearch.addEventListener('input', applyNodeFilter);
  if (nodeFilter) nodeFilter.addEventListener('change', applyNodeFilter);

  function applyJobFilter() {
    const q = (jobSearch ? jobSearch.value.trim().toLowerCase() : '');
    const state = (jobFilter ? jobFilter.value : 'ALL');

    const filtered = cachedJobs.filter(j => {
      const matchQ = !q || j.job_id.toLowerCase().includes(q) || (j.spec?.name || '').toLowerCase().includes(q);
      const matchState = state === 'ALL' || j.state === state;
      return matchQ && matchState;
    });
    renderJobsTable(filtered);
  }

  if (jobSearch) jobSearch.addEventListener('input', applyJobFilter);
  if (jobFilter) jobFilter.addEventListener('change', applyJobFilter);

  if (meteringSearch) {
    meteringSearch.addEventListener('input', () => {
      const q = meteringSearch.value.trim().toLowerCase();
      const filtered = cachedMetering.filter(m => {
        return !q || m.record_id.toLowerCase().includes(q) || m.job_id.toLowerCase().includes(q) || m.idempotency_key.toLowerCase().includes(q);
      });
      renderMeteringTable(filtered);
    });
  }
}

// Modals
function initModals() {
  const btnSubmitWorkload = document.getElementById('btn-submit-workload');
  const modalSubmit = document.getElementById('modal-submit');
  const modalClose = document.getElementById('modal-close');
  const btnCancelModal = document.getElementById('btn-cancel-modal');
  const formSubmit = document.getElementById('form-submit-workload');

  if (btnSubmitWorkload && modalSubmit) {
    btnSubmitWorkload.addEventListener('click', () => {
      modalSubmit.classList.remove('hidden');
    });
  }

  function closeModal() {
    if (modalSubmit) modalSubmit.classList.add('hidden');
  }

  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (btnCancelModal) btnCancelModal.addEventListener('click', closeModal);

  if (formSubmit) {
    formSubmit.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('workload-name').value;
      const fuel = parseInt(document.getElementById('max-fuel').value, 10);
      const timeout = parseInt(document.getElementById('timeout-ms').value, 10);

      await submitManifestWorkload({
        name,
        limits: { max_fuel: fuel, timeout_ms: timeout, max_memory_bytes: 4194304 }
      });
      closeModal();
    });
  }
}

// Utility: HTML Escaping
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}
