import test from "node:test";
import assert from "node:assert/strict";
import { SPaaSCoordinator } from "../src/coordinator.js";
import workerGateway from "../src/index.js";

const TEST_ADMIN_SECRET = "spaas_test_admin_secret_token_override";
const ADMIN_HEADERS = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${TEST_ADMIN_SECRET}`
};

test("SPaaSCoordinator — Public Health & System Diagnostics", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_CONTROL_PLANE_EPOCH: "1",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const healthRes = await coordinator.fetch(new Request("http://localhost/health"));
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.status, "healthy");
  assert.equal(health.role, "PRIMARY");
  assert.equal(health.epoch, 1);
  assert.equal(health.fabric_status, "ACTIVE");

  const sysHealthRes = await coordinator.fetch(new Request("http://localhost/api/v1/system/health"));
  assert.equal(sysHealthRes.status, 200);

  const diagRes = await coordinator.fetch(new Request("http://localhost/api/v1/system/diagnostics"));
  assert.equal(diagRes.status, 200);
  const diag = await diagRes.json();
  assert.ok(diag.primary_control_plane.includes("Cloudflare"));
  assert.equal(diag.node_counts.total, 0);

  const drRes = await coordinator.fetch(new Request("http://localhost/api/v1/dr/status"));
  assert.equal(drRes.status, 200);
  const dr = await drRes.json();
  assert.equal(dr.role, "PRIMARY");
  assert.equal(dr.status, "ACTIVE");
});

test("SPaaSCoordinator — Rate Limiting Enforcement", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_RATE_LIMIT_RPS: "1", // 60 requests per minute
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // Rapid requests from test IP
  const reqHeaders = { "CF-Connecting-IP": "198.51.100.42" };
  let limitedResponse = null;

  for (let i = 0; i < 65; i++) {
    const res = await coordinator.fetch(new Request("http://localhost/api/v1/system/diagnostics", {
      headers: reqHeaders
    }));
    if (res.status === 429) {
      limitedResponse = res;
      break;
    }
  }

  assert.ok(limitedResponse, "Expected rate limit 429 response when RPS threshold exceeded");
  assert.equal(limitedResponse.status, 429);
  assert.ok(limitedResponse.headers.get("Retry-After"));
  assert.equal(limitedResponse.headers.get("X-RateLimit-Remaining"), "0");
  const body = await limitedResponse.json();
  assert.equal(body.error, "RATE_LIMIT_EXCEEDED");
});

test("SPaaSCoordinator — Administrative Authentication Boundaries", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // 1. Admin-only endpoint WITHOUT auth header must be rejected with 401
  const unauthRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/fabric/pause", { method: "POST" })
  );
  assert.equal(unauthRes.status, 401);
  const unauth = await unauthRes.json();
  assert.equal(unauth.error, "UNAUTHORIZED");

  // 2. Admin-only endpoint with WRONG auth header must be rejected with 401
  const badAuthRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/fabric/pause", {
      method: "POST",
      headers: { "Authorization": "Bearer invalid_secret_token" }
    })
  );
  assert.equal(badAuthRes.status, 401);

  // 3. Enrollment endpoint is PUBLIC (no admin auth required)
  const publicRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/enrollment/create", { method: "POST" })
  );
  assert.equal(publicRes.status, 200);
  const enrollData = await publicRes.json();
  assert.ok(enrollData.pairing_code.startsWith("SP-"));
  assert.ok(enrollData.opaque_credential);

  // 4. Admin-only endpoint with VALID auth header succeeds
  const validRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/fabric/pause", {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(validRes.status, 200);
});

test("SPaaSCoordinator — Single-Use Pairing Tokens & Device Registration", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Issue enrollment session (public endpoint, no admin auth needed)
  const tokenRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/enrollment/create", {
      method: "POST"
    })
  );
  assert.equal(tokenRes.status, 200);
  const enrollData = await tokenRes.json();
  const shortCode = enrollData.pairing_code || enrollData.short_code;
  const opaqueToken = enrollData.opaque_credential || enrollData.token;
  assert.ok(shortCode.startsWith("SP-"), `Short code should start with SP-, got: ${shortCode}`);
  assert.ok(opaqueToken.length > 10, "Opaque credential should be a UUID");
  assert.ok(enrollData.expires_at_ms > Date.now(), "Expiry must be in the future");
  assert.equal(enrollData.ttl_seconds, 600, "TTL should be 10 minutes");

  // 2. Pair a new Android phone using the opaque credential
  const pairPayload = {
    pairing_token: opaqueToken,
    node_id: "phone-pixel-test-01",
    device_name: "Pixel 8 Pro (Test)",
    device_type: "Phone",
    public_key: "ed25519_pk_test_123"
  };

  const pairRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pairPayload)
    })
  );
  assert.equal(pairRes.status, 200);
  const pair = await pairRes.json();
  assert.equal(pair.status, "approved");
  assert.equal(pair.node_id, "phone-pixel-test-01");
  assert.ok(pair.auth_token.startsWith("spaas_auth_"));
  assert.equal(pair.epoch, 1);

  // 3. Replaying the consumed pairing token must be rejected
  const replayRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pairPayload)
    })
  );
  assert.equal(replayRes.status, 400);
  const replay = await replayRes.json();
  assert.equal(replay.error, "TOKEN_ALREADY_CONSUMED");

  // 4. Verify node exists in fleet and auth_token is redacted
  const nodeRes = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/phone-pixel-test-01"));
  assert.equal(nodeRes.status, 200);
  const node = await nodeRes.json();
  assert.equal(node.name, "Pixel 8 Pro (Test)");
  assert.equal(node.state, "Ready");
  assert.equal(node.auth_token, undefined, "Sensitive device auth token must be redacted from fleet API");
});

test("SPaaSCoordinator — Device Authentication for Heartbeat & Results", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // Enroll device
  const token = (await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST", headers: ADMIN_HEADERS })
  )).json()).token;

  const pairRes = await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: token,
        node_id: "phone-worker-01",
        device_name: "Galaxy S24",
        device_type: "Phone",
        public_key: "ed25519_pk_s24"
      })
    })
  )).json();

  const deviceAuthToken = pairRes.auth_token;
  assert.ok(deviceAuthToken);

  // 1. Heartbeat WITHOUT device auth token must be rejected
  const unauthHb = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: "phone-worker-01" })
    })
  );
  assert.equal(unauthHb.status, 401);

  // 2. Heartbeat WITH valid device auth token succeeds
  const authHb = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceAuthToken}`
      },
      body: JSON.stringify({
        node_id: "phone-worker-01",
        telemetry: { battery_level: 95, temperature_c: 29.5 }
      })
    })
  );
  assert.equal(authHb.status, 200);
  const hbData = await authHb.json();
  assert.equal(hbData.status, "ok");

  // 3. Polling with device auth
  const pollRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/phone-worker-01/poll", {
      headers: { "Authorization": `Bearer ${deviceAuthToken}` }
    })
  );
  assert.equal(pollRes.status, 200);
});

