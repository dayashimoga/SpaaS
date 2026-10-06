import test from 'node:test';
import assert from 'node:assert/strict';
import { SPaaSClient, SPaaSException } from './spaas-sdk.js';

test('SPaaS JavaScript SDK — Client Initialization & Config', () => {
  const client = new SPaaSClient({
    apiUrl: 'http://localhost:8787/',
    token: 'test_token',
    tenantId: 'tenant_enterprise_customer'
  });

  assert.equal(client.apiUrl, 'http://localhost:8787');
  assert.equal(client.token, 'test_token');
  assert.equal(client.tenantId, 'tenant_enterprise_customer');

  const headers = client._headers({ 'X-Custom': 'val' });
  assert.equal(headers['Authorization'], 'Bearer test_token');
  assert.equal(headers['X-Tenant-ID'], 'tenant_enterprise_customer');
  assert.equal(headers['X-Custom'], 'val');
});

test('SPaaS JavaScript SDK — Fallback Workload Catalog', async () => {
  const client = new SPaaSClient({ apiUrl: 'http://127.0.0.1:9999' }); // non-existent port
  const catalog = await client.workloads();
  assert.ok(Array.isArray(catalog));
  assert.ok(catalog.length >= 3);
  assert.equal(catalog[0].id, 'sha256_hash');
});

test('SPaaS JavaScript SDK — Exception Handling', () => {
  const ex = new SPaaSException('Forbidden Action', 403, { error: 'FORBIDDEN' });
  assert.equal(ex.message, 'Forbidden Action');
  assert.equal(ex.statusCode, 403);
  assert.equal(ex.details.error, 'FORBIDDEN');
});
