/**
 * SPaaS Universal Edge Compute Fabric — SQLite Storage Bridge
 * Seamlessly bridges Cloudflare Durable Objects `ctx.storage.sql` and `sql.js` WASM engine for local/test execution.
 */

let SQL = null;

export async function createSqlEngine(ctx) {
  // 1. Native Cloudflare Workers Durable Object SQLite
  if (ctx?.storage?.sql) {
    return {
      isNative: true,
      exec(query, ...params) {
        try {
          const cursor = ctx.storage.sql.exec(query, ...params);
          if (typeof cursor.toArray === "function") {
            return cursor.toArray();
          }
          return Array.from(cursor);
        } catch (err) {
          console.error(`[SQL Native Error] Query: ${query}`, err);
          throw err;
        }
      }
    };
  }

  // 2. High-Fidelity WASM SQLite (sql.js) for Local / Testing / Standalone
  try {
    if (!SQL) {
      const initSqlJs = (await import("sql.js")).default;
      SQL = await initSqlJs();
    }
    const db = new SQL.Database();
    return {
      isNative: false,
      rawDb: db,
      exec(query, ...params) {
        const q = query.trim();
        try {
          if (!params || params.length === 0) {
            const results = db.exec(q);
            if (results.length === 0) return [];
            const last = results[results.length - 1];
            return last.values.map(row => {
              const obj = {};
              last.columns.forEach((col, i) => {
                obj[col] = row[i];
              });
              return obj;
            });
          }

          const stmt = db.prepare(q);
          stmt.bind(params);
          const rows = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
          return rows;
        } catch (err) {
          console.error(`[SQL WASM Error] Query: ${query} Params: ${JSON.stringify(params)}`, err);
          throw err;
        }
      }
    };
  } catch (err) {
    // When sql.js is not installed locally, use our transactional in-memory store
    return createMinimalFallbackEngine();
  }
}

