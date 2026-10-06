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
    idempotency_keys: new Map(),
    device_sessions: new Map(),
    ledger: new Map(),
    node_commands: new Map(),
    audit_log: [],
    meta: new Map([["role", "PRIMARY"], ["epoch", "1"], ["fabric_status", "ACTIVE"]]),
    tenants: new Map([
      ["tenant_spaas_system", { id: "tenant_spaas_system", name: "SPaaS Global System", plan: "enterprise", balance_credits: 1000000.0, currency_balance: 10000.0, status: "ACTIVE" }],
      ["tenant_enterprise_customer", { id: "tenant_enterprise_customer", name: "Acme Distributed AI Labs", plan: "enterprise", balance_credits: 5000.0, currency_balance: 50.0, status: "ACTIVE" }],
      ["tenant_community_providers", { id: "tenant_community_providers", name: "Community Compute Providers", plan: "starter", balance_credits: 250.0, currency_balance: 2.5, status: "ACTIVE" }],
      ["tenant_competitor_b", { id: "tenant_competitor_b", name: "Competitor AI Labs", plan: "starter", balance_credits: 500.0, currency_balance: 5.0, status: "ACTIVE" }]
    ]),
    users: new Map([
      ["usr_admin", { id: "usr_admin", tenant_id: "tenant_spaas_system", email: "admin@spaas.dev", password_hash: "hash_admin_master", role: "SUPER_ADMIN", status: "ACTIVE", mfa_enabled: 1 }],
      ["usr_cust_admin", { id: "usr_cust_admin", tenant_id: "tenant_enterprise_customer", email: "customer_admin@acme.ai", password_hash: "hash_cust_admin", role: "CUSTOMER_ADMIN", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_cust_dev", { id: "usr_cust_dev", tenant_id: "tenant_enterprise_customer", email: "developer@acme.ai", password_hash: "hash_cust_dev", role: "CUSTOMER", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_provider", { id: "usr_provider", tenant_id: "tenant_community_providers", email: "provider@edge.net", password_hash: "hash_provider", role: "PROVIDER", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_ops", { id: "usr_ops", tenant_id: "tenant_spaas_system", email: "ops@spaas.dev", password_hash: "hash_ops", role: "OPS", status: "ACTIVE", mfa_enabled: 1 }],
      ["usr_security", { id: "usr_security", tenant_id: "tenant_spaas_system", email: "security@spaas.dev", password_hash: "hash_security", role: "SECURITY", status: "ACTIVE", mfa_enabled: 1 }],
      ["usr_finance", { id: "usr_finance", tenant_id: "tenant_spaas_system", email: "finance@spaas.dev", password_hash: "hash_finance", role: "FINANCE", status: "ACTIVE", mfa_enabled: 1 }],
      ["usr_support", { id: "usr_support", tenant_id: "tenant_spaas_system", email: "support@spaas.dev", password_hash: "hash_support", role: "SUPPORT", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_auditor", { id: "usr_auditor", tenant_id: "tenant_spaas_system", email: "auditor@spaas.dev", password_hash: "hash_auditor", role: "AUDITOR", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_locked", { id: "usr_locked", tenant_id: "tenant_enterprise_customer", email: "locked@acme.ai", password_hash: "hash_locked", role: "CUSTOMER", status: "LOCKED", mfa_enabled: 0 }],
      ["usr_competitor_dev", { id: "usr_competitor_dev", tenant_id: "tenant_competitor_b", email: "competitor@external.ai", password_hash: "hash_competitor", role: "CUSTOMER", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_cust_prompt", { id: "usr_cust_prompt", tenant_id: "tenant_enterprise_customer", email: "customer@acme.com", password_hash: "hash_cust_prompt", role: "CUSTOMER", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_cust_admin_prompt", { id: "usr_cust_admin_prompt", tenant_id: "tenant_enterprise_customer", email: "customer_admin@acme.com", password_hash: "hash_cust_admin_prompt", role: "CUSTOMER_ADMIN", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_provider_prompt", { id: "usr_provider_prompt", tenant_id: "tenant_community_providers", email: "provider@phonefarm.io", password_hash: "hash_provider_prompt", role: "PROVIDER", status: "ACTIVE", mfa_enabled: 0 }],
      ["usr_superadmin_prompt", { id: "usr_superadmin_prompt", tenant_id: "tenant_spaas_system", email: "superadmin@spaas.internal", password_hash: "hash_superadmin_prompt", role: "SUPER_ADMIN", status: "ACTIVE", mfa_enabled: 1 }],
      ["usr_locked_prompt", { id: "usr_locked_prompt", tenant_id: "tenant_enterprise_customer", email: "locked@acme.com", password_hash: "hash_locked_prompt", role: "CUSTOMER", status: "LOCKED", mfa_enabled: 0 }]
    ]),
    api_keys: new Map(),
    sessions: new Map(),
    invoices: new Map(),
    provider_payouts: new Map(),
    billing_config: new Map([["platform_fee_pct", "15.0"], ["min_withdrawal_credits", "50.0"], ["credit_to_usd_rate", "0.01"]])
  };

  return {
    isNative: false,
    exec(query, ...params) {
      const q = query.trim().replace(/\s+/g, " ");
      const qu = q.toUpperCase();

      if (qu.startsWith("CREATE") || qu.startsWith("ALTER TABLE")) return [];

      // META
      if (qu.startsWith("INSERT OR IGNORE INTO META") || qu.startsWith("INSERT OR REPLACE INTO META") || qu.startsWith("INSERT INTO META")) {
        const [k, v] = params;
        tables.meta.set(k, v);
        return [];
      }
      if (qu.startsWith("UPDATE META SET VALUE =")) {
        let key = "fabric_status";
        let val;
        if (params.length >= 2) {
          [val, key] = params;
        } else if (params.length === 1) {
          val = params[0];
          const m = qu.match(/WHERE KEY = '([^']+)'/i);
          if (m) key = m[1];
        } else {
          val = qu.includes("'PAUSED'") ? "PAUSED" : qu.includes("'ACTIVE'") ? "ACTIVE" : qu.includes("'DRAINING'") ? "DRAINING" : "STOPPED";
        }
        tables.meta.set(key, val);
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM META")) {
        if (qu.includes("WHERE KEY =")) {
          const k = params.length > 0 ? params[0] : (qu.match(/WHERE KEY = '([^']+)'/i)?.[1]);
          if (k && tables.meta.has(k)) {
            return [{ key: k, value: tables.meta.get(k) }];
          }
          return [];
        }
        return Array.from(tables.meta.entries()).map(([key, value]) => ({ key, value }));
      }

      // PAIRING_TOKENS
      if (qu.startsWith("INSERT INTO PAIRING_TOKENS")) {
        let token, short_code, opaque_credential, expires_at, status_unused, created_at, tenant_id, created_by;
        if (params.length >= 7) {
          [token, short_code, opaque_credential, expires_at, created_at, tenant_id, created_by] = params;
        } else if (params.length >= 5) {
          [token, short_code, opaque_credential, expires_at, status_unused, created_at] = params;
        } else {
          [token, expires_at, created_at] = params;
          short_code = token;
          opaque_credential = token;
        }
        tables.pairing_tokens.set(token, {
          token,
          short_code: short_code || token,
          opaque_credential: opaque_credential || token,
          expires_at,
          status: "Active",
          claimed_by: null,
          consumed_at: null,
          created_at: created_at || Date.now(),
          tenant_id: tenant_id || "tenant_community_providers",
          created_by: created_by || "usr_cust_dev"
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
        let id = params[0];
        let name = params[1] || "Node";
        let device_type = params[2] || "android";
        let nodeState = "Ready";
        if (qu.includes("'REVOKED'")) nodeState = "Revoked";
        else if (qu.includes("'BUSY'")) nodeState = "Busy";
        else if (qu.includes("'PAUSED'")) nodeState = "Paused";
        else if (qu.includes("'OFFLINE'")) nodeState = "Offline";

        let isSimulated = (qu.includes("'READY', 1") || qu.includes(", 1,") || qu.includes(", 1 ,")) ? 1 : 0;
        let last_heartbeat = Date.now();
        let created_at = Date.now();
        let public_key = "ed25519_pk";
        let auth_token = "spaas_auth_test";
        let capabilities = null;
        let qualification = null;
        let policy = null;
        let telemetry = null;

        const colMatch = q.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+nodes\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (colMatch) {
          const cols = colMatch[1].split(",").map(c => c.trim().toLowerCase());
          const valTokens = colMatch[2].split(",").map(v => v.trim());
          let pIdx = 0;
          const row = {};
          for (let i = 0; i < cols.length; i++) {
            const col = cols[i];
            const vToken = valTokens[i];
            if (vToken === "?") {
              row[col] = params[pIdx++];
            } else if (vToken.toUpperCase() === "NULL") {
              row[col] = null;
            } else if (vToken.startsWith("'") && vToken.endsWith("'")) {
              row[col] = vToken.slice(1, -1);
            } else if (!isNaN(Number(vToken))) {
              row[col] = Number(vToken);
            } else {
              row[col] = vToken;
            }
          }
          if (row.id !== undefined) id = row.id;
          if (row.name !== undefined) name = row.name;
          if (row.device_type !== undefined) device_type = row.device_type;
          if (row.state !== undefined) nodeState = row.state;
          if (row.is_simulated !== undefined) isSimulated = row.is_simulated;
          if (row.last_heartbeat !== undefined) last_heartbeat = row.last_heartbeat;
          if (row.created_at !== undefined) created_at = row.created_at;
          if (row.public_key !== undefined) public_key = row.public_key;
          if (row.auth_token !== undefined) auth_token = row.auth_token;
          if (row.capabilities !== undefined) capabilities = row.capabilities;
          if (row.qualification !== undefined) qualification = row.qualification;
          if (row.policy !== undefined) policy = row.policy;
          if (row.telemetry !== undefined) telemetry = row.telemetry;

          tables.nodes.set(id, {
            id,
            name,
            device_type,
            public_key,
            auth_token,
            state: nodeState,
            capabilities,
            qualification,
            policy,
            telemetry,
            is_simulated: isSimulated,
            tenant_id: row.tenant_id || "tenant_community_providers",
            version_id: 1,
            last_heartbeat,
            created_at
          });
          return [];
        }

        if (qu.includes("QUALIFICATION") && params.length === 8) {
          capabilities = params[3] || null;
          qualification = params[4] || null;
          telemetry = params[5] || null;
          last_heartbeat = params[6] || Date.now();
          created_at = params[7] || Date.now();
        } else if (params.length >= 10) {
          public_key = params[3] || "ed25519_pk";
          auth_token = params[4] || "spaas_auth_test";
          if (params.length >= 11) {
            capabilities = params[5] || null;
            qualification = params[6] || null;
            policy = params[7] || null;
            telemetry = params[8] || null;
            last_heartbeat = params[9] || Date.now();
            created_at = params[10] || Date.now();
          } else {
            capabilities = params[5] || null;
            policy = params[6] || null;
            telemetry = params[7] || null;
            last_heartbeat = params[8] || Date.now();
            created_at = params[9] || Date.now();
          }
        } else if (qu.includes("QUALIFICATION") && params.length === 9) {
          auth_token = params[2] || "spaas_auth_test";
          capabilities = params[3] || null;
          qualification = params[4] || null;
          policy = params[5] || null;
          telemetry = params[6] || null;
          last_heartbeat = params[7] || Date.now();
          created_at = params[8] || Date.now();
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

        nodeState = "Ready";
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
          version_id: 1,
          last_heartbeat,
          created_at
        });
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET LAST_HEARTBEAT")) {
        const id = params[params.length - 1];
        const last_heartbeat = params[0];
        const telemetry = params.length >= 3 ? params[1] : null;
        const n = tables.nodes.get(id);
        if (n) {
          n.last_heartbeat = last_heartbeat;
          if (telemetry !== null) n.telemetry = telemetry;
          if (n.state === "Offline") n.state = "Ready";
        }
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET STATE = 'REVOKED'")) {
        const id = params[0] || q.match(/WHERE id = '([^']+)'/i)?.[1] || q.match(/WHERE id = "([^"]+)"/i)?.[1];
        const n = tables.nodes.get(id);
        if (n) n.state = "Revoked";
        return [];
      }
      if (qu.startsWith("UPDATE NODES SET STATE = 'OFFLINE'")) {
        const id = params[0] || q.match(/WHERE id = '([^']+)'/i)?.[1] || q.match(/WHERE id = "([^"]+)"/i)?.[1];
        const n = tables.nodes.get(id);
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
        if (n) {
          if (qu.includes("STATE != 'REVOKED'") && n.state === "Revoked") return [];
          n.state = state;
          if (qu.includes("VERSION_ID =")) n.version_id = (n.version_id || 1) + 1;
        }
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
        if (qu.includes("VERSION_ID =")) {
          const [policy, version_id, id] = params;
          const n = tables.nodes.get(id);
          if (n) {
            n.policy = policy;
            n.version_id = version_id;
          }
        } else {
          const [policy, id] = params;
          const n = tables.nodes.get(id);
          if (n) {
            n.policy = policy;
            n.version_id = (n.version_id || 1) + 1;
          }
        }
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
      if (qu.startsWith("SELECT") && qu.includes("FROM NODES WHERE AUTH_TOKEN =")) {
        const token = params[0];
        const match = Array.from(tables.nodes.values()).find(n => n.auth_token === token);
        return match ? [match] : [];
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
        let id = params[0];
        let workload_id = params[1] || "workload";
        let state = qu.includes("'RUNNING'") ? "Running" : qu.includes("'COMPLETED'") ? "Completed" : "Pending";
        let assigned_node_id = null;
        let lease_term = 1;
        let lease_expires_at = null;
        let epoch = 1;
        let fencing_token = null;
        let retry_count = 0;
        let max_retries = 3;
        let scheduler_decision = null;
        let correlation_id = null;
        let version_id = 1;
        let created_at = Date.now();
        let completed_at = null;

        const colMatch = q.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+jobs\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (colMatch) {
          const cols = colMatch[1].split(",").map(c => c.trim().toLowerCase());
          const valTokens = colMatch[2].split(",").map(v => v.trim());
          let pIdx = 0;
          const row = {};
          for (let i = 0; i < cols.length; i++) {
            const col = cols[i];
            const vToken = valTokens[i];
            if (vToken === "?") {
              row[col] = params[pIdx++];
            } else if (vToken.toUpperCase() === "NULL") {
              row[col] = null;
            } else if (vToken.startsWith("'") && vToken.endsWith("'")) {
              row[col] = vToken.slice(1, -1);
            } else if (!isNaN(Number(vToken))) {
              row[col] = Number(vToken);
            } else {
              row[col] = vToken;
            }
          }
          if (row.id !== undefined) id = row.id;
          if (row.workload_id !== undefined) workload_id = row.workload_id;
          if (row.state !== undefined) state = row.state;
          if (row.assigned_node_id !== undefined) assigned_node_id = row.assigned_node_id;
          if (row.lease_term !== undefined) lease_term = row.lease_term;
          if (row.lease_expires_at !== undefined) lease_expires_at = row.lease_expires_at;
          if (row.epoch !== undefined) epoch = row.epoch;
          if (row.fencing_token !== undefined) fencing_token = row.fencing_token;
          if (row.retry_count !== undefined) retry_count = row.retry_count;
          if (row.max_retries !== undefined) max_retries = row.max_retries;
          if (row.scheduler_decision !== undefined) scheduler_decision = row.scheduler_decision;
          if (row.correlation_id !== undefined) correlation_id = row.correlation_id;
          if (row.version_id !== undefined) version_id = row.version_id;
          if (row.created_at !== undefined) created_at = row.created_at;
          if (row.completed_at !== undefined) completed_at = row.completed_at;

          tables.jobs.set(id, {
            id,
            workload_id,
            state,
            assigned_node_id,
            lease_term,
            lease_expires_at,
            epoch,
            fencing_token,
            retry_count,
            max_retries,
            result: null,
            scheduler_decision,
            correlation_id,
            tenant_id: row.tenant_id || "tenant_enterprise_customer",
            user_id: row.user_id || "usr_cust_dev",
            version_id: version_id || 1,
            created_at: created_at || Date.now(),
            completed_at
          });
          return [];
        }

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
            version_id: 1,
            created_at: cAt || Date.now(),
            completed_at: null
          });
          return [];
        }

        // Check if id is inlined or query has OFFERED
        const inlinedMatch = q.match(/VALUES\s*\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/i);
        if (inlinedMatch) {
          id = inlinedMatch[1];
          workload_id = inlinedMatch[2];
          state = inlinedMatch[3];
          assigned_node_id = params[0];
          created_at = params[1] || Date.now();
        } else if (params.length === 4 && (qu.includes("'OFFERED'") || qu.includes("OFFERED"))) {
          id = params[0];
          workload_id = params[1];
          state = "OFFERED";
          assigned_node_id = params[2];
          created_at = params[3];
        } else if (params.length === 4) {
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
          version_id: 1,
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
        const id = params[params.length - 1];
        const j = tables.jobs.get(id);
        if (j) {
          j.state = "COMPLETED";
          if (qu.includes("RESULT = ?")) {
            j.result = params[0];
          }
          if (qu.includes("COMPLETED_AT = ?")) {
            j.completed_at = params[1] || Date.now();
          }
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
          if (qu.includes("ASSIGNED_NODE_ID = ?") && params.length >= 3) {
            j.assigned_node_id = params[1];
          }
          if (qu.includes("NEXT_ACTION = ?")) {
            j.next_action = params[1];
          }
          if (qu.includes("VERSION_ID =")) {
            j.version_id = (j.version_id || 1) + 1;
          }
        }
        return [];
      }
      if (qu.startsWith("UPDATE JOBS SET WAIT_REASON =")) {
        const id = params[params.length - 1];
        const j = tables.jobs.get(id);
        if (j) {
          if (qu.includes("WAIT_REASON = NULL")) {
            j.wait_reason = null;
            j.stage_details = null;
            j.queue_status = null;
          } else {
            j.wait_reason = params[0];
            if (qu.includes("STAGE_DETAILS = ?") && params.length >= 2) {
              j.stage_details = params[1];
            }
            if (qu.includes("QUEUE_STATUS = ?") && params.length >= 3) {
              j.queue_status = params[2];
            }
          }
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
      if (qu.includes("FROM JOBS") && qu.includes("ASSIGNED_NODE_ID =") && (qu.includes("STATE = 'OFFERED'") || qu.includes('STATE = "OFFERED"'))) {
        const nodeId = params[0];
        return Array.from(tables.jobs.values()).filter(j => j.assigned_node_id === nodeId && (j.state || "").toUpperCase() === "OFFERED");
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
        let j = tables.jobs.get(id);
        if (!j) {
          j = Array.from(tables.jobs.values()).find(x => x.id === id || x.correlation_id === id);
        }
        return j ? [j] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM JOBS WHERE TENANT_ID =")) {
        const tenantId = params[0];
        return Array.from(tables.jobs.values())
          .filter(j => j.tenant_id === tenantId)
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM JOBS")) {
        return Array.from(tables.jobs.values()).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
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
        let lease_id = params[0];
        let job_id = params[1];
        let node_id = params[2];
        let fencing_token = params[3];
        let epoch = 1;
        let expires_at = Date.now() + 60000;
        let state = "ACTIVE";
        let created_at = Date.now();

        const colMatch = q.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+leases\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (colMatch) {
          const cols = colMatch[1].split(",").map(c => c.trim().toLowerCase());
          const valTokens = colMatch[2].split(",").map(v => v.trim());
          let pIdx = 0;
          const row = {};
          for (let i = 0; i < cols.length; i++) {
            const col = cols[i];
            const vToken = valTokens[i];
            if (vToken === "?") {
              row[col] = params[pIdx++];
            } else if (vToken.toUpperCase() === "NULL") {
              row[col] = null;
            } else if (vToken.startsWith("'") && vToken.endsWith("'")) {
              row[col] = vToken.slice(1, -1);
            } else if (!isNaN(Number(vToken))) {
              row[col] = Number(vToken);
            } else {
              row[col] = vToken;
            }
          }
          if (row.lease_id !== undefined) lease_id = row.lease_id;
          if (row.job_id !== undefined) job_id = row.job_id;
          if (row.node_id !== undefined) node_id = row.node_id;
          if (row.fencing_token !== undefined) fencing_token = row.fencing_token;
          if (row.epoch !== undefined) epoch = row.epoch;
          if (row.expires_at !== undefined) expires_at = row.expires_at;
          if (row.state !== undefined) state = row.state;
          if (row.created_at !== undefined) created_at = row.created_at;
        } else if (params.length === 8) {
          [lease_id, job_id, node_id, fencing_token, epoch, expires_at, state, created_at] = params;
        } else if (params.length >= 4) {
          [lease_id, job_id, node_id, fencing_token] = params;
          if (params[4] !== undefined) expires_at = params[4];
        }

        tables.leases.set(lease_id, {
          lease_id,
          job_id,
          node_id,
          fencing_token,
          epoch: epoch || 1,
          expires_at,
          state: state || "ACTIVE",
          created_at: created_at || Date.now()
        });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM LEASES WHERE JOB_ID =")) {
        const jobId = params[0];
        const fencingToken = params[1];
        let list = Array.from(tables.leases.values()).filter(l => l.job_id === jobId);
        if (fencingToken && qu.includes("FENCING_TOKEN =")) {
          list = list.filter(l => l.fencing_token === fencingToken);
        }
        if (qu.includes("ORDER BY CREATED_AT DESC")) {
          list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        } else if (qu.includes("ORDER BY CREATED_AT ASC")) {
          list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        }
        if (qu.includes("LIMIT 1")) {
          return list.slice(0, 1);
        }
        return list;
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM LEASES WHERE NODE_ID =")) {
        const nodeId = params[0];
        let list = Array.from(tables.leases.values()).filter(l => l.node_id === nodeId);
        if (qu.includes("STATE = 'ACTIVE'")) {
          list = list.filter(l => l.state === "ACTIVE");
        }
        return list;
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM LEASES WHERE LEASE_ID =")) {
        const leaseId = params[0];
        const l = tables.leases.get(leaseId);
        return l ? [l] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM LEASES WHERE STATE = 'ACTIVE'")) {
        return Array.from(tables.leases.values()).filter(l => l.state === "ACTIVE");
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM LEASES")) {
        return Array.from(tables.leases.values());
      }
      if (qu.startsWith("UPDATE LEASES SET STATE =")) {
        if (qu.includes("WHERE JOB_ID =")) {
          const st = qu.includes("'EXPIRED'") ? "EXPIRED" : (params[0] || "EXPIRED");
          const jobId = params[params.length - 1];
          for (const l of tables.leases.values()) {
            if (l.job_id === jobId && (qu.includes("STATE = 'ACTIVE'") ? l.state === "ACTIVE" : true)) {
              l.state = st;
            }
          }
          return [];
        }
        const [st, leaseId] = params.length >= 2 ? params : [qu.includes("'EXPIRED'") ? "EXPIRED" : "ACTIVE", params[0]];
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
      if (qu.startsWith("SELECT") && qu.includes("FROM DEVICE_SESSIONS")) {
        return Array.from(tables.device_sessions.values());
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

      // IDEMPOTENCY_KEYS
      if (qu.startsWith("INSERT OR REPLACE INTO IDEMPOTENCY_KEYS") || qu.startsWith("INSERT INTO IDEMPOTENCY_KEYS")) {
        let key, tenant_id, endpoint, request_hash, response_status, response_body, created_at, expires_at;
        if (params.length >= 8) {
          [key, tenant_id, endpoint, request_hash, response_status, response_body, created_at, expires_at] = params;
        } else {
          [key, endpoint, request_hash, response_status, response_body, created_at, expires_at] = params;
          tenant_id = null;
        }
        tables.idempotency_keys.set(key, {
          key,
          tenant_id,
          endpoint,
          request_hash,
          response_status: Number(response_status),
          response_body,
          created_at: Number(created_at) || Date.now(),
          expires_at: Number(expires_at) || Date.now() + 86400000
        });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM IDEMPOTENCY_KEYS WHERE KEY =")) {
        const key = params[0];
        const tenantId = params.length > 1 ? params[1] : null;
        const rec = tables.idempotency_keys.get(key);
        if (!rec) return [];
        if (tenantId && rec.tenant_id && rec.tenant_id !== tenantId) return [];
        return [rec];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM IDEMPOTENCY_KEYS")) {
        return Array.from(tables.idempotency_keys.values());
      }
      if (qu.startsWith("DELETE FROM IDEMPOTENCY_KEYS WHERE KEY =")) {
        tables.idempotency_keys.delete(params[0]);
        return [];
      }
      if (qu.startsWith("DELETE FROM IDEMPOTENCY_KEYS WHERE EXPIRES_AT <=")) {
        const thresh = Number(params[0]);
        for (const [k, v] of tables.idempotency_keys.entries()) {
          if (v.expires_at <= thresh) tables.idempotency_keys.delete(k);
        }
        return [];
      }

      // LEDGER
      if (qu.startsWith("INSERT OR IGNORE INTO LEDGER") || qu.startsWith("INSERT INTO LEDGER")) {
        let entry;
        if (qu.includes("TENANT_ID") || params.length >= 18) {
          const [id, tx_id, idempotency_key, epoch, job_id, tenant_id, entry_type, account, counterparty, consumer_pubkey, provider_pubkey, amount_credits, fuel_used, duration_ms, memory_mb, status, now, correlation_id, platform_fee_credits] = params;
          entry = {
            id,
            tx_id,
            idempotency_key,
            epoch,
            job_id,
            tenant_id: tenant_id || "tenant_enterprise_customer",
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
            correlation_id: correlation_id || null,
            platform_fee_credits: Number(platform_fee_credits) || 0
          };
        } else if (qu.includes("ENTRY_TYPE") || params.length >= 16) {
          const [id, tx_id, idempotency_key, epoch, job_id, entry_type, account, counterparty, consumer_pubkey, provider_pubkey, amount_credits, fuel_used, duration_ms, memory_mb, status, now, correlation_id] = params;
          entry = {
            id,
            tx_id,
            idempotency_key,
            epoch,
            job_id,
            tenant_id: "tenant_enterprise_customer",
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
            correlation_id: correlation_id || null,
            platform_fee_credits: 0
          };
        } else {
          const [id, idempotency_key, epoch, job_id, consumer_pubkey, provider_pubkey, amount_credits, fuel_used, duration_ms, memory_mb, now] = params;
          entry = {
            id,
            tx_id: `tx_${id}`,
            idempotency_key,
            epoch,
            job_id,
            tenant_id: "tenant_enterprise_customer",
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
            timestamp: now,
            correlation_id: null,
            platform_fee_credits: 0
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
        if (qu.includes("WHERE JOB_ID =") || qu.includes("CORRELATION_ID =")) {
          const key1 = params[0] || q.match(/WHERE job_id = '([^']+)'/i)?.[1];
          const key2 = params[1] || key1;
          entries = entries.filter(e => e.job_id === key1 || e.correlation_id === key1 || e.job_id === key2 || e.correlation_id === key2);
        }
        if (qu.includes("WHERE ACCOUNT =")) {
          const acc = params[0];
          entries = entries.filter(e => e.account === acc || e.consumer_pubkey === acc || e.provider_pubkey === acc);
        }
        if (qu.includes("WHERE TENANT_ID =") || qu.includes("WHERE TENANT_ID=?")) {
          const tid = params[0] || q.match(/WHERE tenant_id = '([^']+)'/i)?.[1];
          if (tid) entries = entries.filter(e => e.tenant_id === tid);
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

      // BILLING_CONFIG
      if (qu.includes("FROM BILLING_CONFIG WHERE KEY =")) {
        const keyMatch = q.match(/WHERE\s+key\s*=\s*'([^']+)'/i);
        const key = params[0] || (keyMatch ? keyMatch[1] : 'platform_fee_pct');
        const val = tables.billing_config.get(key) || tables.billing_config.get(key.toLowerCase());
        return val !== undefined ? [{ value: val }] : [];
      }
      if (qu.startsWith("SELECT VALUE FROM BILLING_CONFIG") || (qu.startsWith("SELECT") && qu.includes("FROM BILLING_CONFIG"))) {
        const key = params[0];
        if (key) {
          const val = tables.billing_config.get(key) || tables.billing_config.get(key.toLowerCase());
          return val !== undefined ? [{ value: val }] : [];
        }
        return Array.from(tables.billing_config.entries()).map(([key, value]) => ({ key, value }));
      }
      if (qu.includes("INTO BILLING_CONFIG") || qu.startsWith("INSERT OR REPLACE INTO BILLING_CONFIG") || qu.startsWith("INSERT OR IGNORE INTO BILLING_CONFIG")) {
        let k, v;
        if (params.length === 2) {
          [k, v] = params;
        } else if (params.length === 1) {
          const keyMatch = q.match(/VALUES\s*\(\s*'([^']+)'/i);
          k = keyMatch ? keyMatch[1] : 'platform_fee_pct';
          v = params[0];
        } else {
          const m = q.match(/VALUES\s*\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/i);
          if (m) {
            k = m[1];
            v = m[2];
          }
        }
        if (k) tables.billing_config.set(k, String(v));
        return [];
      }
      if (qu.startsWith("UPDATE BILLING_CONFIG SET VALUE =")) {
        const [val, key] = params;
        tables.billing_config.set(key, String(val));
        return [];
      }

      // USERS
      if (qu.startsWith("INSERT INTO USERS") || qu.startsWith("INSERT OR IGNORE INTO USERS")) {
        const [id, tenant_id, email, password_hash, role, status, mfa_enabled, created_at] = params;
        tables.users.set(id, { id, tenant_id, email, password_hash, role, status: status || 'ACTIVE', mfa_enabled: mfa_enabled || 0, created_at: created_at || Date.now() });
        return [];
      }
      if (qu.startsWith("SELECT") && (qu.includes("FROM USERS WHERE EMAIL =") || qu.includes("FROM USERS WHERE LOWER(EMAIL) ="))) {
        const email = (params[0] || "").toLowerCase();
        const match = Array.from(tables.users.values()).find(u => (u.email || "").toLowerCase() === email);
        return match ? [match] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM USERS WHERE ID =")) {
        const id = params[0];
        const match = tables.users.get(id);
        return match ? [match] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM USERS")) {
        return Array.from(tables.users.values());
      }

      // SESSIONS
      if (qu.startsWith("INSERT INTO SESSIONS")) {
        let token, tenant_id, user_id, role, expires_at, csrf_token, created_at;
        if (params.length >= 7) {
          [token, tenant_id, user_id, role, expires_at, csrf_token, created_at] = params;
        } else {
          [token, tenant_id, user_id, role, expires_at, created_at] = params;
        }
        tables.sessions.set(token, { token, tenant_id, user_id, role, expires_at, csrf_token: csrf_token || null, created_at: created_at || Date.now() });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM SESSIONS WHERE TOKEN =")) {
        const token = params[0];
        const sess = tables.sessions.get(token);
        if (!sess) return [];
        if (qu.includes("EXPIRES_AT >") && params.length >= 2) {
          const now = params[1];
          if (!sess.expires_at || sess.expires_at <= now) return [];
        }
        return [sess];
      }
      if (qu.startsWith("DELETE FROM SESSIONS WHERE TOKEN =")) {
        tables.sessions.delete(params[0]);
        return [];
      }

      // API KEYS
      if (qu.startsWith("INSERT INTO API_KEYS")) {
        let id, tenant_id, user_id, name, key_hash, prefix, role, scopes, status, created_at;
        if (params.length === 9) {
          [id, tenant_id, user_id, name, key_hash, prefix, role, scopes, created_at] = params;
          status = 'ACTIVE';
        } else {
          [id, tenant_id, user_id, name, key_hash, prefix, role, scopes, status, created_at] = params;
        }
        tables.api_keys.set(id, { id, tenant_id, user_id, name, key_hash, prefix, role, scopes, status: status || 'ACTIVE', created_at: created_at || Date.now(), last_used_at: null, expires_at: null });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM API_KEYS WHERE TENANT_ID =")) {
        const tenant_id = params[0];
        return Array.from(tables.api_keys.values()).filter(k => k.tenant_id === tenant_id && k.status === 'ACTIVE');
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM API_KEYS WHERE")) {
        const token = params[0];
        const match = tables.api_keys.get(token) || Array.from(tables.api_keys.values()).find(k => k.id === token || k.key_hash === token);
        return match ? [match] : [];
      }
      if (qu.startsWith("UPDATE API_KEYS SET STATUS = 'REVOKED'")) {
        const id = params[0];
        const k = tables.api_keys.get(id);
        if (k) k.status = 'REVOKED';
        return [];
      }
      if (qu.startsWith("UPDATE API_KEYS SET LAST_USED_AT =")) {
        const [last_used, id] = params;
        const k = tables.api_keys.get(id);
        if (k) k.last_used_at = last_used;
        return [];
      }

      // TENANTS
      if (qu.startsWith("SELECT * FROM TENANTS WHERE ID =")) {
        const id = params[0];
        const t = tables.tenants.get(id);
        return t ? [t] : [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM TENANTS")) {
        return Array.from(tables.tenants.values());
      }

      // INVOICES
      if (qu.startsWith("INSERT INTO INVOICES")) {
        const [id, tenant_id, amount_credits, amount_fiat, status, paid_at, created_at] = params;
        tables.invoices.set(id, { id, tenant_id, amount_credits, amount_fiat, status, paid_at, created_at });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM INVOICES")) {
        const tenant_id = params[0];
        const invs = Array.from(tables.invoices.values());
        return tenant_id ? invs.filter(i => i.tenant_id === tenant_id) : invs;
      }

      // PROVIDER PAYOUTS
      if (qu.startsWith("INSERT INTO PROVIDER_PAYOUTS")) {
        const [id, provider_id, amount_credits, amount_fiat, status, method, created_at] = params;
        tables.provider_payouts.set(id, { id, provider_id, amount_credits, amount_fiat, status, method, created_at });
        return [];
      }
      if (qu.startsWith("SELECT") && qu.includes("FROM PROVIDER_PAYOUTS")) {
        return Array.from(tables.provider_payouts.values());
      }

      return [];
    }
  };
}
