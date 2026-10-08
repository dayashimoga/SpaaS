// Live Node Enrollment and Heartbeat Verification Script
const LIVE_URL = "https://spaas-control-plane.dayashimoga.workers.dev";

async function main() {
  console.log(`[1] Authenticating as Provider on ${LIVE_URL}...`);
  const loginRes = await fetch(`${LIVE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "provider@phonefarm.io", password: "ProviderSecret123!" })
  });
  const loginData = await loginRes.json();
  if (!loginData.token) {
    throw new Error(`Login failed: ${JSON.stringify(loginData)}`);
  }
  const sessionToken = loginData.token;
  console.log(`Provider authenticated! Session: ${sessionToken.substring(0, 16)}...`);

  console.log(`[2] Requesting pairing token from ${LIVE_URL}...`);
  const pairTokenRes = await fetch(`${LIVE_URL}/api/v1/devices/pairing-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ role: "PROVIDER", client: "live-worker-test" })
  });

  console.log(`Pairing token response: ${pairTokenRes.status}`);
  const pairTokenData = await pairTokenRes.json();
  console.log("Pairing data:", pairTokenData);

  const enrollmentToken = pairTokenData.token || pairTokenData.pairing_token || pairTokenData.short_code;
  if (!enrollmentToken) {
    throw new Error("No enrollment token received!");
  }

  console.log(`[3] Enrolling compute device using token ${enrollmentToken}...`);
  const enrollRes = await fetch(`${LIVE_URL}/api/v1/devices/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enrollment_token: enrollmentToken,
      device_name: "Live Edge Workstation Alpha",
      device_type: "desktop_workstation",
      capabilities: {
        architecture: "x86_64",
        cores: 16,
        ram_mb: 32768,
        storage_free_mb: 100000,
        wasm_engine: "wasmi_0.31",
        os: "Windows 11 Enterprise"
      },
      initial_telemetry: {
        battery_pct: 100,
        charging_state: "AC_Power",
        network_type: "Gigabit_Ethernet",
        thermal_status: "Nominal",
        cpu_usage_pct: 8.5,
        available_ram_mb: 24576
      }
    })
  });

  console.log(`Enroll response status: ${enrollRes.status}`);
  const enrollData = await enrollRes.json();
  console.log("Enroll data:", enrollData);

  const nodeId = enrollData.node_id;
  const authToken = enrollData.auth_token;

  if (!nodeId || !authToken) {
    throw new Error("Enrollment did not return nodeId and authToken");
  }

  console.log(`[4] Sending authenticated heartbeat for node ${nodeId}...`);
  const hbRes = await fetch(`${LIVE_URL}/api/v1/nodes/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Auth": authToken,
      "X-SPaaS-Node-ID": nodeId
    },
    body: JSON.stringify({
      node_id: nodeId,
      auth_token: authToken,
      telemetry: {
        battery_pct: 100,
        charging_state: "AC_Power",
        network_type: "Gigabit_Ethernet",
        thermal_status: "Nominal",
        cpu_usage_pct: 10.2,
        available_ram_mb: 24000
      }
    })
  });

  console.log(`Heartbeat response status: ${hbRes.status}`);
  const hbData = await hbRes.json();
  console.log("Heartbeat data:", hbData);

  console.log(`[5] Verifying health and active nodes on live fabric...`);
  const healthRes = await fetch(`${LIVE_URL}/health`);
  const healthData = await healthRes.json();
  console.log("Live Fabric Health:", JSON.stringify(healthData, null, 2));

  if (healthData.total_nodes >= 1 && healthData.active_nodes >= 1) {
    console.log("\n>>> SUCCESS: LIVE COMPUTE NODE CONNECTED & ACTIVE ON FABRIC! <<<");
  } else {
    console.warn("Node enrolled but state may be reconciling:", healthData);
  }
}

main().catch(err => {
  console.error("Error during live verification:", err);
  process.exit(1);
});
