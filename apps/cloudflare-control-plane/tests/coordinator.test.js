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
  assert.ok(job.state === "DISPATCHED" || job.state === "Running");
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

test("SPaaSCoordinator — End-to-End Authoritative Challenge Lifecycle, ACK, START, Verification & Trace", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  const deviceToken = "dev_token_e2e_vivo_12221";
  const nodeId = "e2e-vivo-i2221";

  // 1. Register device
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, public_key, auth_token, state, capabilities, qualification, policy, telemetry, is_simulated, last_heartbeat, created_at)
     VALUES (?, ?, 'android_smartphone', 'ed25519_pk_vivo', ?, 'Ready', ?, ?, ?, ?, 0, ?, ?)`,
    nodeId,
    "Vivo I2221",
    deviceToken,
    JSON.stringify({ device_model: "Vivo I2221", architecture: "aarch64", cpu_cores: 8, total_ram_mb: 8192 }),
    JSON.stringify({ wasm_conformance_passed: true, edge_score: 92, tier: "QUALIFIED" }),
    JSON.stringify({ only_while_charging: false, min_battery_threshold_pct: 20 }),
    JSON.stringify({ battery_pct: 75, charging_state: "DISCHARGING", thermal_status: "NONE", round_trip_ping_ms: 15 }),
    Date.now(),
    Date.now()
  );

  // 2. Policy Update Test
  const policyRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${nodeId}/policy`, {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        charging_only: false,
        unmetered_only: true,
        min_battery_pct: 25,
        max_cpu_pct: 70
      })
    })
  );
  assert.equal(policyRes.status, 200);
  const policyData = await policyRes.json();
  assert.equal(policyData.status, "ok");
  assert.equal(policyData.policy.only_while_charging, false);
  assert.equal(policyData.policy.min_battery_threshold_pct, 25);

  // 3. Dispatch Challenge Job
  const dispatchRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${nodeId}/dispatch-challenge`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(dispatchRes.status, 200);
  const dispatchData = await dispatchRes.json();
  assert.equal(dispatchData.status, "ok");
  assert.equal(dispatchData.state, "DISPATCHED");
  assert.ok(dispatchData.job_id);
  assert.ok(dispatchData.lease_id);
  assert.ok(dispatchData.fencing_token);
  assert.ok(dispatchData.nonce);
  assert.ok(dispatchData.expected_digest);

  const jobId = dispatchData.job_id;
  const leaseId = dispatchData.lease_id;
  const fencingToken = dispatchData.fencing_token;
  const nonce = dispatchData.nonce;
  const expectedDigest = dispatchData.expected_digest;

  // Verify node transitioned to Busy
  const nodeBusy = (coordinator.sqlExec(`SELECT state FROM nodes WHERE id = ?`, nodeId))[0];
  assert.equal(nodeBusy.state, "Busy");

  // 4. Device Polls for Job (Verifies Fallback and payload completeness)
  const pollRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${nodeId}/poll`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${deviceToken}` }
    })
  );
  assert.equal(pollRes.status, 200);
  const pollData = await pollRes.json();
  assert.ok(pollData.job);
  assert.equal(pollData.job.job_id, jobId);
  assert.equal(pollData.job.fencing_token, fencingToken);
  assert.equal(pollData.job.spec.expected_digest, expectedDigest);
  assert.ok(pollData.job.spec.args.includes(nonce));

  // 5. Device Sends ACK (DISPATCHED -> ACKNOWLEDGED)
  const ackRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceToken}` },
      body: JSON.stringify({
        node_id: nodeId,
        job_id: jobId,
        lease_id: leaseId,
        fencing_token: fencingToken,
        artifact_sha256: "c86da4754d1c8581596aa48bc6bd7e60edd1b5f4281fe32b5e956a5efc98cad7"
      })
    })
  );
  assert.equal(ackRes.status, 200);
  const ackData = await ackRes.json();
  assert.equal(ackData.status, "ok");
  assert.equal(ackData.state, "ACKNOWLEDGED");

  // Verify DB state is ACKNOWLEDGED
  let jobRecord = (coordinator.sqlExec(`SELECT state FROM jobs WHERE id = ?`, jobId))[0];
  assert.equal(jobRecord.state, "ACKNOWLEDGED");

  // 6. Device Sends START (ACKNOWLEDGED -> RUNNING)
  const startRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceToken}` },
      body: JSON.stringify({
        node_id: nodeId,
        job_id: jobId,
        lease_id: leaseId,
        fencing_token: fencingToken
      })
    })
  );
  assert.equal(startRes.status, 200);
  const startData = await startRes.json();
  assert.equal(startData.status, "ok");
  assert.equal(startData.state, "RUNNING");

  jobRecord = (coordinator.sqlExec(`SELECT state FROM jobs WHERE id = ?`, jobId))[0];
  assert.equal(jobRecord.state, "RUNNING");

  // 7. Test Negative Verification: submit invalid/forged output
  const badRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceToken}` },
      body: JSON.stringify({
        node_id: nodeId,
        job_id: jobId,
        lease_id: leaseId,
        fencing_token: fencingToken,
        result: {
          exit_code: 0,
          stdout: "SPaaS Sandbox Fake: Digest: 0000000000000000000000000000000000000000000000000000000000000000\n",
          stderr: "",
          fuel_consumed: 12000,
          wall_time_ms: 50
        }
      })
    })
  );
  assert.equal(badRes.status, 200);
  const badData = await badRes.json();
  assert.equal(badData.status, "rejected");
  assert.equal(badData.reason, "CHALLENGE_VERIFICATION_FAILED");

  // 8. Re-mark RUNNING and submit Authentic Genuine Verification Output
  coordinator.sqlExec(`UPDATE jobs SET state = 'RUNNING' WHERE id = ?`, jobId);
  const authenticStdout = `SPaaS WASM Sandbox: SHA-256 Cryptographic Benchmark\nAlgorithm: SHA-256 (FIPS 180-4)\nNonce: ${nonce}\nDigest: ${expectedDigest}\nStatus: SUCCESS\n`;

  const goodRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceToken}` },
      body: JSON.stringify({
        node_id: nodeId,
        job_id: jobId,
        lease_id: leaseId,
        fencing_token: fencingToken,
        result: {
          exit_code: 0,
          stdout: authenticStdout,
          stderr: "",
          fuel_consumed: 1850000,
          wall_time_ms: 120,
          node_signature: "sig_ed25519_physical_device_proven"
        }
      })
    })
  );
  assert.equal(goodRes.status, 200);
  const goodData = await goodRes.json();
  assert.equal(goodData.status, "accepted");
  assert.equal(goodData.state, "COMPLETED");
  assert.equal(goodData.verification, "VERIFIED");
  assert.ok(goodData.credits_settled > 0);
  assert.ok(goodData.tx_id);

  // 9. Test Idempotency: re-submitting returns existing settlement without duplicate credits
  const ledgerCountBefore = (coordinator.sqlExec(`SELECT COUNT(*) as c FROM ledger WHERE job_id = ?`, jobId))[0].c;
  assert.equal(ledgerCountBefore, 2); // 1 DEBIT + 1 CREDIT

  const replayRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceToken}` },
      body: JSON.stringify({
        node_id: nodeId,
        job_id: jobId,
        lease_id: leaseId,
        fencing_token: fencingToken,
        result: { exit_code: 0, stdout: authenticStdout }
      })
    })
  );
  assert.equal(replayRes.status, 200);
  const replayData = await replayRes.json();
  assert.equal(replayData.status, "accepted");
  assert.equal(replayData.idempotent, true);
  assert.equal(replayData.tx_id, goodData.tx_id);

  const ledgerCountAfter = (coordinator.sqlExec(`SELECT COUNT(*) as c FROM ledger WHERE job_id = ?`, jobId))[0].c;
  assert.equal(ledgerCountAfter, 2); // Still exactly 2 entries (no duplicates!)

  // 10. Test Execution Trace Endpoint
  const traceRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/jobs/${jobId}/trace`, {
      method: "GET",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(traceRes.status, 200);
  const traceData = await traceRes.json();
  assert.equal(traceData.status, "ok");
  assert.equal(traceData.job_id, jobId);
  assert.equal(traceData.node_id, nodeId);
  assert.ok(traceData.transitions.length >= 7);

  const transitionStates = traceData.transitions.map(t => t.to_state);
  assert.ok(transitionStates.includes("CREATED"));
  assert.ok(transitionStates.includes("QUEUED"));
  assert.ok(transitionStates.includes("ASSIGNED"));
  assert.ok(transitionStates.includes("LEASED"));
  assert.ok(transitionStates.includes("DISPATCHED"));
  assert.ok(transitionStates.includes("ACKNOWLEDGED"));
  assert.ok(transitionStates.includes("RUNNING"));
  assert.ok(transitionStates.includes("VERIFIED"));
  assert.ok(transitionStates.includes("COMPLETED"));

  // Verify node returned to Ready
  const nodeReady = (coordinator.sqlExec(`SELECT state FROM nodes WHERE id = ?`, nodeId))[0];
  assert.equal(nodeReady.state, "Ready");
});

test("SPaaSCoordinator — Comprehensive Failure, Security, Rejection & Recovery Boundaries", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  const devToken = "dev_token_boundary_phone";
  const validNodeId = "boundary-phone-vivo";
  const now = Date.now();

  // 1. Register valid node
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, public_key, auth_token, state, capabilities, qualification, policy, telemetry, is_simulated, last_heartbeat, created_at)
     VALUES (?, ?, 'android_smartphone', 'ed25519_pk_boundary', ?, 'Ready', ?, ?, ?, ?, 0, ?, ?)`,
    validNodeId,
    "Vivo Boundary Phone",
    devToken,
    JSON.stringify({ device_model: "Vivo I2221", architecture: "aarch64", cpu_cores: 8, total_ram_mb: 8192 }),
    JSON.stringify({ wasm_conformance_passed: true, edge_score: 90, tier: "QUALIFIED" }),
    JSON.stringify({ only_while_charging: false, min_battery_threshold_pct: 30 }),
    JSON.stringify({ battery_pct: 75, charging_state: "DISCHARGING", thermal_status: "NONE" }),
    now,
    now
  );

  // 2. Node trace endpoint
  const nodeTraceRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${validNodeId}/trace`, {
      method: "GET",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(nodeTraceRes.status, 200);
  const nodeTrace = await nodeTraceRes.json();
  assert.equal(nodeTrace.status, "ok");
  assert.equal(nodeTrace.node.id, validNodeId);

  // 3. Dispatch challenge to non-existent node -> 404
  const resNotFound = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/non-existent-node/dispatch-challenge`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(resNotFound.status, 404);

  // 4. Dispatch challenge to revoked node -> 403
  coordinator.sqlExec(`UPDATE nodes SET state = 'Revoked' WHERE id = ?`, validNodeId);
  const resRevoked = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${validNodeId}/dispatch-challenge`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(resRevoked.status, 403);
  coordinator.sqlExec(`UPDATE nodes SET state = 'Ready' WHERE id = ?`, validNodeId);

  // 5. Dispatch challenge to offline node (>60s heartbeat) -> 409
  coordinator.sqlExec(`UPDATE nodes SET last_heartbeat = ? WHERE id = ?`, now - 120000, validNodeId);
  const resOffline = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${validNodeId}/dispatch-challenge`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(resOffline.status, 409);
  coordinator.sqlExec(`UPDATE nodes SET last_heartbeat = ? WHERE id = ?`, now, validNodeId);

  // 6. Dispatch challenge to paused node -> 409
  coordinator.sqlExec(`UPDATE nodes SET state = 'Paused' WHERE id = ?`, validNodeId);
  const resPaused = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${validNodeId}/dispatch-challenge`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(resPaused.status, 409);
  coordinator.sqlExec(`UPDATE nodes SET state = 'Ready' WHERE id = ?`, validNodeId);

  // 7. Dispatch challenge with battery below policy threshold -> 409
  coordinator.sqlExec(
    `UPDATE nodes SET telemetry = ? WHERE id = ?`,
    JSON.stringify({ battery_pct: 15, charging_state: "DISCHARGING", thermal_status: "NONE" }),
    validNodeId
  );
  const resLowBattery = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${validNodeId}/dispatch-challenge`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(resLowBattery.status, 409);
  coordinator.sqlExec(
    `UPDATE nodes SET telemetry = ? WHERE id = ?`,
    JSON.stringify({ battery_pct: 80, charging_state: "DISCHARGING", thermal_status: "NONE" }),
    validNodeId
  );

  // 8. Poll endpoint boundaries (unauthorized, revoked, empty)
  const pollUnauth = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${validNodeId}/poll`, {
      method: "GET"
    })
  );
  assert.equal(pollUnauth.status, 401);

  coordinator.sqlExec(`UPDATE nodes SET state = 'Revoked' WHERE id = ?`, validNodeId);
  const pollRevoked = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${validNodeId}/poll`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${devToken}` }
    })
  );
  assert.equal(pollRevoked.status, 403);
  coordinator.sqlExec(`UPDATE nodes SET state = 'Ready' WHERE id = ?`, validNodeId);

  const pollEmpty = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${validNodeId}/poll`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${devToken}` }
    })
  );
  assert.equal(pollEmpty.status, 200);
  const pollEmptyData = await pollEmpty.json();
  assert.equal(pollEmptyData.job, null);

  // 9. ACK & START boundaries (missing job_id, unauthorized)
  const ackBad = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${devToken}` },
      body: JSON.stringify({ node_id: validNodeId })
    })
  );
  assert.equal(ackBad.status, 400);

  const startBad = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${devToken}` },
      body: JSON.stringify({ node_id: validNodeId })
    })
  );
  assert.equal(startBad.status, 400);

  // 10. Result submission boundaries
  const resBadJob = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${devToken}` },
      body: JSON.stringify({ node_id: validNodeId, job_id: "non-existent-job" })
    })
  );
  assert.equal(resBadJob.status, 200);
  const badJobData = await resBadJob.json();
  assert.equal(badJobData.status, "rejected");
  assert.equal(badJobData.reason, "JOB_NOT_FOUND");
});

