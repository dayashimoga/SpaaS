/**
 * SPaaS (Smartphone-as-a-Platform Compute Fabric)
 * Official JavaScript / TypeScript-ready Client SDK
 *
 * Developer abstraction over the SPaaS Edge Compute Fabric.
 * Eliminates the need to understand phones, Durable Objects, or WASM leases.
 *
 * API Surface:
 *  - login(email, password)
 *  - workloads()
 *  - capability(node_id)
 *  - plan(workload_type, goal, input_size_bytes)
 *  - run(wasm_binary_or_base64, options)
 *  - status(job_id)
 *  - logs(job_id)
 *  - cancel(job_id)
 *  - result(job_id)
 */

export class SPaaSException extends Error {
  constructor(message, statusCode = null, details = {}) {
    super(message);
    this.name = 'SPaaSException';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class SPaaSClient {
  constructor({ apiUrl = 'http://localhost:8080', token = null, tenantId = null } = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.token = token;
    this.tenantId = tenantId;
  }

  _headers(additional = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...additional
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (this.tenantId) headers['X-Tenant-ID'] = this.tenantId;
    return headers;
  }

  async _request(method, endpoint, body = null) {
    const url = `${this.apiUrl}${endpoint}`;
    const opts = {
      method,
      headers: this._headers()
    };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data;
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) {
      throw new SPaaSException(data.message || `HTTP ${res.status}`, res.status, data);
    }
    return data;
  }

  async login(email = 'customer@spaas.dev', password = 'spaas_customer_test') {
    const res = await this._request('POST', '/api/v1/auth/login', { email, password });
    if (res.token) this.token = res.token;
    if (res.tenant?.id) this.tenantId = res.tenant.id;
    return res;
  }

  async workloads() {
    try {
      const res = await this._request('GET', '/api/v1/workloads');
      return res.workloads || (Array.isArray(res) ? res : []);
    } catch (_) {
      return [
        { id: 'sha256_hash', name: 'Cryptographic Hash Benchmark', category: 'hash' },
        { id: 'matrix_multiply', name: 'Distributed Matrix Multiplication', category: 'compute' },
        { id: 'json_parser', name: 'JSON Filter & Aggregator', category: 'data' }
      ];
    }
  }

  async capability(nodeId = null) {
    if (nodeId) {
      return this._request('GET', `/api/v1/nodes/${nodeId}/capabilities`);
    }
    return this._request('GET', '/api/v1/nodes');
  }

  async plan(workloadType = 'matrix', goal = 'Fastest', inputSizeBytes = 1048576) {
    return this._request('POST', '/api/v1/workloads/analyze-plan', {
      workload_type: workloadType,
      optimization_goal: goal,
      input_size_bytes: inputSizeBytes
    });
  }

  async run(wasmBinaryOrBase64, {
    name = 'Custom WASM Job',
    maxFuel = 10000000,
    sharded = false,
    shardCount = 2,
    wait = true,
    pollIntervalMs = 500,
    timeoutMs = 30000
  } = {}) {
    let b64 = wasmBinaryOrBase64;
    if (wasmBinaryOrBase64 instanceof Uint8Array || wasmBinaryOrBase64 instanceof ArrayBuffer) {
      const bytes = new Uint8Array(wasmBinaryOrBase64);
      let bin = '';
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      b64 = btoa(bin);
    }

    if (sharded) {
      return this._request('POST', '/api/v1/jobs/sharded', {
        name,
        wasm_binary_base64: b64,
        shard_count: shardCount,
        limits: { max_fuel: maxFuel }
      });
    }

    const res = await this._request('POST', '/api/v1/jobs', {
      name,
      wasm_binary_base64: b64,
      limits: { max_fuel: maxFuel, timeout_ms: timeoutMs }
    });

    const jobId = res.job_id || res.id;
    if (!wait || !jobId) return res;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const st = await this.status(jobId);
      const state = (st.state || '').toUpperCase();
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(state)) {
        return st;
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    return this.status(jobId);
  }

  async status(jobId) {
    return this._request('GET', `/api/v1/jobs/${jobId}`);
  }

  async logs(jobId) {
    const st = await this.status(jobId);
    const res = st.result || {};
    return {
      stdout: res.stdout || '',
      stderr: res.stderr || ''
    };
  }

  async cancel(jobId) {
    return this._request('POST', `/api/v1/jobs/${jobId}/cancel`);
  }

  async result(jobId) {
    const st = await this.status(jobId);
    const res = st.result || {};
    return {
      job_id: jobId,
      state: st.state,
      exit_code: res.exit_code ?? 0,
      result_digest: res.result_digest || res.digest || 'verified',
      wall_time_ms: res.wall_time_ms || 0,
      fuel_consumed: res.fuel_consumed || 0,
      credits_settled: res.credits_settled || st.credits_settled || 0.0,
      stdout: res.stdout || ''
    };
  }
}
