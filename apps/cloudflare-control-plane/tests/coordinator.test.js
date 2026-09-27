import test from "node:test";
import assert from "node:assert/strict";
import { SPaaSCoordinator } from "../src/coordinator.js";

test("SPaaSCoordinator — Health & System Diagnostics", async () => {
  const coordinator = new SPaaSCoordinator(null, { SPAAS_ROLE: "PRIMARY" });

  const healthRes = await coordinator.fetch(new Request("http://localhost/health"));
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.status, "healthy");
  assert.equal(health.role, "PRIMARY");
  assert.equal(health.epoch, 1);

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

test("SPaaSCoordinator — Single-Use Pairing Tokens & Enrollment", async () => {
  const coordinator = new SPaaSCoordinator(null, { SPAAS_ROLE: "PRIMARY" });

  // 1. Issue pairing token
  const tokenRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST" })
  );
  assert.equal(tokenRes.status, 200);
  const { token, expires_at } = await tokenRes.json();
  assert.ok(token.startsWith("SP-"));
  assert.ok(expires_at > Date.now());

  // 2. Pair a new Android phone
  const pairPayload = {
    pairing_token: token,
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
  assert.equal(replay.error, "INVALID_PAIRING_TOKEN");

  // 4. Verify node exists in fleet
  const nodeRes = await coordinator.fetch(new Request("http://localhost/api/v1/nodes/phone-pixel-test-01"));
  assert.equal(nodeRes.status, 200);
  const node = await nodeRes.json();
  assert.equal(node.name, "Pixel 8 Pro (Test)");
  assert.equal(node.state, "Ready");
  assert.equal(node.is_simulated, false);
});

test("SPaaSCoordinator — Workload Submission, Placement & Settlement", async () => {
  const coordinator = new SPaaSCoordinator(null, { SPAAS_ROLE: "PRIMARY" });

  // Enroll a ready worker node
  await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: (await (await coordinator.fetch(new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST" }))).json()).token,
        node_id: "node-desktop-compute-01",
        device_name: "Desktop Ryzen 9",
        device_type: "Desktop",
        public_key: "ed25519_desktop_key"
      })
    })
  );

  // Submit a compute job
  const jobRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: "job-sha256-test-001",
        workload_id: "sha256_hasher"
      })
    })
  );
  assert.equal(jobRes.status, 201);
  const job = await jobRes.json();
  assert.equal(job.id, "job-sha256-test-001");
  assert.equal(job.state, "Running");
  assert.equal(job.assigned_node_id, "node-desktop-compute-01");
  assert.ok(job.fencing_token);

  // Inspect "Why This Device?" explanation
  const decisionRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs/job-sha256-test-001/scheduler-decision")
  );
  assert.equal(decisionRes.status, 200);
  const { decision } = await decisionRes.json();
  assert.equal(decision.selected_node_id, "node-desktop-compute-01");
  assert.ok(decision.rationale.includes("Desktop Ryzen 9"));

  // Submit result with valid fencing token
  const resultRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: "job-sha256-test-001",
        node_id: "node-desktop-compute-01",
        fencing_token: job.fencing_token,
        exit_code: 0,
        stdout: "SHA256: 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\n",
        fuel_used: 1250000
      })
    })
  );
  assert.equal(resultRes.status, 200);
  const result = await resultRes.json();
  assert.equal(result.status, "accepted");
  assert.equal(result.credits_settled, 50.0);

  // Verify double-entry ledger
  const ledgerRes = await coordinator.fetch(new Request("http://localhost/api/v1/metering"));
  assert.equal(ledgerRes.status, 200);
  const ledger = await ledgerRes.json();
  assert.equal(ledger.summary.total_settled_credits, 50.0);
  assert.equal(ledger.summary.transaction_count, 1);
});

test("SPaaSCoordinator — Simulation Purge & Checkpoint Export", async () => {
  const coordinator = new SPaaSCoordinator(null, { SPAAS_ROLE: "PRIMARY" });

  // Start demo cluster
  const startRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/demo/start-cluster", { method: "POST" })
  );
  assert.equal(startRes.status, 200);
  const startData = await startRes.json();
  assert.equal(startData.nodes.length, 4);

  // Verify nodes are labeled simulated
  const nodesRes1 = await coordinator.fetch(new Request("http://localhost/api/v1/nodes"));
  const { nodes: nodes1 } = await nodesRes1.json();
  assert.equal(nodes1.length, 4);
  assert.ok(nodes1.every(n => n.is_simulated === true));

  // Purge simulated nodes
  const purgeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/demo/purge-simulated-nodes", { method: "POST" })
  );
  assert.equal(purgeRes.status, 200);

  const nodesRes2 = await coordinator.fetch(new Request("http://localhost/api/v1/nodes"));
  const { nodes: nodes2 } = await nodesRes2.json();
  assert.equal(nodes2.length, 0);

  // Checkpoint export for Cloud Run Cold Standby DR
  const checkpointRes = await coordinator.fetch(new Request("http://localhost/api/v1/dr/checkpoint"));
  assert.equal(checkpointRes.status, 200);
  const checkpoint = await checkpointRes.json();
  assert.equal(checkpoint.role, "PRIMARY");
  assert.equal(checkpoint.epoch, 1);
  assert.ok(Array.isArray(checkpoint.nodes));
  assert.ok(Array.isArray(checkpoint.jobs));
  assert.ok(Array.isArray(checkpoint.ledger));
});

test("SPaaSCoordinator — Alarm Reconciliation & Stale Fencing Defense", async () => {
  const coordinator = new SPaaSCoordinator(null, { SPAAS_ROLE: "PRIMARY" });

  // 1. Enroll worker
  const token = (await (await coordinator.fetch(new Request("http://localhost/api/v1/devices/pairing-token", { method: "POST" }))).json()).token;
  await coordinator.fetch(
    new Request("http://localhost/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_token: token,
        node_id: "node-reconciler-test",
        device_name: "Phone Reconciler Test",
        device_type: "Phone",
        public_key: "pk_reconcile"
      })
    })
  );

  // 2. Submit job
  const job = await (await coordinator.fetch(
    new Request("http://localhost/api/v1/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: "job-reconcile-01" })
    })
  )).json();
  assert.equal(job.state, "Running");

  // 3. Stale fencing token submission must be rejected
  const staleRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: "job-reconcile-01",
        fencing_token: "invalid-stale-fencing-token-xyz"
      })
    })
  );
  assert.equal(staleRes.status, 200);
  const stale = await staleRes.json();
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reason, "STALE_FENCING_TOKEN");

  // 4. Node operational controls: rename, state transition, revocation
  const renameRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/node-reconciler-test/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed Device Alpha" })
    })
  );
  assert.equal(renameRes.status, 200);

  const revokeRes = await coordinator.fetch(
    new Request("http://localhost/api/v1/nodes/node-reconciler-test/revoke", { method: "POST" })
  );
  assert.equal(revokeRes.status, 200);

  const node = await (await coordinator.fetch(new Request("http://localhost/api/v1/nodes/node-reconciler-test"))).json();
  assert.equal(node.name, "Renamed Device Alpha");
  assert.equal(node.state, "Revoked");
});