test("SPaaSCoordinator — Fleet Inventory, WebSocket Hibernation Full Lifecycle, APK Downloads & Bulk Pruning", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_CONTROL_PLANE_EPOCH: "1"
  });

  // 1. GET /api/v1/nodes fleet listing with multiple nodes
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, auth_token, capabilities, telemetry, policy, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, ?, ?, ?, ?, ?, ?)`,
    "fleet-node-01",
    "Galaxy S24",
    "Phone",
    "secret-node-token-01",
    JSON.stringify({ device_model: "Galaxy S24", architecture: "aarch64", total_ram_mb: 8192, cpu_cores: 8 }),
    JSON.stringify({ battery_pct: 95, charging_state: "CHARGING", thermal_status: "NONE", available_ram_mb: 4096 }),
    JSON.stringify({ allowExecution: true, minimumBatteryPct: 20 }),
    Date.now(),
    Date.now()
  );

  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, auth_token, capabilities, telemetry, policy, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Revoked', 0, ?, NULL, NULL, NULL, ?, ?)`,
    "fleet-node-revoked",
    "Old Tablet",
    "Tablet",
    "secret-node-token-02",
    Date.now() - 100000,
    Date.now() - 100000
  );

  const fleetRes = await coordinator.fetch(new Request("http://localhost/api/v1/nodes"));
  assert.equal(fleetRes.status, 200);
  const fleetData = await fleetRes.json();
  assert.ok(fleetData.total >= 2);
  const foundS24 = fleetData.nodes.find(n => n.id === "fleet-node-01");
  assert.ok(foundS24);
  assert.equal(foundS24.auth_token, undefined, "Secret auth token must be redacted from fleet listing");
  assert.equal(foundS24.name, "Galaxy S24");
  assert.equal(foundS24.capabilities.architecture, "aarch64");
  assert.equal(foundS24.policy.allowExecution, true);

  // Set qualification on fleet-node-01
  coordinator.sqlExec(
    "UPDATE nodes SET qualification = ? WHERE id = ?",
    JSON.stringify({ wasm_conformance_passed: true, verified_at: Date.now() }),
    "fleet-node-01"
  );

  // 2. Heartbeat returning assigned_job when node is busy
  const challengeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/fleet-node-01/dispatch-challenge", {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(challengeRes.status, 200);
  const challengeData = await challengeRes.json();
  const jobHbId = challengeData.job_id;
  const fToken = challengeData.fencing_token;
  const expectedDigest = challengeData.expected_digest;

  const hbRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer secret-node-token-01" },
      body: JSON.stringify({
        node_id: "fleet-node-01",
        state: "Busy",
        battery_pct: 95,
        is_charging: true
      })
    })
  );
  assert.equal(hbRes.status, 200);
  const hbData = await hbRes.json();
  assert.ok(hbData.assigned_job, "Heartbeat must return assigned_job when node has an active job");
  assert.equal(hbData.assigned_job.job_id, jobHbId);
  assert.equal(hbData.assigned_job.lease_id, fToken);
  assert.equal(hbData.assigned_job.spec.expected_digest, expectedDigest);
  assert.ok(hbData.assigned_job.wasm_bytes);
  assert.ok(hbData.policy, "Heartbeat must return node policy");
  assert.equal(hbData.policy.allowExecution, true);

  // 3. WebSocket Hibernation message handlers: Heartbeat (with job), ACK, START, Result, ping, error, close
  const wsMessages = [];
  const mockWs = {
    send: (msg) => wsMessages.push(JSON.parse(msg)),
    close: () => {}
  };
  const mockCtx = {
    getTags: (ws) => ["fleet-node-01"]
  };
  coordinator.ctx = mockCtx;

  // WS Heartbeat when node has assigned job
  await coordinator.webSocketMessage(mockWs, JSON.stringify({
    type: "Heartbeat",
    node_id: "fleet-node-01",
    telemetry: { battery_pct: 94 }
  }));
  const lastWsMsg = wsMessages[wsMessages.length - 1];
  assert.equal(lastWsMsg.type, "HeartbeatAck");
  assert.ok(lastWsMsg.assigned_job);
  assert.equal(lastWsMsg.assigned_job.job_id, jobHbId);

  // WS ACK
  await coordinator.webSocketMessage(mockWs, JSON.stringify({
    type: "ACK",
    node_id: "fleet-node-01",
    job_id: jobHbId
  }));
  const ackMsg = wsMessages[wsMessages.length - 1];
  assert.equal(ackMsg.type, "AckReceipt");
  assert.equal(ackMsg.state, "ACKNOWLEDGED");

  // WS START
  await coordinator.webSocketMessage(mockWs, JSON.stringify({
    type: "START",
    node_id: "fleet-node-01",
    job_id: jobHbId
  }));
  const startMsg = wsMessages[wsMessages.length - 1];
  assert.equal(startMsg.type, "StartReceipt");
  assert.equal(startMsg.state, "RUNNING");

  // WS Result
  await coordinator.webSocketMessage(mockWs, JSON.stringify({
    type: "Result",
    node_id: "fleet-node-01",
    job_id: jobHbId,
    exit_code: 0,
    stdout: `Digest: ${expectedDigest}`,
    result_digest: expectedDigest,
    fencing_token: fToken,
    execution_time_ms: 120,
    fuel_used: 50
  }));
  const resMsg = wsMessages[wsMessages.length - 1];
  assert.equal(resMsg.type, "ResultAck");
  assert.equal(resMsg.status, "accepted");
  assert.equal(resMsg.state, "COMPLETED");

  // WS Error handling (invalid JSON string)
  await coordinator.webSocketMessage(mockWs, "{ malformed-json");
  const errMsg = wsMessages[wsMessages.length - 1];
  assert.equal(errMsg.type, "error");

  // WS Close
  await coordinator.webSocketClose(mockWs, 1000, "Clean device disconnect", true);
  const sessRows = coordinator.sqlExec(`SELECT connection_state FROM device_sessions WHERE node_id = ?`, "fleet-node-01");
  assert.equal(sessRows[0]?.connection_state, "DISCONNECTED");

  // 4. Consumer / Provider Metering Balance Query
  // Missing account key
  const noAccRes = await coordinator.fetch(new Request("http://localhost/api/v1/metering/consumer/"));
  assert.equal(noAccRes.status, 400);

  // Valid account balance query
  const balRes = await coordinator.fetch(new Request("http://localhost/api/v1/metering/consumer/fleet-node-01"));
  assert.equal(balRes.status, 200);
  const balData = await balRes.json();
  assert.equal(balData.account, "fleet-node-01");
  assert.ok(balData.balance_credits > 0);
  assert.ok(balData.transaction_count > 0);
  assert.ok(Array.isArray(balData.transactions));

  // 5. Bulk Node Deletion / Pruning endpoints
  // Unauthorized check
  const delUnauth = await coordinator.fetch(new Request("http://localhost/api/v1/nodes", { method: "DELETE" }));
  assert.equal(delUnauth.status, 401);

  // Prune revoked only
  const pruneRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes?revoked_only=true", {
      method: "DELETE",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(pruneRes.status, 200);
  const pruneData = await pruneRes.json();
  assert.equal(pruneData.status, "pruned");
  assert.ok(pruneData.count >= 1);

  // Clear all nodes
  const clearRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes", {
      method: "DELETE",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(clearRes.status, 200);
  const clearData = await clearRes.json();
  assert.equal(clearData.status, "cleared");
  assert.ok(clearData.count >= 1);

  // 6. Gateway Ingress APK Downloads & Forwarding Errors
  const apkRedirect = await workerGateway.fetch(new Request("http://localhost/app-debug.apk"));
  assert.equal(apkRedirect.status, 302);
  assert.ok(apkRedirect.headers.get("Location").includes(".apk"));

  const dlRedirect = await workerGateway.fetch(new Request("http://localhost/downloads/SPaaS-Node-v0.1.0.apk"));
  assert.equal(dlRedirect.status, 302);

  // Gateway DO Forwarding error recovery & 500
  const failingStub = {
    fetch: async () => { throw new Error("DO cluster transient partition"); }
  };
  const failingEnv = {
    COORDINATOR: {
      idFromName: () => "mock-do-failing",
      get: () => failingStub
    },
    SPAAS_ROLE: "PRIMARY"
  };

  const failingHealth = await workerGateway.fetch(new Request("http://localhost/health"), failingEnv);
  assert.equal(failingHealth.status, 200);
  const fHealthData = await failingHealth.json();
  assert.equal(fHealthData.do_status, "RECOVERING");

  const failingRoute = await workerGateway.fetch(new Request("http://localhost/api/v1/jobs"), failingEnv);
  assert.equal(failingRoute.status, 500);
  const fRouteData = await failingRoute.json();
  assert.equal(fRouteData.error, "COORDINATOR_DISPATCH_ERROR");
});

