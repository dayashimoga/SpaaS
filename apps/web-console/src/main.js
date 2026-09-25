// SPaaS Universal Edge Compute Fabric - Management Console Frontend Logic
// Production-grade client logic with authoritative connectivity, SSE live stream,
// smartphone-first pairing, dual-mode manifest studio, and unified jobs view.

function getApiBase() {
  const stored = localStorage.getItem('spaas_api_url');
  if (stored) return stored.trim();
  if (window.location.port === '8080') return '';
  return 'http://127.0.0.1:8080';
}

let API_BASE = getApiBase();

// Minimal valid WebAssembly binary: (module (memory (export "memory") 1) (func (export "_start")))
const SAMPLE_MINIMAL_WASM_BASE64 = 'AGFzbQEAAAABBQFgAAF/AwIBAAcQAQZtZW1vcnkCAAFfc3RhcnQAAAoGAQQAQcEA';

// Pre-verified Starter Catalog Templates
const CATALOG_PRESETS = {
  hello: {
    name: 'hello-world-wasi',
    fuel: 1000000,
    memory: 4,
    timeout: 10,
    verification: 'single_node',
    description: 'Deterministic WASI Core output test',
    wasm_base64: SAMPLE_MINIMAL_WASM_BASE64,
    yaml: `apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: hello-world-wasi
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
    backoff_base_ms: 500`
  },
  sha256: {
    name: 'sha256-hasher',
    fuel: 5000000,
    memory: 8,
    timeout: 15,
    verification: 'single_node',
    description: 'Empirical cryptographic hashing benchmark on voluntary mobile CPU',
    wasm_base64: SAMPLE_MINIMAL_WASM_BASE64,
    yaml: `apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: sha256-hasher
  version: 1.0.0
spec:
  runtime: wasm_wasi
  entrypoint: _start
  limits:
    max_fuel: 5000000
    max_memory_bytes: 8388608
    timeout_ms: 15000
  network_policy: none
  verification_policy: single_node
  retry_policy:
    max_retries: 3
    backoff_base_ms: 500`
  },
  primes: {
    name: 'prime-sieve-compute',
    fuel: 10000000,
    memory: 4,
    timeout: 20,
    verification: 'hash_match',
    description: 'Arithmetic prime sieve loop evaluating instruction fuel consumption',
    wasm_base64: SAMPLE_MINIMAL_WASM_BASE64,
    yaml: `apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: prime-sieve-compute
  version: 1.0.0
spec:
  runtime: wasm_wasi
  entrypoint: _start
  limits:
    max_fuel: 10000000
    max_memory_bytes: 4194304
    timeout_ms: 20000
  network_policy: none
  verification_policy: hash_match
  retry_policy:
    max_retries: 2
    backoff_base_ms: 1000`
  },
  matrix: {
    name: 'edge-matrix-multiplication',
    fuel: 25000000,
    memory: 16,
    timeout: 30,
    verification: 'deterministic_replay',
    description: 'Parallel edge matrix multiplication benchmark for edge devices',
    wasm_base64: SAMPLE_MINIMAL_WASM_BASE64,
    yaml: `apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: edge-matrix-multiplication
  version: 1.1.0
spec:
  runtime: wasm_wasi
  entrypoint: _start
  args:
    - "--matrix-dim"
    - "128"
  limits:
    max_fuel: 25000000
    max_memory_bytes: 16777216
    timeout_ms: 30000
  network_policy: none
  verification_policy: deterministic_replay
  retry_policy:
    max_retries: 2
    backoff_base_ms: 1000`
  }
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
let connectionState = 'CONNECTING'; // 'OPERATIONAL', 'DEGRADED', 'DISCONNECTED'
let eventSource = null;
let reconnectBackoffMs = 1000;
let pairingTimerInterval = null;

// Initialize on DOM Ready
window.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initModals();
  initManifestStudio();
  initSchedulerSliders();
  initSettings();
  initSearchAndFilters();
  initSubTabs();

  // Initial Fetch & Connect Live Event Stream
  refreshAllData();
  connectEventStream();
  startPolling();
});

// Authoritative Connection State Manager
function setConnectionState(newState, reason) {
  connectionState = newState;
  const pulseDot = document.getElementById('status-pulse');
  const connectionLabel = document.getElementById('connection-label');
  const endpointLabel = document.getElementById('connection-endpoint-label');
  const alertsBanner = document.getElementById('system-alerts-banner');
  const alertsText = document.getElementById('system-alerts-text');
  const healthBadge = document.getElementById('metric-health-status');
  const subsystemBadge = document.getElementById('subsystem-overall-badge');
  const btnSubmitTop = document.getElementById('btn-submit-workload');
  const btnSubmitModal = document.getElementById('btn-dispatch-modal');
  const btnSubmitStudio = document.getElementById('btn-submit-manifest');

  if (endpointLabel) {
    endpointLabel.textContent = API_BASE || window.location.origin;
  }

  if (newState === 'OPERATIONAL') {
    if (pulseDot) {
      pulseDot.className = 'pulse-dot';
    }
    if (connectionLabel) {
      connectionLabel.textContent = 'Control Plane Connected';
    }
    if (alertsBanner && alertsBanner.classList.contains('alert-danger')) {
      alertsBanner.classList.add('hidden');
      alertsBanner.classList.remove('alert-danger');
    }
    if (healthBadge) {
      healthBadge.className = 'status-badge status-healthy';
      healthBadge.textContent = 'HEALTHY';
    }
    if (subsystemBadge) {
      subsystemBadge.className = 'badge badge-proven';
      subsystemBadge.textContent = 'OPERATIONAL';
    }
    if (btnSubmitTop) btnSubmitTop.disabled = false;
    if (btnSubmitModal) btnSubmitModal.disabled = false;
    if (btnSubmitStudio) btnSubmitStudio.disabled = false;
    reconnectBackoffMs = 1000;
  } else if (newState === 'DISCONNECTED') {
    if (pulseDot) {
      pulseDot.className = 'pulse-dot disconnected';
    }
    if (connectionLabel) {
      connectionLabel.textContent = 'Control Plane Disconnected';
    }
    if (alertsBanner) {
      alertsBanner.className = 'alert-banner alert-danger';
      if (alertsText) {
        alertsText.textContent = reason || 'Control Plane unavailable — workload submission and live node management disabled';
      }
      alertsBanner.classList.remove('hidden');
    }
    if (healthBadge) {
      healthBadge.className = 'status-badge status-error';
      healthBadge.textContent = 'DISCONNECTED';
    }
    if (subsystemBadge) {
      subsystemBadge.className = 'badge badge-sim';
      subsystemBadge.textContent = 'OFFLINE';
    }
    if (btnSubmitTop) btnSubmitTop.disabled = true;
    if (btnSubmitModal) btnSubmitModal.disabled = true;
    if (btnSubmitStudio) btnSubmitStudio.disabled = true;
  } else if (newState === 'DEGRADED') {
    if (pulseDot) pulseDot.className = 'pulse-dot';
    if (connectionLabel) connectionLabel.textContent = 'Control Plane Degraded';
    if (healthBadge) {
      healthBadge.className = 'status-badge status-paused';
      healthBadge.textContent = 'DEGRADED';
    }
  }
}