test("SPaaSCoordinator — Workload Submission, Placement & Dynamic Settlement", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // Enroll ready node
  const tok = (await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST", headers: ADMIN_HEADERS })
  )).json()).token;

  const pairData = await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: tok,
        node_id: "node-desktop-compute-01",
        device_name: "Desktop Ryzen 9",
        device_type: "Desktop",
        public_key: "ed25519_desktop_key"
      })
    })
  )).json();
  const deviceAuthToken = pairData.auth_token;

  // Submit job (authenticated with X-Correlation-ID)
  const submitRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "X-Correlation-ID": "corr-matrix-test-999" },
      body: JSON.stringify({
        job_id: "job-matrix-wasm-001",
        workload_id: "matrix_compute"
      })
    })
  );
  assert.equal(submitRes.status, 201);
  const job = await submitRes.json();
  assert.equal(job.id, "job-matrix-wasm-001");
  assert.equal(job.state, "Running");
  assert.equal(job.assigned_node_id, "node-desktop-compute-01");
  assert.equal(job.correlation_id, "corr-matrix-test-999");
  assert.ok(job.fencing_token);

  // Submit result with valid device auth and correct fencing token
  const resultRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/results", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceAuthToken}`
      },
      body: JSON.stringify({
        job_id: "job-matrix-wasm-001",
        node_id: "node-desktop-compute-01",
        fencing_token: job.fencing_token,
        exit_code: 0,
        stdout: "Computed 8192 FLOPs",
        fuel_used: 1500000
      })
    })
  );
  assert.equal(resultRes.status, 200);
  const result = await resultRes.json();
  assert.equal(result.status, "accepted");
  assert.equal(result.correlation_id, "corr-matrix-test-999");
  assert.ok(result.credits_settled > 0);

  // Invariant: ledger entries store correlation_id
  const ledgerRows = coordinator.sqlExec(`SELECT correlation_id FROM ledger WHERE job_id = 'job-matrix-wasm-001'`);
  assert.ok(ledgerRows.length >= 2);
  assert.equal(ledgerRows[0].correlation_id, "corr-matrix-test-999");

  // Stale fencing token submission must be rejected
  const staleRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/results", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceAuthToken}`
      },
      body: JSON.stringify({
        job_id: "job-matrix-wasm-001",
        node_id: "node-desktop-compute-01",
        fencing_token: "stale-expired-token",
        exit_code: 0
      })
    })
  );
  const staleData = await staleRes.json();
  assert.equal(staleData.status, "rejected");
  assert.equal(staleData.reason, "STALE_FENCING_TOKEN");
});