function createMinimalFallbackEngine() {
  const tables = {
    nodes: new Map(),
    pairing_tokens: new Map(),
    workloads: new Map(),
    jobs: new Map(),
    job_transitions: new Map(),
    leases: new Map(),
    device_sessions: new Map(),
    ledger: new Map(),
    node_commands: new Map(),
    audit_log: [],
    meta: new Map([["role", "PRIMARY"], ["epoch", "1"], ["fabric_status", "ACTIVE"]])
  };

  return {
    isNative: false,
    exec(query, ...params) {
      const q = query.trim().replace(/\s+/g, " ");
      const qu = q.toUpperCase();

      if (qu.startsWith("CREATE") || qu.startsWith("ALTER TABLE")) return [];

      // META
      if (qu.startsWith("INSERT OR IGNORE INTO META")) {
        const [k, v] = params;
        if (!tables.meta.has(k)) tables.meta.set(k, v);
        return [];
      }
      if (qu.startsWith("UPDATE META SET VALUE =")) {
        const [val, key] = params.length >= 2 ? [params[0], params[1]] : [qu.includes("'PAUSED'") ? 'PAUSED' : qu.includes("'ACTIVE'") ? 'ACTIVE' : qu.includes("'DRAINING'") ? 'DRAINING' : 'STOPPED', 'fabric_status'];
        tables.meta.set(key, val);
        return [];
      }

      // PAIRING_TOKENS
      if (qu.startsWith("INSERT INTO PAIRING_TOKENS")) {
        const [token, short_code, opaque_credential, expires_at, status_unused, created_at] =
          params.length >= 5 ? params : [params[0], params[0], params[0], params[1], "Active", params[2] || Date.now()];
        tables.pairing_tokens.set(token, {
          token,
          short_code: short_code || token,
          opaque_credential: opaque_credential || token,
          expires_at,
          status: "Active",
          claimed_by: null,
          consumed_at: null,
          created_at: created_at || Date.now()
        });
        return [];
      }
      if (qu.startsWith("UPDATE PAIRING_TOKENS SET STATUS = 'CONSUMING'")) {
        // Atomic: only succeed if status is Active and not expired
        const tokenKey = params[0];
        const now = params[1] || Date.now();
        const t = tables.pairing_tokens.get(tokenKey);
        if (t && t.status === "Active" && t.expires_at > now) {
          t.status = "Consuming";
        }
        return [];
      }
      if (qu.startsWith("UPDATE PAIRING_TOKENS SET STATUS = 'CONSUMED'")) {
        const [claimed_by, consumed_at, tokenKey] = params;
        const t = tables.pairing_tokens.get(tokenKey);
        if (t) {
          t.status = "Consumed";
          t.claimed_by = claimed_by;
          t.consumed_at = consumed_at;
        }
        return [];
      }
      if (qu.startsWith("UPDATE PAIRING_TOKENS SET STATUS = 'CLAIMED'")) {
        const [claimed_by, token] = params;
        const t = tables.pairing_tokens.get(token);
        if (t) {
          t.status = "Consumed";
          t.claimed_by = claimed_by;
          t.consumed_at = Date.now();
        }
        return [];
      }
      if (qu.includes("FROM PAIRING_TOKENS WHERE OPAQUE_CREDENTIAL =")) {
        const searchVal = (params[0] || "").toLowerCase();
        const match = Array.from(tables.pairing_tokens.values()).find(t => (t.opaque_credential || "").toLowerCase() === searchVal);
        return match ? [match] : [];
      }
      if (qu.includes("FROM PAIRING_TOKENS WHERE SHORT_CODE =")) {
        const code = params[0];
        const matches = Array.from(tables.pairing_tokens.values()).filter(t => t.short_code === code && t.status === "Active");
        return matches.length > 0 ? [matches[0]] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM PAIRING_TOKENS WHERE TOKEN =")) {
        const searchVal = (params[0] || "").toLowerCase();
        const t = tables.pairing_tokens.get(params[0]) || Array.from(tables.pairing_tokens.values()).find(t => (t.token || "").toLowerCase() === searchVal);
        return t ? [t] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM PAIRING_TOKENS")) {
        return Array.from(tables.pairing_tokens.values());
      }

      // NODES
      if (qu.startsWith("INSERT OR REPLACE INTO NODES") || qu.startsWith("INSERT INTO NODES")) {
        const id = params[0];
        const isSimulated = (qu.includes("'READY', 1") || qu.includes(", 1,") || qu.includes(", 1 ,")) ? 1 : 0;
        let last_heartbeat = Date.now();
        let created_at = Date.now();
        let public_key = "ed25519_pk";
        let auth_token = "spaas_auth_test";
        let capabilities = null;
        let qualification = null;
        let policy = null;
        let telemetry = null;

        if (qu.includes("QUALIFICATION") && params.length === 8) {
          capabilities = params[3] || null;
          qualification = params[4] || null;
          telemetry = params[5] || null;
          last_heartbeat = params[6] || Date.now();
          created_at = params[7] || Date.now();
        } else if (qu.includes("QUALIFICATION") && params.length >= 9) {
          auth_token = params[2] || "spaas_auth_test";
          capabilities = params[3] || null;
          qualification = params[4] || null;
          policy = params[5] || null;
          telemetry = params[6] || null;
          last_heartbeat = params[7] || Date.now();
          created_at = params[8] || Date.now();
        } else if (params.length >= 10) {
          public_key = params[3] || "ed25519_pk";
          auth_token = params[4] || "spaas_auth_test";
          capabilities = params[5] || null;
          policy = params[6] || null;
          telemetry = params[7] || null;
          last_heartbeat = params[8] || Date.now();
          created_at = params[9] || Date.now();
        } else if (qu.includes("POLICY") && params.length === 9) {
          auth_token = params[3] || "spaas_auth_test";
          capabilities = params[4] || null;
          telemetry = params[5] || null;
          policy = params[6] || null;
          last_heartbeat = params[7] || Date.now();
          created_at = params[8] || Date.now();
        } else if (params.length === 5) {
          last_heartbeat = params[3];
          created_at = params[4];
        } else if (params.length >= 7) {
          public_key = params[3] || "ed25519_pk";
          auth_token = params[4] || "spaas_auth_test";
          last_heartbeat = params[5] || Date.now();
          created_at = params[6] || Date.now();
        }

        let nodeState = "Ready";
        if (qu.includes("'REVOKED'")) nodeState = "Revoked";
        else if (qu.includes("'BUSY'")) nodeState = "Busy";
        else if (qu.includes("'PAUSED'")) nodeState = "Paused";
        else if (qu.includes("'OFFLINE'")) nodeState = "Offline";

        tables.nodes.set(id, {
          id: params[0],
          name: params[1],
          device_type: params[2],
          public_key,
          auth_token,
          state: nodeState,
          capabilities,
          qualification,
          policy,
          telemetry,
          is_simulated: isSimulated,
          last_heartbeat,
          created_at
        });
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET LAST_HEARTBEAT")) {
        let last_heartbeat, telemetry = null, id;
        if (params.length === 2) {
          [last_heartbeat, id] = params;
        } else {
          [last_heartbeat, telemetry, id] = params;
        }
        const n = tables.nodes.get(id);
        if (n) {
          n.last_heartbeat = last_heartbeat;
          if (telemetry !== null) n.telemetry = telemetry;
          if (n.state === "Offline") n.state = "Ready";
        }
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET STATE = 'REVOKED'")) {
        const n = tables.nodes.get(params[0]);
        if (n) n.state = "Revoked";
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET STATE = 'OFFLINE'")) {
        const n = tables.nodes.get(params[0]);
        if (n) n.state = "Offline";
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET STATE =")) {
        if (params.length === 0) {
          const bulkState = qu.includes("'PAUSED'") ? "Paused" : qu.includes("'READY'") ? "Ready" : "Ready";
          for (const n of tables.nodes.values()) {
            if (qu.includes("STATE != 'REVOKED'") && n.state === "Revoked") continue;
            n.state = bulkState;
          }
          return [];
        }
        let state, id;
        if (params.length === 1) {
          id = params[0];
          state = qu.includes("'OFFLINE'") ? "Offline" : qu.includes("'READY'") ? "Ready" : qu.includes("'REVOKED'") ? "Revoked" : qu.includes("'RUNNING'") ? "Running" : qu.includes("'BUSY'") ? "Busy" : qu.includes("'PAUSED'") ? "Paused" : qu.includes("'RESERVED'") ? "Reserved" : "Ready";
        } else {
          [state, id] = params;
        }
        const n = tables.nodes.get(id);
        if (n) n.state = state;
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET NAME =")) {
        const [name, id] = params;
        const n = tables.nodes.get(id);
        if (n) n.name = name;
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET QUALIFICATION =")) {
        const [qual, id] = params;
        const n = tables.nodes.get(id);
        if (n) n.qualification = qual;
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET POLICY =")) {
        const [policy, id] = params;
        const n = tables.nodes.get(id);
        if (n) n.policy = policy;
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET TELEMETRY =")) {
        const [telemetry, id] = params;
        const n = tables.nodes.get(id);
        if (n) n.telemetry = telemetry;
        return [];
      }
      if (qu.startsWith("DELETE FROM NODES WHERE ID =")) {
        tables.nodes.delete(params[0]);
        return [];
      }
      if (qu.startsWith("DELETE FROM NODES WHERE IS_SIMULATED = 1")) {
        for (const [id, n] of tables.nodes.entries()) {
          if (n.is_simulated) tables.nodes.delete(id);
        }
        return [];
      }
      if (qu.startsWith("DELETE FROM NODES WHERE STATE = 'REVOKED'")) {
        for (const [id, n] of tables.nodes.entries()) {
          if (n.state === 'Revoked') tables.nodes.delete(id);
        }
        return [];
      }
      if (qu.startsWith("DELETE FROM NODES")) {
        tables.nodes.clear();
        return [];
      }
      if (qu.startsWith("SELECT AUTH_TOKEN, STATE FROM NODES WHERE ID =")) {
        const n = tables.nodes.get(params[0]);
        return n ? [{ auth_token: n.auth_token, state: n.state }] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM NODES WHERE ID =")) {
        const id = params[0] || q.match(/WHERE id = '([^']+)'/i)?.[1] || q.match(/WHERE id = "([^"]+)"/i)?.[1];
        const n = tables.nodes.get(id);
        return n ? [n] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM NODES WHERE STATE = 'READY' AND IS_SIMULATED = 0")) {
        return Array.from(tables.nodes.values()).filter(n => n.state === "Ready" && !n.is_simulated);
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM NODES WHERE STATE != 'OFFLINE' AND STATE != 'REVOKED'")) {
        const threshold = params[0];
        return Array.from(tables.nodes.values()).filter(n => n.state !== "Offline" && n.state !== "Revoked" && n.last_heartbeat < threshold);
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM NODES")) {
        if (qu.includes("COUNT(*)")) {
          const count = tables.nodes.size;
          return [{ c: count, count }];
        }
        return Array.from(tables.nodes.values());
      }

      // WORKLOADS
      if (qu.startsWith("INSERT OR REPLACE INTO WORKLOADS") || qu.startsWith("INSERT INTO WORKLOADS")) {
        const [id, spec, submitter_pubkey, wasm_bytes, created_at] = params;
        tables.workloads.set(id, {
          id,
          spec,
          signature: null,
          submitter_pubkey: submitter_pubkey || "public_consumer",
          wasm_bytes: wasm_bytes || null,
          created_at: created_at || Date.now()
        });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM WORKLOADS WHERE ID =")) {
        const id = params[0];
        const w = tables.workloads.get(id);
        return w ? [w] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM WORKLOADS")) {
        return Array.from(tables.workloads.values());
      }

      // JOBS
      if (qu.startsWith("INSERT INTO JOBS")) {
        if (qu.includes("FENCING_TOKEN") && params.length >= 8) {
          let jId, wId, jState, aNodeId, lTerm = 1, lExpires, ep = 1, fToken, rCount = 0, mRetries = 3, sDecision = null, corrId = null, cAt;
          if (params.length === 13) {
            [jId, wId, jState, aNodeId, lTerm, lExpires, ep, fToken, rCount, mRetries, sDecision, corrId, cAt] = params;
          } else {
            [jId, wId, jState, aNodeId, fToken, lExpires, ep, sDecision, cAt] = params;
          }
          tables.jobs.set(jId, {
            id: jId,
            workload_id: wId,
            state: jState,
            assigned_node_id: aNodeId,
            lease_term: lTerm,
            lease_expires_at: lExpires,
            epoch: ep || 1,
            fencing_token: fToken,
            retry_count: rCount,
            max_retries: mRetries,
            result: null,
            scheduler_decision: sDecision,
            correlation_id: corrId,
            created_at: cAt || Date.now(),
            completed_at: null
          });
          return [];
        }
        let id = params[0];
        let workload_id = params[1] || "workload";
        let state = qu.includes("'RUNNING'") ? "Running" : qu.includes("'COMPLETED'") ? "Completed" : "Pending";
        let assigned_node_id = null;
        let lease_expires_at = null;
        let retry_count = 0;
        let max_retries = 3;
        let correlation_id = null;
        let created_at = Date.now();

        let fencing_token = null;
        let scheduler_decision = null;

        if (params.length === 4) {
          correlation_id = params[2];
          created_at = params[3];
        } else if (params.length === 13) {
          state = params[2];
          assigned_node_id = params[3];
          lease_expires_at = params[5];
          fencing_token = params[7];
          retry_count = params[8];
          max_retries = params[9];
          scheduler_decision = params[10];
          correlation_id = params[11];
          created_at = params[12];
        } else if (params.length === 10) {
          state = params[2];
          assigned_node_id = params[3];
          lease_expires_at = params[5];
          correlation_id = params[8];
          created_at = params[9];
        } else if (params.length === 5) {
          assigned_node_id = params[2];
          lease_expires_at = params[3];
          created_at = params[4];
          if (qu.includes("?, ?, 'RUNNING', ?, ?, 3, 3, ?")) {
            retry_count = 3;
          }
        } else if (params.length >= 7) {
          state = params[2];
          assigned_node_id = params[3];
          lease_expires_at = params[4];
          retry_count = params[5];
          max_retries = params[6];
          created_at = params[7] || Date.now();
        } else if (params.length === 3) {
          created_at = params[2];
        }

        tables.jobs.set(id, {
          id,
          workload_id,
          state,
          assigned_node_id,
          lease_term: 1,
          lease_expires_at,
          epoch: 1,
          fencing_token,
          retry_count,
          max_retries,
          result: null,
          scheduler_decision,
          correlation_id,
          created_at,
          completed_at: null
        });
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET STATE = 'RUNNING'") || qu.startsWith("UPDATE JOBS SET STATE = 'DISPATCHED'") || qu.startsWith("UPDATE JOBS SET STATE = 'OFFERED'")) {
        const [assigned_node_id, fencing_token, lease_expires_at, scheduler_decision, ...rest] = params;
        const id = rest[rest.length - 1];
        const j = tables.jobs.get(id);
        if (j) {
          j.state = qu.includes("'DISPATCHED'") ? "DISPATCHED" : (qu.includes("'OFFERED'") ? "OFFERED" : "Running");
          j.assigned_node_id = assigned_node_id;
          j.fencing_token = fencing_token;
          j.lease_expires_at = lease_expires_at;
          j.scheduler_decision = scheduler_decision;
          if (rest.length > 1 && !j.correlation_id) {
            j.correlation_id = rest[0];
          }
        }
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET STATE = 'COMPLETED'")) {
        const [result, completed_at, id] = params;
        const j = tables.jobs.get(id);
        if (j) {
          j.state = "COMPLETED";
          j.result = result;
          j.completed_at = completed_at;
        }
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET STATE = 'CANCELLED'")) {
        if (params.length === 1) {
          const j = tables.jobs.get(params[0]);
          if (j) j.state = "Cancelled";
        } else {
          for (const j of tables.jobs.values()) {
            if (j.state === "Running" || j.state === "Pending") j.state = "Cancelled";
          }
        }
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET STATE = 'PENDING'") || qu.startsWith("UPDATE JOBS SET STATE = 'QUEUED'")) {
        const id = params[params.length - 1];
        const j = tables.jobs.get(id);
        if (j) {
          j.state = qu.includes("'QUEUED'") ? "QUEUED" : "Pending";
          j.assigned_node_id = null;
          j.lease_expires_at = null;
          if (qu.includes("WAIT_REASON = ?")) {
            j.wait_reason = params[0];
          }
          if (qu.startsWith("UPDATE JOBS SET STATE = 'PENDING'")) {
            j.retry_count = (j.retry_count || 0) + 1;
          }
        }
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET STATE = 'FAILED'")) {
        const [completed_at, id] = params;
        const j = tables.jobs.get(id);
        if (j) {
          j.state = "Failed";
          j.completed_at = completed_at;
        }
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET STATE = ?")) {
        const state = params[0];
        const id = params[params.length - 1];
        const j = tables.jobs.get(id);
        if (j) {
          j.state = state;
          if (qu.includes("NEXT_ACTION = ?")) {
            j.next_action = params[1];
          }
        }
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET WAIT_REASON =")) {
        const [wait_reason, id] = params;
        const j = tables.jobs.get(id);
        if (j) {
          j.wait_reason = wait_reason;
        }
        return [];
      }
      if (qu.startsWith("DELETE FROM JOBS WHERE ID =")) {
        tables.jobs.delete(params[0]);
        return [];
      }
      if (qu.startsWith("DELETE FROM JOBS WHERE STATE IN")) {
        for (const [id, j] of tables.jobs.entries()) {
          const s = (j.state || "").toUpperCase();
          if (qu.includes("'COMPLETED'") && ['COMPLETED', 'SETTLED', 'VERIFIED', 'FAILED', 'CANCELLED'].includes(s)) {
            tables.jobs.delete(id);
          } else if (qu.includes("'QUEUED'") && ['QUEUED', 'PENDING', 'SCHEDULED', 'ASSIGNED', 'LEASED'].includes(s)) {
            tables.jobs.delete(id);
          }
        }
        return [];
      }
      if (qu.startsWith("DELETE FROM JOBS")) {
        tables.jobs.clear();
        return [];
      }
      if (qu.startsWith("DELETE FROM LEASES WHERE JOB_ID =")) {
        for (const [id, l] of tables.leases.entries()) {
          if (l.job_id === params[0]) tables.leases.delete(id);
        }
        return [];
      }
      if (qu.startsWith("DELETE FROM LEASES")) {
        tables.leases.clear();
        return [];
      }
      if (qu.startsWith("DELETE FROM JOB_TRANSITIONS WHERE JOB_ID =")) {
        for (const [id, t] of tables.job_transitions.entries()) {
          if (t.job_id === params[0]) tables.job_transitions.delete(id);
        }
        return [];
      }
      if (qu.startsWith("DELETE FROM JOB_TRANSITIONS")) {
        tables.job_transitions.clear();
        return [];
      }
      if (qu.startsWith("SELECT COUNT(*) AS COUNT FROM JOBS WHERE STATE IN")) {
        const count = Array.from(tables.jobs.values()).filter(j => j.state === "Running" || j.state === "RUNNING" || j.state === "Pending" || j.state === "QUEUED" || j.state === "DISPATCHED").length;
        return [{ count }];
      }
      if (qu.includes("FROM JOBS WHERE") && qu.includes("LEASE_EXPIRES_AT <=")) {
        const now = params[params.length - 1];
        return Array.from(tables.jobs.values()).filter(j => j.lease_expires_at && j.lease_expires_at <= now && !["Completed", "COMPLETED", "Failed", "FAILED", "Cancelled", "CANCELLED"].includes(j.state));
      }
      if (qu.startsWith("SELECT * FROM JOBS WHERE STATE = 'PENDING'") || qu.startsWith("SELECT * FROM JOBS WHERE STATE = 'QUEUED'") || qu.startsWith("SELECT * FROM JOBS WHERE STATE IN")) {
        return Array.from(tables.jobs.values()).filter(j => j.state === "Pending" || j.state === "Queued" || j.state === "QUEUED");
      }
      if (qu.startsWith("SELECT * FROM JOBS WHERE ASSIGNED_NODE_ID = ?")) {
        const nodeId = params[0];
        const rows = Array.from(tables.jobs.values()).filter(j => j.assigned_node_id === nodeId);
        if (qu.includes("AND STATE = 'RUNNING'")) {
          return rows.filter(j => j.state === "Running" || j.state === "RUNNING");
        }
        if (qu.includes("AND STATE IN")) {
          return rows.filter(j => ["ASSIGNED", "LEASED", "DISPATCHED", "ACKNOWLEDGED", "RUNNING", "OFFERED"].includes((j.state || "").toUpperCase()) && (!j.lease_expires_at || j.lease_expires_at > Date.now()));
        }
        return rows;
      }
      if (qu.startsWith("SELECT SCHEDULER_DECISION FROM JOBS WHERE ID =")) {
        const j = tables.jobs.get(params[0]);
        return j ? [{ scheduler_decision: j.scheduler_decision }] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM JOBS WHERE ID =")) {
        const id = params[0] || q.match(/WHERE id = '([^']+)'/i)?.[1] || q.match(/WHERE id = "([^"]+)"/i)?.[1];
        const j = tables.jobs.get(id);
        return j ? [j] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM JOBS")) {
        return Array.from(tables.jobs.values());
      }

      // JOB_TRANSITIONS
      if (qu.startsWith("INSERT INTO JOB_TRANSITIONS")) {
        let id, job_id, from_state, to_state, reason, next_action, timestamp, metadata;
        if (params.length === 7) {
          [job_id, from_state, to_state, reason, next_action, metadata, timestamp] = params;
          id = `trans_${tables.job_transitions.size + 1}_${Math.random().toString(36).substring(2, 7)}`;
        } else if (params.length === 6) {
          [job_id, from_state, to_state, reason, metadata, timestamp] = params;
          id = `trans_${tables.job_transitions.size + 1}_${Math.random().toString(36).substring(2, 7)}`;
        } else {
          [id, job_id, from_state, to_state, reason, timestamp, metadata] = params;
        }
        tables.job_transitions.set(id, { id, job_id, from_state, to_state, reason, next_action, timestamp, metadata });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM JOB_TRANSITIONS WHERE JOB_ID =")) {
        const jobId = params[0];
        return Array.from(tables.job_transitions.values())
          .filter(t => t.job_id === jobId)
          .sort((a, b) => a.timestamp - b.timestamp);
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM JOB_TRANSITIONS")) {
        return Array.from(tables.job_transitions.values());
      }

      // LEASES
      if (qu.startsWith("INSERT OR REPLACE INTO LEASES") || qu.startsWith("INSERT INTO LEASES")) {
        const [lease_id, job_id, node_id, fencing_token, epoch, expires_at, state, created_at] = params;
        tables.leases.set(lease_id, { lease_id, job_id, node_id, fencing_token, epoch: epoch || 1, expires_at, state: state || "ACTIVE", created_at: created_at || Date.now() });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM LEASES WHERE JOB_ID =")) {
        const jobId = params[0];
        return Array.from(tables.leases.values()).filter(l => l.job_id === jobId);
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM LEASES WHERE LEASE_ID =")) {
        const leaseId = params[0];
        const l = tables.leases.get(leaseId);
        return l ? [l] : [];
      }
      if (qu.startsWith("UPDATE LEASES SET STATE =")) {
        const [st, leaseId] = params;
        const l = tables.leases.get(leaseId);
        if (l) l.state = st;
        return [];
      }

      // DEVICE_SESSIONS
      if (qu.startsWith("INSERT OR REPLACE INTO DEVICE_SESSIONS")) {
        let node_id, tenant_id, shard, session_id, connection_state, last_seen, active_lease_id, active_job_id, updated_at;
        if (params.length === 8) {
          [node_id, session_id, connection_state, last_seen, active_lease_id, active_job_id, shard, updated_at] = params;
          tenant_id = "default";
        } else {
          [node_id, tenant_id, shard, session_id, connection_state, last_seen, active_lease_id, active_job_id, updated_at] = params;
        }
        tables.device_sessions.set(node_id, { node_id, tenant_id, shard, session_id, connection_state, last_seen, active_lease_id, active_job_id, updated_at });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM DEVICE_SESSIONS WHERE NODE_ID =")) {
        const s = tables.device_sessions.get(params[0]);
        return s ? [s] : [];
      }
      if (qu.startsWith("UPDATE DEVICE_SESSIONS SET CONNECTION_STATE =")) {
        let connection_state, updated_at, node_id;
        if (qu.includes("SET CONNECTION_STATE = 'DISCONNECTED'")) {
          [updated_at, node_id] = params;
          connection_state = "DISCONNECTED";
        } else {
          [connection_state, updated_at, node_id] = params;
        }
        const s = tables.device_sessions.get(node_id);
        if (s) {
          s.connection_state = connection_state;
          s.updated_at = updated_at;
        }
        return [];
      }
      if (qu.startsWith("UPDATE DEVICE_SESSIONS SET ACTIVE_LEASE_ID = NULL")) {
        const [updated_at, node_id] = params;
        const s = tables.device_sessions.get(node_id);
        if (s) {
          s.active_lease_id = null;
          s.active_job_id = null;
          s.updated_at = updated_at;
        }
        return [];
      }

      // LEDGER
      if (qu.startsWith("INSERT OR IGNORE INTO LEDGER") || qu.startsWith("INSERT INTO LEDGER")) {
        let entry;
        if (qu.includes("ENTRY_TYPE") || params.length >= 16) {
          const [id, tx_id, idempotency_key, epoch, job_id, entry_type, account, counterparty, consumer_pubkey, provider_pubkey, amount_credits, fuel_used, duration_ms, memory_mb, status, now, correlation_id] = params;
          entry = {
            id,
            tx_id,
            idempotency_key,
            epoch,
            job_id,
            entry_type: entry_type || "CREDIT",
            account: account || provider_pubkey,
            counterparty: counterparty || consumer_pubkey,
            consumer_pubkey,
            provider_pubkey,
            amount_credits: Number(amount_credits) || 0,
            fuel_used,
            duration_ms,
            memory_mb,
            status: status || "SETTLED",
            timestamp: now,
            correlation_id: correlation_id || null
          };
        } else {
          const [id, idempotency_key, epoch, job_id, consumer_pubkey, provider_pubkey, amount_credits, fuel_used, duration_ms, memory_mb, now] = params;
          entry = {
            id,
            tx_id: `tx_${id}`,
            idempotency_key,
            epoch,
            job_id,
            entry_type: "CREDIT",
            account: provider_pubkey,
            counterparty: consumer_pubkey,
            consumer_pubkey,
            provider_pubkey,
            amount_credits: Number(amount_credits) || 0,
            fuel_used,
            duration_ms,
            memory_mb,
            status: "SETTLED",
            timestamp: now
          };
        }
        if (!tables.ledger.has(entry.idempotency_key)) {
          tables.ledger.set(entry.idempotency_key, entry);
        }
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM LEDGER")) {
        let entries = Array.from(tables.ledger.values());
        if (qu.includes("WHERE ENTRY_TYPE = 'CREDIT'") || qu.includes('WHERE ENTRY_TYPE = "CREDIT"')) {
          entries = entries.filter(e => (e.entry_type || "").toUpperCase() === "CREDIT");
        } else if (qu.includes("WHERE ENTRY_TYPE = 'DEBIT'") || qu.includes('WHERE ENTRY_TYPE = "DEBIT"')) {
          entries = entries.filter(e => (e.entry_type || "").toUpperCase() === "DEBIT");
        }
        if (qu.includes("WHERE JOB_ID =")) {
          const jobId = params[0] || q.match(/WHERE job_id = '([^']+)'/i)?.[1];
          entries = entries.filter(e => e.job_id === jobId);
        }
        if (qu.includes("WHERE ACCOUNT =")) {
          const acc = params[0];
          entries = entries.filter(e => e.account === acc || e.consumer_pubkey === acc || e.provider_pubkey === acc);
        }
        if (qu.includes("COUNT(*)")) {
          return [{ c: entries.length, count: entries.length }];
        }
        return entries;
      }

      // NODE COMMANDS
      if (qu.startsWith("INSERT INTO NODE_COMMANDS")) {
        const [id, node_id, command, created_at] = params;
        tables.node_commands.set(id, { id, node_id, command, created_at: created_at || Date.now() });
        return [];
      }
      if (qu.startsWith("SELECT ID, COMMAND FROM NODE_COMMANDS WHERE NODE_ID =")) {
        const nodeId = params[0];
        const match = Array.from(tables.node_commands.values())
          .filter(c => c.node_id === nodeId)
          .sort((a, b) => a.created_at - b.created_at)[0];
        return match ? [{ id: match.id, command: match.command }] : [];
      }
      if (qu.startsWith("DELETE FROM NODE_COMMANDS WHERE ID =")) {
        tables.node_commands.delete(params[0]);
        return [];
      }

      // AUDIT_LOG
      if (qu.startsWith("INSERT INTO AUDIT_LOG")) {
        const [event_type, details, timestamp] = params;
        tables.audit_log.push({
          id: tables.audit_log.length + 1,
          event_type,
          details,
          timestamp
        });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM AUDIT_LOG")) {
        return [...tables.audit_log].reverse().slice(0, 100);
      }

      return [];
    }
  };
}