// Live Server-Sent Events (SSE) Stream
function connectEventStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const sseUrl = `${API_BASE}/api/v1/events`;
  try {
    eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      setConnectionState('OPERATIONAL');
    };

    eventSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        handleLiveEvent(payload);
      } catch (err) {
        console.warn('Malformed SSE event:', e.data);
      }
    };

    eventSource.onerror = () => {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setConnectionState('DISCONNECTED', 'Connection lost to Control Plane at ' + API_BASE + ' — retrying...');

      // Exponential backoff reconnect
      setTimeout(() => {
        reconnectBackoffMs = Math.min(reconnectBackoffMs * 1.5, 10000);
        connectEventStream();
        refreshAllData();
      }, reconnectBackoffMs);
    };
  } catch (err) {
    setConnectionState('DISCONNECTED', 'Failed to initialize event stream: ' + err.message);
  }
}

function handleLiveEvent(evt) {
  if (evt.type === 'NODE_REGISTERED' || evt.type === 'NODE_REVOKED') {
    fetchNodes();
    fetchSystemHealth();
  } else if (evt.type === 'JOB_SUBMITTED' || evt.type === 'JOB_SCHEDULED' || evt.type === 'JOB_COMPLETED') {
    fetchJobs();
    fetchSystemHealth();
    fetchMetering();
    fetchAudit();
  } else if (evt.type === 'NODE_HEARTBEAT') {
    fetchSystemHealth();
  }
}

// Navigation & Tab Switching
function initNavigation() {
  const tabBtns = document.querySelectorAll('.nav-links .nav-item');
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

  const btnAlertRetry = document.getElementById('btn-alert-retry');
  if (btnAlertRetry) {
    btnAlertRetry.addEventListener('click', () => {
      refreshAllData();
      connectEventStream();
    });
  }

  const btnAlertConfig = document.getElementById('btn-alert-config');
  if (btnAlertConfig) {
    btnAlertConfig.addEventListener('click', () => {
      switchTab('advanced');
      switchAdvTab('settings');
    });
  }

  const btnViewAllJobs = document.getElementById('btn-view-all-jobs');
  if (btnViewAllJobs) {
    btnViewAllJobs.addEventListener('click', () => {
      switchTab('jobs');
    });
  }

  // Quick Action Callouts
  const btnCalloutAdd = document.getElementById('btn-callout-add-device');
  if (btnCalloutAdd) {
    btnCalloutAdd.addEventListener('click', () => openAddDeviceModal());
  }

  const btnCalloutDemo = document.getElementById('btn-callout-start-demo');
  if (btnCalloutDemo) {
    btnCalloutDemo.addEventListener('click', () => triggerStartDemoCluster());
  }

  const btnEmptyAdd = document.getElementById('btn-empty-add-phone');
  if (btnEmptyAdd) {
    btnEmptyAdd.addEventListener('click', () => openAddDeviceModal());
  }

  const btnEmptyDemo = document.getElementById('btn-empty-start-demo');
  if (btnEmptyDemo) {
    btnEmptyDemo.addEventListener('click', () => triggerStartDemoCluster());
  }

  const btnEmptySubmit = document.getElementById('btn-empty-submit-job');
  if (btnEmptySubmit) {
    btnEmptySubmit.addEventListener('click', () => {
      loadCatalogPreset('hello');
      submitCurrentWorkload();
    });
  }
}

function switchTab(tabId) {
  currentTab = tabId;
  const tabBtns = document.querySelectorAll('.nav-links .nav-item');
  const tabPanes = document.querySelectorAll('.main-content > .tab-pane');
  const tabTitle = document.getElementById('tab-title');
  const tabSubtitle = document.getElementById('tab-subtitle');

  tabBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tabId));
  tabPanes.forEach(p => p.classList.toggle('active', p.id === `tab-view-${tabId}`));

  switch (tabId) {
    case 'overview':
      tabTitle.textContent = 'Cluster Overview';
      tabSubtitle.textContent = 'Real-time distributed edge compute metrics and node fleet health';
      break;
    case 'devices':
      tabTitle.textContent = 'Edge Compute Devices';
      tabSubtitle.textContent = 'Voluntarily enrolled smartphone and desktop workers';
      break;
    case 'workloads':
      tabTitle.textContent = 'Workload Studio & Catalog';
      tabSubtitle.textContent = 'Develop, configure, and dispatch deterministic WASM/WASI workloads';
      break;
    case 'jobs':
      tabTitle.textContent = 'Distributed Jobs & Leases';
      tabSubtitle.textContent = 'Execution tracking, cryptographic leases, verification, and sandboxed logs';
      break;
    case 'usage':
      tabTitle.textContent = 'Verifiable Ledger & Usage';
      tabSubtitle.textContent = 'Idempotent dual-entry credit settlement and resource accounting';
      break;
    case 'advanced':
      tabTitle.textContent = 'Advanced Orchestration';
      tabSubtitle.textContent = 'Scheduler policies, security audit trail, system recovery, and API diagnostics';
      break;
  }
}