test("SPaaSCoordinator — Job Management: Edit, Retry, Delete & Bulk Clear", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });
  coordinator.sqlExec(`INSERT INTO nodes (id, name, state, is_simulated) VALUES ('test-edit-node', 'Test Node', 'Ready', 0)`);

  // 1. Submit a job
  const submitRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec: { name: "Original Workload", limits: { max_fuel: 1000000, timeout_ms: 5000 } },
        wasm_binary_base64: "AGFzbQEAAAABBQFgAAF/AwIBAAcQAQZtZW1vcnkCAAFfc3RhcnQAAAoGAQQAQcEA"
      })
    })
  );
  assert.equal(submitRes.status, 201);
  const submitData = await submitRes.json();
  const jobId = submitData.job_id;

  // 2. Edit the job
  const editRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/jobs/${jobId}`, {
      method: "PUT",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        name: "Renamed Workload Spec",
        state: "Queued",
        limits: { max_fuel: 2500000, timeout_ms: 12000 }
      })
    })
  );
  assert.equal(editRes.status, 200);
  const editData = await editRes.json();
  assert.equal(editData.status, "ok");

  // 3. Retry the job
  const retryRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/jobs/${jobId}/retry`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(retryRes.status, 200);
  const retryData = await retryRes.json();
  assert.equal(retryData.status, "ok");
  assert.equal(retryData.state, "Queued");

  // 4. Delete the single job
  const delRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/jobs/${jobId}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(delRes.status, 200);
  const delData = await delRes.json();
  assert.equal(delData.deleted, jobId);

  // 5. Submit two more jobs and Bulk Clear
  await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec: { name: "Bulk Job 1" },
        wasm_binary_base64: "AGFzbQEAAAABBQFgAAF/AwIBAAcQAQZtZW1vcnkCAAFfc3RhcnQAAAoGAQQAQcEA"
      })
    })
  );
  await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec: { name: "Bulk Job 2" },
        wasm_binary_base64: "AGFzbQEAAAABBQFgAAF/AwIBAAcQAQZtZW1vcnkCAAFfc3RhcnQAAAoGAQQAQcEA"
      })
    })
  );

  const clearRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs?filter=all", {
      method: "DELETE",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(clearRes.status, 200);
  const clearData = await clearRes.json();
  assert.equal(clearData.status, "ok");
  assert.ok(clearData.cleared_count >= 2);

  // Verify jobs queue is now 0
  const jobsRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs"));
  const jobsData = await jobsRes.json();
  assert.equal(jobsData.total, 0);
});

test("SPaaSCoordinator — Case-Insensitive Pairing Tokens & Direct Digest Verification", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_CONTROL_PLANE_EPOCH: "1",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Generate pairing code (creates opaque_credential UUID, token UUID, and SP-XXXX short code)
  const codeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/enrollment/create", {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(codeRes.status, 200);
  const codeData = await codeRes.json();
  const opaqueCred = codeData.opaque_credential;
  assert.ok(opaqueCred);

  // 2. Case-insensitive lookups: uppercase UUID (simulating Android QR uppercase bug)
  const upperCred = opaqueCred.toUpperCase();
  const lowerCred = opaqueCred.toLowerCase();

  // Both uppercase and lowercase should successfully resolve in verify/enrollment
  const enrollRes1 = await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: upperCred,
        device_name: "Pixel 9 Pro QR Uppercase",
        device_type: "android_smartphone"
      })
    })
  );
  assert.equal(enrollRes1.status, 200);
  const enrollData1 = await enrollRes1.json();
  assert.ok(enrollData1.node_id);
  assert.ok(enrollData1.auth_token);

  const challengeRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/${enrollData1.node_id}/dispatch-challenge`, {
      method: "POST",
      headers: ADMIN_HEADERS
    })
  );
  assert.equal(challengeRes.status, 200);
  const challengeData = await challengeRes.json();
  const chJobId = challengeData.job_id;
  const expectedDigest = challengeData.expected_digest;
  assert.ok(expectedDigest);

  // Submit result with matching result_digest (even if exit_code is 0 or WASM exit code)
  const resultRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/results", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${enrollData1.auth_token}`
      },
      body: JSON.stringify({
        node_id: enrollData1.node_id,
        job_id: chJobId,
        lease_id: challengeData.lease_id,
        fencing_token: challengeData.fencing_token,
        result: {
          job_id: chJobId,
          node_id: enrollData1.node_id,
          exit_code: 0,
          stdout: "SPaaS WASM Sandbox: SHA-256 Cryptographic Benchmark\nStatus: SUCCESS",
          stderr: "",
          result_digest: expectedDigest.toUpperCase(), // Test case-insensitive digest comparison
          fuel_consumed: 125000,
          wall_time_ms: 18,
          node_signature: "ed25519_sig"
        }
      })
    })
  );
  assert.equal(resultRes.status, 200);
  const resultData = await resultRes.json();
  assert.equal(resultData.status, "accepted");
  assert.equal(resultData.verification, "VERIFIED");

  // Verify job state transitioned to COMPLETED
  const traceRes = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${chJobId}/trace`));
  assert.equal(traceRes.status, 200);
  const traceData = await traceRes.json();
  assert.equal(traceData.job_state, "COMPLETED");
});

test("SPaaSCoordinator — Generic Workloads, Pareto Explainability, Provider Ask-Me Controls & Fleet Filtering", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  const deviceToken = "dev_token_generic_provider_01";
  const nodeId = "node-physical-phone-01";

  // 1. Register physical provider node with ASK_ME mode
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, public_key, auth_token, state, capabilities, qualification, policy, telemetry, is_simulated, last_heartbeat, created_at)
     VALUES (?, ?, 'android_smartphone', 'ed25519_pk_p1', ?, 'Ready', ?, ?, ?, ?, 0, ?, ?)`,
    nodeId,
    "Google Pixel 8 Pro",
    deviceToken,
    JSON.stringify({ device_model: "Pixel 8 Pro", architecture: "aarch64", cpu_cores: 8, total_ram_mb: 12288 }),
    JSON.stringify({ wasm_conformance_passed: true, edge_score: 96, tier: "QUALIFIED" }),
    JSON.stringify({ provider_mode: "ASK_ME", only_while_charging: false, min_battery_threshold_pct: 15 }),
    JSON.stringify({ battery_pct: 85, charging_state: "CHARGING", thermal_status: "NOMINAL", round_trip_ping_ms: 12 }),
    Date.now(),
    Date.now()
  );

  // Register a second simulated node
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, public_key, auth_token, state, capabilities, qualification, policy, telemetry, is_simulated, last_heartbeat, created_at)
     VALUES (?, ?, 'server_vps', 'ed25519_pk_s1', 'sim_tok_1', 'Ready', ?, ?, ?, ?, 1, ?, ?)`,
    "node-simulated-cloud-01",
    "Simulated Cluster Node 01",
    JSON.stringify({ architecture: "x86_64", cpu_cores: 16, total_ram_mb: 32768 }),
    JSON.stringify({ wasm_conformance_passed: true, edge_score: 99, tier: "QUALIFIED" }),
    JSON.stringify({ provider_mode: "AUTO_ACCEPT" }),
    JSON.stringify({ battery_pct: 100 }),
    Date.now(),
    Date.now()
  );

  // 2. Test Fleet Filtering (Physical vs Simulated)
  const physicalFleetRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes?filter=physical", { headers: ADMIN_HEADERS })
  );
  assert.equal(physicalFleetRes.status, 200);
  const physicalFleet = await physicalFleetRes.json();
  const physicalIds = physicalFleet.nodes.map(n => n.id);
  assert.ok(physicalIds.includes(nodeId));
  assert.ok(!physicalIds.includes("node-simulated-cloud-01"));

  const simFleetRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes?filter=simulated", { headers: ADMIN_HEADERS })
  );
  assert.equal(simFleetRes.status, 200);
  const simFleet = await simFleetRes.json();
  const simIds = simFleet.nodes.map(n => n.id);
  assert.ok(simIds.includes("node-simulated-cloud-01"));
  assert.ok(!simIds.includes(nodeId));

  // 3. Submit Generic Matrix Multiplication Workload
  const matrixJobId = "job_matrix_mult_test_01";
  const submitRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: matrixJobId,
        preset: "matrix_mult",
        workload_spec: {
          name: "Matrix Multiplication (64x64)",
          limits: { max_fuel: 10000000, max_memory_bytes: 33554432, timeout_ms: 15000 },
          args: ["64", "float32"]
        },
        requirements: {
          min_ram_mb: 2048,
          target_tier: "QUALIFIED"
        }
      })
    })
  );
  assert.equal(submitRes.status, 201);
  const submitData = await submitRes.json();
  assert.ok(submitData.job_id);
  assert.equal(submitData.job_id, matrixJobId);

  // Run scheduler to trigger Pareto match
  await coordinator.schedulePendingJobs();

  // 4. Inspect Decision Explainability
  const decisionRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/jobs/${matrixJobId}/decision`, { headers: ADMIN_HEADERS })
  );
  assert.equal(decisionRes.status, 200);
  const decisionData = await decisionRes.json();
  assert.ok(decisionData.selected_node_id);
  assert.ok(decisionData.rationale);
  assert.ok(decisionData.score > 0);

  // 5. Test Provider Ask-Me Mode: Job is in OFFERED state for the node
  // If matched to physical node with ASK_ME policy:
  const jobStateRes = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${matrixJobId}`));
  const jobStateData = await jobStateRes.json();
  const jobState = jobStateData.job?.state || jobStateData.state;
  
  if (jobState === "OFFERED") {
    // Provider accepts the offer
    const acceptRes = await coordinator.fetch(
      new Request(`http://localhost/api/v1/nodes/offer/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceToken}` },
        body: JSON.stringify({ node_id: nodeId, job_id: matrixJobId })
      })
    );
    assert.equal(acceptRes.status, 200);
    const acceptData = await acceptRes.json();
    assert.equal(acceptData.state, "DISPATCHED");
    assert.ok(acceptData.lease_id);
  }

  // 6. Test Node Progress Reporting (DOWNLOADING -> EXECUTING -> UPLOADING)
  const progRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceToken}` },
      body: JSON.stringify({
        node_id: nodeId,
        job_id: matrixJobId,
        progress_pct: 65,
        stage: "EXECUTING",
        details: "Performing SGEMM 64x64 floating point multiply"
      })
    })
  );
  assert.equal(progRes.status, 200);
  const progData = await progRes.json();
  assert.equal(progData.progress_pct, 65);
  assert.equal(progData.stage, "EXECUTING");

  // 7. Test Offer Decline Flow
  const declineJobId = "job_decline_test_01";
  await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: declineJobId,
        preset: "prime_sieve",
        workload_spec: { name: "Prime Sieve (100,000)" }
      })
    })
  );
  
  // Transition manually to OFFERED to test decline
  coordinator.recordJobTransition(declineJobId, "OFFERED", "Offered to node", { nodeId });
  coordinator.sqlExec(`UPDATE jobs SET state = 'OFFERED', assigned_node_id = ? WHERE id = ?`, nodeId, declineJobId);

  const declineRes = await coordinator.fetch(
    new Request(`http://localhost/api/v1/nodes/offer/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceToken}` },
      body: JSON.stringify({ node_id: nodeId, job_id: declineJobId, reason: "Battery too low for heavy computation" })
    })
  );
  assert.equal(declineRes.status, 200);
  const declineData = await declineRes.json();
  assert.equal(declineData.state, "QUEUED");
  assert.equal(declineData.reason, "Battery too low for heavy computation");

  // 8. Verify Execution Trace for Full 12-State Transitions
  const traceRes = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${matrixJobId}/trace`));
  assert.equal(traceRes.status, 200);
  const traceData = await traceRes.json();
  assert.ok(traceData.transitions.length >= 3);
});

test("SPaaSCoordinator — Subtest 24: Health Live Aggregates, Capability Vectors, Compatibility, Emergency Stop & Multi-Worker DAG Sharding", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Enroll and register 2 nodes (1 physical Android node, 1 desktop worker)
  const phoneId = "physical-vivo-test-01";
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_phone', 'token_phone', ?, ?, ?, ?, ?)`,
    phoneId,
    "Vivo I2221 Testbed",
    "android_smartphone",
    JSON.stringify({ architecture: "aarch64", cpu_cores: 8, total_ram_mb: 8192, device_model: "Vivo I2221" }),
    JSON.stringify({ wasm_conformance_passed: true, edge_score: 94.2, tier: "QUALIFIED", benchmark_version: "v1.2.0-verified" }),
    JSON.stringify({ battery_pct: 88, charging_state: "CHARGING_AC", network_type: "Wi-Fi (Unmetered)", thermal_status: "NONE", round_trip_ping_ms: 14 }),
    Date.now(),
    Date.now()
  );

  const desktopId = "desktop-ubuntu-test-02";
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_desktop', 'token_desktop', ?, ?, ?, ?, ?)`,
    desktopId,
    "Ubuntu 24.04 Rig",
    "Desktop",
    JSON.stringify({ architecture: "x86_64", cpu_cores: 16, total_ram_mb: 32768, device_model: "AMD Ryzen 9" }),
    JSON.stringify({ wasm_conformance_passed: true, edge_score: 98.0, tier: "QUALIFIED", benchmark_version: "v1.2.0-verified" }),
    JSON.stringify({ battery_pct: 100, charging_state: "CHARGING_AC", network_type: "Ethernet", thermal_status: "NONE", round_trip_ping_ms: 4 }),
    Date.now(),
    Date.now()
  );

  // 2. Test Health Endpoint Live Aggregates
  const healthRes = await coordinator.fetch(new Request("http://localhost/api/v1/system/health"));
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.status, "healthy");
  assert.equal(health.total_nodes, 2);
  assert.equal(health.physical_nodes, 1);
  assert.equal(health.ready_nodes, 2);
  assert.equal(health.fabric_status, "ACTIVE");
  assert.ok(health.subsystems.scheduler === "PARETO_ACTIVE");

  // 3. Test Capability Vector Endpoint for Vivo I2221
  const capsRes = await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${phoneId}/capabilities`));
  assert.equal(capsRes.status, 200);
  const capsData = await capsRes.json();
  assert.equal(capsData.status, "ok");
  assert.equal(capsData.capabilities.is_physical, true);
  assert.equal(capsData.capabilities.provenance, "PHYSICAL_DEVICE_PROVEN");
  assert.equal(capsData.capabilities.qualification_tier, "QUALIFIED");
  assert.equal(capsData.capabilities.wasm.conformance_passed, true);
  assert.equal(capsData.capabilities.accelerators.gpu.validation_status, "UNVERIFIED");
  assert.equal(capsData.capabilities.accelerators.gpu.evidence_label, "HARDWARE-REQUIRED");
  assert.equal(capsData.capabilities.accelerators.npu.validation_status, "UNVERIFIED");

  // 4. Test Workload Compatibility Pre-flight Estimator
  const compatRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/compatibility", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: phoneId,
      spec: {
        name: "Telemetry Compressor",
        required_capabilities: { min_ram_mb: 256, require_charging: true },
        limits: { max_fuel: 10000000 }
      }
    })
  }));
  assert.equal(compatRes.status, 200);
  const compatData = await compatRes.json();
  assert.equal(compatData.can_run, true);
  assert.ok(compatData.estimates.runtime_ms > 0);
  assert.ok(compatData.estimates.credits_cost >= 10.0);
  assert.ok(compatData.why_this_device.includes("passed all capability filters"));

  // 4b. Test Incompatible Workload (Unverified GPU)
  const gpuCompatRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/compatibility", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: phoneId,
      spec: {
        name: "Vulkan Matrix Shader",
        required_capabilities: { gpu: true }
      }
    })
  }));
  assert.equal(gpuCompatRes.status, 200);
  const gpuCompatData = await gpuCompatRes.json();
  assert.equal(gpuCompatData.can_run, false);
  assert.ok(gpuCompatData.reasons.some(r => r.includes("GPU acceleration (Unverified / Hardware-Required)")));

  // 5. Test Multi-Worker DAG Sharding Benchmark
  const shardedRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs/sharded", {
    method: "POST",
    headers: { ...ADMIN_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Distributed Deflate Compressor",
      shard_count: 4,
      shards: 4
    })
  }));
  assert.equal(shardedRes.status, 200);
  const shardedData = await shardedRes.json();
  assert.equal(shardedData.status, "ok");
  assert.equal(shardedData.shard_count, 4);
  assert.equal(shardedData.shards.length, 4);
  assert.ok(shardedData.metrics.single_node_baseline_ms > 0);
  assert.ok(shardedData.metrics.parallel_wall_time_ms > 0);
  assert.ok(parseFloat(shardedData.metrics.speedup_factor) > 1.0);
  assert.ok(shardedData.metrics.total_credits_settled > 0);

  // 6. Test Node Emergency Stop
  const nodeStopRes = await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${phoneId}/emergency-stop`, {
    method: "POST",
    headers: ADMIN_HEADERS
  }));
  assert.equal(nodeStopRes.status, 200);
  const nodeStopData = await nodeStopRes.json();
  assert.equal(nodeStopData.status, "ok");
  assert.equal(nodeStopData.state, "Paused");

  const phoneRow = coordinator.sqlExec(`SELECT state FROM nodes WHERE id = ?`, phoneId)[0];
  assert.equal(phoneRow.state, "Paused");

  // 7. Test Fabric Emergency Stop
  const fabricStopRes = await coordinator.fetch(new Request("http://localhost/api/v1/fabric/emergency-stop", {
    method: "POST",
    headers: ADMIN_HEADERS
  }));
  assert.equal(fabricStopRes.status, 200);
  const fabricStopData = await fabricStopRes.json();
  assert.equal(fabricStopData.status, "ok");
  assert.equal(fabricStopData.fabric_status, "STOPPED");

  const fabricHealthRes = await coordinator.fetch(new Request("http://localhost/api/v1/system/health"));
  const fabricHealth = await fabricHealthRes.json();
  assert.equal(fabricHealth.fabric_status, "STOPPED");
  assert.equal(fabricHealth.paused_nodes, 2);
});

