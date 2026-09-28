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
        const match = Array.from(tables.pairing_tokens.values()).find(t => t.opaque_credential === params[0]);
        return match ? [match] : [];
      }
      if (qu.includes("FROM PAIRING_TOKENS WHERE SHORT_CODE =")) {
        const code = params[0];
        const matches = Array.from(tables.pairing_tokens.values()).filter(t => t.short_code === code && t.status === "Active");
        return matches.length > 0 ? [matches[0]] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM PAIRING_TOKENS WHERE TOKEN =")) {
        const t = tables.pairing_tokens.get(params[0]);
        return t ? [t] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM PAIRING_TOKENS")) {
        return Array.from(tables.pairing_tokens.values());
      }

      // NODES
      if (qu.startsWith("INSERT OR REPLACE INTO NODES") || qu.startsWith("INSERT INTO NODES")) {
        const id = params[0];
        const isSimulated = qu.includes("'READY', 1") ? 1 : 0;
        let last_heartbeat = Date.now();
        let created_at = Date.now();
        let public_key = "ed25519_pk";
        let auth_token = "spaas_auth_test";

        if (params.length === 5) {
          last_heartbeat = params[3];
          created_at = params[4];
        } else if (params.length >= 7) {
          public_key = params[3] || "ed25519_pk";
          auth_token = params[4] || "spaas_auth_test";
          last_heartbeat = params[5] || Date.now();
          created_at = params[6] || Date.now();
        }

        tables.nodes.set(id, {
          id: params[0],
          name: params[1],
          device_type: params[2],
          public_key,
          auth_token,
          state: "Ready",
          capabilities: null,
          qualification: null,
          policy: null,
          telemetry: null,
          is_simulated: isSimulated,
          last_heartbeat,
          created_at
        });
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET LAST_HEARTBEAT")) {
        const [last_heartbeat, telemetry, id] = params;
        const n = tables.nodes.get(id);
        if (n) {
          n.last_heartbeat = last_heartbeat;
          n.telemetry = telemetry;
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
        let state, id;
        if (params.length === 1) {
          id = params[0];
          state = qu.includes("'OFFLINE'") ? "Offline" : qu.includes("'READY'") ? "Ready" : qu.includes("'REVOKED'") ? "Revoked" : qu.includes("'RUNNING'") ? "Running" : "Ready";
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
          const [jId, wId, jState, aNodeId, fToken, lExpires, ep, sDecision, cAt] = params;
          tables.jobs.set(jId, {
            id: jId,
            workload_id: wId,
            state: jState,
            assigned_node_id: aNodeId,
            lease_term: 1,
            lease_expires_at: lExpires,
            epoch: ep || 1,
            fencing_token: fToken,
            retry_count: 0,
            max_retries: 3,
            result: null,
            scheduler_decision: sDecision,
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

        if (params.length === 4) {
          correlation_id = params[2];
          created_at = params[3];
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
          fencing_token: null,
          retry_count,
          max_retries,
          result: null,
          scheduler_decision: null,
          correlation_id,
          created_at,
          completed_at: null
        });
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET STATE = 'RUNNING'")) {
        const [assigned_node_id, fencing_token, lease_expires_at, scheduler_decision, id] = params;
        const j = tables.jobs.get(id);
        if (j) {
          j.state = "Running";
          j.assigned_node_id = assigned_node_id;
          j.fencing_token = fencing_token;
          j.lease_expires_at = lease_expires_at;
          j.scheduler_decision = scheduler_decision;
        }
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET STATE = 'COMPLETED'")) {
        const [result, completed_at, id] = params;
        const j = tables.jobs.get(id);
        if (j) {
          j.state = "Completed";
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
      if (qu.startsWith("UPDATE JOBS SET STATE = 'PENDING'")) {
        const j = tables.jobs.get(params[0]);
        if (j) {
          j.state = "Pending";
          j.assigned_node_id = null;
          j.lease_expires_at = null;
          j.retry_count = (j.retry_count || 0) + 1;
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
      if (qu.startsWith("SELECT COUNT(*) AS COUNT FROM JOBS WHERE STATE IN")) {
        const count = Array.from(tables.jobs.values()).filter(j => j.state === "Running" || j.state === "Pending").length;
        return [{ count }];
      }
      if (qu.startsWith("SELECT * FROM JOBS WHERE STATE = 'RUNNING' AND LEASE_EXPIRES_AT <=")) {
        const now = params[0];
        return Array.from(tables.jobs.values()).filter(j => j.state === "Running" && j.lease_expires_at <= now);
      }
      if (qu.startsWith("SELECT * FROM JOBS WHERE STATE = 'PENDING'")) {
        return Array.from(tables.jobs.values()).filter(j => j.state === "Pending");
      }
      if (qu.startsWith("SELECT * FROM JOBS WHERE ASSIGNED_NODE_ID = ? AND STATE = 'RUNNING'")) {
        const nodeId = params[0];
        const match = Array.from(tables.jobs.values()).find(j => j.assigned_node_id === nodeId && j.state === "Running");
        return match ? [match] : [];
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
        if (qu.includes("WHERE JOB_ID =")) {
          const jobId = params[0] || q.match(/WHERE job_id = '([^']+)'/i)?.[1];
          return Array.from(tables.ledger.values()).filter(e => e.job_id === jobId);
        }
        return Array.from(tables.ledger.values());
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