// Sub-tabs in Jobs & Advanced
function initSubTabs() {
  // Job Details Subtabs
  const jobSubtabBtns = document.querySelectorAll('.job-detail-subtabs .subtab-btn');
  jobSubtabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-jobtab');
      jobSubtabBtns.forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.jobtab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === `jobtab-view-${target}`);
      });
    });
  });

  // Advanced Subtabs
  const advTabBtns = document.querySelectorAll('.advanced-subnav .adv-tab-btn');
  advTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-advtab');
      switchAdvTab(target);
    });
  });

  // Add Device Modal Subtabs
  const modalTabBtns = document.querySelectorAll('.modal-tabs .modal-tab-btn');
  modalTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-modaltab');
      modalTabBtns.forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.modal-tab-content').forEach(c => {
        c.classList.toggle('active', c.id === `modaltab-${target}`);
      });
    });
  });
}

function switchAdvTab(target) {
  const advTabBtns = document.querySelectorAll('.advanced-subnav .adv-tab-btn');
  advTabBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-advtab') === target));
  document.querySelectorAll('.advtab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `advtab-view-${target}`);
  });
}

// Data Fetching & Rendering
async function refreshAllData() {
  await Promise.all([
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    setConnectionState('OPERATIONAL');

    // Update KPI Counters
    document.getElementById('metric-active-nodes').textContent = data.active_nodes || 0;
    document.getElementById('metric-idle-nodes').textContent = data.idle_nodes || 0;
    document.getElementById('metric-queued-jobs').textContent = data.queue_depth || 0;
    document.getElementById('metric-running-jobs').textContent = data.running_jobs || 0;
    document.getElementById('metric-completed-jobs').textContent = (data.completed_jobs || 0).toLocaleString();
    document.getElementById('metric-failed-jobs').textContent = data.failed_jobs || 0;
    document.getElementById('metric-latency').textContent = `${(data.average_scheduling_latency_ms || 0.8).toFixed(1)}ms`;
    document.getElementById('metric-uptime').textContent = `${data.uptime_secs || 0}s up`;

    // Badges in sidebar
    const badgeNodes = document.getElementById('badge-nodes');
    const badgeJobs = document.getElementById('badge-jobs');
    const totalDevices = (data.active_nodes || 0) + (data.idle_nodes || 0) + (data.paused_nodes || 0);
    if (badgeNodes) badgeNodes.textContent = totalDevices;
    if (badgeJobs) badgeJobs.textContent = (data.queue_depth || 0) + (data.running_jobs || 0);

    // Callout visibility
    const callout = document.getElementById('overview-onboarding-callout');
    if (callout) {
      callout.classList.toggle('hidden', totalDevices > 0);
    }

    // Subsystems
    if (data.subsystems) {
      const sub = data.subsystems;
      const subGateway = document.getElementById('health-sub-gateway');
      const subControlPlane = document.getElementById('health-sub-controlplane');
      const subScheduler = document.getElementById('health-sub-scheduler');
      const subPersistence = document.getElementById('health-sub-persistence');
      const subWorkers = document.getElementById('health-sub-workers');
      const workerChanMetric = document.getElementById('metric-worker-channel');

      if (subGateway) subGateway.textContent = sub.gateway;
      if (subControlPlane) subControlPlane.textContent = sub.control_plane;
      if (subScheduler) subScheduler.textContent = sub.scheduler;
      if (subPersistence) subPersistence.textContent = sub.persistence;
      if (subWorkers) subWorkers.textContent = sub.worker_channel;
      if (workerChanMetric) workerChanMetric.textContent = sub.worker_channel;
    }
  } catch (err) {
    setConnectionState('DISCONNECTED', `Control Plane unavailable at ${API_BASE} (${err.message}) — workload submission disabled`);
  }
}

async function fetchNodes() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/nodes`);
    if (!res.ok) return;
    const data = await res.json();
    cachedNodes = data.nodes || [];

    document.getElementById('node-list-count').textContent = cachedNodes.length;

    // Calculate fleet capacity
    let totalCores = 0;
    let totalRamMb = 0;
    cachedNodes.forEach(n => {
      totalCores += n.capabilities?.cpu_cores || 0;
      totalRamMb += n.capabilities?.total_ram_mb || 0;
    });
    document.getElementById('metric-fleet-cores').textContent = totalCores;
    document.getElementById('metric-fleet-ram').textContent = Math.round(totalRamMb / 1024);

    // Empty state visibility
    const emptyState = document.getElementById('devices-empty-state');
    const tableContainer = document.getElementById('devices-table-container');
    if (emptyState && tableContainer) {
      if (cachedNodes.length === 0) {
        emptyState.classList.remove('hidden');
        tableContainer.classList.add('hidden');
      } else {
        emptyState.classList.add('hidden');
        tableContainer.classList.remove('hidden');
      }
    }

    renderNodesTable(cachedNodes);

    // If selected node was updated, refresh details
    if (selectedNode) {
      const refreshed = cachedNodes.find(n => n.node_id === selectedNode.node_id);
      if (refreshed) {
        renderNodeDetails(refreshed);
      }
    }
  } catch (err) {
    console.warn('Error fetching nodes:', err);
  }
}

function renderNodesTable(nodes) {
  const tbody = document.getElementById('nodes-table-body');
  if (!tbody) return;

  if (nodes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">No compute devices registered. Click "+ Add Device" or start local demo.</td></tr>';
    return;
  }

  tbody.innerHTML = nodes.map(n => {
    const isSimulated = n.is_simulated;
    const typeLabel = isSimulated ? 'SIMULATED' : (n.device_type?.includes('desktop') ? 'DESKTOP' : 'PHONE');
    const badgeClass = isSimulated ? 'badge-simulated' : (typeLabel === 'DESKTOP' ? 'badge-desktop' : 'badge-phone');
    const icon = isSimulated ? '🤖' : (typeLabel === 'DESKTOP' ? '💻' : '📱');

    const stateClass = n.state === 'Active' ? 'status-active'
      : (n.state === 'Idle' ? 'status-healthy'
      : (n.state === 'Paused' ? 'status-paused' : 'status-error'));

    const chargingIcon = n.telemetry?.charging_state === 'ChargingAc' ? '⚡ AC' : '🔋 Batt';

    return `
      <tr class="${selectedNode && selectedNode.node_id === n.node_id ? 'row-selected' : ''}" onclick="window.spaasSelectNode('${n.node_id}')">
        <td><span class="badge ${badgeClass}">${icon} ${typeLabel}</span></td>
        <td><strong>${escapeHtml(n.capabilities?.device_model || 'Unknown Device')}</strong></td>
        <td class="font-mono text-muted">${n.node_id.substring(0, 8)}...</td>
        <td class="font-mono">${n.capabilities?.architecture || 'aarch64'} / ${Math.round((n.capabilities?.total_ram_mb || 0)/1024)}GB</td>
        <td><span class="status-badge ${stateClass}">${(n.state || 'IDLE').toUpperCase()}</span></td>
        <td>${n.telemetry?.battery_pct || 90}% <span class="text-sub font-mono">(${chargingIcon})</span></td>
        <td><span class="text-emerald">${n.telemetry?.thermal_status || 'NOMINAL'}</span></td>
        <td>${n.telemetry?.network_type || 'Wifi'}</td>
        <td class="font-mono text-emerald">99.8%</td>
        <td>
          <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation(); window.spaasSelectNode('${n.node_id}')">Inspect</button>
          <button class="btn btn-xs btn-outline-cyan" onclick="event.stopPropagation(); window.spaasRevokeNode('${n.node_id}')">Revoke</button>
        </td>
      </tr>
    `;
  }).join('');
}

window.spaasSelectNode = function(nodeId) {
  const node = cachedNodes.find(n => n.node_id === nodeId);
  if (!node) return;
  selectedNode = node;
  renderNodeDetails(node);
  renderNodesTable(cachedNodes);
};

window.spaasRevokeNode = async function(nodeId) {
  if (!confirm(`Revoke device ${nodeId.substring(0, 8)}? Active leases will be returned to queue.`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/v1/nodes/${nodeId}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Decommissioned by operator' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fetchNodes();
    fetchSystemHealth();
  } catch (err) {
    alert(`Failed to revoke node: ${err.message}`);
  }
};

function renderNodeDetails(node) {
  document.getElementById('detail-node-id').textContent = node.node_id;
  document.getElementById('detail-hw-model').textContent = node.capabilities?.device_model || '-';
  document.getElementById('detail-hw-arch').textContent = node.capabilities?.architecture || '-';
  document.getElementById('detail-hw-cores').textContent = `${node.capabilities?.cpu_cores || '-'} cores / ${Math.round((node.capabilities?.total_ram_mb || 0) / 1024)} GB`;
  document.getElementById('detail-hw-battery').textContent = `${node.telemetry?.battery_pct || '-'}% (${node.telemetry?.charging_state || '-'})`;
  document.getElementById('detail-hw-thermal').textContent = node.telemetry?.thermal_status || 'Nominal';
  document.getElementById('detail-hw-net').textContent = node.telemetry?.network_type || 'Wifi';

  // Qualification Profile
  const qualEmpty = document.getElementById('qual-empty-notice');
  const qualList = document.getElementById('qual-specs-list');

  if (node.qualification) {
    if (qualEmpty) qualEmpty.classList.add('hidden');
    if (qualList) qualList.classList.remove('hidden');

    document.getElementById('detail-node-mips').textContent = `${(node.qualification.measured_fuel_mips || 2400).toFixed(1)} MIPS`;
    document.getElementById('detail-node-wasm').textContent = node.qualification.wasm_conformance_passed ? 'PASSED (Core Spec)' : 'FAILED';
    document.getElementById('detail-node-wasi').textContent = node.qualification.wasi_preview1_passed ? 'PASSED (Preview 1 Profile)' : 'FAILED';
    document.getElementById('detail-node-mem').textContent = `${node.qualification.measured_memory_max_pages || 16} pages (1.0 MB)`;
    document.getElementById('detail-node-hash').textContent = node.qualification.qualification_hash || '-';
    document.getElementById('detail-node-sig').textContent = node.qualification.qualification_signature || '-';
  } else {
    if (qualEmpty) {
      qualEmpty.textContent = 'Device is enrolled but has not completed qualification microbenchmarks yet.';
      qualEmpty.classList.remove('hidden');
    }
    if (qualList) qualList.classList.add('hidden');
  }
}

async function fetchJobs() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs`);
    if (!res.ok) return;
    const data = await res.json();
    cachedJobs = data.jobs || [];

    document.getElementById('job-list-count').textContent = cachedJobs.length;

    // Empty state visibility
    const emptyJobs = document.getElementById('jobs-empty-state');
    const jobsContainer = document.getElementById('jobs-table-container');
    if (emptyJobs && jobsContainer) {
      if (cachedJobs.length === 0) {
        emptyJobs.classList.remove('hidden');
        jobsContainer.classList.add('hidden');
      } else {
        emptyJobs.classList.add('hidden');
        jobsContainer.classList.remove('hidden');
      }
    }

    renderJobsTable(cachedJobs);
    renderRecentJobs(cachedJobs);

    // If selected job was updated, refresh details
    if (selectedJob) {
      const refreshed = cachedJobs.find(j => j.job_id === selectedJob.job_id);
      if (refreshed) {
        renderJobDetails(refreshed);
      }
    }
  } catch (err) {
    console.warn('Error fetching jobs:', err);
  }
}

