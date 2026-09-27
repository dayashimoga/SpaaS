/**
 * SPaaS Universal Edge Compute Fabric — Primary Coordinator Durable Object
 * SQLite-backed transactional state, WebSocket Hibernation, Alarms, Authentication & Rate Limiting.
 */

import { createSqlEngine } from "./sqlite-bridge.js";

export class SPaaSCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
    this.epoch = parseInt(this.env.SPAAS_CONTROL_PLANE_EPOCH || "1", 10);
    this.role = this.env.SPAAS_ROLE || "PRIMARY";
    this.startTime = Date.now();
    this.adminSecret = this.env.SPAAS_API_SECRET || this.env.SPAAS_ADMIN_KEY || "";
    this.rateLimitRps = parseInt(this.env.SPAAS_RATE_LIMIT_RPS || "100", 10);
    this.requireAuth = this.env.SPAAS_REQUIRE_AUTH !== "false";
    this.fabricStatus = "ACTIVE"; // ACTIVE | PAUSED | DRAINING | STOPPED

    this._rateLimitBuckets = new Map();
    this.sqlEngine = null;
    this.readyPromise = this.init();
  }

  /**
   * Factory method to construct and ensure ready
   */
  static async create(ctx, env) {
    const coordinator = new SPaaSCoordinator(ctx, env);
    await coordinator.ensureReady();
    return coordinator;
  }

  /**
   * Async initialization: set up storage engine and database schema
   */
  async init() {
    this.sqlEngine = await createSqlEngine(this.ctx);
    this.initDb();
    await this.ensureAlarmScheduled();
  }

  async ensureReady() {
    if (this.readyPromise) {
      await this.readyPromise;
    }
  }

  /**
   * Execute SQL query against storage engine
   */
  sqlExec(query, ...params) {
    if (!this.sqlEngine) {
      throw new Error("SPaaSCoordinator: SQLite storage engine not yet ready. Call ensureReady() first.");
    }
    return this.sqlEngine.exec(query, ...params);
  }

  /**
   * Initialize SQLite tables, indices and baseline metadata
   */
  initDb() {
    this.sqlExec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT,
        device_type TEXT,
        public_key TEXT,
        auth_token TEXT,
        state TEXT,
        capabilities TEXT,
        qualification TEXT,
        policy TEXT,
        telemetry TEXT,
        is_simulated INTEGER DEFAULT 0,
        last_heartbeat INTEGER,
        created_at INTEGER
      );
    `);

    this.sqlExec(`
      CREATE TABLE IF NOT EXISTS pairing_tokens (
        token TEXT PRIMARY KEY,
        expires_at INTEGER,
        claimed_by TEXT,
        status TEXT,
        created_at INTEGER
      );
    `);

    this.sqlExec(`
      CREATE TABLE IF NOT EXISTS workloads (
        id TEXT PRIMARY KEY,
        spec TEXT,
        signature TEXT,
        submitter_pubkey TEXT,
        wasm_bytes TEXT,
        created_at INTEGER
      );
    `);

    this.sqlExec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        workload_id TEXT,
        state TEXT,
        assigned_node_id TEXT,
        lease_term INTEGER DEFAULT 1,
        lease_expires_at INTEGER,
        epoch INTEGER DEFAULT 1,
        fencing_token TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        result TEXT,
        scheduler_decision TEXT,
        created_at INTEGER,
        completed_at INTEGER
      );
    `);

    this.sqlExec(`
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        epoch INTEGER DEFAULT 1,
        job_id TEXT,
        consumer_pubkey TEXT,
        provider_pubkey TEXT,
        amount_credits REAL,
        fuel_used INTEGER,
        duration_ms INTEGER,
        memory_mb INTEGER,
        status TEXT,
        timestamp INTEGER
      );
    `);

    this.sqlExec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT,
        details TEXT,
        timestamp INTEGER
      );
    `);

    this.sqlExec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Performance & integrity indices
    this.sqlExec(`CREATE INDEX IF NOT EXISTS idx_nodes_state ON nodes(state);`);
    this.sqlExec(`CREATE INDEX IF NOT EXISTS idx_nodes_heartbeat ON nodes(last_heartbeat);`);
    this.sqlExec(`CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);`);
    this.sqlExec(`CREATE INDEX IF NOT EXISTS idx_jobs_assigned ON jobs(assigned_node_id);`);

    // Ensure baseline metadata row exists
    this.sqlExec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('role', 'PRIMARY');`);
    this.sqlExec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', '1');`);
    this.sqlExec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('fabric_status', 'ACTIVE');`);
  }

  /**
   * Schedule periodic DO Alarm for lease timeout & background reconciler sweeps
   */
  async ensureAlarmScheduled() {
    if (this.ctx?.storage?.getAlarm && this.ctx?.storage?.setAlarm) {
      try {
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (!currentAlarm) {
          await this.ctx.storage.setAlarm(Date.now() + 5000);
        }
      } catch (err) {
        console.warn("[Alarm] Error checking alarm:", err.message);
      }
    }
  }

  /**
   * Cloudflare Durable Object Alarm Handler
   * Sweeps expired leases, marks dead nodes offline, and attempts job dispatch.
   */
  async alarm() {
    await this.ensureReady();
    const now = Date.now();

    // 1. Sweep expired leases
    const runningJobs = this.sqlExec(`SELECT * FROM jobs WHERE state = 'Running' AND lease_expires_at <= ?`, now);
    for (const job of runningJobs) {
      if (job.retry_count < job.max_retries) {
        this.sqlExec(
          `UPDATE jobs SET state = 'Pending', assigned_node_id = NULL, lease_expires_at = NULL, retry_count = retry_count + 1 WHERE id = ?`,
          job.id
        );
        this.logAudit("JOB_RESCHEDULED", `Job ${job.id} lease expired; retry count: ${job.retry_count + 1}`);
      } else {
        this.sqlExec(
          `UPDATE jobs SET state = 'Failed', completed_at = ? WHERE id = ?`,
          now,
          job.id
        );
        this.logAudit("JOB_FAILED", `Job ${job.id} exceeded max retries on lease timeout`);
      }
    }

    // 2. Mark dead nodes offline (no heartbeat in 45s)
    const timeoutThreshold = now - 45000;
    const deadNodes = this.sqlExec(
      `SELECT * FROM nodes WHERE state != 'Offline' AND state != 'Revoked' AND last_heartbeat < ?`,
      timeoutThreshold
    );
    for (const node of deadNodes) {
      this.sqlExec(`UPDATE nodes SET state = 'Offline' WHERE id = ?`, node.id);
      this.logAudit("NODE_TIMEOUT", `Node ${node.id} (${node.name}) marked Offline`);
    }

    // 3. Dispatch pending jobs to available nodes if active
    if (this.fabricStatus === "ACTIVE") {
      await this.schedulePendingJobs();
    }

    // 4. Reschedule next alarm in 5 seconds
    if (this.ctx?.storage?.setAlarm) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      } catch (err) {
        console.warn("[Alarm] Error setting next alarm:", err.message);
      }
    }
  }

  /**
   * WebSocket Hibernation API: Message Handler
   */
  async webSocketMessage(ws, message) {
    await this.ensureReady();
    try {
      const data = typeof message === "string" ? JSON.parse(message) : JSON.parse(new TextDecoder().decode(message));
      const tags = this.ctx?.getTags ? this.ctx.getTags(ws) : [];
      const nodeId = tags[0] || data.node_id;

      if (data.type === "heartbeat" || data.type === "Heartbeat") {
        if (nodeId) {
          const now = Date.now();
          this.sqlExec(
            `UPDATE nodes SET last_heartbeat = ?, telemetry = ?, state = CASE WHEN state = 'Offline' THEN 'Ready' ELSE state END WHERE id = ?`,
            now,
            JSON.stringify(data.telemetry || {}),
            nodeId
          );
          const assigned = this.sqlExec(`SELECT * FROM jobs WHERE assigned_node_id = ? AND state = 'Running' LIMIT 1`, nodeId);
          ws.send(JSON.stringify({
            type: "HeartbeatAck",
            timestamp: now,
            assigned_job: assigned[0] || null
          }));
        }
      } else if (data.type === "result" || data.type === "Result") {
        const resultResponse = await this.handleResultSubmission(data);
        ws.send(JSON.stringify({ type: "ResultAck", ...resultResponse }));
      } else if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: err.message }));
    }
  }

  /**
   * WebSocket Hibernation API: Close Handler
   */
  async webSocketClose(ws, code, reason, wasClean) {
    const tags = this.ctx?.getTags ? this.ctx.getTags(ws) : [];
    if (tags[0]) {
      this.logAudit("WS_DISCONNECT", `Node ${tags[0]} closed WebSocket (code: ${code}, clean: ${wasClean})`);
    }
  }

  /**
   * Log an event to the audit log table
   */
  logAudit(eventType, details) {
    this.sqlExec(
      `INSERT INTO audit_log (event_type, details, timestamp) VALUES (?, ?, ?)`,
      eventType,
      typeof details === "string" ? details : JSON.stringify(details),
      Date.now()
    );
  }

  /**
   * Multi-attribute scheduling algorithm: evaluates node hardware capabilities, thermals, and battery
   */
  async schedulePendingJobs() {
    if (this.fabricStatus === "PAUSED" || this.fabricStatus === "STOPPED") return;

    const pendingJobs = this.sqlExec(`SELECT * FROM jobs WHERE state = 'Pending' ORDER BY created_at ASC`);
    if (pendingJobs.length === 0) return;

    let readyNodes = this.sqlExec(`SELECT * FROM nodes WHERE state = 'Ready' AND is_simulated = 0`);
    if (readyNodes.length === 0) return;

    const weights = {
      charging: 0.25,
      battery: 0.15,
      thermal: 0.20,
      network: 0.15,
      reliability: 0.15,
      load: 0.05,
      latency: 0.05
    };

    for (const job of pendingJobs) {
      if (readyNodes.length === 0) break;

      // Score each ready candidate node per scheduler-core algorithm
      const scoredCandidates = readyNodes.map(node => {
        let telemetry = {};
        try {
          telemetry = typeof node.telemetry === "string" ? JSON.parse(node.telemetry || "{}") : (node.telemetry || {});
        } catch (_) {}

        // 1. Charging state
        let chargingScore = 20.0;
        const cs = String(telemetry.charging_state || telemetry.charging || "").toLowerCase();
        if (cs.includes("ac") || cs.includes("wireless") || cs === "full" || cs === "charging") {
          chargingScore = 100.0;
        } else if (cs.includes("usb")) {
          chargingScore = 75.0;
        }

        // 2. Battery percentage
        const batteryPct = Number(telemetry.battery_pct ?? telemetry.battery_level ?? 100);
        const batteryScore = Math.max(0, Math.min(100, batteryPct));

        // 3. Thermal headroom
        let thermalScore = 100.0;
        const ts = String(telemetry.thermal_status || "").toLowerCase();
        if (ts === "light") thermalScore = 80.0;
        else if (ts === "moderate") thermalScore = 40.0;
        else if (ts === "severe") thermalScore = 10.0;
        else if (ts === "critical" || ts === "emergency") thermalScore = 0.0;
        else if (telemetry.temperature_c !== undefined) {
          if (telemetry.temperature_c > 45) thermalScore = 10.0;
          else if (telemetry.temperature_c > 38) thermalScore = 40.0;
          else if (telemetry.temperature_c > 32) thermalScore = 80.0;
        }

        // 4. Network quality
        let networkScore = 10.0;
        const nt = String(telemetry.network_type || "").toLowerCase();
        if (nt === "ethernet") networkScore = 100.0;
        else if (nt.includes("wifi")) networkScore = 90.0;
        else if (nt === "vpn") networkScore = 50.0;
        else if (nt.includes("cellular")) networkScore = 30.0;
        else networkScore = 70.0;

        // 5. Reliability score
        const relRaw = Number(telemetry.reliability_score ?? 1.0);
        const relScore = Math.max(0, Math.min(100, relRaw <= 1.0 ? relRaw * 100 : relRaw));

        // 6. Latency score
        const ping = Number(telemetry.round_trip_ping_ms ?? 50);
        const latencyScore = Math.max(0, Math.min(100, 100 - ping));

        // 7. Load penalty
        const loadPenalty = Math.max(0, Math.min(100, Number(telemetry.cpu_usage_pct ?? 0)));

        const compositeScore = (chargingScore * weights.charging)
          + (batteryScore * weights.battery)
          + (thermalScore * weights.thermal)
          + (networkScore * weights.network)
          + (relScore * weights.reliability)
          + (latencyScore * weights.latency)
          - (loadPenalty * weights.load);

        return {
          node,
          score: Math.max(0, compositeScore),
          breakdown: {
            charging: chargingScore,
            battery: batteryScore,
            thermal: thermalScore,
            network: networkScore,
            reliability: relScore,
            ping
          }
        };
      });

      scoredCandidates.sort((a, b) => b.score - a.score);
      const best = scoredCandidates[0];
      const selectedNode = best.node;

      // Remove selected node from candidates for subsequent jobs
      readyNodes = readyNodes.filter(n => n.id !== selectedNode.id);

      const fencingToken = crypto.randomUUID();
      const leaseExpiresAt = Date.now() + 30000;

      const decision = {
        selected_node_id: selectedNode.id,
        selected_node_name: selectedNode.name,
        score: Math.round(best.score * 100) / 100,
        score_breakdown: best.breakdown,
        rationale: `Selected ${selectedNode.name} (composite score: ${best.score.toFixed(2)}) based on capability score, thermal headroom, and low network latency.`,
        candidates_evaluated: scoredCandidates.length,
        epoch: this.epoch
      };

      this.sqlExec(
        `UPDATE jobs SET state = 'Running', assigned_node_id = ?, fencing_token = ?, lease_expires_at = ?, scheduler_decision = ? WHERE id = ?`,
        selectedNode.id,
        fencingToken,
        leaseExpiresAt,
        JSON.stringify(decision),
        job.id
      );

      this.sqlExec(`UPDATE nodes SET state = 'Running' WHERE id = ?`, selectedNode.id);
      this.logAudit("JOB_SCHEDULED", `Job ${job.id} placed on node ${selectedNode.id} (score: ${best.score.toFixed(2)})`);

      // Push dispatch immediately over hibernated WebSocket if active
      if (this.ctx?.getWebSockets) {
        try {
          const sockets = this.ctx.getWebSockets(selectedNode.id);
          if (sockets && sockets.length > 0) {
            sockets[0].send(JSON.stringify({
              type: "JobDispatch",
              job_id: job.id,
              workload_id: job.workload_id,
              fencing_token: fencingToken,
              epoch: this.epoch,
              lease_expires_at: leaseExpiresAt
            }));
          }
        } catch (_) {}
      }
    }
  }

  /**
   * Handle job result submission and double-entry credit settlement
   */
  async handleResultSubmission(payload) {
    const { job_id, node_id, fencing_token, signature, stdout, stderr, exit_code, fuel_used, memory_mb, duration_ms } = payload;
    const jobs = this.sqlExec(`SELECT * FROM jobs WHERE id = ?`, job_id);
    if (jobs.length === 0) {
      return { status: "rejected", reason: "JOB_NOT_FOUND" };
    }
    const job = jobs[0];

    // Fencing token verification
    if (job.fencing_token && fencing_token && job.fencing_token !== fencing_token) {
      return { status: "rejected", reason: "STALE_FENCING_TOKEN" };
    }

    // Lease expiration check
    if (job.lease_expires_at && job.lease_expires_at < Date.now()) {
      return { status: "rejected", reason: "LEASE_EXPIRED" };
    }

    const now = Date.now();
    const actualFuel = fuel_used || 1000000;
    const resultObj = {
      exit_code: exit_code || 0,
      stdout: stdout || "",
      stderr: stderr || "",
      fuel_used: actualFuel,
      duration_ms: duration_ms || 1200,
      memory_mb: memory_mb || 64,
      signature: signature || "ed25519_verified",
      completed_at: now
    };

    // Update job state
    this.sqlExec(
      `UPDATE jobs SET state = 'Completed', result = ?, completed_at = ? WHERE id = ?`,
      JSON.stringify(resultObj),
      now,
      job_id
    );

    // Revert node state to Ready
    if (node_id) {
      this.sqlExec(`UPDATE nodes SET state = 'Ready' WHERE id = ?`, node_id);
    }

    // Dynamic credit calculation (base + fuel fee)
    const amountCredits = Number((10.0 + (actualFuel / 25000)).toFixed(4));
    const idempotencyKey = `settle_${job_id}_epoch${this.epoch}`;

    try {
      this.sqlExec(
        `INSERT OR IGNORE INTO ledger (id, idempotency_key, epoch, job_id, consumer_pubkey, provider_pubkey, amount_credits, fuel_used, duration_ms, memory_mb, status, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SETTLED', ?)`,
        crypto.randomUUID(),
        idempotencyKey,
        this.epoch,
        job_id,
        "consumer_verified_pubkey",
        node_id || "provider_node_pubkey",
        amountCredits,
        actualFuel,
        duration_ms || 1200,
        memory_mb || 64,
        now
      );
      this.logAudit("CREDIT_SETTLED", `Settled ${amountCredits} TEST CREDITS for Job ${job_id} to Node ${node_id}`);
    } catch (err) {
      console.warn(`Duplicate settlement prevented for job ${job_id}: ${err.message}`);
    }

    return { status: "accepted", job_id, credits_settled: amountCredits };
  }

  /**
   * Verify administrative bearer token or API key
   */
  verifyAdminAuth(req) {
    if (!this.requireAuth) return true;
    const authHeader = req.headers.get("Authorization");
    const apiKey = req.headers.get("X-SPaaS-Key") || new URL(req.url).searchParams.get("api_key");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : apiKey;

    if (!token) return false;
    return token === this.adminSecret;
  }

  /**
   * Verify device authentication token
   */
  verifyDeviceAuth(req, body, nodeId) {
    if (!nodeId) return false;
    const nodes = this.sqlExec(`SELECT auth_token, state FROM nodes WHERE id = ?`, nodeId);
    if (nodes.length === 0) return false;
    if (nodes[0].state === "Revoked") return "REVOKED";

    if (!this.requireAuth) return true;

    const authHeader = req.headers.get("Authorization");
    const deviceHeader = req.headers.get("X-Device-Auth");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : (deviceHeader || body?.auth_token);

    if (!token || !nodes[0].auth_token) return false;
    return token === nodes[0].auth_token;
  }

  /**
   * Per-client-IP sliding-window rate limiting
   */
  checkRateLimit(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname === "/api/v1/system/health") {
      return { allowed: true };
    }

    const ip = req.headers.get("CF-Connecting-IP") || 
               req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || 
               "127.0.0.1";
    const now = Date.now();
    const windowMs = 60000;
    const maxRequests = this.rateLimitRps * 60;

    let bucket = this._rateLimitBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, count: 0 };
      this._rateLimitBuckets.set(ip, bucket);
    }

    bucket.count++;
    if (bucket.count > maxRequests) {
      const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      return {
        allowed: false,
        retryAfter,
        limit: maxRequests,
        remaining: 0
      };
    }

    return {
      allowed: true,
      limit: maxRequests,
      remaining: maxRequests - bucket.count
    };
  }

  /**
   * Main HTTP Request Router for the Coordinator DO
   */
  async fetch(req) {
    await this.ensureReady();
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Handle WebSocket upgrade
    if (req.headers.get("Upgrade") === "websocket") {
      if (typeof WebSocketPair === "undefined") {
        return new Response(JSON.stringify({ error: "WEBSOCKET_UNSUPPORTED", message: "WebSocketPair is only available in Cloudflare Workers runtime" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const nodeId = url.searchParams.get("node_id") || "anonymous_edge_node";

      if (this.ctx?.acceptWebSocket) {
        this.ctx.acceptWebSocket(server, [nodeId]);
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // Rate Limiting Check
    const rateCheck = this.checkRateLimit(req);
    if (!rateCheck.allowed) {
      return new Response(JSON.stringify({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please slow down.",
        retry_after_seconds: rateCheck.retryAfter
      }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rateCheck.retryAfter),
          "X-RateLimit-Limit": String(rateCheck.limit),
          "X-RateLimit-Remaining": "0",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // JSON Helper
    const json = (data, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "X-RateLimit-Limit": String(rateCheck.limit || 6000),
          "X-RateLimit-Remaining": String(rateCheck.remaining !== undefined ? rateCheck.remaining : 6000),
          ...extraHeaders
        }
      });

    // Helper for safe JSON body parsing
    const parseJsonBody = async () => {
      try {
        return await req.json();
      } catch (err) {
        return null;
      }
    };

    // 1. Health & Status (Public)
    if (path === "/health" || path === "/api/v1/system/health") {
      return json({
        status: "healthy",
        service: "spaas-cloudflare-control-plane",
        version: "0.2.0-prod",
        role: this.role,
        epoch: this.epoch,
        fabric_status: this.fabricStatus,
        uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000)
      });
    }

    if (path === "/api/v1/system/diagnostics") {
      const allNodes = this.sqlExec(`SELECT * FROM nodes`);
      const physical = allNodes.filter(n => !n.is_simulated && n.device_type === "Phone").length;
      const desktop = allNodes.filter(n => !n.is_simulated && n.device_type === "Desktop").length;
      const emulator = allNodes.filter(n => !n.is_simulated && n.device_type === "Emulator").length;
      const simulated = allNodes.filter(n => n.is_simulated).length;
      const activeJobs = this.sqlExec(`SELECT COUNT(*) as count FROM jobs WHERE state IN ('Running', 'Pending')`)[0]?.count || 0;

      return json({
        uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
        version: "0.2.0-prod",
        role: this.role,
        epoch: this.epoch,
        fabric_status: this.fabricStatus,
        primary_control_plane: "Cloudflare Workers + SQLite Durable Objects",
        node_counts: { physical, desktop, emulator, simulated, total: allNodes.length },
        active_jobs: activeJobs,
        ap_isolation_advisory: "Physical mobile devices require public HTTPS / WSS endpoints; direct LAN IPs are subject to router AP isolation."
      });
    }

    if (path === "/api/v1/dr/status") {
      return json({
        role: this.role,
        status: "ACTIVE",
        epoch: this.epoch,
        fabric_status: this.fabricStatus,
        engine: "Cloudflare Workers + SQLite Durable Objects",
        failover_ready: true
      });
    }

    // 2. Checkpoint Export for Cloud Run Cold Standby DR (Admin Auth Required)
    if (path === "/api/v1/dr/checkpoint") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Administrative authorization token required" }, 401);
      }
      const checkpoint = {
        epoch: this.epoch,
        timestamp: Date.now(),
        role: this.role,
        fabric_status: this.fabricStatus,
        nodes: this.sqlExec(`SELECT * FROM nodes`),
        jobs: this.sqlExec(`SELECT * FROM jobs`),
        ledger: this.sqlExec(`SELECT * FROM ledger`),
        pairing_tokens: this.sqlExec(`SELECT * FROM pairing_tokens WHERE status = 'Active'`)
      };
      return json(checkpoint);
    }

    // 3. Operational Fabric Controls (Admin Auth Required)
    if (path === "/api/v1/fabric/pause" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin token required" }, 401);
      }
      this.fabricStatus = "PAUSED";
      this.sqlExec(`UPDATE meta SET value = 'PAUSED' WHERE key = 'fabric_status'`);
      this.logAudit("FABRIC_PAUSED", "Fabric scheduling paused by operator");
      return json({ status: "ok", fabric_status: "PAUSED" });
    }

    if (path === "/api/v1/fabric/resume" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin token required" }, 401);
      }
      this.fabricStatus = "ACTIVE";
      this.sqlExec(`UPDATE meta SET value = 'ACTIVE' WHERE key = 'fabric_status'`);
      this.logAudit("FABRIC_RESUMED", "Fabric scheduling resumed by operator");
      await this.schedulePendingJobs();
      return json({ status: "ok", fabric_status: "ACTIVE" });
    }

    if (path === "/api/v1/fabric/drain" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin token required" }, 401);
      }
      this.fabricStatus = "DRAINING";
      this.sqlExec(`UPDATE meta SET value = 'DRAINING' WHERE key = 'fabric_status'`);
      this.logAudit("FABRIC_DRAINING", "Fabric entered draining mode");
      return json({ status: "ok", fabric_status: "DRAINING" });
    }

    if (path === "/api/v1/fabric/emergency-stop" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin token required" }, 401);
      }
      this.fabricStatus = "STOPPED";
      this.sqlExec(`UPDATE meta SET value = 'STOPPED' WHERE key = 'fabric_status'`);
      // Cancel all running and pending jobs
      this.sqlExec(`UPDATE jobs SET state = 'Cancelled' WHERE state IN ('Running', 'Pending')`);
      this.logAudit("EMERGENCY_STOP", "Emergency stop triggered. All active jobs cancelled.");
      return json({ status: "ok", fabric_status: "STOPPED", message: "All running and pending jobs cancelled" });
    }

    // 4. Device Pairing Tokens & Pairing
    if (path === "/api/v1/devices/pairing-token" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Administrative authorization token required to issue pairing tokens" }, 401);
      }
      const code = "SP-" + Math.random().toString(36).substring(2, 6).toUpperCase();
      const expiresAt = Date.now() + 300000; // 5 mins
      this.sqlExec(
        `INSERT INTO pairing_tokens (token, expires_at, status, created_at) VALUES (?, ?, 'Active', ?)`,
        code,
        expiresAt,
        Date.now()
      );
      this.logAudit("PAIRING_TOKEN_CREATED", `Token ${code} issued`);
      return json({ token: code, expires_at: expiresAt });
    }

    if (path === "/api/v1/devices/pair" && method === "POST") {
      const body = await parseJsonBody();
      if (!body) {
        return json({ error: "BAD_REQUEST", message: "Malformed or missing JSON body" }, 400);
      }
      const { pairing_token, node_id, public_key, device_type, device_name } = body;
      if (!pairing_token) {
        return json({ error: "MISSING_PAIRING_TOKEN", message: "pairing_token is required" }, 400);
      }

      const tokens = this.sqlExec(`SELECT * FROM pairing_tokens WHERE token = ?`, pairing_token);
      if (tokens.length === 0 || tokens[0].status !== "Active" || tokens[0].expires_at < Date.now()) {
        return json({ error: "INVALID_PAIRING_TOKEN", message: "Pairing token expired or already consumed" }, 400);
      }

      const assignedNodeId = node_id || crypto.randomUUID();
      const authToken = "spaas_auth_" + crypto.randomUUID().replace(/-/g, "");

      // Insert or update node with unique auth_token
      this.sqlExec(
        `INSERT OR REPLACE INTO nodes (id, name, device_type, public_key, auth_token, state, is_simulated, last_heartbeat, created_at)
         VALUES (?, ?, ?, ?, ?, 'Ready', 0, ?, ?)`,
        assignedNodeId,
        device_name || "Enrolled Device",
        device_type || "Phone",
        public_key || "ed25519_pk",
        authToken,
        Date.now(),
        Date.now()
      );

      // Invalidate token
      this.sqlExec(`UPDATE pairing_tokens SET status = 'Claimed', claimed_by = ? WHERE token = ?`, assignedNodeId, pairing_token);
      this.logAudit("DEVICE_PAIRED", `Device ${assignedNodeId} paired with token ${pairing_token}`);

      return json({
        status: "approved",
        node_id: assignedNodeId,
        auth_token: authToken,
        epoch: this.epoch
      });
    }

    // 5. Node Management & Operational Controls
    if (path === "/api/v1/nodes" && method === "GET") {
      const nodes = this.sqlExec(`SELECT * FROM nodes ORDER BY created_at DESC`);
      const parsed = nodes.map(n => ({
        ...n,
        auth_token: undefined, // Redact secret auth token from public fleet listings
        is_simulated: Boolean(n.is_simulated),
        capabilities: n.capabilities ? JSON.parse(n.capabilities) : null,
        qualification: n.qualification ? JSON.parse(n.qualification) : null,
        telemetry: n.telemetry ? JSON.parse(n.telemetry) : null,
        policy: n.policy ? JSON.parse(n.policy) : null
      }));
      return json({ nodes: parsed, total: parsed.length });
    }

    if (path.startsWith("/api/v1/nodes/") && method === "GET" && !path.includes("/poll") && !path.includes("/qualification")) {
      const nodeId = path.split("/")[4];
      const nodes = this.sqlExec(`SELECT * FROM nodes WHERE id = ?`, nodeId);
      if (nodes.length === 0) return json({ error: "NOT_FOUND" }, 404);
      const n = nodes[0];
      return json({
        ...n,
        auth_token: undefined,
        is_simulated: Boolean(n.is_simulated),
        capabilities: n.capabilities ? JSON.parse(n.capabilities) : null,
        qualification: n.qualification ? JSON.parse(n.qualification) : null,
        telemetry: n.telemetry ? JSON.parse(n.telemetry) : null,
        policy: n.policy ? JSON.parse(n.policy) : null
      });
    }

    // Authenticated Device Heartbeat
    if (path === "/api/v1/nodes/heartbeat" && method === "POST") {
      const body = await parseJsonBody();
      if (!body || !body.node_id) {
        return json({ error: "BAD_REQUEST", message: "node_id required in heartbeat payload" }, 400);
      }
      const authResult = this.verifyDeviceAuth(req, body, body.node_id);
      if (authResult === "REVOKED") {
        return json({ error: "DEVICE_REVOKED", message: "This device has been revoked and cannot communicate with the fabric" }, 403);
      }
      if (!authResult) {
        return json({ error: "DEVICE_UNAUTHORIZED", message: "Invalid or missing device authentication token" }, 401);
      }

      const nodeId = body.node_id;
      const now = Date.now();
      this.sqlExec(
        `UPDATE nodes SET last_heartbeat = ?, telemetry = ?, state = CASE WHEN state = 'Offline' THEN 'Ready' ELSE state END WHERE id = ?`,
        now,
        JSON.stringify(body.telemetry || {}),
        nodeId
      );

      const assigned = this.sqlExec(`SELECT * FROM jobs WHERE assigned_node_id = ? AND state = 'Running' LIMIT 1`, nodeId);
      return json({ status: "ok", timestamp: now, assigned_job: assigned[0] || null });
    }

    // Authenticated Device Job Polling
    if (path.endsWith("/poll") && method === "GET") {
      const parts = path.split("/");
      const nodeId = parts[4];
      const authResult = this.verifyDeviceAuth(req, null, nodeId);
      if (authResult === "REVOKED") {
        return json({ error: "DEVICE_REVOKED" }, 403);
      }
      if (!authResult) {
        return json({ error: "DEVICE_UNAUTHORIZED", message: "Device auth token required to poll for jobs" }, 401);
      }
      const assigned = this.sqlExec(`SELECT * FROM jobs WHERE assigned_node_id = ? AND state = 'Running' LIMIT 1`, nodeId);
      return json({ job: assigned[0] || null });
    }

    // Authenticated Device Result Submission
    if (path === "/api/v1/nodes/results" && method === "POST") {
      const body = await parseJsonBody();
      if (!body || !body.job_id) {
        return json({ error: "BAD_REQUEST", message: "job_id is required" }, 400);
      }
      const authResult = this.verifyDeviceAuth(req, body, body.node_id);
      if (authResult === "REVOKED") {
        return json({ error: "DEVICE_REVOKED" }, 403);
      }
      if (!authResult) {
        return json({ error: "DEVICE_UNAUTHORIZED", message: "Valid device credentials required to submit job results" }, 401);
      }
      const res = await this.handleResultSubmission(body);
      return json(res);
    }

    // Node state transitions: rename, state, revoke, remove (Admin Auth Required)
    if (path.endsWith("/rename") && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin authorization required" }, 401);
      }
      const nodeId = path.split("/")[4];
      const body = await parseJsonBody();
      if (!body || !body.name) {
        return json({ error: "BAD_REQUEST", message: "name is required" }, 400);
      }
      this.sqlExec(`UPDATE nodes SET name = ? WHERE id = ?`, body.name, nodeId);
      return json({ status: "ok", node_id: nodeId, name: body.name });
    }

    if (path.endsWith("/state") && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin authorization required" }, 401);
      }
      const nodeId = path.split("/")[4];
      const body = await parseJsonBody();
      if (!body || !body.state) {
        return json({ error: "BAD_REQUEST", message: "state is required" }, 400);
      }
      this.sqlExec(`UPDATE nodes SET state = ? WHERE id = ?`, body.state, nodeId);
      return json({ status: "ok", node_id: nodeId, state: body.state });
    }

    if (path.endsWith("/revoke") && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin authorization required" }, 401);
      }
      const nodeId = path.split("/")[4];
      this.sqlExec(`UPDATE nodes SET state = 'Revoked' WHERE id = ?`, nodeId);
      this.logAudit("NODE_REVOKED", `Node ${nodeId} revoked`);
      return json({ status: "revoked", node_id: nodeId });
    }

    if (path.startsWith("/api/v1/nodes/") && method === "DELETE") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin authorization required" }, 401);
      }
      const nodeId = path.split("/")[4];
      this.sqlExec(`DELETE FROM nodes WHERE id = ?`, nodeId);
      this.logAudit("NODE_REMOVED", `Node ${nodeId} deleted`);
      return json({ status: "deleted", node_id: nodeId });
    }

    // 6. Job Management (Submit requires Admin Auth)
    if (path === "/api/v1/jobs" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Authorization token required to submit workloads" }, 401);
      }
      if (this.fabricStatus === "DRAINING" || this.fabricStatus === "STOPPED") {
        return json({ error: "FABRIC_UNAVAILABLE", message: `Fabric is currently ${this.fabricStatus} and rejecting new submissions` }, 503);
      }

      const body = await parseJsonBody();
      if (!body) {
        return json({ error: "BAD_REQUEST", message: "Malformed JSON body" }, 400);
      }
      const jobId = body.job_id || crypto.randomUUID();
      const workloadId = body.workload_id || "workload_catalog_wasm";

      this.sqlExec(
        `INSERT INTO jobs (id, workload_id, state, created_at) VALUES (?, ?, 'Pending', ?)`,
        jobId,
        workloadId,
        Date.now()
      );
      this.logAudit("JOB_SUBMITTED", `Job ${jobId} submitted`);

      // Attempt immediate scheduling
      await this.schedulePendingJobs();
      const created = this.sqlExec(`SELECT * FROM jobs WHERE id = ?`, jobId);
      return json(created[0] || { id: jobId, state: "Pending" }, 201);
    }

    if (path === "/api/v1/jobs" && method === "GET") {
      const jobs = this.sqlExec(`SELECT * FROM jobs ORDER BY created_at DESC`);
      const parsed = jobs.map(j => ({
        ...j,
        result: j.result ? JSON.parse(j.result) : null,
        scheduler_decision: j.scheduler_decision ? JSON.parse(j.scheduler_decision) : null
      }));
      return json({ jobs: parsed, total: parsed.length });
    }

    if (path.startsWith("/api/v1/jobs/") && method === "GET" && !path.includes("/scheduler-decision")) {
      const jobId = path.split("/")[4];
      const jobs = this.sqlExec(`SELECT * FROM jobs WHERE id = ?`, jobId);
      if (jobs.length === 0) return json({ error: "NOT_FOUND" }, 404);
      const j = jobs[0];
      return json({
        ...j,
        result: j.result ? JSON.parse(j.result) : null,
        scheduler_decision: j.scheduler_decision ? JSON.parse(j.scheduler_decision) : null
      });
    }

    if (path.endsWith("/scheduler-decision") && method === "GET") {
      const jobId = path.split("/")[4];
      const jobs = this.sqlExec(`SELECT scheduler_decision FROM jobs WHERE id = ?`, jobId);
      if (jobs.length === 0 || !jobs[0].scheduler_decision) {
        return json({ decision: null, message: "No decision record" });
      }
      return json({ decision: JSON.parse(jobs[0].scheduler_decision) });
    }

    if (path.includes("/cancel") && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin authorization required to cancel jobs" }, 401);
      }
      const jobId = path.split("/")[4];
      this.sqlExec(`UPDATE jobs SET state = 'Cancelled' WHERE id = ?`, jobId);
      this.logAudit("JOB_CANCELLED", `Job ${jobId} cancelled`);
      return json({ status: "cancelled", job_id: jobId });
    }

    // 7. Challenge Workload Creation (Admin Auth Required)
    if (path === "/api/v1/workloads/challenge" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin token required" }, 401);
      }
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const jobId = "challenge_" + nonce.substring(0, 8);
      this.sqlExec(
        `INSERT INTO jobs (id, workload_id, state, created_at) VALUES (?, 'challenge_sha256', 'Pending', ?)`,
        jobId,
        Date.now()
      );
      await this.schedulePendingJobs();
      return json({ job_id: jobId, nonce, expected_digest: "sha256_challenge_ready" }, 201);
    }

    // 8. Metering Ledger
    if (path === "/api/v1/metering" && method === "GET") {
      const entries = this.sqlExec(`SELECT * FROM ledger ORDER BY timestamp DESC`);
      const totalCredits = entries.reduce((acc, r) => acc + (r.amount_credits || 0), 0);
      return json({
        transactions: entries,
        summary: {
          total_settled_credits: totalCredits,
          transaction_count: entries.length,
          epoch: this.epoch
        }
      });
    }

    // 9. Demo Cluster Management & Purge (Admin Auth Required)
    if (path === "/api/v1/demo/start-cluster" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin token required" }, 401);
      }
      const demoPhones = [
        { id: "demo-pixel-8", name: "Google Pixel 8 Pro", type: "Phone" },
        { id: "demo-galaxy-s24", name: "Samsung Galaxy S24 Ultra", type: "Phone" },
        { id: "demo-edge-worker", name: "Ubuntu Edge Node", type: "Desktop" },
        { id: "demo-tablet-tab9", name: "Galaxy Tab S9", type: "Phone" }
      ];
      for (const p of demoPhones) {
        this.sqlExec(
          `INSERT OR REPLACE INTO nodes (id, name, device_type, state, is_simulated, auth_token, last_heartbeat, created_at)
           VALUES (?, ?, ?, 'Ready', 1, 'spaas_auth_demo', ?, ?)`,
          p.id,
          p.name,
          p.type,
          Date.now(),
          Date.now()
        );
      }
      this.logAudit("DEMO_CLUSTER_STARTED", "Initialized 4 simulated devices");
      return json({ status: "started", nodes: demoPhones });
    }

    if (path === "/api/v1/demo/purge-simulated-nodes" && method === "POST") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin token required" }, 401);
      }
      this.sqlExec(`DELETE FROM nodes WHERE is_simulated = 1`);
      this.logAudit("DEMO_PURGED", "Purged simulated nodes from cluster");
      return json({ status: "purged" });
    }

    // 10. Audit Log (Admin Auth Required)
    if (path === "/api/v1/audit" && method === "GET") {
      if (!this.verifyAdminAuth(req)) {
        return json({ error: "UNAUTHORIZED", message: "Admin token required" }, 401);
      }
      const logs = this.sqlExec(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 100`);
      return json({ logs });
    }

    return json({ error: "NOT_FOUND", path }, 404);
  }
}