test("SPaaSCoordinator — Operational Fabric Controls & Emergency Stop", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // Pause
  const pauseRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/fabric/pause", { method: "POST", headers: ADMIN_HEADERS })
  );
  assert.equal(pauseRes.status, 200);
  assert.equal((await pauseRes.json()).fabric_status, "PAUSED");

  // Resume
  const resumeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/fabric/resume", { method: "POST", headers: ADMIN_HEADERS })
  );
  assert.equal(resumeRes.status, 200);
  assert.equal((await resumeRes.json()).fabric_status, "ACTIVE");

  // Drain
  const drainRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/fabric/drain", { method: "POST", headers: ADMIN_HEADERS })
  );
  assert.equal(drainRes.status, 200);
  assert.equal((await drainRes.json()).fabric_status, "DRAINING");

  // New job submission during DRAINING must return 503
  const rejectRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ job_id: "drain-reject-job" })
    })
  );
  assert.equal(rejectRes.status, 503);

  // Emergency stop cancels active jobs
  const stopRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/fabric/emergency-stop", { method: "POST", headers: ADMIN_HEADERS })
  );
  assert.equal(stopRes.status, 200);
  assert.equal((await stopRes.json()).fabric_status, "STOPPED");
});

test("SPaaSCoordinator — Device Revocation & DR Checkpoint Export", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // Pair device
  const token = (await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST", headers: ADMIN_HEADERS })
  )).json()).token;

  const pairData = await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: token,
        node_id: "node-to-revoke",
        device_name: "Revocable Node",
        device_type: "Phone"
      })
    })
  )).json();

  // Revoke device
  const revokeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/node-to-revoke/revoke", {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(revokeRes.status, 200);

  // Revoked device heartbeat must be rejected with 403 Forbidden
  const hbRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${pairData.auth_token}`
      },
      body: JSON.stringify({ node_id: "node-to-revoke" })
    })
  );
  assert.equal(hbRes.status, 403);
  assert.equal((await hbRes.json()).error, "DEVICE_REVOKED");

  // Export DR Checkpoint
  const cpRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/dr/checkpoint", { headers: ADMIN_HEADERS })
  );
  assert.equal(cpRes.status, 200);
  const cp = await cpRes.json();
  assert.equal(cp.role, "PRIMARY");
  assert.ok(Array.isArray(cp.nodes));
  assert.ok(Array.isArray(cp.jobs));
});

test("SPaaS Gateway — Ingress CORS & APK Download Metadata", async () => {
  // 1. CORS Pre-flight OPTIONS
  const optionsRes = await workerGateway.fetch(
    new Request("http://localhost/api/v1/system/health", { method: "OPTIONS" }),
    { SPAAS_ALLOWED_ORIGINS: "*" }
  );
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.headers.get("Access-Control-Allow-Origin"), "*");
  assert.ok(optionsRes.headers.get("Access-Control-Allow-Methods").includes("POST"));

  // 2. APK Download Metadata
  const apkInfoRes = await workerGateway.fetch(
    new Request("http://localhost/api/v1/downloads/apk-info"),
    { SPAAS_ALLOWED_ORIGINS: "*" }
  );
  assert.equal(apkInfoRes.status, 200);
  const apkInfo = await apkInfoRes.json();
  assert.equal(apkInfo.apk_filename, "SPaaS-Node-v0.1.0.apk");
  assert.equal(apkInfo.package_name, "dev.spaas.node");
  assert.equal(apkInfoRes.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(apkInfoRes.headers.get("X-Frame-Options"), "DENY");

  // 3. Worker Gateway Fallback Dispatching (Verifies Restricted CORS)
  const gwHealthRes = await workerGateway.fetch(
    new Request("http://localhost/health", { headers: { Origin: "https://spaas-console.pages.dev" } }),
    { SPAAS_ROLE: "PRIMARY", SPAAS_API_SECRET: TEST_ADMIN_SECRET }
  );
  assert.equal(gwHealthRes.status, 200);
  assert.equal(gwHealthRes.headers.get("Access-Control-Allow-Origin"), "https://spaas-console.pages.dev");
  assert.equal(gwHealthRes.headers.get("Vary"), "Origin");

  // 4. Worker Gateway DO Binding Forwarding
  const mockStub = {
    fetch: async (req) => new Response(JSON.stringify({ forwarded: true, url: req.url }), {
      headers: { "Content-Type": "application/json" }
    })
  };
  const mockEnv = {
    COORDINATOR: {
      idFromName: (name) => `do-id-${name}`,
      get: (id) => mockStub
    }
  };
  const doRes = await workerGateway.fetch(new Request("http://localhost/api/v1/test"), mockEnv);
  assert.equal(doRes.status, 200);
  const doData = await doRes.json();
  assert.equal(doData.forwarded, true);
});

test("SPaaSCoordinator — DO Alarms, Lease Reconciler & Node Heartbeat Timeout", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Insert a dead node with last_heartbeat 60 seconds ago
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, ?, ?)`,
    "dead-node-01",
    "Stale Node",
    "Phone",
    Date.now() - 60000,
    Date.now() - 60000
  );

  // 2. Insert a running job with expired lease
  coordinator.sqlExec(
    `INSERT INTO jobs (id, workload_id, state, assigned_node_id, lease_expires_at, retry_count, max_retries, created_at)
     VALUES (?, ?, 'Running', ?, ?, 0, 3, ?)`,
    "expired-job-01",
    "matrix_wasm",
    "dead-node-01",
    Date.now() - 5000,
    Date.now() - 60000
  );

  // 3. Insert a job that exceeded max retries on lease timeout
  coordinator.sqlExec(
    `INSERT INTO jobs (id, workload_id, state, assigned_node_id, lease_expires_at, retry_count, max_retries, created_at)
     VALUES (?, ?, 'Running', ?, ?, 3, 3, ?)`,
    "fatal-job-01",
    "heavy_wasm",
    "dead-node-01",
    Date.now() - 5000,
    Date.now() - 60000
  );

  // Trigger alarm reconciler sweep
  await coordinator.alarm();

  // Verify dead node was transitioned to Offline
  const node = (coordinator.sqlExec(`SELECT state FROM nodes WHERE id = ?`, "dead-node-01"))[0];
  assert.ok(node, "Node dead-node-01 must exist");
  assert.equal(node.state, "Offline");

  // Verify expired job was rescheduled to Pending with retry_count incremented
  const reschedJob = (coordinator.sqlExec(`SELECT state, retry_count, assigned_node_id FROM jobs WHERE id = ?`, "expired-job-01"))[0];
  assert.ok(reschedJob, "Job expired-job-01 must exist");
  assert.equal(reschedJob.state, "Pending");
  assert.equal(reschedJob.retry_count, 1);
  assert.equal(reschedJob.assigned_node_id, null);

  // Verify job exceeding max retries transitioned to Failed
  const fatalJob = (coordinator.sqlExec(`SELECT state FROM jobs WHERE id = ?`, "fatal-job-01"))[0];
  assert.ok(fatalJob, "Job fatal-job-01 must exist");
  assert.equal(fatalJob.state, "Failed");
});