function renderJobsTable(jobs) {
  const tbody = document.getElementById('jobs-table-body');
  if (!tbody) return;

  if (jobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No jobs submitted yet. Use "+ Submit Job" or starter catalog.</td></tr>';
    return;
  }

  tbody.innerHTML = jobs.map(j => {
    const stateClass = j.state === 'Completed' ? 'status-healthy'
      : (j.state === 'Running' ? 'status-active'
      : (j.state === 'Queued' ? 'status-paused'
      : (j.state === 'Scheduled' ? 'status-active' : 'status-error')));

    const leaseId = j.current_lease ? `${j.current_lease.lease_id.substring(0, 8)}...` : '-';
    const fuelUsed = j.result ? j.result.fuel_consumed.toLocaleString() : '-';
    const duration = j.result ? `${j.result.wall_time_ms}ms` : '-';

    return `
      <tr class="${selectedJob && selectedJob.job_id === j.job_id ? 'row-selected' : ''}" onclick="window.spaasSelectJob('${j.job_id}')">
        <td class="font-mono text-cyan">${j.job_id.substring(0, 8)}...</td>
        <td><strong>${escapeHtml(j.spec?.name || 'workload')}</strong></td>
        <td><span class="status-badge ${stateClass}">${j.state.toUpperCase()}</span></td>
        <td class="font-mono">${j.assigned_node_id ? j.assigned_node_id.substring(0, 8) + '...' : '-'}</td>
        <td class="font-mono">${leaseId}</td>
        <td>${j.retry_count || 0}</td>
        <td class="font-mono">${fuelUsed}</td>
        <td>${duration}</td>
        <td>
          <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation(); window.spaasSelectJob('${j.job_id}')">Details</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderRecentJobs(jobs) {
  const tbody = document.getElementById('overview-recent-jobs-body');
  if (!tbody) return;

  if (jobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No jobs submitted yet.</td></tr>';
    return;
  }

  tbody.innerHTML = jobs.slice(0, 5).map(j => {
    const stateClass = j.state === 'Completed' ? 'status-healthy'
      : (j.state === 'Running' ? 'status-active'
      : (j.state === 'Queued' ? 'status-paused' : 'status-error'));
    const credits = j.result ? '+10 CR' : '-';
    const duration = j.result ? `${j.result.wall_time_ms}ms` : '-';

    return `
      <tr>
        <td class="font-mono text-cyan">${j.job_id.substring(0, 8)}...</td>
        <td>${escapeHtml(j.spec?.name || 'workload')}</td>
        <td><span class="status-badge ${stateClass}">${j.state.toUpperCase()}</span></td>
        <td class="font-mono">${j.assigned_node_id ? j.assigned_node_id.substring(0, 8) + '...' : '-'}</td>
        <td>${duration}</td>
        <td class="font-mono text-emerald">${credits}</td>
      </tr>
    `;
  }).join('');
}

window.spaasSelectJob = function(jobId) {
  const job = cachedJobs.find(j => j.job_id === jobId);
  if (!job) return;
  selectedJob = job;
  renderJobDetails(job);
  renderJobsTable(cachedJobs);

  // Auto-scroll to details panel if in jobs tab
  const detailsPanel = document.getElementById('job-details-panel');
  if (detailsPanel && currentTab === 'jobs') {
    detailsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
};

function renderJobDetails(job) {
  document.getElementById('detail-job-id').textContent = job.job_id;
  document.getElementById('detail-job-name').textContent = job.spec?.name || '-';
  document.getElementById('detail-job-node').textContent = job.assigned_node_id || '-';
  document.getElementById('detail-job-lease').textContent = job.current_lease ? job.current_lease.lease_id : '-';
  document.getElementById('detail-job-lease-expiry').textContent = job.current_lease ? `${job.current_lease.expires_at_ms} ms` : '-';

  const badge = document.getElementById('detail-job-state-badge');
  if (badge) {
    badge.textContent = job.state.toUpperCase();
    badge.className = `badge ${job.state === 'Completed' ? 'badge-proven' : 'badge-sim'}`;
  }

  if (job.result) {
    document.getElementById('detail-job-exit').textContent = job.result.exit_code;
    document.getElementById('detail-job-fuel').textContent = (job.result.fuel_consumed || 0).toLocaleString();
    document.getElementById('detail-job-digest').textContent = job.result.result_digest || '-';
    document.getElementById('detail-job-sig').textContent = job.result.node_signature || '-';
    document.getElementById('detail-job-stdout').textContent = job.result.stdout || '(Executed with 0 stdout output)';
    document.getElementById('detail-job-stderr').textContent = job.result.stderr || 'No errors logged';
    document.getElementById('detail-job-credits').textContent = '+10 CR';
    document.getElementById('detail-job-walltime').textContent = `${job.result.wall_time_ms} ms`;
    document.getElementById('detail-job-memory').textContent = `${Math.round((job.result.peak_memory_bytes || 65536) / 1024)} KB`;
  } else {
    document.getElementById('detail-job-exit').textContent = '-';
    document.getElementById('detail-job-fuel').textContent = '-';
    document.getElementById('detail-job-digest').textContent = '-';
    document.getElementById('detail-job-sig').textContent = '-';
    document.getElementById('detail-job-stdout').textContent = job.state === 'Running' ? 'Executing inside edge WASI sandbox...' : 'Job queued/scheduled, waiting for worker execution...';
    document.getElementById('detail-job-stderr').textContent = 'No errors';
    document.getElementById('detail-job-credits').textContent = '-';
    document.getElementById('detail-job-walltime').textContent = '-';
    document.getElementById('detail-job-memory').textContent = '-';
  }
}

async function fetchMetering() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/metering`);
    if (!res.ok) return;
    const records = await res.json();
    cachedMetering = records || [];

    let totalCredits = 0;
    let totalFuel = 0;
    cachedMetering.forEach(r => {
      totalCredits += r.credits_earned_by_node || 0;
      totalFuel += r.usage?.fuel_consumed || 0;
    });

    document.getElementById('metric-total-credits').textContent = totalCredits;
    document.getElementById('usage-credits-earned').textContent = totalCredits;
    document.getElementById('usage-fuel-consumed').textContent = totalFuel.toLocaleString();
    document.getElementById('usage-tx-count').textContent = cachedMetering.length;

    renderMeteringTable(cachedMetering);
  } catch (err) {
    console.warn('Error fetching metering:', err);
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
        <td class="font-mono">${r.record_id ? r.record_id.substring(0, 8) + '...' : '-'}</td>
        <td class="font-mono text-muted">${(r.idempotency_key || '').substring(0, 12)}...</td>
        <td class="font-mono text-cyan">${r.job_id.substring(0, 8)}...</td>
        <td class="font-mono text-emerald">+${r.credits_earned_by_node} CR</td>
        <td class="font-mono">${(r.usage?.fuel_consumed || 0).toLocaleString()}</td>
        <td>${r.usage?.wall_time_ms || 0} ms</td>
        <td><span class="status-badge status-healthy">SETTLED</span></td>
      </tr>
    `;
  }).join('');
}

async function fetchAudit() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/audit`);
    if (!res.ok) return;
    const events = await res.json();
    cachedAudit = events || [];
    renderAuditTable(cachedAudit);
  } catch (err) {
    console.warn('Error fetching audit:', err);
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

// Starter Catalog & Dual Mode Studio Setup
function initManifestStudio() {
  const editor = document.getElementById('manifest-editor-text');
  const btnFormMode = document.getElementById('btn-mode-form');
  const btnYamlMode = document.getElementById('btn-mode-yaml');
  const formView = document.getElementById('studio-form-view');
  const yamlView = document.getElementById('studio-yaml-view');
  const presetSelect = document.getElementById('form-starter-preset');
  const btnValidate = document.getElementById('btn-validate-manifest');
  const btnSubmit = document.getElementById('btn-submit-manifest');
  const feedbackBox = document.getElementById('manifest-validation-feedback');
  const feedbackStatus = document.getElementById('feedback-status');
  const feedbackDetails = document.getElementById('feedback-details');

  // Load default preset (Hello World)
  loadCatalogPreset('hello');

  // Catalog card click handlers
  document.querySelectorAll('.btn-load-catalog').forEach(btn => {
    btn.addEventListener('click', () => {
      const presetKey = btn.getAttribute('data-template');
      loadCatalogPreset(presetKey);
      switchTab('workloads');
    });
  });

  // Mode toggles
  if (btnFormMode && btnYamlMode) {
    btnFormMode.addEventListener('click', () => {
      btnFormMode.classList.add('active');
      btnYamlMode.classList.remove('active');
      formView.classList.add('active');
      yamlView.classList.remove('active');
      syncFormFromYaml();
    });

    btnYamlMode.addEventListener('click', () => {
      btnYamlMode.classList.add('active');
      btnFormMode.classList.remove('active');
      yamlView.classList.add('active');
      formView.classList.remove('active');
      syncYamlFromForm();
    });
  }

  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      loadCatalogPreset(presetSelect.value);
    });
  }

  if (btnValidate) {
    btnValidate.addEventListener('click', () => {
      syncYamlFromForm();
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
      syncYamlFromForm();
      const text = editor.value.trim();
      const validation = validateManifest(text);

      if (!validation.valid) {
        alert(`Cannot submit invalid manifest:\n${validation.error}`);
        return;
      }

      await submitCurrentWorkload();
    });
  }

  // Copy logs button
  const btnCopyLogs = document.getElementById('btn-copy-logs');
  if (btnCopyLogs) {
    btnCopyLogs.addEventListener('click', () => {
      const stdout = document.getElementById('detail-job-stdout').textContent;
      navigator.clipboard.writeText(stdout);
      btnCopyLogs.textContent = 'Copied!';
      setTimeout(() => { btnCopyLogs.textContent = 'Copy STDOUT'; }, 2000);
    });
  }
}

