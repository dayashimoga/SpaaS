"""
Unit Tests for SPaaS Python Client SDK
"""

import unittest
from spaas_sdk import SPaaSClient, SPaaSException


class TestSPaaSClient(unittest.TestCase):
    def setUp(self):
        self.client = SPaaSClient(api_url="http://localhost:8787", token="test_token", tenant_id="tenant_enterprise_customer")

    def test_client_init(self):
        self.assertEqual(self.client.api_url, "http://localhost:8787")
        self.assertEqual(self.client.token, "test_token")
        self.assertEqual(self.client.tenant_id, "tenant_enterprise_customer")

    def test_headers_construction(self):
        headers = self.client._headers({"X-Custom": "Val"})
        self.assertEqual(headers["Authorization"], "Bearer test_token")
        self.assertEqual(headers["X-Tenant-ID"], "tenant_enterprise_customer")
        self.assertEqual(headers["X-Custom"], "Val")
        self.assertEqual(headers["Content-Type"], "application/json")

    def test_workloads_fallback(self):
        # Workloads fallback when offline returns standard catalog
        catalog = self.client.workloads()
        self.assertGreaterEqual(len(catalog), 3)
        self.assertEqual(catalog[0]["id"], "sha256_hash")

    def test_exception_properties(self):
        ex = SPaaSException("Forbidden", status_code=403, details={"error": "FORBIDDEN"})
        self.assertEqual(str(ex), "Forbidden")
        self.assertEqual(ex.status_code, 403)
        self.assertEqual(ex.details["error"], "FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