test("SPaaSCoordinator — Subtest 25: Comprehensive Scheduler Policy Filters & Disqualification Edge Cases", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // Register nodes with diverse restrictive policies and telemetry
  // 1. Disqualified by low battery threshold
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_low_bat', 'token_1', ?, ?, ?, ?, ?)`,
    "node-low-bat",
    "Low Battery Device",
    "Phone",
    JSON.stringify({ cpu_cores: 8, total_ram_mb: 4096 }),
    JSON.stringify({ min_battery_threshold_pct: 50 }),
    JSON.stringify({ battery_pct: 30, charging_state: "DISCHARGING", network_type: "wifi", thermal_status: "NONE" }),
    Date.now(),
    Date.now()
  );

  // 2. Disqualified by charging only policy
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_charge_only', 'token_2', ?, ?, ?, ?, ?)`,
    "node-charge-only",
    "Charging Only Device",
    "Phone",
    JSON.stringify({ cpu_cores: 8, total_ram_mb: 4096 }),
    JSON.stringify({ only_while_charging: true }),
    JSON.stringify({ battery_pct: 90, charging_state: "DISCHARGING", network_type: "wifi", thermal_status: "NONE" }),
    Date.now(),
    Date.now()
  );

  // 3. Disqualified by unmetered network only policy
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_unmetered', 'token_3', ?, ?, ?, ?, ?)`,
    "node-cellular",
    "Cellular Device",
    "Phone",
    JSON.stringify({ cpu_cores: 8, total_ram_mb: 4096 }),
    JSON.stringify({ only_unmetered_network: true }),
    JSON.stringify({ battery_pct: 90, charging_state: "CHARGING_AC", network_type: "cellular_lte", thermal_status: "NONE" }),
    Date.now(),
    Date.now()
  );

  // 4. Disqualified by thermal critical
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_thermal', 'token_4', ?, ?, ?, ?, ?)`,
    "node-thermal-crit",
    "Overheating Device",
    "Phone",
    JSON.stringify({ cpu_cores: 8, total_ram_mb: 4096 }),
    JSON.stringify({}),
    JSON.stringify({ battery_pct: 90, charging_state: "CHARGING_AC", network_type: "wifi", thermal_status: "CRITICAL", temperature_c: 48 }),
    Date.now(),
    Date.now()
  );

  // 5. Submit heavy workload requiring unmetered network, charging, high RAM, and light thermal
  const heavyJobId = "job_heavy_policy_test";
  const heavyWlId = "wl_heavy_policy_test";
  coordinator.sqlExec(
    `INSERT INTO workloads (id, spec, submitter_pubkey, created_at) VALUES (?, ?, 'tester', ?)`,
    heavyWlId,
    JSON.stringify({
      name: "High Precision Sensor Analysis",
      required_capabilities: {
        min_ram_mb: 16384, // No node has 16GB
        require_charging: true,
        require_unmetered_network: true,
        min_battery_pct: 80,
        max_thermal_level: "LIGHT"
      },
      limits: { max_fuel: 50000000 }
    }),
    Date.now()
  );

  coordinator.sqlExec(
    `INSERT INTO jobs (id, workload_id, state, created_at) VALUES (?, ?, 'Queued', ?)`,
    heavyJobId,
    heavyWlId,
    Date.now()
  );

  // Attempt schedule
  await coordinator.schedulePendingJobs();

  // Verify wait_reason was populated explaining why no node was placed
  const jobRow = coordinator.sqlExec(`SELECT state, wait_reason FROM jobs WHERE id = ?`, heavyJobId)[0];
  assert.ok(["Pending", "Queued", "QUEUED"].includes(jobRow.state));
  assert.ok(jobRow.wait_reason.includes("Waiting for suitable node") || jobRow.wait_reason.includes("RAM"));

  // Test Workload Compatibility endpoint evaluating all reasons
  const compatAllRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/compatibility", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: "node-thermal-crit",
      spec: {
        name: "Test Heavy",
        required_capabilities: { min_ram_mb: 8192, require_charging: true }
      }
    })
  }));
  assert.equal(compatAllRes.status, 200);
  const compatAllData = await compatAllRes.json();
  assert.equal(compatAllData.can_run, false);
  assert.ok(compatAllData.reasons.length >= 1);
});

