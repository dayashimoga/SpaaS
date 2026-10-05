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
});