test("SPaaSCoordinator — WebSocket Hibernation Messaging", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, last_heartbeat, created_at)
     VALUES ('ws-node-01', 'WebSocket Phone', 'Phone', 'Ready', 0, ?, ?)`,
    Date.now(),
    Date.now()
  );

  const messagesSent = [];
  const mockWs = {
    send: (msg) => messagesSent.push(JSON.parse(msg))
  };

  // 1. Heartbeat message
  await coordinator.webSocketMessage(mockWs, JSON.stringify({
    type: "heartbeat",
    node_id: "ws-node-01",
    telemetry: { battery: 88, temp_c: 31 }
  }));

  assert.equal(messagesSent.length, 1);
  assert.equal(messagesSent[0].type, "HeartbeatAck");

  // 2. Ping message
  await coordinator.webSocketMessage(mockWs, JSON.stringify({ type: "ping" }));
  assert.equal(messagesSent.length, 2);
  assert.equal(messagesSent[1].type, "pong");

  // 3. WebSocket close
  await coordinator.webSocketClose(mockWs, 1000, "Normal closure", true);
});

test("SPaaSCoordinator — Node Operational Management (Rename, State, Delete)", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, last_heartbeat, created_at)
     VALUES ('manage-node-01', 'Original Name', 'Phone', 'Ready', 0, ?, ?)`,
    Date.now(),
    Date.now()
  );

  // 1. Rename node
  const renameRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/manage-node-01/rename", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ name: "Updated Device Name" })
    })
  );
  assert.equal(renameRes.status, 200);
  assert.equal((await renameRes.json()).name, "Updated Device Name");

  // 2. Change state to Paused
  const stateRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/manage-node-01/state", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ state: "Paused" })
    })
  );
  assert.equal(stateRes.status, 200);
  assert.equal((await stateRes.json()).state, "Paused");

  // 3. Delete node
  const deleteRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/manage-node-01", {
      method: "DELETE",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(deleteRes.status, 200);
  assert.equal((await deleteRes.json()).status, "deleted");

  // Verify gone
  const getRes = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/manage-node-01"));
  assert.equal(getRes.status, 404);
});