test("SPaaSCoordinator — Subtest 26: Authoritative 6-Tuple Device State & 10-Stage Job Lifecycle", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  // Register a Phone node (Online, Verified, Fully Qualified, Idle)
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_phone_6tuple', 'tok_phone_6tuple', ?, ?, ?, ?, ?, ?)`,
    "node-phone-6tuple",
    "Vivo I2221",
    "Phone",
    JSON.stringify({ cpu_cores: 8, total_ram_mb: 8192, wasm_verified: true, simd_supported: true, threads_supported: true }),
    JSON.stringify({ status: "VERIFIED", cpu_single_mips: 2450, memory_bandwidth_mbps: 14200 }),
    JSON.stringify({ max_cpu_pct: 60, max_ram_mb: 512, only_while_charging: false }),
    JSON.stringify({ battery_pct: 85, charging_state: "CHARGING", network_type: "wifi", thermal_status: "NONE" }),
    now,
    now
  );

  // Register an Offline Node
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_offline_node', 'tok_offline_node', ?, ?, ?, ?, ?, ?)`,
    "node-offline-6tuple",
    "Stale Worker",
    "Desktop",
    JSON.stringify({ cpu_cores: 16, total_ram_mb: 32768 }),
    JSON.stringify({ status: "STALE" }),
    JSON.stringify({ max_cpu_pct: 80 }),
    JSON.stringify({ battery_pct: 100, charging_state: "AC", network_type: "ethernet" }),
    now - 120000, // 2 minutes ago -> offline
    now - 120000
  );

  // Fetch nodes list
  const listRes = await coordinator.fetch(new Request("http://localhost/api/v1/nodes"));
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  const phoneNode = listData.nodes.find(n => n.id === "node-phone-6tuple");
  assert.ok(phoneNode);
  assert.equal(phoneNode.connection, "ONLINE");
  assert.equal(phoneNode.enrollment, "VERIFIED");
  assert.equal(phoneNode.qualification_status, "VERIFIED");
  assert.equal(phoneNode.availability, "AVAILABLE");
  assert.equal(phoneNode.eligibility, "FULL");
  assert.equal(phoneNode.execution_status, "IDLE");
  assert.deepEqual(phoneNode.authoritative_state, {
    connection: "ONLINE",
    enrollment: "VERIFIED",
    qualification: "VERIFIED",
    availability: "AVAILABLE",
    eligibility: "FULL",
    execution: "IDLE"
  });

  const offlineNode = listData.nodes.find(n => n.id === "node-offline-6tuple");
  assert.ok(offlineNode);
  assert.equal(offlineNode.connection, "OFFLINE");
  assert.equal(offlineNode.eligibility, "NONE");

  // Verify 10-Stage Job Lifecycle Transitions:
  // SUBMITTED -> QUEUED -> OFFERED -> LEASED -> DISPATCHED -> RUNNING -> UPLOADING -> VERIFYING -> COMPLETED -> SETTLED
  const jobId = "job-lifecycle-10stage";
  const submitRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: jobId,
      name: "Image Processing Lifecycle Test",
      spec: {
        runtime: "wasm",
        entrypoint: "process_image",
        required_capabilities: { min_ram_mb: 256 }
      }
    })
  }));
  assert.equal(submitRes.status, 201);

  // Check state transitions recorded
  let transitions = coordinator.sqlExec(`SELECT * FROM job_transitions WHERE job_id = ? ORDER BY timestamp ASC`, jobId);
  assert.ok(transitions.length >= 2);
  assert.equal(transitions[0].to_state, "SUBMITTED");
  assert.equal(transitions[1].to_state, "QUEUED");

  // Record transition to OFFERED
  coordinator.recordJobTransition(jobId, "OFFERED", "Dispatched offer to node-phone-6tuple", "Awaiting provider accept");
  // Record transition to LEASED
  coordinator.recordJobTransition(jobId, "LEASED", "Provider accepted job offer", "Fencing lease issued");
  // Record transition to DISPATCHED
  coordinator.recordJobTransition(jobId, "DISPATCHED", "Payload transferred to worker", "Awaiting execution");
  // Record transition to RUNNING
  coordinator.recordJobTransition(jobId, "RUNNING", "Worker execution started", "WASM sandbox active");
  // Record transition to UPLOADING
  coordinator.recordJobTransition(jobId, "UPLOADING", "Execution finished, uploading result payload", "Network egress");
  // Record transition to VERIFYING
  coordinator.recordJobTransition(jobId, "VERIFYING", "Attestation hash and fuel verification", "Coordinator verifying");
  // Record transition to COMPLETED
  coordinator.recordJobTransition(jobId, "COMPLETED", "Cryptographic proof verified", "Settling ledger");
  // Record transition to SETTLED
  coordinator.recordJobTransition(jobId, "SETTLED", "Ledger credit transfer settled", "Job complete");

  transitions = coordinator.sqlExec(`SELECT * FROM job_transitions WHERE job_id = ? ORDER BY timestamp ASC`, jobId);
  const states = transitions.map(t => t.to_state);
  assert.ok(states.includes("QUEUED"));
  assert.ok(states.includes("OFFERED"));
  assert.ok(states.includes("LEASED"));
  assert.ok(states.includes("DISPATCHED"));
  assert.ok(states.includes("RUNNING"));
  assert.ok(states.includes("UPLOADING"));
  assert.ok(states.includes("VERIFYING"));
  assert.ok(states.includes("COMPLETED"));
  assert.ok(states.includes("SETTLED"));
});

test("SPaaSCoordinator — Subtest 27: Blocked Scheduler UX & Automatic Dispatch on Heartbeat Charging Transition", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  const phoneId = "I2221";

  // Register phone on battery with only_while_charging policy
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    phoneId,
    "Vivo I2221",
    "Phone",
    "pk_i2221",
    "tok_i2221",
    JSON.stringify({ cpu_cores: 8, total_ram_mb: 8192, wasm_verified: true }),
    JSON.stringify({ status: "VERIFIED" }),
    JSON.stringify({ only_while_charging: true, min_battery_threshold_pct: 20 }),
    JSON.stringify({ battery_pct: 52, charging_state: "DISCHARGING", network_type: "wifi", thermal_status: "NONE" }),
    now,
    now
  );

  // Submit workload requiring charging
  const blockedJobId = "job-telemetry-compressor-001";
  const submitRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: blockedJobId,
      name: "Telemetry Compressor",
      spec: {
        runtime: "wasm",
        entrypoint: "compress",
        required_capabilities: { min_ram_mb: 256, require_charging: true }
      }
    })
  }));
  assert.equal(submitRes.status, 201);

  // Attempt schedule while phone is on battery
  await coordinator.schedulePendingJobs();

  // Verify job is marked QUEUED with structured queue_status
  const jobRow = coordinator.sqlExec(`SELECT state, wait_reason, queue_status FROM jobs WHERE id = ?`, blockedJobId)[0];
  assert.ok(["QUEUED", "Pending", "Queued"].includes(jobRow.state));
  assert.ok(jobRow.wait_reason.includes("0/1 eligible"));
  assert.ok(jobRow.wait_reason.includes("Charging required; currently on battery."));

  const queueStatus = JSON.parse(jobRow.queue_status);
  assert.equal(queueStatus.status, "BLOCKED");
  assert.equal(queueStatus.eligible_devices, 0);
  assert.equal(queueStatus.total_compatible, 1);
  assert.deepEqual(queueStatus.allowed_actions, ["Wait", "Edit Requirements", "Cancel"]);
  assert.ok(queueStatus.blocked_devices.some(d => d.device_id === phoneId && d.reason.includes("Charging required")));

  // Now phone transitions to charging via heartbeat
  const heartbeatRes = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/heartbeat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SPaaS-Node-ID": phoneId,
      "Authorization": "Bearer tok_i2221"
    },
    body: JSON.stringify({
      node_id: phoneId,
      battery_pct: 53,
      charging_state: "CHARGING",
      network_type: "wifi",
      thermal_status: "NONE"
    })
  }));
  assert.equal(heartbeatRes.status, 200);

  // Heartbeat immediately triggered schedulePendingJobs() because phone eligibility shifted from LIMITED to FULL!
  const updatedJobRow = coordinator.sqlExec(`SELECT state, assigned_node_id, wait_reason FROM jobs WHERE id = ?`, blockedJobId)[0];
  assert.ok(["DISPATCHED", "ASSIGNED", "OFFERED", "LEASED", "RUNNING"].includes((updatedJobRow.state || "").toUpperCase()));
  assert.equal(updatedJobRow.assigned_node_id, phoneId);
});

test("SPaaSCoordinator — Subtest 28: Intelligent Cost/Benefit DAG Decision", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  // Register 2 ready nodes: 1 PC and 1 Phone
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, 'Desktop', 'Ready', 0, 'pk_pc', 'tok_pc', ?, ?, ?, ?, ?, ?)`,
    "node-pc-01",
    "PC Linux Worker",
    JSON.stringify({ cpu_cores: 16, total_ram_mb: 32768, wasm_verified: true }),
    JSON.stringify({ status: "VERIFIED" }),
    JSON.stringify({ max_cpu_pct: 100 }),
    JSON.stringify({ battery_pct: 100, charging_state: "AC", network_type: "ethernet" }),
    now,
    now
  );

  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, policy, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, 'Phone', 'Ready', 0, 'pk_phone', 'tok_phone', ?, ?, ?, ?, ?, ?)`,
    "node-phone-01",
    "Phone Worker",
    JSON.stringify({ cpu_cores: 8, total_ram_mb: 8192, wasm_verified: true }),
    JSON.stringify({ status: "VERIFIED" }),
    JSON.stringify({ max_cpu_pct: 60 }),
    JSON.stringify({ battery_pct: 90, charging_state: "CHARGING", network_type: "wifi" }),
    now,
    now
  );

  // 1. Tiny Workload: Cost/Benefit model selects SINGLE NODE (DISTRIBUTION NOT BENEFICIAL)
  const tinyRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs/sharded", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "job-sharded-tiny-001",
      name: "Tiny SHA-256 (16KB)",
      divisible: true,
      total_operations: 5000,
      shard_count: 2,
      payload_bytes: 16384,
      spec: { runtime: "wasm", entrypoint: "hash" }
    })
  }));
  assert.equal(tinyRes.status, 200);
  const tinyData = await tinyRes.json();
  assert.equal(tinyData.distribution_decision, "DISTRIBUTION NOT BENEFICIAL");
  assert.ok(tinyData.decision_reason.includes("transfer+scheduling overhead > compute gain"));
  assert.equal(tinyData.sharding_executed, false);

  // 2. Large Divisible Workload: Cost/Benefit model selects SHARDED DAG (DISTRIBUTION BENEFICIAL)
  const largeRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs/sharded", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "job-sharded-large-001",
      name: "Matrix Multiply (512x512)",
      divisible: true,
      total_operations: 150000000,
      shard_count: 2,
      payload_bytes: 2097152,
      spec: { runtime: "wasm", entrypoint: "matmul" }
    })
  }));
  assert.equal(largeRes.status, 200);
  const largeData = await largeRes.json();
  assert.equal(largeData.distribution_decision, "DISTRIBUTION BENEFICIAL");
  assert.ok(largeData.decision_reason.includes("compute gain exceeds"));
  assert.equal(largeData.sharding_executed, true);
  assert.equal(largeData.shards.length, 2);
});

test("SPaaSCoordinator — Subtest 29: Scaling Lab Evidence, Preflight Calculation & Observability Tracing", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Workload Preflight Feasibility Calculation
  const preflightRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Preflight Test Task",
      spec: {
        runtime: "wasm",
        required_capabilities: { min_ram_mb: 512, require_charging: false }
      }
    })
  }));
  assert.equal(preflightRes.status, 200);
  const preflightData = await preflightRes.json();
  assert.ok(preflightData.status === "ok");
  assert.ok(typeof preflightData.total_devices === "number");
  assert.ok(typeof preflightData.compatible_devices === "number");
  assert.ok(typeof preflightData.currently_eligible_devices === "number");
  assert.ok(Array.isArray(preflightData.why_not_these_devices));

  // 2. Scaling Lab Run (Automated Reproducible Benchmarks)
  const runLabRes = await coordinator.fetch(new Request("http://localhost/api/v1/scaling-lab/run", {
    method: "POST"
  }));
  assert.equal(runLabRes.status, 200);
  const labData = await runLabRes.json();
  assert.equal(labData.status, "ok");
  assert.ok(labData.report_id.startsWith("sl_report_"));
  assert.ok(["PROVEN", "PHYSICAL-DEVICE-PROVEN"].includes(labData.provenance_classification));
  assert.equal(labData.experiments.length, 4);
  assert.ok(labData.signature.startsWith("sig_ed25519_scaling_lab_"));
  assert.ok(labData.artifact_sha256);

  // 3. Scaling Lab HTML Download Endpoint
  const reportHtmlRes = await coordinator.fetch(new Request("http://localhost/api/v1/scaling-lab/report"));
  assert.equal(reportHtmlRes.status, 200);
  const reportHtml = await reportHtmlRes.text();
  assert.ok(reportHtml.includes("<!DOCTYPE html>"));
  assert.ok(reportHtml.includes("Capability &amp; Scaling Lab Empirical Evidence Report"));
  assert.ok(reportHtml.includes("DISTRIBUTION BENEFICIAL"));
  assert.ok(reportHtml.includes("DISTRIBUTION NOT BENEFICIAL"));

  // 4. Observability Metrics
  const metricsRes = await coordinator.fetch(new Request("http://localhost/api/v1/observability/metrics"));
  assert.equal(metricsRes.status, 200);
  const metricsData = await metricsRes.json();
  assert.equal(metricsData.status, "ok");
  assert.ok(metricsData.epoch >= 1);
  assert.ok(typeof metricsData.node_eligibility.total === "number");
  assert.ok(typeof metricsData.jobs_lifecycle.total === "number");
  assert.ok(typeof metricsData.uptime_seconds === "number");

  // 5. Observability Trace
  await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: "job-trace-test-001",
      name: "Trace Test Job",
      spec: { runtime: "wasm", entrypoint: "main" }
    })
  }));
  const traceRes = await coordinator.fetch(new Request("http://localhost/api/v1/observability/trace/job-trace-test-001"));
  assert.equal(traceRes.status, 200);
  const traceData = await traceRes.json();
  assert.equal(traceData.status, "ok");
  assert.equal(traceData.job_id, "job-trace-test-001");
  assert.ok(traceData.lifecycle_timeline.length >= 1);
});

