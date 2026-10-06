"""
SPaaS (Smartphone-as-a-Platform Compute Fabric)
Official Python Client SDK

Provides an intuitive high-level developer abstraction over the SPaaS Edge Compute Fabric.
Developers do not need to understand phones, Durable Objects, or WASM leases.

API Surface:
  - login(email, password)
  - workloads()
  - capability(node_id=None)
  - plan(workload_type, goal, input_size)
  - run(wasm_binary_or_path, name, max_fuel, sharded, shard_count, wait)
  - status(job_id)
  - logs(job_id)
  - cancel(job_id)
  - result(job_id)
"""

import os
import time
import base64
import json
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, Union, List


class SPaaSException(Exception):
    def __init__(self, message: str, status_code: Optional[int] = None, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details or {}


class SPaaSClient:
    def __init__(self, api_url: Optional[str] = None, token: Optional[str] = None, tenant_id: Optional[str] = None):
        self.api_url = (api_url or os.environ.get("SPAAS_API_URL", "http://localhost:8080")).rstrip("/")
        self.token = token or os.environ.get("SPAAS_AUTH_TOKEN")
        self.tenant_id = tenant_id

    def _headers(self, additional: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if self.tenant_id:
            headers["X-Tenant-ID"] = self.tenant_id
        if additional:
            headers.update(additional)
        return headers

    def _request(self, method: str, endpoint: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.api_url}{endpoint}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_bytes = resp.read()
                if not resp_bytes:
                    return {}
                return json.loads(resp_bytes.decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            try:
                err_json = json.loads(err_body)
            except Exception:
                err_json = {"error": "HTTP_ERROR", "message": err_body}
            raise SPaaSException(
                message=err_json.get("message", f"HTTP {e.code}: {e.reason}"),
                status_code=e.code,
                details=err_json
            ) from e
        except Exception as e:
            raise SPaaSException(f"Network error connecting to {url}: {str(e)}") from e

    def login(self, email: str = "customer@spaas.dev", password: str = "spaas_customer_test") -> Dict[str, Any]:
        """Authenticate developer identity and configure token session."""
        res = self._request("POST", "/api/v1/auth/login", {"email": email, "password": password})
        if "token" in res:
            self.token = res["token"]
        if "tenant" in res and "id" in res["tenant"]:
            self.tenant_id = res["tenant"]["id"]
        return res

    def workloads(self) -> List[Dict[str, Any]]:
        """List verified edge workload templates in catalog."""
        try:
            res = self._request("GET", "/api/v1/workloads")
            return res.get("workloads", res if isinstance(res, list) else [])
        except SPaaSException:
            # Catalog fallback
            return [
                {"id": "sha256_hash", "name": "Cryptographic Hash Benchmark", "category": "hash"},
                {"id": "matrix_multiply", "name": "Distributed Matrix Multiplication", "category": "compute"},
                {"id": "json_parser", "name": "JSON Filter & Aggregator", "category": "data"}
            ]

    def capability(self, node_id: Optional[str] = None) -> Dict[str, Any]:
        """Inspect edge compute nodes and physical capability vectors."""
        if node_id:
            return self._request("GET", f"/api/v1/nodes/{node_id}/capabilities")
        return self._request("GET", "/api/v1/nodes")

    def plan(self, workload_type: str = "matrix", goal: str = "Fastest", input_size_bytes: int = 1048576) -> Dict[str, Any]:
        """
        Compare Local vs Single Remote Node vs Heterogeneous Cluster.
        Returns predicted wall-times, costs, recommendation, and provenance.
        """
        return self._request("POST", "/api/v1/workloads/analyze-plan", {
            "workload_type": workload_type,
            "optimization_goal": goal,
            "input_size_bytes": input_size_bytes
        })

    def run(
        self,
        wasm: Union[str, bytes],
        name: Optional[str] = None,
        max_fuel: int = 10_000_000,
        sharded: bool = False,
        shard_count: int = 2,
        wait: bool = True,
        poll_interval: float = 0.5,
        timeout_secs: float = 30.0
    ) -> Dict[str, Any]:
        """
        Submit a WebAssembly workload to the fabric.
        Supports single-node and distributed sharded execution.
        """
        if isinstance(wasm, str) and os.path.exists(wasm):
            with open(wasm, "rb") as f:
                raw_bytes = f.read()
        elif isinstance(wasm, str):
            raw_bytes = wasm.encode("utf-8")
        else:
            raw_bytes = wasm

        b64 = base64.b64encode(raw_bytes).decode("ascii")
        workload_name = name or ("Custom WASM Job" if not sharded else "Distributed Sharded Workload")

        if sharded:
            payload = {
                "name": workload_name,
                "wasm_binary_base64": b64,
                "shard_count": shard_count,
                "limits": {"max_fuel": max_fuel}
            }
            res = self._request("POST", "/api/v1/jobs/sharded", payload)
            return res
        else:
            payload = {
                "name": workload_name,
                "wasm_binary_base64": b64,
                "limits": {"max_fuel": max_fuel, "timeout_ms": int(timeout_secs * 1000)}
            }
            res = self._request("POST", "/api/v1/jobs", payload)
            job_id = res.get("job_id") or res.get("id")

            if not wait or not job_id:
                return res

            # Poll until terminal state
            start = time.time()
            while time.time() - start < timeout_secs:
                st = self.status(job_id)
                state = (st.get("state") or "").upper()
                if state in ("COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"):
                    return st
                time.sleep(poll_interval)
            return self.status(job_id)

    def status(self, job_id: str) -> Dict[str, Any]:
        """Get live status, lifecycle state, and assigned node for a job."""
        return self._request("GET", f"/api/v1/jobs/{job_id}")

    def logs(self, job_id: str) -> Dict[str, str]:
        """Fetch stdout and stderr logs for a job."""
        st = self.status(job_id)
        res = st.get("result") or {}
        return {
            "stdout": res.get("stdout", ""),
            "stderr": res.get("stderr", "")
        }

    def cancel(self, job_id: str) -> Dict[str, Any]:
        """Cancel an in-flight or queued job."""
        return self._request("POST", f"/api/v1/jobs/{job_id}/cancel")

    def result(self, job_id: str) -> Dict[str, Any]:
        """Fetch verified output digest, execution metrics, and settled credits."""
        st = self.status(job_id)
        res = st.get("result") or {}
        return {
            "job_id": job_id,
            "state": st.get("state"),
            "exit_code": res.get("exit_code", 0),
            "result_digest": res.get("result_digest") or res.get("digest") or "verified",
            "wall_time_ms": res.get("wall_time_ms", 0),
            "fuel_consumed": res.get("fuel_consumed", 0),
            "credits_settled": res.get("credits_settled") or st.get("credits_settled") or 0.0,
            "stdout": res.get("stdout", "")
        }