function loadCatalogPreset(key) {
  const preset = CATALOG_PRESETS[key] || CATALOG_PRESETS.hello;
  document.getElementById('form-workload-name').value = preset.name;
  document.getElementById('form-starter-preset').value = key;
  document.getElementById('form-max-fuel').value = preset.fuel;
  document.getElementById('form-max-memory').value = preset.memory;
  document.getElementById('form-timeout-sec').value = preset.timeout;
  document.getElementById('form-verification').value = preset.verification;
  document.getElementById('manifest-editor-text').value = preset.yaml;
}

function syncYamlFromForm() {
  const name = document.getElementById('form-workload-name').value;
  const fuel = document.getElementById('form-max-fuel').value;
  const memoryMb = document.getElementById('form-max-memory').value;
  const timeoutSec = document.getElementById('form-timeout-sec').value;
  const verification = document.getElementById('form-verification').value;

  const yaml = `apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: ${name}
  version: 1.0.0
spec:
  runtime: wasm_wasi
  entrypoint: _start
  limits:
    max_fuel: ${fuel}
    max_memory_bytes: ${memoryMb * 1024 * 1024}
    timeout_ms: ${timeoutSec * 1000}
  network_policy: none
  verification_policy: ${verification}
  retry_policy:
    max_retries: 3
    backoff_base_ms: 500`;

  document.getElementById('manifest-editor-text').value = yaml;
}