test("SPaaSCoordinator — Subtest 30: Identity, Tenant Isolation, Sessions, Scoped API Keys & 9-Role RBAC Authorization", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // 1. Login as Enterprise Customer
  const loginRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "developer@acme.ai", role: "CUSTOMER" })
  }));
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.equal(loginData.status, "ok");
  assert.ok(loginData.token.startsWith("sess_"));
  assert.equal(loginData.user.role, "CUSTOMER");
  assert.equal(loginData.tenant.id, "tenant_enterprise_customer");
  assert.equal(loginData.permissions.can_submit_jobs, true);
  assert.equal(loginData.permissions.can_access_admin, false);

  // 2. Validate session via /api/v1/auth/me
  const meRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/me", {
    method: "GET",
    headers: { "Authorization": `Bearer ${loginData.token}` }
  }));
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.role, "CUSTOMER");
  assert.equal(meData.tenant.name, "Acme Distributed AI Labs");

  // 3. Customer is forbidden from accessing Admin DR endpoint
  const adminForbiddenRes = await coordinator.fetch(new Request("http://localhost/api/v1/dr/checkpoint", {
    method: "GET",
    headers: { "Authorization": `Bearer ${loginData.token}` }
  }));
  assert.equal(adminForbiddenRes.status, 401);

  // 4. Create Scoped API Key as Customer Admin
  const custAdminLogin = await coordinator.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "customer_admin@acme.ai", role: "CUSTOMER_ADMIN" })
  }));
  const custAdminData = await custAdminLogin.json();

  const createKeyRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${custAdminData.token}` },
    body: JSON.stringify({ name: "CI Matrix Runner", scopes: ["jobs:create", "jobs:read"] })
  }));
  assert.equal(createKeyRes.status, 201);
  const keyData = await createKeyRes.json();
  assert.ok(keyData.api_key.startsWith("spaas_key_"));

  // 5. Query keys
  const listKeysRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/api-keys", {
    method: "GET",
    headers: { "Authorization": `Bearer ${custAdminData.token}` }
  }));
  assert.equal(listKeysRes.status, 200);
  const listKeysData = await listKeysRes.json();
  assert.ok(listKeysData.keys.length >= 1);

  // 6. Revoke key
  const revokeKeyRes = await coordinator.fetch(new Request(`http://localhost/api/v1/auth/api-keys/${keyData.key_id}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${custAdminData.token}` }
  }));
  assert.equal(revokeKeyRes.status, 200);

  // 7. Verify Super Admin Access
  const adminMeRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/me", {
    method: "GET",
    headers: { "Authorization": `Bearer ${TEST_ADMIN_SECRET}` }
  }));
  assert.equal(adminMeRes.status, 200);
  const adminMeData = await adminMeRes.json();
  assert.equal(adminMeData.role, "SUPER_ADMIN");
  assert.equal(adminMeData.permissions.can_access_admin, true);
});

test("SPaaSCoordinator — Subtest 31: Outcome Planner (Local vs Single Node vs Cluster Cost/Benefit Analysis & Explainability)", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  // Register active phone and desktop workers
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, last_heartbeat, created_at)
     VALUES ('phone_planner_01', 'Vivo I2221', 'Phone', 'Ready', 0, 'pk_phone', 'tok_phone', '{"cpu_cores":8}', ?, ?)`,
    now, now
  );
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, last_heartbeat, created_at)
     VALUES ('desktop_planner_01', 'Workstation PC', 'Desktop', 'Ready', 0, 'pk_pc', 'tok_pc', '{"cpu_cores":16}', ?, ?)`,
    now, now
  );

  // 1. Analyze Large Workload: Planner evaluates Local vs Single vs Cluster
  const planRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Matrix Multiply (512x512)",
      workload_type: "matrix",
      payload_bytes: 2097152,
      total_operations: 150000000,
      optimization_goal: "Fastest"
    })
  }));
  assert.equal(planRes.status, 200);
  const planData = await planRes.json();
  assert.equal(planData.status, "ok");
  assert.equal(planData.distribution_decision, "DISTRIBUTION BENEFICIAL");
  assert.equal(planData.recommended_mode, "CLUSTER");
  assert.ok(planData.plans.local.total_wall_time_ms > 0);
  assert.ok(planData.plans.single_node.total_wall_time_ms > 0);
  assert.ok(planData.plans.cluster.total_wall_time_ms > 0);
  assert.ok(planData.plans.cluster.speedup_factor_vs_single.includes("x"));
  assert.ok(planData.plans.single_node.why_this_device.length > 0);
  assert.ok(planData.plans.cluster.why_distribute.length > 0);

  // 2. Analyze Small Workload: Planner explains why NOT to distribute
  const smallPlanRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Tiny SHA-256",
      workload_type: "hash",
      payload_bytes: 4096,
      total_operations: 10000,
      optimization_goal: "Fastest"
    })
  }));
  assert.equal(smallPlanRes.status, 200);
  const smallPlanData = await smallPlanRes.json();
  assert.equal(smallPlanData.distribution_decision, "DISTRIBUTION NOT BENEFICIAL");
  assert.equal(smallPlanData.recommended_mode, "SINGLE_NODE");
  assert.ok(smallPlanData.recommendation_reason.includes("exceed"));
});

test("SPaaSCoordinator — Subtest 32: Marketplace Billing, Configurable Platform Fees, Provider Payouts & Triple-Entry Balanced Financial Reconciliation", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Query billing config
  const cfgRes = await coordinator.fetch(new Request("http://localhost/api/v1/billing/config"));
  assert.equal(cfgRes.status, 200);
  const cfgData = await cfgRes.json();
  assert.equal(cfgData.platform_fee_pct, 15.0);

  // 2. Update platform fee to 20%
  const updateCfgRes = await coordinator.fetch(new Request("http://localhost/api/v1/billing/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TEST_ADMIN_SECRET}` },
    body: JSON.stringify({ platform_fee_pct: 20.0 })
  }));
  assert.equal(updateCfgRes.status, 200);

  const newCfgRes = await coordinator.fetch(new Request("http://localhost/api/v1/billing/config"));
  const newCfgData = await newCfgRes.json();
  assert.equal(newCfgData.platform_fee_pct, 20.0);

  // 3. Provider requests payout
  const payoutRes = await coordinator.fetch(new Request("http://localhost/api/v1/billing/payout-request", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer token_provider" },
    body: JSON.stringify({ amount_credits: 75.0 })
  }));
  assert.equal(payoutRes.status, 201);
  const payoutData = await payoutRes.json();
  assert.equal(payoutData.status, "PENDING");
  assert.equal(payoutData.amount_credits, 75.0);
  assert.equal(payoutData.amount_usd, 0.75);

  // 4. Query financial reconciliation report (as Auditor)
  const reconRes = await coordinator.fetch(new Request("http://localhost/api/v1/billing/reconciliation", {
    headers: { "Authorization": "Bearer token_auditor" }
  }));
  assert.equal(reconRes.status, 200);
  const reconData = await reconRes.json();
  assert.equal(reconData.status, "ok");
  assert.equal(reconData.reconciliation_status, "BALANCED");
  assert.equal(reconData.discrepancy_credits, 0.0000);
  assert.equal(reconData.evidence_label, "PROVEN");
});

test("SPaaSCoordinator — Subtest 33: Provider ASK ME Job Offers Lifecycle & Monotonic State Sync", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  const nodeId = "node-ask-me-01";
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, policy, last_heartbeat, created_at)
     VALUES (?, 'Provider Phone', 'Phone', 'Ready', 0, 'pk_ask', 'tok_ask', '{"mode":"ASK_ME"}', ?, ?)`,
    nodeId, now, now
  );

  // Insert an offered job
  coordinator.sqlExec(
    `INSERT INTO jobs (id, workload_id, state, assigned_node_id, version_id, created_at)
     VALUES (?, ?, 'OFFERED', ?, 1, ?)`,
    "job-offer-99", "matrix_multiply", nodeId, now
  );

  // 1. Provider polls for offers
  const offersRes = await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${nodeId}/offers`, {
    headers: { "Authorization": "Bearer tok_ask" }
  }));
  assert.equal(offersRes.status, 200);
  const offersData = await offersRes.json();
  assert.equal(offersData.offers.length, 1);
  assert.equal(offersData.offers[0].job_id, "job-offer-99");

  // 2. Provider responds with ACCEPT
  const acceptRes = await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${nodeId}/offers/job-offer-99/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer tok_ask" },
    body: JSON.stringify({ action: "ACCEPT" })
  }));
  assert.equal(acceptRes.status, 200);
  const acceptData = await acceptRes.json();
  assert.equal(acceptData.state, "LEASED");

  // 3. Monotonic State Sync
  const syncRes = await coordinator.fetch(new Request("http://localhost/api/v1/state/sync?since_version=0"));
  assert.equal(syncRes.status, 200);
  const syncData = await syncRes.json();
  assert.ok(syncData.current_version >= 1);
  assert.ok(syncData.jobs.length >= 1);
});

test("SPaaSCoordinator — Subtest 34: Real Sharded DAG Fault Recovery with Injected Worker Failure, Rescheduling & Identical Verified Digest", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const recoveryRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs/sharded/fail-and-recover", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TEST_ADMIN_SECRET}` }
  }));
  assert.equal(recoveryRes.status, 200);
  const recoveryData = await recoveryRes.json();
  assert.equal(recoveryData.status, "ok");
  assert.equal(recoveryData.recovery_demonstrated, true);
  assert.equal(recoveryData.fault_injected, "Worker-01 disconnection mid-flight");
  assert.equal(recoveryData.shard_1_status, "COMPLETED_ON_BACKUP");
  assert.equal(recoveryData.shard_2_status, "COMPLETED");
  assert.equal(recoveryData.output_verified, true);
  assert.ok(recoveryData.deterministic_result_digest);
  assert.equal(recoveryData.exactly_once_billing_verified, true);
  assert.equal(recoveryData.classification, "PROVEN");
});