test("SPaaSCoordinator — Job Queries, Decisions, Cancellation & Challenge Workload", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Submit challenge workload
  const challengeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/workloads/challenge", {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(challengeRes.status, 201);
  const challengeData = await challengeRes.json();
  assert.ok(challengeData.job_id.startsWith("challenge_"));
  assert.ok(challengeData.nonce);

  // 2. Query all jobs
  const jobsRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs"));
  assert.equal(jobsRes.status, 200);
  const { jobs, total } = await jobsRes.json();
  assert.ok(total >= 1);

  // 3. Query single job by ID
  const jobRes = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${challengeData.job_id}`));
  assert.equal(jobRes.status, 200);
  const singleJob = await jobRes.json();
  assert.equal(singleJob.id, challengeData.job_id);

  // 4. Query scheduler decision
  const decRes = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${challengeData.job_id}/scheduler-decision`));
  assert.equal(decRes.status, 200);

  // 5. Cancel job
  const cancelRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/jobs/${challengeData.job_id}/cancel`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json()).status, "cancelled");

  // 6. Test cancellation command dispatched to assigned node via heartbeat side-channel
  coordinator.sqlExec(
    `INSERT OR REPLACE INTO nodes (id, name, device_type, public_key, auth_token, state, is_simulated, last_heartbeat, created_at)
     VALUES (?, ?, ?, ?, ?, 'Ready', 0, ?, ?)`,
    "cancel-node-1",
    "Test Node",
    "Phone",
    "ed25519_pk",
    "tok_cancel_1",
    Date.now(),
    Date.now()
  );
  coordinator.sqlExec(
    `INSERT INTO jobs (id, workload_id, state, assigned_node_id, lease_expires_at, retry_count, max_retries, created_at)
     VALUES (?, ?, 'Running', ?, ?, 0, 3, ?)`,
    "cancel-job-1",
    "wl_test",
    "cancel-node-1",
    Date.now() + 60000,
    Date.now()
  );

  const cancelRunningRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/jobs/cancel-job-1/cancel`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(cancelRunningRes.status, 200);

  // Heartbeat from cancel-node-1 receives command
  const hbRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer tok_cancel_1"
      },
      body: JSON.stringify({ node_id: "cancel-node-1" })
    })
  );
  assert.equal(hbRes.status, 200);
  const hbData = await hbRes.json();
  assert.deepEqual(hbData.command, { action: "cancel_job", job_id: "cancel-job-1" });

  // Subsequent heartbeat has null command (consumed)
  const hb2Res = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer tok_cancel_1"
      },
      body: JSON.stringify({ node_id: "cancel-node-1" })
    })
  );
  assert.equal((await hb2Res.json()).command, null);
});