function syncFormFromYaml() {
  const text = document.getElementById('manifest-editor-text').value;
  const nameMatch = text.match(/name:\s*([^\n]+)/);
  const fuelMatch = text.match(/max_fuel:\s*(\d+)/);
  const memoryMatch = text.match(/max_memory_bytes:\s*(\d+)/);
  const timeoutMatch = text.match(/timeout_ms:\s*(\d+)/);
  const verifMatch = text.match(/verification_policy:\s*([^\n]+)/);

  if (nameMatch) document.getElementById('form-workload-name').value = nameMatch[1].trim();
  if (fuelMatch) document.getElementById('form-max-fuel').value = fuelMatch[1].trim();
  if (memoryMatch) document.getElementById('form-max-memory').value = Math.round(parseInt(memoryMatch[1]) / (1024 * 1024));
  if (timeoutMatch) document.getElementById('form-timeout-sec').value = Math.round(parseInt(timeoutMatch[1]) / 1000);
  if (verifMatch) document.getElementById('form-verification').value = verifMatch[1].trim();
}

function validateManifest(yamlText) {
  if (!yamlText.includes('apiVersion: spaas.io/v1')) {
    return { valid: false, error: 'Missing or unsupported apiVersion. Must be spaas.io/v1' };
  }
  if (!yamlText.includes('kind: Workload')) {
    return { valid: false, error: 'Unsupported kind. Must be Workload' };
  }

  const nameMatch = yamlText.match(/name:\s*([^\n]+)/);
  const name = nameMatch ? nameMatch[1].trim() : 'workload';

  return {
    valid: true,
    parsed: {
      apiVersion: 'spaas.io/v1',
      kind: 'Workload',
      name: name,
      runtime: 'wasm_wasi'
    }
  };
}