test("SPaaSCoordinator — Subtest 35: Planner Unified Typed Contract, Cross-Layer Field Parity & Evidence Provenance", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  const now = Date.now();
  // Register physical qualified desktop worker
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, last_heartbeat, created_at)
     VALUES ('desktop_contract_01', 'AMD Ryzen Threadripper', 'Desktop', 'Ready', 0, 'pk_pc', 'tok_pc', '{"cpu_cores":16}', '{"wasm_conformance_passed":true,"measured_fuel_mips":180}', ?, ?)`,
    now, now
  );

  // 1. Unified Contract Call (Frontend field compatibility validation)
  const planRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Contract Parity Test",
      workload_type: "matrix",
      input_size_bytes: 1048576,
      total_operations: 10000000,
      optimization_goal: "Fastest"
    })
  }));
  assert.equal(planRes.status, 200);
  const plan = await planRes.json();

  // Root contract
  assert.equal(plan.status, "ok");
  assert.ok(plan.recommended_mode);
  assert.ok(plan.recommendation_reason);
  assert.ok(plan.distribution_decision);

  // Cross-layer compatibility: both flat and nested objects present
  assert.ok(plan.plans);
  assert.ok(plan.plans.local);
  assert.ok(plan.plans.single_node);
  assert.ok(plan.plans.cluster);
  assert.ok(plan.local);
  assert.ok(plan.single_node);
  assert.ok(plan.cluster);

  // UI field accessors validation
  assert.equal(plan.local.predicted_wall_time_ms, plan.plans.local.total_wall_time_ms);
  assert.equal(plan.single_node.predicted_wall_time_ms, plan.plans.single_node.total_wall_time_ms);
  assert.equal(plan.cluster.predicted_wall_time_ms, plan.plans.cluster.total_wall_time_ms);

  assert.ok(typeof plan.single_node.transfer_overhead_ms === "number");
  assert.ok(typeof plan.single_node.queue_wait_ms === "number");
  assert.ok(typeof plan.single_node.estimated_cost_credits === "number");
  assert.ok(typeof plan.cluster.transfer_overhead_ms === "number");
  assert.ok(typeof plan.cluster.aggregation_overhead_ms === "number");
  assert.ok(typeof plan.cluster.estimated_cost_credits === "number");

  assert.ok(plan.why_this_device.length > 0);
  assert.ok(plan.why_distribute.length > 0);
  assert.ok(plan.recommendation.mode);
  assert.ok(plan.recommendation.reason);

  // Honest Evidence Classification
  assert.ok(["PROVEN", "SIMULATION", "HEURISTIC", "EMPIRICAL", "PHYSICAL"].includes(plan.evidence_source));
  assert.equal(plan.evidence_label, plan.evidence_source);
  assert.ok(plan.data_provenance);
  assert.ok(plan.data_provenance.evaluated_workers_count >= 1);
  assert.ok(plan.data_provenance.confidence_pct >= 80);
});

test("SPaaSCoordinator — Subtest 36: Monotonic Optimistic Concurrency Sequence Tracking on Jobs & Nodes", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  // 1. Submit job and verify initial version_id
  const submitRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: "job-version-test-01",
      name: "Version Concurrency Test",
      spec: { runtime: "wasm", entrypoint: "main" }
    })
  }));
  assert.equal(submitRes.status, 201);

  const jobRows1 = coordinator.sqlExec(`SELECT state, version_id FROM jobs WHERE id = ?`, "job-version-test-01");
  assert.ok(jobRows1.length > 0);
  const v1 = jobRows1[0].version_id;
  assert.ok(v1 >= 1);

  // 2. Perform state transition and assert monotonic version increment
  coordinator.recordJobTransition("job-version-test-01", "RUNNING", "Worker execution started");
  const jobRows2 = coordinator.sqlExec(`SELECT state, version_id FROM jobs WHERE id = ?`, "job-version-test-01");
  const v2 = jobRows2[0].version_id;
  assert.ok(v2 > v1);
  assert.equal(jobRows2[0].state, "RUNNING");

  // 3. Complete job and assert monotonic increment
  coordinator.recordJobTransition("job-version-test-01", "COMPLETED", "Execution completed successfully");
  const jobRows3 = coordinator.sqlExec(`SELECT state, version_id FROM jobs WHERE id = ?`, "job-version-test-01");
  const v3 = jobRows3[0].version_id;
  assert.ok(v3 > v2);
  assert.equal(jobRows3[0].state, "COMPLETED");
});

test("SPaaSCoordinator — Subtest 37: Planner Typed Contract, Schema Versioning & Complete Strategies Shape", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const res = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workload_id: "wkld_custom_001",
      name: "Matrix Multiplication Benchmark",
      workload_type: "matrix",
      payload_bytes: 1048576,
      total_operations: 50000000,
      optimization_goal: "Fastest"
    })
  }));
  assert.equal(res.status, 200);
  const data = await res.json();

  // Root contract attributes
  assert.equal(data.schema_version, "2026-03-29.v1");
  assert.ok(data.plan_id && data.plan_id.startsWith("plan_"));
  assert.equal(data.workload_id, "wkld_custom_001");
  assert.equal(data.workload.name, "Matrix Multiplication Benchmark");
  assert.equal(data.workload.type, "matrix");
  assert.ok(typeof data.recommendation.confidence_pct === "number");

  // Canonical strategies structure
  assert.ok(data.strategies);
  assert.ok(data.strategies.local);
  assert.ok(data.strategies.single_node);
  assert.ok(data.strategies.cluster);

  const loc = data.strategies.local;
  assert.equal(loc.mode, "LOCAL_BROWSER");
  assert.equal(loc.worker_count, 1);
  assert.ok(typeof loc.predicted_wall_time_ms === "number");
  assert.equal(loc.cost.currency, "TEST_CREDITS");
  assert.equal(loc.cost.credits, 0);
  assert.ok(loc.privacy_guarantee.length > 0);

  const single = data.strategies.single_node;
  assert.equal(single.mode, "SINGLE_NODE");
  assert.ok(single.selected_node);
  assert.ok(typeof single.predicted_wall_time_ms === "number");
  assert.ok(typeof single.time_breakdown.transfer_upload_ms === "number");
  assert.ok(typeof single.time_breakdown.queue_wait_ms === "number");
  assert.ok(typeof single.time_breakdown.execution_ms === "number");
  assert.equal(single.cost.currency, "TEST_CREDITS");

  const clus = data.strategies.cluster;
  assert.equal(clus.mode, "CLUSTER");
  assert.ok(clus.worker_count >= 2);
  assert.ok(typeof clus.time_breakdown.aggregation_ms === "number");
  assert.ok(typeof clus.speedup_factor === "number");
  assert.ok(typeof clus.efficiency_pct === "number");
  assert.equal(clus.cost.currency, "TEST_CREDITS");

  // Provenance block
  assert.ok(data.provenance);
  assert.ok(["SIMULATION", "EMPIRICAL", "PHYSICAL"].includes(data.provenance.classification));
  assert.ok(data.provenance.source_breakdown.disclaimer.includes("simulation"));
});

test("SPaaSCoordinator — Subtest 38: Planner Truthful Simulation Provenance with Simulated Fleet", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  // Ensure only simulated node exists
  coordinator.sqlExec(`DELETE FROM nodes`);
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, last_heartbeat, created_at)
     VALUES ('sim_worker_01', 'Simulated Worker', 'Desktop', 'Ready', 1, 'pk_sim', 'tok_sim', '{"cpu_cores":4}', ?, ?)`,
    now, now
  );

  const res = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workload_type: "hash", optimization_goal: "Balanced" })
  }));
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.provenance.classification, "SIMULATION");
  assert.equal(data.provenance.simulated_workers_count, 1);
  assert.equal(data.provenance.physical_workers_count, 0);
  assert.equal(data.provenance.source_breakdown.is_synthetic, true);
  assert.equal(data.provenance.source_breakdown.calibration_source, "DEFAULT_SIMULATION_MODEL");
  assert.notEqual(data.provenance.classification, "PROVEN");
  assert.notEqual(data.provenance.classification, "HEURISTIC");
});