test("SPaaSCoordinator — Ledger, Demo Simulated Cluster & Audit Log", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Start demo cluster (4 simulated nodes)
  const demoRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/demo/start-cluster", {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(demoRes.status, 200);
  const demoData = await demoRes.json();
  assert.equal(demoData.nodes.length, 4);

  // 2. Query metering ledger
  const meterRes = await coordinator.fetch(new Request("http://localhost/api/v1/metering"));
  assert.equal(meterRes.status, 200);
  const meterData = await meterRes.json();
  assert.ok(meterData.summary);

  // 3. Purge simulated nodes
  const purgeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/demo/purge-simulated-nodes", {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(purgeRes.status, 200);
  assert.equal((await purgeRes.json()).status, "purged");

  // 4. Query audit log
  const auditRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/audit", { headers: ADMIN_HEADERS })
  );
  assert.equal(auditRes.status, 200);
  const auditData = await auditRes.json();
  assert.ok(Array.isArray(auditData.logs));
  assert.ok(auditData.logs.length >= 2);

  // 5. Unknown route returns 404
  const notFoundRes = await coordinator.fetch(new Request("http://localhost/api/v1/unknown/route"));
  assert.equal(notFoundRes.status, 404);

  // 6. Malformed JSON body returns 400
  const badJsonRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TEST_ADMIN_SECRET}` },
      body: "invalid-not-json{"
    })
  );
  assert.equal(badJsonRes.status, 400);
});

test("SPaaSCoordinator — True Double-Entry Ledger & CSV Download (GAP-M06)", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Pair a test node
  const token = (await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST", headers: ADMIN_HEADERS })
  )).json()).token;

  const pairData = await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: token,
        node_id: "double-entry-test-node",
        device_name: "Ledger Worker",
        device_type: "Desktop"
      })
    })
  )).json();

  // 2. Submit a job
  const jobSubmit = await (await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        job_id: "double-entry-job-1",
        workload_id: "matrix_compute",
        assigned_node_id: "double-entry-test-node",
        status: "assigned"
      })
    })
  )).json();

  // 3. Submit result for settlement
  const settleRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/results", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${pairData.auth_token}`
      },
      body: JSON.stringify({
        job_id: "double-entry-job-1",
        node_id: "double-entry-test-node",
        exit_code: 0,
        fuel_consumed: 50000,
        duration_ms: 250,
        result_digest: "sha256_mock_valid_digest"
      })
    })
  );
  assert.equal(settleRes.status, 200);

  // 4. Query metering ledger — verify true double-entry balance
  const meterRes = await coordinator.fetch(new Request("http://localhost/api/v1/metering"));
  assert.equal(meterRes.status, 200);
  const meterData = await meterRes.json();

  assert.ok(meterData.summary);
  assert.equal(meterData.summary.is_balanced, true);
  assert.ok(meterData.summary.total_debits > 0);
  assert.equal(meterData.summary.total_debits, meterData.summary.total_credits);

  // Check paired transactions
  const debits = meterData.transactions.filter(t => t.entry_type === "DEBIT");
  const credits = meterData.transactions.filter(t => t.entry_type === "CREDIT");
  assert.ok(debits.length >= 1);
  assert.ok(credits.length >= 1);
  assert.equal(debits[0].tx_id, credits[0].tx_id);
  assert.equal(debits[0].amount_credits, credits[0].amount_credits);

  // 5. Query CSV download endpoint
  const downloadRes = await coordinator.fetch(new Request("http://localhost/api/v1/ledger/download"));
  assert.equal(downloadRes.status, 200);
  assert.ok(downloadRes.headers.get("content-type").includes("text/csv"));
  assert.ok(downloadRes.headers.get("content-disposition").includes("spaas-ledger-epoch-"));
  const csvText = await downloadRes.text();
  assert.ok(csvText.includes("id,tx_id,timestamp_iso"));
  assert.ok(csvText.includes("DEBIT"));
  assert.ok(csvText.includes("CREDIT"));
});