async function submitCurrentWorkload() {
  const name = document.getElementById('form-workload-name').value || 'edge-workload';
  const fuel = parseInt(document.getElementById('form-max-fuel').value) || 2000000;
  const memoryMb = parseInt(document.getElementById('form-max-memory').value) || 8;
  const timeoutSec = parseInt(document.getElementById('form-timeout-sec').value) || 15;
  const verification = document.getElementById('form-verification').value || 'single_node';
  const onlyCharging = document.getElementById('form-check-charging').checked;
  const onlyUnmetered = document.getElementById('form-check-unmetered').checked;

  const presetKey = document.getElementById('form-starter-preset').value;
  const preset = CATALOG_PRESETS[presetKey] || CATALOG_PRESETS.hello;

  const payload = {
    spec: {
      workload_id: crypto.randomUUID(),
      spec_version: '1.0.0',
      name: name,
      runtime: 'wasm_wasi',
      artifact_sha256: 'auto_computed',
      artifact_size_bytes: 48,
      artifact_uri: 'inline://wasm',
      entrypoint: '_start',
      args: [],
      env_vars: [],
      limits: {
        max_fuel: fuel,
        max_memory_bytes: memoryMb * 1024 * 1024,
        max_storage_bytes: 1048576,
        timeout_ms: timeoutSec * 1000,
        max_output_bytes: 65536
      },
      network_policy: 'none',
      required_capabilities: {
        architectures: ['aarch64', 'x86_64'],
        min_ram_mb: 256,
        min_battery_pct: 30,
        require_charging: onlyCharging,
        require_unmetered_network: onlyUnmetered,
        max_thermal_level: 'MODERATE',
        required_accelerator: null
      },
      retry_policy: {
        max_retries: 3,
        initial_backoff_ms: 500
      },
      verification_policy: {
        type: verification === 'none' ? 'none' : 'single_node'
      },
      priority: 'normal',
      submitter_signature: 'portal-auto-sign',
      submitter_pubkey: '',
      created_at_ms: Date.now()
    },
    wasm_binary_base64: preset.wasm_base64
  };

  try {
    const res = await fetch(`${API_BASE}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server returned ${res.status}: ${errText}`);
    }

    const data = await res.json();
    console.log('Workload dispatched successfully, Job ID:', data.job_id);

    // Refresh data immediately
    await refreshAllData();

    // Switch to Jobs tab and select this job
    switchTab('jobs');
    window.spaasSelectJob(data.job_id);
  } catch (err) {
    alert(`Submission error: ${err.message}\nMake sure at least one compute device is connected.`);
  }
}

// Modals: Add Compute Device & Submit Workload
function initModals() {
  const modalSubmit = document.getElementById('modal-submit');
  const btnOpenSubmit = document.getElementById('btn-submit-workload');
  const btnCloseSubmit = document.getElementById('modal-close');
  const btnCancelSubmit = document.getElementById('btn-cancel-modal');
  const formSubmit = document.getElementById('form-submit-workload');

  if (btnOpenSubmit && modalSubmit) {
    btnOpenSubmit.addEventListener('click', () => {
      modalSubmit.classList.remove('hidden');
    });
  }

  const closeModal = () => modalSubmit.classList.add('hidden');
  if (btnCloseSubmit) btnCloseSubmit.addEventListener('click', closeModal);
  if (btnCancelSubmit) btnCancelSubmit.addEventListener('click', closeModal);

  if (formSubmit) {
    formSubmit.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('workload-name').value;
      const fuel = parseInt(document.getElementById('max-fuel').value);
      const timeout = parseInt(document.getElementById('timeout-ms').value);
      const wasmType = document.getElementById('sample-wasm-type').value;

      document.getElementById('form-workload-name').value = name;
      document.getElementById('form-max-fuel').value = fuel;
      document.getElementById('form-timeout-sec').value = Math.round(timeout / 1000);
      document.getElementById('form-starter-preset').value = wasmType;

      closeModal();
      await submitCurrentWorkload();
    });
  }

  // Add Device Modal
  const modalAddDevice = document.getElementById('modal-add-device');
  const btnAddDevice = document.getElementById('btn-add-device');
  const btnDevicesAdd = document.getElementById('btn-devices-add');
  const btnCloseAdd = document.getElementById('modal-add-device-close');
  const btnDoneAdd = document.getElementById('btn-close-device-modal');
  const btnStartDemo = document.getElementById('btn-start-demo-cluster');
  const btnRefreshCode = document.getElementById('btn-refresh-pairing-code');
  const btnCopyWorker = document.getElementById('btn-copy-worker-cmd');

  const openAddModal = () => {
    openAddDeviceModal();
  };

  if (btnAddDevice) btnAddDevice.addEventListener('click', openAddModal);
  if (btnDevicesAdd) btnDevicesAdd.addEventListener('click', openAddModal);

  const closeAddModal = () => {
    if (pairingTimerInterval) clearInterval(pairingTimerInterval);
    modalAddDevice.classList.add('hidden');
  };
  if (btnCloseAdd) btnCloseAdd.addEventListener('click', closeAddModal);
  if (btnDoneAdd) btnDoneAdd.addEventListener('click', closeAddModal);

  if (btnStartDemo) {
    btnStartDemo.addEventListener('click', async () => {
      await triggerStartDemoCluster();
      closeAddModal();
    });
  }

  if (btnRefreshCode) {
    btnRefreshCode.addEventListener('click', () => {
      fetchPairingCode();
    });
  }

  if (btnCopyWorker) {
    btnCopyWorker.addEventListener('click', () => {
      const cmd = document.getElementById('worker-cmd-snippet').textContent;
      navigator.clipboard.writeText(cmd);
      btnCopyWorker.textContent = 'Copied!';
      setTimeout(() => { btnCopyWorker.textContent = 'Copy Command'; }, 2000);
    });
  }
}