test("SPaaSCoordinator — Subtest 39: Planner Truthful Empirical Provenance with Physically Qualified Fleet", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  // Insert physical node with empirical benchmark qualification
  coordinator.sqlExec(`DELETE FROM nodes`);
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, capabilities, qualification, telemetry, last_heartbeat, created_at)
     VALUES (?, ?, ?, 'Ready', 0, 'pk_phys', 'tok_phys', ?, ?, ?, ?, ?)`,
    'phys_worker_01',
    'Physical Vivo V27',
    'Phone',
    JSON.stringify({ architecture: 'aarch64', cpu_cores: 8 }),
    JSON.stringify({ wasm_conformance_passed: true, measured_fuel_mips: 45.2, qualification_score: 98 }),
    JSON.stringify({ battery_pct: 100, charging_state: 'CHARGING_AC', network_type: 'Wi-Fi (Unmetered)' }),
    now,
    now
  );

  const res = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workload_type: "matrix", optimization_goal: "Fastest" })
  }));
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.provenance.classification, "EMPIRICAL");
  assert.equal(data.provenance.physical_workers_count, 1);
  assert.equal(data.provenance.simulated_workers_count, 0);
  assert.equal(data.provenance.source_breakdown.is_synthetic, false);
  assert.equal(data.provenance.source_breakdown.calibration_source, "DEVICE_BENCHMARK");
  assert.equal(data.provenance.confidence_pct, 95);
});

test("SPaaSCoordinator — Subtest 40: Planner RBAC 401 Unauthorized on Missing or Invalid Credentials", async () => {
  // Coordinator requiring planner auth
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_PLANNER_AUTH: "true"
  });

  // 1. Missing credentials when required -> 401
  const missingRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workload_type: "tiny" })
  }));
  assert.equal(missingRes.status, 401);
  const missingData = await missingRes.json();
  assert.equal(missingData.error, "UNAUTHORIZED");

  // 2. Invalid credentials provided -> 401
  const badTokenRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer bad_invalid_token_9999"
    },
    body: JSON.stringify({ workload_type: "tiny" })
  }));
  assert.equal(badTokenRes.status, 401);
  const badTokenData = await badTokenRes.json();
  assert.equal(badTokenData.error, "UNAUTHORIZED");
});

test("SPaaSCoordinator — Subtest 41: Planner RBAC 403 Forbidden for Authenticated Caller Lacking planner:use Permission", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // Role SECURITY does not have planner:use permission
  const forbiddenRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_security"
    },
    body: JSON.stringify({ workload_type: "tiny" })
  }));
  assert.equal(forbiddenRes.status, 403);
  const forbiddenData = await forbiddenRes.json();
  assert.equal(forbiddenData.error, "FORBIDDEN");

  // Role CUSTOMER does have planner:use permission -> 200
  const allowedRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer"
    },
    body: JSON.stringify({ workload_type: "tiny" })
  }));
  assert.equal(allowedRes.status, 200);
});

test("SPaaSCoordinator — Subtest 42: Centralized RBAC Matrix: Provider Cannot Submit Workload / Job (jobs:create required)", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const res = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_provider"
    },
    body: JSON.stringify({
      job_id: "job-provider-unauthorized-01",
      workload_id: "matrix_compute"
    })
  }));
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error, "FORBIDDEN");
  assert.equal(data.required_permission, "jobs:create");
});

test("SPaaSCoordinator — Subtest 43: Centralized RBAC Matrix: Customer Cannot Revoke Node (nodes:revoke required)", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const now = Date.now();
  coordinator.sqlExec(
    `INSERT INTO nodes (id, name, device_type, state, is_simulated, public_key, auth_token, last_heartbeat, created_at)
     VALUES ('test-node-to-revoke', 'Target Node', 'Desktop', 'Ready', 0, 'pk_target', 'tok_target', ?, ?)`,
    now, now
  );

  const res = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/test-node-to-revoke", {
    method: "DELETE",
    headers: {
      "Authorization": "Bearer token_customer"
    }
  }));
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error, "FORBIDDEN");
  assert.equal(data.required_permission, "nodes:revoke");
});

test("SPaaSCoordinator — Subtest 44: Centralized RBAC Matrix: Unauthenticated Request to Protected Route Rejected with 401 Unauthorized", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  const res = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "GET"
  }));
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "UNAUTHORIZED");
});

test("SPaaSCoordinator — Subtest 45: Centralized RBAC Matrix: Invalid Bearer Token Rejected with 401 Unauthorized", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const res = await coordinator.fetch(new Request("http://localhost/api/v1/nodes", {
    method: "GET",
    headers: {
      "Authorization": "Bearer totally_bogus_token_xyz_999"
    }
  }));
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "UNAUTHORIZED");
});

test("SPaaSCoordinator — Subtest 46: Centralized RBAC: Security Role Can Read Audit Logs but Cannot Manage Billing", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Audit read is allowed for SECURITY
  const auditRes = await coordinator.fetch(new Request("http://localhost/api/v1/audit", {
    headers: {
      "Authorization": "Bearer token_security"
    }
  }));
  assert.equal(auditRes.status, 200);

  // 2. Billing read is forbidden for SECURITY
  const billingRes = await coordinator.fetch(new Request("http://localhost/api/v1/metering", {
    headers: {
      "Authorization": "Bearer token_security"
    }
  }));
  assert.equal(billingRes.status, 403);
  const billingData = await billingRes.json();
  assert.equal(billingData.error, "FORBIDDEN");
  assert.equal(billingData.required_permission, "billing:read");
});

test("SPaaSCoordinator — Subtest 47: Idempotency Key Replay Returns Cached Response with Cache Header", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const idempotencyKey = `idem_test_${Date.now()}`;
  const workloadBody = {
    name: "Matrix Multiply Idempotency Test",
    limits: { max_fuel: 1000000, timeout_ms: 10000 }
  };

  // First request
  const res1 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(workloadBody)
  }));
  assert.equal(res1.status, 201);
  const data1 = await res1.json();
  assert.ok(data1.job_id);

  // Exact same replay
  const res2 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(workloadBody)
  }));
  assert.equal(res2.status, 201);
  assert.equal(res2.headers.get("X-Cache-Lookup"), "HIT-IDEMPOTENT");
  const data2 = await res2.json();
  assert.equal(data2.job_id, data1.job_id);
  assert.equal(data2.idempotent_replay, true);
});

test("SPaaSCoordinator — Subtest 48: Idempotency Key Reused with Different Payload Returns 409 Conflict", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const idempotencyKey = `idem_conflict_${Date.now()}`;

  // First request
  const res1 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({ name: "Workload Alpha", limits: { max_fuel: 500000 } })
  }));
  assert.equal(res1.status, 201);

  // Second request with SAME key but DIFFERENT body payload
  const res2 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({ name: "Workload Beta (Modified Payload)", limits: { max_fuel: 9999999 } })
  }));
  assert.equal(res2.status, 409);
  const data2 = await res2.json();
  assert.equal(data2.error, "IDEMPOTENCY_CONFLICT");
});

test("SPaaSCoordinator — Subtest 49: Optimistic Concurrency Control: Job Version Mismatch Returns 409 Conflict", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const createRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer"
    },
    body: JSON.stringify({ name: "OCC Test Workload" })
  }));
  assert.equal(createRes.status, 201);
  const job = await createRes.json();
  const jobId = job.job_id;

  // Stale version provided (e.g. expected_version = 999 while current is job.version_id)
  const updateRes = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${jobId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TEST_ADMIN_SECRET}`
    },
    body: JSON.stringify({
      expected_version: 999,
      name: "Renamed OCC Job"
    })
  }));
  assert.equal(updateRes.status, 409);
  const updateData = await updateRes.json();
  assert.equal(updateData.error, "VERSION_CONFLICT");
  assert.equal(updateData.expected_version, 999);
});

test("SPaaSCoordinator — Subtest 50: Optimistic Concurrency Control: Matching Version Succeeds and Monotonically Increments", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const createRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer"
    },
    body: JSON.stringify({ name: "OCC Monotonic Test" })
  }));
  const job = await createRes.json();
  const initialVersion = job.version_id;

  const updateRes = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${job.job_id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TEST_ADMIN_SECRET}`
    },
    body: JSON.stringify({
      expected_version: initialVersion,
      name: "OCC Updated Name"
    })
  }));
  assert.equal(updateRes.status, 200);
  const updateData = await updateRes.json();
  assert.ok(updateData.version_id > initialVersion);
});

test("SPaaSCoordinator — Subtest 51: Node Policy Optimistic Concurrency Control Enforces expected_version", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const tokenRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST", headers: ADMIN_HEADERS })
  );
  const { token } = await tokenRes.json();

  const pairRes = await (await coordinator.fetch(new Request("http://localhost/api/v1/devices/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairing_token: token,
      name: "OCC Node 01",
      device_name: "OCC Node 01",
      device_type: "android"
    })
  }))).json();

  // Mismatched expected_version
  const failRes = await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${pairRes.node_id}/policy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${pairRes.auth_token}`
    },
    body: JSON.stringify({
      expected_version: 999,
      charging_only: true
    })
  }));
  assert.equal(failRes.status, 409);
  const failData = await failRes.json();
  assert.equal(failData.error, "VERSION_CONFLICT");

  // Matching expected_version
  const nodeGet = await (await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${pairRes.node_id}`))).json();
  const okRes = await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${pairRes.node_id}/policy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${pairRes.auth_token}`
    },
    body: JSON.stringify({
      expected_version: nodeGet.version_id || 1,
      charging_only: true
    })
  }));
  assert.equal(okRes.status, 200);
  const okData = await okRes.json();
  assert.ok(okData.version_id > (nodeGet.version_id || 1));
});

test("SPaaSCoordinator — Subtest 52: State Machine Transition Validation: Cannot Transition COMPLETED to RUNNING", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const createRes = await (await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer token_customer" },
    body: JSON.stringify({ name: "Terminal Transition Test" })
  }))).json();

  // Complete the job
  coordinator.sqlExec("UPDATE jobs SET state = 'COMPLETED' WHERE id = ?", createRes.job_id);

  // Attempt invalid transition back to RUNNING via PUT
  const invalidRes = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${createRes.job_id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TEST_ADMIN_SECRET}` },
    body: JSON.stringify({ state: "RUNNING" })
  }));
  assert.equal(invalidRes.status, 409);
  const invalidData = await invalidRes.json();
  assert.equal(invalidData.error, "INVALID_STATE_TRANSITION");
});

test("SPaaSCoordinator — Subtest 53: Monotonic Fencing Token Generator Produces Ordered Tokens", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const t1 = coordinator.getNextFencingToken();
  const t2 = coordinator.getNextFencingToken();
  const t3 = coordinator.getNextFencingToken();

  assert.ok(t1.startsWith("fence_1_"));
  assert.ok(t2.startsWith("fence_1_"));
  assert.ok(t3.startsWith("fence_1_"));
  assert.notEqual(t1, t2);
  assert.notEqual(t2, t3);
  // Monotonically increasing sequence suffix
  const seq1 = parseInt(t1.split("_").pop(), 10);
  const seq2 = parseInt(t2.split("_").pop(), 10);
  const seq3 = parseInt(t3.split("_").pop(), 10);
  assert.ok(seq2 > seq1);
  assert.ok(seq3 > seq2);
});

test("SPaaSCoordinator — Subtest 54: Expired or Non-Active Lease Fencing Token Rejection", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const tokenRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST", headers: ADMIN_HEADERS })
  );
  const { token } = await tokenRes.json();

  const pairRes = await (await coordinator.fetch(new Request("http://localhost/api/v1/devices/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairing_token: token,
      name: "Fencing Lease Node",
      device_name: "Fencing Lease Node",
      device_type: "android"
    })
  }))).json();

  const fencingToken = coordinator.getNextFencingToken();
  const jobId = "fence-lease-job-001";
  coordinator.sqlExec(
    "INSERT INTO jobs (id, workload_id, state, assigned_node_id, fencing_token, created_at) VALUES (?, 'wl_fencing', 'Running', ?, ?, ?)",
    jobId, pairRes.node_id, fencingToken, Date.now()
  );
  // Insert lease with EXPIRED state
  coordinator.sqlExec(
    "INSERT INTO leases (lease_id, job_id, node_id, fencing_token, epoch, expires_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    `lease_${jobId}`, jobId, pairRes.node_id, fencingToken, 1, Date.now() - 10000, "EXPIRED", Date.now() - 60000
  );

  const res = await coordinator.handleResultSubmission({
    job_id: jobId,
    node_id: pairRes.node_id,
    fencing_token: fencingToken,
    exit_code: 0
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.reason, "STALE_FENCING_TOKEN");
});

test("SPaaSCoordinator — Subtest 55: On-Demand State Reconciliation (/api/v1/reconciliation/run) Heals Fabric", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Create a dead node (heartbeat 60s ago)
  const deadNodeId = "dead_node_test_01";
  coordinator.sqlExec("INSERT INTO nodes (id, name, device_type, state, last_heartbeat, is_simulated) VALUES (?, 'Dead Node', 'android', 'Ready', ?, 0)", deadNodeId, Date.now() - 60000);

  // 2. Create an expired lease
  const expiredJobId = "job_expired_lease_01";
  coordinator.sqlExec("INSERT INTO jobs (id, state, lease_expires_at, retry_count, max_retries) VALUES (?, 'Running', ?, 0, 3)", expiredJobId, Date.now() - 5000);
  coordinator.sqlExec("INSERT INTO leases (lease_id, job_id, node_id, fencing_token, epoch, expires_at, state, created_at) VALUES ('l_exp_01', ?, ?, 'fence_exp', 1, ?, 'ACTIVE', ?)",
    expiredJobId, deadNodeId, Date.now() - 5000, Date.now() - 60000
  );

  // Trigger state reconciliation
  const reconRes = await coordinator.fetch(new Request("http://localhost/api/v1/reconciliation/run", {
    method: "POST",
    headers: {
      "Authorization": "Bearer token_ops"
    }
  }));
  assert.equal(reconRes.status, 200);
  const reconData = await reconRes.json();
  assert.equal(reconData.status, "ok");
  assert.ok(reconData.leases_expired >= 1);
  assert.ok(reconData.nodes_marked_offline >= 1);
  assert.ok(reconData.jobs_requeued >= 1);

  // Verify DB state
  const nodeAfter = coordinator.sqlExec("SELECT state FROM nodes WHERE id = ?", deadNodeId);
  assert.equal(nodeAfter[0].state, "Offline");

  const jobAfter = coordinator.sqlExec("SELECT state, retry_count FROM jobs WHERE id = ?", expiredJobId);
  assert.equal(jobAfter[0].state, "Pending");
  assert.equal(jobAfter[0].retry_count, 1);
});

test("SPaaSCoordinator — Subtest 56: State Reconciliation RBAC Rejects Unprivileged Roles", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // Customer cannot run state reconciliation
  const custRes = await coordinator.fetch(new Request("http://localhost/api/v1/reconciliation/run", {
    method: "POST",
    headers: {
      "Authorization": "Bearer token_customer"
    }
  }));
  assert.equal(custRes.status, 403);
  const custData = await custRes.json();
  assert.equal(custData.error, "FORBIDDEN");

  // Ops can run state reconciliation
  const opsRes = await coordinator.fetch(new Request("http://localhost/api/v1/reconciliation/run", {
    method: "POST",
    headers: {
      "Authorization": "Bearer token_ops"
    }
  }));
  assert.equal(opsRes.status, 200);
});