test("SPaaSCoordinator — Cross-Cloud DR Epoch Handoff & Fencing", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "STANDBY",
    SPAAS_CONTROL_PLANE_EPOCH: "1",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Unauthenticated handoff must be rejected
  const unauthRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/dr/epoch-handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_epoch: 2 })
    })
  );
  assert.equal(unauthRes.status, 401);

  // 2. Stale epoch (target_epoch 0 < current_epoch 1) must be rejected with 409 Conflict
  const staleRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/dr/epoch-handoff", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ target_epoch: 0, target_role: "PRIMARY" })
    })
  );
  assert.equal(staleRes.status, 409);
  const staleData = await staleRes.json();
  assert.equal(staleData.error, "STALE_EPOCH");

  // 3. Valid epoch handoff (epoch 1 -> epoch 2, transition to PRIMARY)
  const handoffRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/dr/epoch-handoff", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        target_epoch: 2,
        target_role: "PRIMARY",
        reason: "Simulated failback from Cloud Run standby",
        checkpoint: {
          nodes: [
            {
              node_id: "dr-synced-node-01",
              device_type: "android_smartphone",
              region: "us-central",
              state: "Idle"
            }
          ]
        }
      })
    })
  );
  assert.equal(handoffRes.status, 200);
  const handoffData = await handoffRes.json();
  assert.equal(handoffData.status, "HANDOFF_COMPLETE");
  assert.equal(handoffData.epoch, 2);
  assert.equal(handoffData.role, "PRIMARY");
  assert.equal(handoffData.is_authoritative, true);
  assert.ok(handoffData.fencing_token.includes("spaas-epoch-2"));

  // Verify internal coordinator state updated
  assert.equal(coordinator.epoch, 2);
  assert.equal(coordinator.role, "PRIMARY");

  // Verify checkpoint node was ingested
  const ingestedNode = coordinator.sqlExec("SELECT * FROM nodes WHERE id = ?", "dr-synced-node-01");
  assert.equal(ingestedNode.length, 1);
  assert.equal(ingestedNode[0].id, "dr-synced-node-01");
});

test("SPaaSCoordinator — Empirical Qualification & Challenge Dispatch", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Enroll a test device
  const tokenRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/enrollment/create", { method: "POST" })
  );
  const { opaque_credential } = await tokenRes.json();

  const pairRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: opaque_credential,
        node_id: "phone-vivo-qual-01",
        device_name: "Vivo I2221",
        device_type: "android_smartphone",
        capabilities: {
          device_model: "Vivo I2221",
          cpu_cores: 8,
          total_ram_mb: 4096
        },
        telemetry: {
          available_ram_mb: 2048,
          temperature_celsius: 33.5,
          battery_pct: 88,
          charging_state: "DISCHARGING",
          network_type: "wifi_unmetered"
        }
      })
    })
  );
  assert.equal(pairRes.status, 200);
  const pairData = await pairRes.json();
  const deviceToken = pairData.auth_token;

  // 2. Run Empirical Qualification
  const qualRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/phone-vivo-qual-01/qualification/run", {
      method: "POST"
    })
  );
  assert.equal(qualRes.status, 200);
  const qualData = await qualRes.json();
  assert.equal(qualData.status, "ok");
  assert.ok(qualData.profile);
  assert.ok(qualData.profile.edge_score >= 80, `Edge score should be >= 80, got ${qualData.profile.edge_score}`);
  assert.ok(qualData.profile.measured_fuel_mips > 100);
  assert.equal(qualData.profile.tier, "QUALIFIED");
  assert.ok(qualData.profile.capability_vector);
  assert.ok(qualData.profile.raw_metrics);

  // 3. Dispatch Challenge Job
  const challengeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/phone-vivo-qual-01/dispatch-challenge", {
      method: "POST"
    })
  );
  assert.equal(challengeRes.status, 200);
  const challengeData = await challengeRes.json();
  assert.equal(challengeData.status, "ok");
  assert.ok(challengeData.job_id.startsWith("challenge_"));

  // 4. Node Polls for Job
  const pollRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/phone-vivo-qual-01/poll", {
      method: "GET",
      headers: { "Authorization": `Bearer ${deviceToken}` }
    })
  );
  assert.equal(pollRes.status, 200);
  const pollData = await pollRes.json();
  assert.ok(pollData.job);
  assert.equal(pollData.job.job_id, challengeData.job_id);
  assert.ok(pollData.job.lease_id);
  assert.ok(pollData.job.spec);
  assert.ok(pollData.job.spec.name.includes("SHA-256"));
});


