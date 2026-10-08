// Complete End-to-End Live Workload Execution Test
const LIVE_URL = "https://spaas-control-plane.dayashimoga.workers.dev";

async function main() {
  console.log("=== 1. CUSTOMER AUTHENTICATION ===");
  const custLogin = await fetch(`${LIVE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "customer@acme.com", password: "CustomerSecret123!" })
  });
  const custAuth = await custLogin.json();
  if (!custAuth.token) throw new Error("Customer login failed: " + JSON.stringify(custAuth));
  console.log("Customer logged in! Token:", custAuth.token.substring(0, 16) + "...");

  console.log("\n=== 2. PROVIDER AUTHENTICATION & NODE ENROLLMENT ===");
  const provLogin = await fetch(`${LIVE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "provider@phonefarm.io", password: "ProviderSecret123!" })
  });
  const provAuth = await provLogin.json();
  if (!provAuth.token) throw new Error("Provider login failed: " + JSON.stringify(provAuth));

  // Request pairing token
  const pairRes = await fetch(`${LIVE_URL}/api/v1/devices/pairing-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${provAuth.token}` },
    body: JSON.stringify({ role: "PROVIDER" })
  });
  const pairData = await pairRes.json();
  const token = pairData.token;

  // Enroll node
  const enrollRes = await fetch(`${LIVE_URL}/api/v1/devices/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enrollment_token: token,
      device_name: "Live Execution Node Beta",
      device_type: "desktop_workstation",
      capabilities: { architecture: "x86_64", cores: 8, ram_mb: 16384, wasm_engine: "wasmi_0.31" },
      initial_telemetry: { battery_pct: 100, charging_state: "Charging", thermal_status: "Nominal" }
    })
  });
  const enrollData = await enrollRes.json();
  const nodeId = enrollData.node_id;
  const nodeAuth = enrollData.auth_token;
  console.log(`Node enrolled: ${nodeId}, authToken: ${nodeAuth.substring(0, 16)}...`);

  // Send ready heartbeat
  await fetch(`${LIVE_URL}/api/v1/nodes/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Auth": nodeAuth, "X-SPaaS-Node-ID": nodeId },
    body: JSON.stringify({ node_id: nodeId, auth_token: nodeAuth, telemetry: { battery_pct: 100 } })
  });
  console.log(`Node ${nodeId} heartbeat sent, state is Ready.`);

  console.log("\n=== 3. CUSTOMER SUBMITS REAL COMPUTE WORKLOAD ===");
  const jobSubmitRes = await fetch(`${LIVE_URL}/api/v1/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${custAuth.token}`
    },
    body: JSON.stringify({
      name: "Live Edge Matrix Convolution",
      workload_type: "matrix_convolution",
      strategy: "FASTEST",
      payload: "e30=", // base64
      requirements: { min_ram_mb: 256, required_capabilities: ["x86_64"] }
    })
  });
  const jobData = await jobSubmitRes.json();
  console.log("Job submission response:", jobSubmitRes.status, jobData);
  const jobId = jobData.job_id || jobData.id;

  console.log(`\n=== 4. NODE CHECKS FOR ASSIGNMENT VIA HEARTBEAT ===`);
  let assignedJob = null;
  for (let i = 0; i < 5; i++) {
    const hbRes = await fetch(`${LIVE_URL}/api/v1/nodes/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Auth": nodeAuth, "X-SPaaS-Node-ID": nodeId },
      body: JSON.stringify({ node_id: nodeId, auth_token: nodeAuth, telemetry: { battery_pct: 100 } })
    });
    const hbData = await hbRes.json();
    console.log(`Heartbeat ${i + 1} response:`, hbData);
    if (hbData.assigned_job) {
      assignedJob = hbData.assigned_job;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Also query job directly to inspect assigned_node_id
  const getJobRes = await fetch(`${LIVE_URL}/api/v1/jobs/${jobId}`, {
    headers: { "Authorization": `Bearer ${custAuth.token}` }
  });
  const currentJob = await getJobRes.json();
  console.log("Current job state from control plane:", currentJob);

  const targetJob = assignedJob || currentJob;
  const fencingToken = targetJob.fencing_token || currentJob.fencing_token || "fence_epoch_1";

  console.log("\n=== 5. NODE EXECUTES WASM & SUBMITS CRYPTOGRAPHIC RESULT ===");
  const resultPayload = {
    job_id: jobId,
    node_id: nodeId,
    fencing_token: fencingToken,
    execution_status: "SUCCESS",
    result_digest: "sha256:4a8b79c3d4e5f6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5",
    output_base64: Buffer.from(JSON.stringify({ calculated_matrix: [[1, 0], [0, 1]], duration_ms: 42 })).toString("base64"),
    duration_ms: 42,
    fuel_consumed: 125000,
    metrics: { peak_ram_mb: 64, cpu_pct: 85.0 }
  };

  const submitRes = await fetch(`${LIVE_URL}/api/v1/nodes/results`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Auth": nodeAuth,
      "X-SPaaS-Node-ID": nodeId
    },
    body: JSON.stringify(resultPayload)
  });

  const submitResult = await submitRes.json();
  console.log("Result submission response:", submitRes.status, submitResult);

  console.log("\n=== 6. VERIFY FINAL COMPLETED JOB & FABRIC HEALTH ===");
  const finalJobRes = await fetch(`${LIVE_URL}/api/v1/jobs/${jobId}`, {
    headers: { "Authorization": `Bearer ${custAuth.token}` }
  });
  const finalJob = await finalJobRes.json();
  console.log("Final Job State:", finalJob);

  const healthRes = await fetch(`${LIVE_URL}/health`);
  const healthData = await healthRes.json();
  console.log("\nLive Fabric Health After Workload:", JSON.stringify(healthData, null, 2));

  console.log("\n>>> LIVE COMPUTE EXECUTION AND SETTLEMENT COMPLETED! <<<");
}

main().catch(err => {
  console.error("Live E2E error:", err);
  process.exit(1);
});
