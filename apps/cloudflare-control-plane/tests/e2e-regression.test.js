/**
 * SPaaS Universal Edge Compute Fabric — Phase 4 E2E Integration & Regression Suite
 * 
 * Verifies end-to-end integration across:
 * 1. Planner Unified Shape & Explainability & Honest Provenance
 * 2. Centralized RBAC Matrix & Device Authorization Interception
 * 3. Idempotency Key Caching & Payload Mismatch Conflict (409)
 * 4. Optimistic Concurrency Control (OCC) on Jobs and Node Policies
 * 5. Authoritative Terminal State Machine Transition Guards
 * 6. Monotonic Fencing Tokens & Stale Lease Rejection
 * 7. Result Replay Deduplication & Double-Entry Ledger Invariance
 * 8. Authoritative Fabric State Reconciliation Sweep
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SPaaSCoordinator } from "../src/coordinator.js";

const TEST_ADMIN_SECRET = "spaas_admin_secret_super_secure_key_12345";
const ADMIN_HEADERS = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${TEST_ADMIN_SECRET}`
};

test("E2E Integration — Planner Unified Typed Contract & Honest Provenance", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // 1. Submit analyze-plan request with customer credentials
  const planRes = await coordinator.fetch(new Request("http://localhost/api/v1/workloads/analyze-plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer"
    },
    body: JSON.stringify({
      workload_id: "e2e_workload_matrix",
      workload_type: "matrix_multiplication",
      target_latency_ms: 500,
      max_fuel: 5000000,
      input_data_bytes: 65536
    })
  }));

  assert.equal(planRes.status, 200);
  const plan = await planRes.json();

  // Unified schema assertions
  assert.equal(plan.schema_version, "2026-03-29.v1");
  assert.ok(plan.plan_id.startsWith("plan_"));
  assert.equal(plan.workload_id, "e2e_workload_matrix");
  assert.ok(["LOCAL", "SINGLE_NODE", "CLUSTER"].includes(plan.recommended_placement));

  // Strategies shape verification (local, single_node, cluster)
  assert.ok(plan.strategies);
  assert.ok(plan.strategies.local);
  assert.ok(plan.strategies.single_node);
  assert.ok(plan.strategies.cluster);
  assert.equal(typeof plan.strategies.local.predicted_wall_time_ms, "number");
  assert.equal(typeof plan.strategies.single_node.predicted_wall_time_ms, "number");
  assert.equal(typeof plan.strategies.cluster.predicted_wall_time_ms, "number");

  // Explainability object assertions
  assert.ok(plan.explanation);
  assert.equal(typeof plan.explanation.summary, "string");
  assert.equal(typeof plan.explanation.pareto_score, "number");
  assert.ok(Array.isArray(plan.explanation.tradeoffs));
  assert.ok(Array.isArray(plan.explanation.resource_bottlenecks));
  assert.ok(plan.explanation.cost_breakdown);

  // Honest provenance validation: Must NEVER claim PROVEN or HEURISTIC
  assert.ok(plan.provenance);
  assert.notEqual(plan.provenance.classification, "PROVEN");
  assert.notEqual(plan.provenance.classification, "HEURISTIC");
  assert.ok(["SIMULATION", "EMPIRICAL", "PHYSICAL"].includes(plan.provenance.classification));
});

test("E2E Integration — Centralized RBAC Interception & Route Security", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // 1. Unauthenticated request to protected route -> 401
  const unauthRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Unauth Job" })
  }));
  assert.equal(unauthRes.status, 401);

  // 2. Malformed token -> 401
  const badTokenRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer invalid_token_xyz" },
    body: JSON.stringify({ name: "Bad Token Job" })
  }));
  assert.equal(badTokenRes.status, 401);

  // 3. Customer accessing Super-Admin route -> 403
  const adminRes = await coordinator.fetch(new Request("http://localhost/api/v1/fabric/emergency-stop", {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(adminRes.status, 403);

  // 4. Provider attempting customer job creation (lacks jobs:create) -> 403
  const provRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer token_provider" },
    body: JSON.stringify({ name: "Provider Job" })
  }));
  assert.equal(provRes.status, 403);
  const provData = await provRes.json();
  assert.equal(provData.error, "FORBIDDEN");
  assert.equal(provData.required_permission, "jobs:create");

  // 5. Customer attempting node revocation (lacks nodes:revoke) -> 403
  const custRes = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/node_target", {
    method: "DELETE",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(custRes.status, 403);
  const custData = await custRes.json();
  assert.equal(custData.error, "FORBIDDEN");
  assert.equal(custData.required_permission, "nodes:revoke");
});

test("E2E Integration — Idempotency Key Caching & Payload Mismatch 409 Conflict", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const idempotencyKey = `e2e_idemp_${crypto.randomUUID()}`;
  const originalPayload = {
    name: "Idempotent Pipeline Job",
    workload_type: "wasm_pipeline",
    limits: { max_fuel: 2500000 }
  };

  // 1. Initial request -> 201 Created
  const res1 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(originalPayload)
  }));
  assert.equal(res1.status, 201);
  const data1 = await res1.json();
  assert.ok(data1.job_id);

  // 2. Exact identical replay -> 201 with cache lookup header
  const res2 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(originalPayload)
  }));
  assert.equal(res2.status, 201);
  assert.equal(res2.headers.get("X-Cache-Lookup"), "HIT-IDEMPOTENT");
  const data2 = await res2.json();
  assert.equal(data2.job_id, data1.job_id);

  // 3. Same key with DIFFERENT payload -> 409 Conflict
  const res3 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({ ...originalPayload, limits: { max_fuel: 9999999 } })
  }));
  assert.equal(res3.status, 409);
  const data3 = await res3.json();
  assert.equal(data3.error, "IDEMPOTENCY_CONFLICT");
});

test("E2E Integration — Optimistic Concurrency Control (OCC) on Jobs and Nodes", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Job OCC
  const jobCreate = await (await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer token_customer" },
    body: JSON.stringify({ name: "OCC Target Job" })
  }))).json();

  const v1 = jobCreate.version_id || 1;

  // Stale version update -> 409
  const jobConflict = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${jobCreate.job_id}`, {
    method: "PATCH",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ expected_version: 999, name: "Failed Update" })
  }));
  assert.equal(jobConflict.status, 409);
  assert.equal((await jobConflict.json()).error, "VERSION_CONFLICT");

  // Valid version update -> 200 and version monotonically increments
  const jobOk = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${jobCreate.job_id}`, {
    method: "PATCH",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ expected_version: v1, name: "Successful Update" })
  }));
  assert.equal(jobOk.status, 200);
  const jobOkData = await jobOk.json();
  assert.ok(jobOkData.version_id > v1);

  // 2. Node Policy OCC
  const token = (await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST", headers: ADMIN_HEADERS })
  )).json()).token;

  const pairData = await (await coordinator.fetch(new Request("http://localhost/api/v1/devices/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_token: token, name: "OCC Node E2E", device_type: "android" })
  }))).json();

  // Mismatched expected_version -> 409
  const nodeConflict = await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${pairData.node_id}/policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${pairData.auth_token}` },
    body: JSON.stringify({ expected_version: 888, charging_only: true })
  }));
  assert.equal(nodeConflict.status, 409);
  assert.equal((await nodeConflict.json()).error, "VERSION_CONFLICT");

  // Matching expected_version -> 200
  const nodeOk = await coordinator.fetch(new Request(`http://localhost/api/v1/nodes/${pairData.node_id}/policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${pairData.auth_token}` },
    body: JSON.stringify({ expected_version: 1, charging_only: true })
  }));
  assert.equal(nodeOk.status, 200);
  const nodeOkData = await nodeOk.json();
  assert.ok(nodeOkData.version_id > 1);
});

test("E2E Integration — Terminal State Machine Transition Guards", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const job = await (await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer token_customer" },
    body: JSON.stringify({ name: "Terminal State Test" })
  }))).json();

  // Mark job COMPLETED
  coordinator.sqlExec("UPDATE jobs SET state = 'COMPLETED' WHERE id = ?", job.job_id);

  // Attempt resurrecting transition back to RUNNING -> 409 Conflict
  const res = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${job.job_id}`, {
    method: "PUT",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ state: "RUNNING" })
  }));
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error, "INVALID_STATE_TRANSITION");

  // Attempt transition to DISPATCHED -> 409 Conflict
  const res2 = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${job.job_id}`, {
    method: "PUT",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ state: "DISPATCHED" })
  }));
  assert.equal(res2.status, 409);
});

test("E2E Integration — Fencing Monotonicity, Stale Token Rejection & Replay Deduplication", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  // 1. Fencing token ordering
  const f1 = coordinator.getNextFencingToken();
  const f2 = coordinator.getNextFencingToken();
  assert.ok(f1.startsWith("fence_1_"));
  assert.ok(f2.startsWith("fence_1_"));
  assert.notEqual(f1, f2);

  // 2. Setup node and job
  const token = (await (await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST", headers: ADMIN_HEADERS })
  )).json()).token;

  const pairData = await (await coordinator.fetch(new Request("http://localhost/api/v1/devices/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_token: token, name: "Replay Test Node", device_type: "android" })
  }))).json();

  const jobId = "job_replay_e2e_001";
  const validFencingToken = coordinator.getNextFencingToken();
  coordinator.sqlExec(
    "INSERT INTO jobs (id, workload_id, state, assigned_node_id, fencing_token, created_at) VALUES (?, 'wl_replay', 'Running', ?, ?, ?)",
    jobId, pairData.node_id, validFencingToken, Date.now()
  );
  coordinator.sqlExec(
    "INSERT INTO leases (lease_id, job_id, node_id, fencing_token, epoch, expires_at, state, created_at) VALUES (?, ?, ?, ?, 1, ?, 'ACTIVE', ?)",
    `lease_${jobId}`, jobId, pairData.node_id, validFencingToken, Date.now() + 60000, Date.now()
  );

  // 3. Stale / mismatched fencing token rejection
  const staleRes = await coordinator.handleResultSubmission({
    job_id: jobId,
    node_id: pairData.node_id,
    fencing_token: "stale_unassigned_token_999",
    exit_code: 0
  });
  assert.equal(staleRes.status, "rejected");
  assert.equal(staleRes.reason, "STALE_FENCING_TOKEN");

  // 4. Authentic result submission -> settles credits
  const goodRes = await coordinator.handleResultSubmission({
    job_id: jobId,
    node_id: pairData.node_id,
    fencing_token: validFencingToken,
    exit_code: 0,
    stdout: "E2E Execution Verified Digest",
    fuel_used: 1200000
  });
  assert.equal(goodRes.status, "accepted");
  assert.ok(goodRes.tx_id);

  const initialLedgerCount = (coordinator.sqlExec("SELECT COUNT(*) as c FROM ledger WHERE job_id = ?", jobId))[0].c;
  assert.equal(initialLedgerCount, 2); // 1 DEBIT + 1 CREDIT

  // 5. Replay of identical result submission -> returns cached settlement without duplicate ledger entries
  const replayRes = await coordinator.handleResultSubmission({
    job_id: jobId,
    node_id: pairData.node_id,
    fencing_token: validFencingToken,
    exit_code: 0,
    stdout: "E2E Execution Verified Digest",
    fuel_used: 1200000
  });
  assert.equal(replayRes.status, "accepted");
  assert.equal(replayRes.idempotent, true);
  assert.equal(replayRes.tx_id, goodRes.tx_id);

  const afterLedgerCount = (coordinator.sqlExec("SELECT COUNT(*) as c FROM ledger WHERE job_id = ?", jobId))[0].c;
  assert.equal(afterLedgerCount, 2); // Exactly 2, no duplication!
});

test("E2E Integration — Authoritative Fabric State Reconciliation", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET
  });

  const deadNodeId = "dead_node_recon_e2e";
  coordinator.sqlExec(
    "INSERT INTO nodes (id, name, device_type, state, last_heartbeat, is_simulated) VALUES (?, 'Stale Node', 'android', 'Ready', ?, 0)",
    deadNodeId, Date.now() - 60000
  );

  const expiredJobId = "job_expired_recon_e2e";
  coordinator.sqlExec(
    "INSERT INTO jobs (id, state, lease_expires_at, retry_count, max_retries) VALUES (?, 'Running', ?, 0, 3)",
    expiredJobId, Date.now() - 5000
  );
  coordinator.sqlExec(
    "INSERT INTO leases (lease_id, job_id, node_id, fencing_token, epoch, expires_at, state, created_at) VALUES ('lease_e2e_exp', ?, ?, 'fence_exp', 1, ?, 'ACTIVE', ?)",
    expiredJobId, deadNodeId, Date.now() - 5000, Date.now() - 60000
  );

  // Unprivileged customer cannot run reconciliation -> 403
  const custRes = await coordinator.fetch(new Request("http://localhost/api/v1/reconciliation/run", {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(custRes.status, 403);

  // Ops can run reconciliation -> 200 and fabric healed
  const opsRes = await coordinator.fetch(new Request("http://localhost/api/v1/reconciliation/run", {
    method: "POST",
    headers: { "Authorization": "Bearer token_ops" }
  }));
  assert.equal(opsRes.status, 200);
  const recon = await opsRes.json();
  assert.equal(recon.status, "ok");
  assert.ok(recon.leases_expired >= 1);
  assert.ok(recon.nodes_marked_offline >= 1);
  assert.ok(recon.jobs_requeued >= 1);

  // Verify node state in DB
  const nodeAfter = coordinator.sqlExec("SELECT state FROM nodes WHERE id = ?", deadNodeId);
  assert.equal(nodeAfter[0].state, "Offline");

  // Verify job requeued in DB
  const jobAfter = coordinator.sqlExec("SELECT state, retry_count FROM jobs WHERE id = ?", expiredJobId);
  assert.equal(jobAfter[0].state, "Pending");
  assert.equal(jobAfter[0].retry_count, 1);
});

test("E2E Integration — Mandatory 14-Attack-Vector RBAC & Security Boundaries Matrix", async () => {
  const coordinator = await SPaaSCoordinator.create(null, {
    SPAAS_ROLE: "PRIMARY",
    SPAAS_API_SECRET: TEST_ADMIN_SECRET,
    SPAAS_REQUIRE_AUTH: "true"
  });

  // Setup seed jobs and nodes for cross-tenant and device-binding tests
  const jobTenantB = "job_tenant_b_secret_01";
  coordinator.sqlExec(
    "INSERT INTO jobs (id, tenant_id, user_id, workload_id, state, assigned_node_id, fencing_token, created_at) VALUES (?, 'tenant_competitor_b', 'usr_competitor_dev', 'wl_secret', 'RUNNING', 'dev_node_b', 'fence_b_1', ?)",
    jobTenantB, Date.now()
  );

  const devTokenA = "spaas_auth_device_a_secret";
  const devTokenB = "spaas_auth_device_b_secret";
  coordinator.sqlExec(
    `INSERT OR REPLACE INTO nodes (id, name, device_type, public_key, auth_token, state, capabilities, policy, telemetry, is_simulated, tenant_id, last_heartbeat, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "dev_node_a", "Device A", "android", "ed25519_pk_a", devTokenA, "Ready", null, null, null, 0, "tenant_community_providers", Date.now(), Date.now()
  );
  coordinator.sqlExec(
    `INSERT OR REPLACE INTO nodes (id, name, device_type, public_key, auth_token, state, capabilities, policy, telemetry, is_simulated, tenant_id, last_heartbeat, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "dev_node_b", "Device B", "android", "ed25519_pk_b", devTokenB, "Ready", null, null, null, 0, "tenant_community_providers", Date.now(), Date.now()
  );

  // Attack 1: Anonymous -> Admin route = 401
  const a1 = await coordinator.fetch(new Request("http://localhost/api/v1/fabric/emergency-stop", { method: "POST" }));
  assert.equal(a1.status, 401, "Attack 1: Anonymous to admin endpoint must return 401");

  // Attack 2: Customer -> Emergency Stop = 403
  const a2 = await coordinator.fetch(new Request("http://localhost/api/v1/fabric/emergency-stop", {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(a2.status, 403, "Attack 2: Customer accessing emergency-stop must return 403");

  // Attack 3: Customer -> Admin Diagnostics = 403
  const a3 = await coordinator.fetch(new Request("http://localhost/api/v1/admin/diagnostics", {
    method: "GET",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(a3.status, 403, "Attack 3: Customer accessing admin diagnostics must return 403");

  // Attack 4: Customer -> Delete Node = 403
  const a4 = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/dev_node_a", {
    method: "DELETE",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(a4.status, 403, "Attack 4: Customer deleting node must return 403");

  // Attack 5: Customer A -> Customer B Job = 403 or 404
  const a5Read = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${jobTenantB}`, {
    method: "GET",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.ok(a5Read.status === 403 || a5Read.status === 404, "Attack 5: Customer A reading Customer B job must return 403/404");

  const a5Cancel = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${jobTenantB}/cancel`, {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.ok(a5Cancel.status === 403 || a5Cancel.status === 404, "Attack 5: Customer A cancelling Customer B job must return 403/404");

  // Attack 6: Provider -> Admin operations = 403
  const a6 = await coordinator.fetch(new Request("http://localhost/api/v1/fabric/emergency-stop", {
    method: "POST",
    headers: { "Authorization": "Bearer token_provider" }
  }));
  assert.equal(a6.status, 403, "Attack 6: Provider accessing admin fabric controls must return 403");

  // Attack 7: Device A -> Device B poll/results = 403
  const a7Poll = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/dev_node_b/poll", {
    method: "GET",
    headers: { "Authorization": `Bearer ${devTokenA}` }
  }));
  assert.equal(a7Poll.status, 403, "Attack 7: Device A polling Device B queue must return 403");

  const a7Res = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/results", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${devTokenA}` },
    body: JSON.stringify({ node_id: "dev_node_b", job_id: jobTenantB, fencing_token: "fence_b_1" })
  }));
  assert.equal(a7Res.status, 403, "Attack 7: Device A submitting results for Device B must return 403");

  // Attack 8: Expired Session Token = 401
  const expiredToken = "sess_expired_attack_test";
  coordinator.sqlExec(
    "INSERT INTO sessions (token, tenant_id, user_id, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    expiredToken, "tenant_enterprise_customer", "usr_cust_dev", "CUSTOMER", Date.now() - 5000, Date.now() - 100000
  );
  const a8 = await coordinator.fetch(new Request("http://localhost/api/v1/auth/me", {
    method: "GET",
    headers: { "Authorization": `Bearer ${expiredToken}` }
  }));
  assert.equal(a8.status, 401, "Attack 8: Expired session token must return 401");

  // Attack 9: Forged Role Header Ignored
  const a9 = await coordinator.fetch(new Request("http://localhost/api/v1/fabric/emergency-stop", {
    method: "POST",
    headers: {
      "Authorization": "Bearer token_customer",
      "X-SPaaS-Role": "SUPER_ADMIN",
      "X-Role": "SUPER_ADMIN",
      "Role": "SUPER_ADMIN"
    }
  }));
  assert.equal(a9.status, 403, "Attack 9: Forged role headers must be ignored and request denied with 403");

  // Attack 10: Modified tenant_id Ignored (Strictly Enforced Server-Side)
  const a10 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token_customer"
    },
    body: JSON.stringify({
      name: "Spoofed Tenant Workload",
      tenant_id: "tenant_competitor_b", // Attacker attempts to forge tenant ownership
      user_id: "usr_attacker_999"
    })
  }));
  assert.equal(a10.status, 201);
  const a10Data = await a10.json();
  const createdJobInDb = coordinator.sqlExec("SELECT tenant_id FROM jobs WHERE id = ?", a10Data.job_id);
  assert.equal(createdJobInDb[0].tenant_id, "tenant_enterprise_customer", "Attack 10: Tenant ID must be strictly bound to authenticated session, ignoring client payload spoofing");

  // Attack 11: Replayed Enrollment Token Rejected
  const tokenRes = await coordinator.fetch(new Request("http://localhost/api/v1/devices/pairing-token", {
    method: "POST",
    headers: ADMIN_HEADERS
  }));
  const { token: pairToken } = await tokenRes.json();
  const pairPayload = { pairing_token: pairToken, node_id: "node_single_use_test", device_type: "android" };
  const firstPair = await coordinator.fetch(new Request("http://localhost/api/v1/devices/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pairPayload)
  }));
  assert.equal(firstPair.status, 200);
  const replayPair = await coordinator.fetch(new Request("http://localhost/api/v1/devices/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pairPayload)
  }));
  assert.equal(replayPair.status, 400, "Attack 11: Replayed enrollment token must be rejected");

  // Attack 12: Revoked Device Rejected = 403
  coordinator.sqlExec("UPDATE nodes SET state = 'Revoked' WHERE id = ?", "dev_node_a");
  const a12 = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${devTokenA}` },
    body: JSON.stringify({ node_id: "dev_node_a" })
  }));
  assert.equal(a12.status, 403, "Attack 12: Revoked device heartbeat must be rejected with 403");

  // Attack 13: Duplicate Mutation with Idempotency-Key Safe
  const idempKey = "idemp_attack_matrix_key";
  const idempPayload = { name: "Safe Job", limits: { max_fuel: 500000 } };
  const m1 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer token_customer", "Idempotency-Key": idempKey },
    body: JSON.stringify(idempPayload)
  }));
  assert.equal(m1.status, 201);
  const m2 = await coordinator.fetch(new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer token_customer", "Idempotency-Key": idempKey },
    body: JSON.stringify(idempPayload)
  }));
  assert.equal(m2.status, 201);
  const m1Data = await m1.json();
  const m2Data = await m2.json();
  assert.equal(m1Data.job_id, m2Data.job_id, "Attack 13: Duplicate mutation with idempotency key must safely return original entity");

  // Attack 14: Stale Fencing Result Rejected = 409
  coordinator.sqlExec("UPDATE jobs SET state = 'RUNNING', assigned_node_id = 'dev_node_b', fencing_token = 'fence_authoritative_epoch_5' WHERE id = ?", jobTenantB);
  const a14 = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/results", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${devTokenB}` },
    body: JSON.stringify({
      node_id: "dev_node_b",
      job_id: jobTenantB,
      fencing_token: "fence_stale_epoch_1", // Stale fence
      result: { exit_code: 0, stdout: "stale computation", fuel_consumed: 1000 }
    })
  }));
  assert.equal(a14.status, 409, "Attack 14: Stale fencing token result must be rejected with 409 Conflict");

  // Attack 15: Anonymous /auth/me = 401
  const a15 = await coordinator.fetch(new Request("http://localhost/api/v1/auth/me", {
    method: "GET"
  }));
  assert.equal(a15.status, 401, "Attack 15: Unauthenticated /auth/me must return 401 Unauthorized");

  // Attack 16: Customer A -> Customer B Job Trace, Decision, Observability Trace = 403
  const a16Trace = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${jobTenantB}/trace`, {
    method: "GET",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(a16Trace.status, 403, "Attack 16: Customer A viewing Customer B job trace must return 403 Forbidden");

  const a16Decision = await coordinator.fetch(new Request(`http://localhost/api/v1/jobs/${jobTenantB}/decision`, {
    method: "GET",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(a16Decision.status, 403, "Attack 16: Customer A viewing Customer B job decision must return 403 Forbidden");

  const a16Obs = await coordinator.fetch(new Request(`http://localhost/api/v1/observability/trace/${jobTenantB}`, {
    method: "GET",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(a16Obs.status, 403, "Attack 16: Customer A viewing Customer B observability trace must return 403 Forbidden");

  // Attack 17: Full Authoritative State DR Checkpoint Export
  const drRes = await coordinator.fetch(new Request("http://localhost/api/v1/dr/checkpoint", {
    method: "GET",
    headers: ADMIN_HEADERS
  }));
  assert.equal(drRes.status, 200);
  const drData = await drRes.json();
  assert.ok(Array.isArray(drData.users), "DR Checkpoint must export users");
  assert.ok(Array.isArray(drData.tenants), "DR Checkpoint must export tenants");
  assert.ok(Array.isArray(drData.leases), "DR Checkpoint must export leases");
  assert.ok(Array.isArray(drData.idempotency_keys), "DR Checkpoint must export idempotency_keys");
  assert.ok(Array.isArray(drData.device_sessions), "DR Checkpoint must export device_sessions");
  assert.ok(Array.isArray(drData.nodes), "DR Checkpoint must export nodes");
  assert.ok(Array.isArray(drData.jobs), "DR Checkpoint must export jobs");
  assert.ok(Array.isArray(drData.ledger), "DR Checkpoint must export ledger");

  // Attack 18: FinOps Commercial Double-Entry Dynamic Reconciliation
  const reconRes = await coordinator.fetch(new Request("http://localhost/api/v1/billing/reconciliation", {
    method: "GET",
    headers: ADMIN_HEADERS
  }));
  assert.equal(reconRes.status, 200);
  const reconData = await reconRes.json();
  assert.equal(typeof reconData.discrepancy_credits, "number");
  assert.equal(reconData.reconciliation_status, "BALANCED");
  assert.ok(reconData.payment_gateway);
  assert.equal(reconData.payment_gateway.fiat_settlement_enabled, false);
  assert.ok(reconData.unit_economics);

  // Attack 19: One-Time First Owner Bootstrap Lifecycle & Permanent Disable
  // Reset bootstrap state to simulate fresh deployment
  const resetRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/bootstrap/test-reset", { method: "POST" }));
  assert.equal(resetRes.status, 200);
  const resetData = await resetRes.json();
  const bootstrapToken = resetData.bootstrap_token;
  assert.ok(bootstrapToken, "Bootstrap token must be generated");

  const bootStatusRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/bootstrap/status", { method: "GET" }));
  assert.equal(bootStatusRes.status, 200);
  const bootStatus = await bootStatusRes.json();
  assert.equal(bootStatus.bootstrap_available, true, "Bootstrap must be available when no superadmin exists");

  // Attempt owner creation with invalid bootstrap token -> 401
  const badBootRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/bootstrap/owner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "invalid_secret_token", email: "first_owner@spaas.dev", password: "SuperSecureOwnerPassword123!" })
  }));
  assert.equal(badBootRes.status, 401, "Attack 19a: Invalid bootstrap token must return 401");

  // Valid owner bootstrap -> 201
  const goodBootRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/bootstrap/owner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: bootstrapToken, email: "first_owner@spaas.dev", password: "SuperSecureOwnerPassword123!" })
  }));
  assert.equal(goodBootRes.status, 201, "Valid owner creation must succeed with 201");
  const goodBoot = await goodBootRes.json();
  assert.equal(goodBoot.role, "SUPER_ADMIN");

  // Subsequent bootstrap attempt MUST be permanently rejected -> 410
  const repeatBootRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/bootstrap/owner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: bootstrapToken, email: "attacker@spaas.dev", password: "AnotherSuperPassword123!" })
  }));
  assert.equal(repeatBootRes.status, 410, "Attack 19b: Subsequent bootstrap attempt must return 410 Gone");

  const bootStatusAfter = await (await coordinator.fetch(new Request("http://localhost/api/v1/auth/bootstrap/status", { method: "GET" }))).json();
  assert.equal(bootStatusAfter.bootstrap_available, false, "Bootstrap must be permanently closed");

  // Attack 20: Brute-Force Login Sliding Window Lockout
  const targetEmail = "first_owner@spaas.dev";
  for (let i = 0; i < 5; i++) {
    await coordinator.fetch(new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: targetEmail, password: "WrongPassword999!" })
    }));
  }
  const lockedLoginRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: targetEmail, password: "SuperSecureOwnerPassword123!" })
  }));
  assert.equal(lockedLoginRes.status, 429, "Attack 20: 6th login attempt after 5 failures must return 429 Too Many Requests");
  // Unlock for subsequent tests
  coordinator.recordLoginSuccess(targetEmail);

  // Attack 21: Turnstile Bot / Abuse Defense Enforcement
  const badTurnstileRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: targetEmail, password: "SuperSecureOwnerPassword123!", turnstile_token: "invalid_bot_token" })
  }));
  assert.equal(badTurnstileRes.status, 403, "Attack 21: Invalid Cloudflare Turnstile token must return 403 Forbidden");

  // Attack 22: Password Reset & Recovery Flow
  const resetReqRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/password/reset-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: targetEmail })
  }));
  assert.equal(resetReqRes.status, 200);
  const resetReqData = await resetReqRes.json();
  const resetToken = resetReqData.reset_token;
  assert.ok(resetToken, "Reset token must be generated in test mode");

  const confirmResetRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/password/reset-confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: resetToken, new_password: "BrandNewOwnerPassword456!" })
  }));
  assert.equal(confirmResetRes.status, 200, "Password reset confirmation must succeed");

  // Login with new password succeeds
  const loginNewPassRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: targetEmail, password: "BrandNewOwnerPassword456!" })
  }));
  assert.equal(loginNewPassRes.status, 200);
  const ownerSession = await loginNewPassRes.json();
  const ownerAuthHeader = `Bearer ${ownerSession.token}`;

  // Attack 23: MFA Enrollment & Verification
  const mfaSetupRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/mfa/setup", {
    method: "POST",
    headers: { "Authorization": ownerAuthHeader }
  }));
  assert.equal(mfaSetupRes.status, 200);
  const mfaSetup = await mfaSetupRes.json();
  assert.ok(mfaSetup.secret);
  assert.ok(Array.isArray(mfaSetup.backup_codes));

  const mfaVerifyRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/mfa/verify", {
    method: "POST",
    headers: { "Authorization": ownerAuthHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ code: "123456" })
  }));
  assert.equal(mfaVerifyRes.status, 200);
  assert.equal((await mfaVerifyRes.json()).mfa_enabled, true);

  // Attack 24: Passkey Challenge & Registration
  const pkChalRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/passkey/register-challenge", {
    method: "POST",
    headers: { "Authorization": ownerAuthHeader }
  }));
  assert.equal(pkChalRes.status, 200);

  const pkRegRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/passkey/verify-register", {
    method: "POST",
    headers: { "Authorization": ownerAuthHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ public_key: "ed25519_pk_yubikey_01", name: "YubiKey 5C NFC" })
  }));
  assert.equal(pkRegRes.status, 200);
  const pkReg = await pkRegRes.json();
  assert.ok(pkReg.passkey_id);

  // Attack 25: Session Listing & Revocation
  const listSessRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/sessions", {
    method: "GET",
    headers: { "Authorization": ownerAuthHeader }
  }));
  assert.equal(listSessRes.status, 200);
  const sessionsList = await listSessRes.json();
  assert.ok(sessionsList.sessions.length >= 1);

  const revokeAllRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/sessions/revoke-all", {
    method: "POST",
    headers: { "Authorization": ownerAuthHeader }
  }));
  assert.equal(revokeAllRes.status, 200);

  // Previously valid session is now revoked -> 401
  const afterRevokeRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/me", {
    method: "GET",
    headers: { "Authorization": ownerAuthHeader }
  }));
  assert.equal(afterRevokeRes.status, 401, "Attack 25: Revoked session must return 401 Unauthorized");

  // Attack 26: User Account Locking by Security Admin
  const lockRes = await coordinator.fetch(new Request("http://localhost/api/v1/admin/users/usr_cust_dev/lock", {
    method: "POST",
    headers: { "Authorization": "Bearer token_security" }
  }));
  assert.equal(lockRes.status, 200);

  // Locked user login attempt -> 403
  const lockedUserLogin = await coordinator.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "developer@acme.ai", password: "any" })
  }));
  assert.equal(lockedUserLogin.status, 403, "Attack 26: Login to locked account must return 403 Forbidden");

  // Unlock user
  const unlockRes = await coordinator.fetch(new Request("http://localhost/api/v1/admin/users/usr_cust_dev/unlock", {
    method: "POST",
    headers: { "Authorization": "Bearer token_security" }
  }));
  assert.equal(unlockRes.status, 200);

  // Attack 27: API Key Rotation
  const createKeyRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/api-keys", {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer_admin", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "CI Build Key" })
  }));
  assert.equal(createKeyRes.status, 201);
  const keyData = await createKeyRes.json();

  const rotateKeyRes = await coordinator.fetch(new Request(`http://localhost/api/v1/auth/api-keys/${keyData.key_id}/rotate`, {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer_admin" }
  }));
  assert.equal(rotateKeyRes.status, 200);
  const rotated = await rotateKeyRes.json();
  assert.notEqual(rotated.api_key, keyData.api_key, "Rotated key secret must differ from original");

  // Attack 28: Audited Break-Glass Emergency Recovery
  const bgInitRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/break-glass/initiate", { method: "POST" }));
  assert.equal(bgInitRes.status, 200);

  const bgConfirmRes = await coordinator.fetch(new Request("http://localhost/api/v1/auth/break-glass/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recovery_code: "emergency_break_glass_root_2026" })
  }));
  assert.equal(bgConfirmRes.status, 200);
  const bgData = await bgConfirmRes.json();
  assert.equal(bgData.role, "SUPER_ADMIN");
  assert.ok(bgData.emergency_session_token);

  // Attack 29: Cloudflare R2 Content-Addressed Artifacts with Tenant Isolation
  const rawBase64 = "SGVsbG8gU1BhYVMgRWRnZSBDb21wdXRlIEZhYnJpYyE=";
  const storeArtRes = await coordinator.fetch(new Request("http://localhost/api/v1/artifacts", {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer", "Content-Type": "application/json" },
    body: JSON.stringify({ content_base64: rawBase64, filename: "payload.bin", content_type: "application/octet-stream" })
  }));
  assert.equal(storeArtRes.status, 201);
  const artData = await storeArtRes.json();
  assert.ok(artData.sha256);

  // Cross-tenant artifact fetch -> 403
  coordinator.sqlExec("INSERT OR IGNORE INTO users (id, tenant_id, email, role, status, created_at) VALUES ('usr_tenant_b', 'tenant_competitor_b', 'b@comp.ai', 'CUSTOMER', 'ACTIVE', 1700000000000)");
  coordinator.sqlExec("INSERT OR IGNORE INTO sessions (token, tenant_id, user_id, role, expires_at, created_at) VALUES ('sess_tenant_b', 'tenant_competitor_b', 'usr_tenant_b', 'CUSTOMER', 9999999999999, 1700000000000)");
  const crossArtRes = await coordinator.fetch(new Request(`http://localhost/api/v1/artifacts/${artData.sha256}`, {
    method: "GET",
    headers: { "Authorization": "Bearer sess_tenant_b" }
  }));
  assert.equal(crossArtRes.status, 403, "Attack 29: Cross-tenant artifact access must return 403 Forbidden");

  // Owner tenant artifact fetch -> 200
  const ownerArtRes = await coordinator.fetch(new Request(`http://localhost/api/v1/artifacts/${artData.sha256}`, {
    method: "GET",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(ownerArtRes.status, 200);

  // Attack 30: Cloudflare Queues Delivery Layer
  const queueMsgRes = await coordinator.fetch(new Request("http://localhost/api/v1/queues/dispatch", {
    method: "POST",
    headers: { "Authorization": "Bearer token_ops", "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: "job_queue_test", task: "compile_wasm" })
  }));
  assert.equal(queueMsgRes.status, 202);
  const qData = await queueMsgRes.json();
  assert.ok(qData.event_id);
  assert.equal(qData.queue, "dispatch");

  const qStatusRes = await coordinator.fetch(new Request("http://localhost/api/v1/queues/status", {
    method: "GET",
    headers: { "Authorization": "Bearer token_ops" }
  }));
  assert.equal(qStatusRes.status, 200);

  // Attack 31: Cloudflare Quota Guard Monitoring
  const quotaRes = await coordinator.fetch(new Request("http://localhost/api/v1/system/quota-guard", { method: "GET" }));
  assert.equal(quotaRes.status, 200);
  const quotaData = await quotaRes.json();
  assert.ok(quotaData.quota_guard);
  assert.equal(quotaData.quota_guard.status, "HEALTHY");

  // Attack 32: Job Checkpoint & Ephemeral CI Agent Lifecycle
  const chkRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs/job_checkpoint_test/checkpoint", {
    method: "POST",
    headers: { "Authorization": "Bearer token_ops", "Content-Type": "application/json" },
    body: JSON.stringify({ step: 42, state_data: { processed_rows: 50000, current_hash: "abcd1234" } })
  }));
  assert.equal(chkRes.status, 201);

  const getChkRes = await coordinator.fetch(new Request("http://localhost/api/v1/jobs/job_checkpoint_test/checkpoint", {
    method: "GET",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(getChkRes.status, 200);
  assert.equal((await getChkRes.json()).checkpoint.step, 42);

  // Ephemeral CI Sandboxed Agent
  const ciRes = await coordinator.fetch(new Request("http://localhost/api/v1/ci/jobs", {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer", "Content-Type": "application/json" },
    body: JSON.stringify({ repo: "https://github.com/spaas/wasm-kernel", commit: "a1b2c3d" })
  }));
  assert.equal(ciRes.status, 201);
  const ciJob = await ciRes.json();
  assert.equal(ciJob.workspace_status, "ACTIVE");

  const destroyCiRes = await coordinator.fetch(new Request(`http://localhost/api/v1/ci/jobs/${ciJob.ci_job_id}/destroy`, {
    method: "POST",
    headers: { "Authorization": "Bearer token_customer" }
  }));
  assert.equal(destroyCiRes.status, 200);
  assert.equal((await destroyCiRes.json()).workspace_status, "DESTROYED");
});