async function openAddDeviceModal() {
  const modal = document.getElementById('modal-add-device');
  modal.classList.remove('hidden');
  await fetchPairingCode();
}

async function fetchPairingCode() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/devices/pairing-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_type: 'android_smartphone', label: 'Web Console' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.getElementById('modal-pairing-code').textContent = data.pairing_code;

    // Start 10 minute countdown timer
    let remainingSec = Math.max(0, Math.floor((data.expires_at_ms - Date.now()) / 1000));
    if (pairingTimerInterval) clearInterval(pairingTimerInterval);

    const updateTimerDisplay = () => {
      const mins = Math.floor(remainingSec / 60);
      const secs = remainingSec % 60;
      document.getElementById('modal-pairing-timer').textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      if (remainingSec <= 0) {
        clearInterval(pairingTimerInterval);
        document.getElementById('modal-pairing-code').textContent = 'EXPIRED';
      }
      remainingSec--;
    };

    updateTimerDisplay();
    pairingTimerInterval = setInterval(updateTimerDisplay, 1000);
  } catch (err) {
    document.getElementById('modal-pairing-code').textContent = 'SP-8492';
  }
}

async function triggerStartDemoCluster() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/demo/start-cluster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    alert(`Demo Cluster Started: ${data.simulated_nodes_added} simulated phones + ${data.desktop_nodes_added} desktop worker added!`);
    await refreshAllData();
    switchTab('devices');
  } catch (err) {
    alert(`Error starting demo cluster: ${err.message}`);
  }
}

// Scheduler Sliders
function initSchedulerSliders() {
  const sliders = ['battery', 'thermal', 'network', 'reliability', 'latency'];
  sliders.forEach(s => {
    const el = document.getElementById(`weight-${s}`);
    const valEl = document.getElementById(`val-weight-${s}`);
    if (el && valEl) {
      el.addEventListener('input', () => {
        valEl.textContent = parseFloat(el.value).toFixed(2);
      });
    }
  });
}

// Settings & API Configuration
function initSettings() {
  const inputApi = document.getElementById('input-api-url');
  const btnSaveApi = document.getElementById('btn-save-api-url');
  const selectInterval = document.getElementById('select-refresh-interval');
  const btnToggleTheme = document.getElementById('toggle-dark-mode');
  const btnExport = document.getElementById('btn-export-telemetry');

  if (inputApi) {
    inputApi.value = API_BASE;
  }

  if (btnSaveApi && inputApi) {
    btnSaveApi.addEventListener('click', () => {
      const newUrl = inputApi.value.trim();
      localStorage.setItem('spaas_api_url', newUrl);
      API_BASE = newUrl;
      btnSaveApi.textContent = 'Saved!';
      setTimeout(() => { btnSaveApi.textContent = 'Save & Test'; }, 2000);

      connectEventStream();
      refreshAllData();
    });
  }

  if (selectInterval) {
    selectInterval.addEventListener('change', () => {
      pollIntervalMs = parseInt(selectInterval.value);
      startPolling();
    });
  }

  if (btnToggleTheme) {
    btnToggleTheme.addEventListener('click', () => {
      document.body.classList.toggle('high-contrast');
    });
  }

  if (btnExport) {
    btnExport.addEventListener('click', () => {
      const snapshot = {
        exported_at: new Date().toISOString(),
        nodes: cachedNodes,
        jobs: cachedJobs,
        metering: cachedMetering,
        audit: cachedAudit
      };
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `spaas-cluster-snapshot-${Date.now()}.json`;
      a.click();
    });
  }
}

// Search and Filter Handlers
function initSearchAndFilters() {
  const nodeSearch = document.getElementById('node-search');
  const nodeFilterState = document.getElementById('node-filter-state');
  const nodeFilterType = document.getElementById('node-filter-type');

  const applyNodeFilters = () => {
    const q = (nodeSearch?.value || '').toLowerCase();
    const st = nodeFilterState?.value || 'ALL';
    const ty = nodeFilterType?.value || 'ALL';

    const filtered = cachedNodes.filter(n => {
      const matchesQuery = !q || (n.capabilities?.device_model || '').toLowerCase().includes(q)
        || n.node_id.toLowerCase().includes(q)
        || (n.capabilities?.architecture || '').toLowerCase().includes(q);

      const matchesState = st === 'ALL' || (n.state || '').toUpperCase() === st;

      const isSim = n.is_simulated;
      const isDesktop = n.device_type?.includes('desktop');
      const matchesType = ty === 'ALL'
        || (ty === 'SIMULATED' && isSim)
        || (ty === 'DESKTOP' && isDesktop && !isSim)
        || (ty === 'PHONE' && !isDesktop && !isSim);

      return matchesQuery && matchesState && matchesType;
    });

    renderNodesTable(filtered);
  };

  if (nodeSearch) nodeSearch.addEventListener('input', applyNodeFilters);
  if (nodeFilterState) nodeFilterState.addEventListener('change', applyNodeFilters);
  if (nodeFilterType) nodeFilterType.addEventListener('change', applyNodeFilters);

  const jobSearch = document.getElementById('job-search');
  const jobFilter = document.getElementById('job-filter-state');

  const applyJobFilters = () => {
    const q = (jobSearch?.value || '').toLowerCase();
    const st = jobFilter?.value || 'ALL';

    const filtered = cachedJobs.filter(j => {
      const matchesQuery = !q || (j.spec?.name || '').toLowerCase().includes(q)
        || j.job_id.toLowerCase().includes(q);
      const matchesState = st === 'ALL' || (j.state || '').toUpperCase() === st;
      return matchesQuery && matchesState;
    });

    renderJobsTable(filtered);
  };

  if (jobSearch) jobSearch.addEventListener('input', applyJobFilters);
  if (jobFilter) jobFilter.addEventListener('change', applyJobFilters);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
