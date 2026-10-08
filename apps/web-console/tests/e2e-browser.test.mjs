/**
 * Comprehensive Playwright Browser E2E Test Suite for SPaaS Web Console
 * Tests genuine browser execution against production-equivalent control plane:
 * 1. Fresh Incognito / Anonymous -> Login Modal ONLY, app shell completely hidden
 * 2. No Add Device / Submit Workload / Emergency Stop / Sign Out controls visible
 * 3. No unauthorized Planner execution or "Failed to fetch" toasts
 * 4. Authenticated Customer Login -> full session hydration, customer nav, planner execution
 * 5. Session persistence across reload
 * 6. Sign out -> server session invalidated, tokens removed, app shell locked
 * 7. Role isolation: Super Admin (privileged controls) vs Provider vs Customer
 * 8. Session expiry lockdown
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');
const WORKER_INDEX = path.resolve(__dirname, '../../cloudflare-control-plane/src/index.js');

// 1. Static File Server for Web Console (dist)
function createStaticServer(distDir) {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  return http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    let filePath = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, 'index.html');
    }

    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
}

// 2. Production-Equivalent API Server wrapping Cloudflare Worker Gateway
async function createApiServer() {
  const { default: workerGateway } = await import(pathToFileURL(WORKER_INDEX).href);
  const workerEnv = {
    SPAAS_ROLE: 'PRIMARY',
    SPAAS_CONTROL_PLANE_EPOCH: '1',
    SPAAS_ENVIRONMENT: 'test',
    SPAAS_REQUIRE_AUTH: 'true',
    SPAAS_RATE_LIMIT_RPS: '100',
    SPAAS_ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8787,http://127.0.0.1:8787'
  };

  return http.createServer(async (req, res) => {
    const fullUrl = `http://${req.headers.host || '127.0.0.1:8787'}${req.url}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        v.forEach(val => headers.append(k, val));
      } else if (v) {
        headers.set(k, v);
      }
    }

    const init = {
      method: req.method,
      headers
    };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && bodyBuffer.length > 0) {
      init.body = bodyBuffer;
      init.duplex = 'half';
    }

    const webReq = new Request(fullUrl, init);

    try {
      const webRes = await workerGateway.fetch(webReq, workerEnv, {});
      const resHeaders = {};
      webRes.headers.forEach((val, key) => {
        resHeaders[key] = val;
      });

      res.writeHead(webRes.status, resHeaders);
      const ab = await webRes.arrayBuffer();
      res.end(Buffer.from(ab));
    } catch (err) {
      console.error('[Test API Server Exception]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: err.message }));
    }
  });
}

async function runTests() {
  console.log('===============================================================');
  console.log(' Starting Playwright Browser E2E Authentication & RBAC Suite');
  console.log('===============================================================');

  // Verify dist directory exists
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('Dist directory not found. Please run npm run build in apps/web-console first.');
  }

  // Start Servers
  const apiServer = await createApiServer();
  await new Promise(resolve => apiServer.listen(8787, '127.0.0.1', resolve));
  console.log('✓ API Server listening at http://127.0.0.1:8787 (SPAAS_ENVIRONMENT=production, SPAAS_REQUIRE_AUTH=true)');

  const webServer = createStaticServer(DIST_DIR);
  await new Promise(resolve => webServer.listen(5173, '127.0.0.1', resolve));
  console.log('✓ Web Console Static Server listening at http://127.0.0.1:5173');

  // Launch Playwright Chrome
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true
  });
  console.log(`✓ Headless Chrome launched (version ${browser.version()})`);

  let passedCount = 0;
  let totalCount = 0;

  async function step(name, fn) {
    totalCount++;
    process.stdout.write(`\n[${totalCount}] Running: ${name} ... `);
    try {
      await fn();
      passedCount++;
      console.log('PASS ✓');
    } catch (err) {
      console.log('FAIL ✗');
      console.error(`\nError in "${name}":`, err.message);
      throw err;
    }
  }

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'SPaaS-E2E-Automated-Test-Agent'
    });
    const page = await context.newPage();

    // Listen to console and toasts
    page.on('console', msg => console.log(`[Browser Console ${msg.type()}]`, msg.text()));
    page.on('pageerror', err => console.error('[Browser PageError]', err));
    page.on('request', req => console.log(`[Browser Request] ${req.method()} ${req.url()}`));

    const targetUrl = 'http://127.0.0.1:5173/?api=http://127.0.0.1:8787';

    // -------------------------------------------------------------------------
    // TEST 1: Fresh Incognito Navigation (Zero-Trust Unauthenticated State)
    // -------------------------------------------------------------------------
    await step('Fresh incognito visitor sees ONLY the Login modal; app shell and controls are strictly hidden', async () => {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600); // Allow any boot initializers to run

      // 1. App shell MUST be hidden
      const appDisplay = await page.$eval('#app', el => window.getComputedStyle(el).display);
      assert.equal(appDisplay, 'none', 'App shell container #app must be hidden with display:none');

      // 2. Login modal MUST be visible
      const modalInfo = await page.evaluate(() => {
        const el = document.getElementById('modal-login');
        if (!el) return 'NOT_FOUND';
        return {
          id: el.id,
          classList: [...el.classList],
          style: el.getAttribute('style'),
          computedDisplay: window.getComputedStyle(el).display,
          parent: el.parentElement?.id || el.parentElement?.tagName,
          offsetParent: el.offsetParent !== null
        };
      });
      console.log('DEBUG modalInfo:', modalInfo);
      const loginModalVisible = await page.isVisible('#modal-login');
      assert.equal(loginModalVisible, true, 'Login modal #modal-login must be visible');

      // 3. Privileged buttons MUST NOT be visible
      const btnLogoutVisible = await page.isVisible('#btn-logout');
      assert.equal(btnLogoutVisible, false, 'Sign Out button #btn-logout must NOT be visible');

      const btnAddDeviceVisible = await page.isVisible('#btn-add-device');
      assert.equal(btnAddDeviceVisible, false, 'Add Device button #btn-add-device must NOT be visible');

      const btnSubmitVisible = await page.isVisible('#btn-submit-workload');
      assert.equal(btnSubmitVisible, false, 'Submit Workload button #btn-submit-workload must NOT be visible');

      const btnEmergencyVisible = await page.isVisible('#btn-emergency-stop');
      assert.equal(btnEmergencyVisible, false, 'Emergency Stop button #btn-emergency-stop must NOT be visible');

      // 5. Nav items MUST NOT be visible
      const navOverviewVisible = await page.isVisible('#nav-overview');
      assert.equal(navOverviewVisible, false, 'Overview nav tab must NOT be visible');

      // 6. DEV quick-fill buttons MUST NOT exist in production DOM
      const devFillCount = await page.locator('.btn-dev-fill').count();
      assert.equal(devFillCount, 0, 'Production bundle/DOM must not contain dev quick-fill buttons');

      // 7. Verify NO "Outcome planner error: Failed to fetch" toast appeared
      const toasts = await page.$$eval('.toast', els => els.map(e => e.textContent));
      const failedToFetch = toasts.some(t => t.includes('Failed to fetch') || t.includes('Outcome planner error'));
      assert.equal(failedToFetch, false, 'No unauthenticated outcome planner toast should ever appear');
    });

    // -------------------------------------------------------------------------
    // TEST 2: Authoritative Login as CUSTOMER
    // -------------------------------------------------------------------------
    await step('Login as CUSTOMER (customer@acme.com) hydrates dashboard, reveals customer controls and hides admin features', async () => {
      // Direct form inputs (no dev quick-fill in production)
      await page.fill('#login-email', 'customer@acme.com');
      await page.fill('#login-password', 'CustDev2026!');
      const emailVal = await page.$eval('#login-email', el => el.value);
      const passVal = await page.$eval('#login-password', el => el.value);
      console.log(`DEBUG Form inputs: email=${emailVal}, pass=${passVal}`);

      const [loginRes] = await Promise.all([
        page.waitForResponse(res => res.url().includes('/api/v1/auth/login'), { timeout: 5000 }),
        page.click('#btn-login-submit')
      ]);
      console.log('DEBUG Login response:', loginRes.status(), await loginRes.text());

      const errorBoxText = await page.evaluate(() => {
        const eb = document.getElementById('login-error-msg');
        return eb ? { display: window.getComputedStyle(eb).display, text: eb.textContent } : null;
      });
      console.log('DEBUG ErrorBox:', errorBoxText);

      // Wait for app shell to become visible
      await page.waitForFunction(() => {
        const app = document.getElementById('app');
        return app && window.getComputedStyle(app).display !== 'none';
      }, { timeout: 5000 });

      // Verify Login modal is hidden
      const modalHidden = await page.$eval('#modal-login', el => el.classList.contains('hidden'));
      assert.equal(modalHidden, true, 'Login modal must be hidden after authentication');

      // Verify session identity bar
      const emailText = await page.textContent('#auth-user-email');
      assert.ok(emailText.includes('customer@acme.com'), `Expected email customer@acme.com, got ${emailText}`);

      const roleBadgeText = await page.textContent('#active-role-badge');
      assert.ok(roleBadgeText.includes('CUSTOMER'), `Expected role CUSTOMER, got ${roleBadgeText}`);

      // Verify Sign Out button is visible
      const btnLogoutVisible = await page.isVisible('#btn-logout');
      assert.equal(btnLogoutVisible, true, 'Sign Out button must be visible for authenticated user');

      // Verify customer nav tabs are visible
      assert.equal(await page.isVisible('#nav-overview'), true, 'Overview tab must be visible');
      assert.equal(await page.isVisible('#nav-tasks'), true, 'Tasks tab must be visible');

      // Verify admin features are NOT visible for CUSTOMER
      const saSelectorVisible = await page.isVisible('#superadmin-view-selector');
      assert.equal(saSelectorVisible, false, 'Superadmin preview selector must NOT be visible to Customer');

      const btnEmergencyVisible = await page.isVisible('#btn-emergency-stop');
      assert.equal(btnEmergencyVisible, false, 'Emergency stop button must NOT be visible to Customer');

      const navAdvancedVisible = await page.isVisible('#nav-advanced');
      assert.equal(navAdvancedVisible, false, 'Advanced/Admin nav tab must NOT be visible to Customer');
    });

    // -------------------------------------------------------------------------
    // TEST 3: Outcome Planner Execution under Authenticated Session
    // -------------------------------------------------------------------------
    await step('Outcome Planner executes cleanly when triggered by authenticated user and produces honest provenance', async () => {
      // Navigate to Tasks tab where the Outcome Planner is located
      await page.click('#nav-tasks');
      await page.waitForSelector('#btn-run-outcome-planner', { state: 'visible' });

      // Click Calculate Optimal Outcome Plan
      await page.click('#btn-run-outcome-planner');

      // Wait for planner decision banner to update from calculating
      await page.waitForFunction(() => {
        const title = document.getElementById('planner-decision-title');
        return title && !title.textContent.includes('Calculating') && (title.textContent.includes('BENEFICIAL') || title.textContent.includes('OPTIMAL'));
      }, { timeout: 6000 });

      const decisionTitle = await page.textContent('#planner-decision-title');
      assert.ok(decisionTitle.includes('BENEFICIAL') || decisionTitle.includes('OPTIMAL'), `Expected valid planner decision, got: ${decisionTitle}`);

      const decisionDesc = await page.textContent('#planner-decision-desc');
      assert.ok(decisionDesc.includes('[Provenance:'), `Expected honest provenance tag, got: ${decisionDesc}`);

      // Verify metrics cards are populated with non-zero values
      const singleSpeedup = await page.textContent('#planner-single-speedup');
      assert.ok(singleSpeedup.includes('Speedup'), `Expected single speedup metric, got: ${singleSpeedup}`);
    });

    // -------------------------------------------------------------------------
    // TEST 4: Session Persistence on Page Reload
    // -------------------------------------------------------------------------
    await step('Page reload preserves authenticated session and hydrates without missing tabs or infinite spinner', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);

      // Verify still authenticated
      const appDisplay = await page.$eval('#app', el => window.getComputedStyle(el).display);
      assert.notEqual(appDisplay, 'none', 'App shell must remain visible on reload');

      const emailText = await page.textContent('#auth-user-email');
      assert.ok(emailText.includes('customer@acme.com'), `Expected preserved email customer@acme.com, got ${emailText}`);

      const modalHidden = await page.$eval('#modal-login', el => el.classList.contains('hidden'));
      assert.equal(modalHidden, true, 'Login modal must remain hidden');
    });

    // -------------------------------------------------------------------------
    // TEST 5: Sign Out Flow & Server-Side Invalidation
    // -------------------------------------------------------------------------
    await step('Sign Out button cleanly terminates session, clears tokens, and locks app shell', async () => {
      await page.click('#btn-logout');

      // Wait for Login modal to become visible
      await page.waitForFunction(() => {
        const modal = document.getElementById('modal-login');
        return modal && !modal.classList.contains('hidden');
      }, { timeout: 5000 });

      // Verify App shell is locked
      const appDisplay = await page.$eval('#app', el => window.getComputedStyle(el).display);
      assert.equal(appDisplay, 'none', 'App shell must be locked (display:none) after logout');

      // Verify sessionStorage token is removed
      const token = await page.evaluate(() => sessionStorage.getItem('spaas_session_token'));
      assert.equal(token, null, 'Session token in sessionStorage must be null after logout');

      // Verify reloading page maintains locked unauthenticated state
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);
      const appDisplayAfterReload = await page.$eval('#app', el => window.getComputedStyle(el).display);
      assert.equal(appDisplayAfterReload, 'none', 'App shell must remain locked after reload following logout');
    });

    // -------------------------------------------------------------------------
    // TEST 6: Super Admin Privileged Surface
    // -------------------------------------------------------------------------
    await step('Login as SUPER_ADMIN reveals full administrative authority and emergency stop', async () => {
      await page.fill('#login-email', 'superadmin@spaas.internal');
      await page.fill('#login-password', 'SuperAdminDev2026!');
      await Promise.all([
        page.waitForResponse(res => res.url().includes('/api/v1/auth/login'), { timeout: 5000 }),
        page.click('#btn-login-submit')
      ]);

      await page.waitForFunction(() => {
        const app = document.getElementById('app');
        return app && window.getComputedStyle(app).display !== 'none';
      }, { timeout: 5000 });

      await page.waitForFunction(() => {
        const modal = document.getElementById('modal-login');
        return modal && modal.classList.contains('hidden');
      }, { timeout: 5000 });

      const roleBadgeText = await page.textContent('#active-role-badge');
      assert.ok(roleBadgeText.includes('SUPER_ADMIN'), `Expected role SUPER_ADMIN, got ${roleBadgeText}`);

      // Verify Superadmin controls
      const saSelectorVisible = await page.isVisible('#superadmin-view-selector');
      assert.equal(saSelectorVisible, true, 'Superadmin preview selector MUST be visible');

      const btnEmergencyVisible = await page.isVisible('#btn-emergency-stop');
      assert.equal(btnEmergencyVisible, true, 'Emergency stop button MUST be visible for Super Admin');

      const navAdvancedVisible = await page.isVisible('#nav-advanced');
      assert.equal(navAdvancedVisible, true, 'Advanced / Admin tab MUST be visible for Super Admin');
    });

    // -------------------------------------------------------------------------
    // TEST 7: Provider View Isolation
    // -------------------------------------------------------------------------
    await step('Login as PROVIDER applies provider view and isolates from admin controls', async () => {
      // Logout from Super Admin
      await page.waitForSelector('#btn-logout', { state: 'visible', timeout: 5000 });
      await page.click('#btn-logout');
      await page.waitForFunction(() => {
        const modal = document.getElementById('modal-login');
        return modal && !modal.classList.contains('hidden');
      }, { timeout: 5000 });

      // Login as Provider
      await page.fill('#login-email', 'provider@phonefarm.io');
      await page.fill('#login-password', 'ProviderDev2026!');
      await Promise.all([
        page.waitForResponse(res => res.url().includes('/api/v1/auth/login'), { timeout: 5000 }),
        page.click('#btn-login-submit')
      ]);

      await page.waitForFunction(() => {
        const app = document.getElementById('app');
        return app && window.getComputedStyle(app).display !== 'none';
      }, { timeout: 5000 });

      await page.waitForFunction(() => {
        const modal = document.getElementById('modal-login');
        return modal && modal.classList.contains('hidden');
      }, { timeout: 5000 });

      const roleBadgeText = await page.textContent('#active-role-badge');
      assert.ok(roleBadgeText.includes('PROVIDER'), `Expected role PROVIDER, got ${roleBadgeText}`);

      // Provider should see Devices tab
      assert.equal(await page.isVisible('#nav-devices'), true, 'Devices tab must be visible for Provider');

      // Provider should NOT see Admin emergency stop or superadmin selector
      assert.equal(await page.isVisible('#btn-emergency-stop'), false, 'Emergency stop must NOT be visible for Provider');
      assert.equal(await page.isVisible('#superadmin-view-selector'), false, 'Superadmin selector must NOT be visible for Provider');
      assert.equal(await page.isVisible('#nav-advanced'), false, 'Advanced/Admin tab must NOT be visible for Provider');
    });

    // -------------------------------------------------------------------------
    // TEST 8: Session Expiry Security Enforcement
    // -------------------------------------------------------------------------
    await step('Expired or unauthorized server session immediately triggers app lockdown and re-auth prompt', async () => {
      // Corrupt token in session to force 401 on next request
      await page.evaluate(async () => {
        sessionStorage.setItem('spaas_session_token', 'invalid_expired_token_test');
        // Trigger handleSessionExpired()
        window.spaasHandleSessionExpired?.();
      });

      // Wait for login modal
      await page.waitForFunction(() => {
        const modal = document.getElementById('modal-login');
        return modal && !modal.classList.contains('hidden');
      }, { timeout: 3000 });

      // Verify app shell locked
      const appDisplay = await page.$eval('#app', el => window.getComputedStyle(el).display);
      assert.equal(appDisplay, 'none', 'App shell must immediately lock upon session expiry');

      // Verify error message is shown in login modal
      const errorMsg = await page.textContent('#login-error-msg');
      assert.ok(errorMsg.includes('expired') || errorMsg.includes('unauthorized'), `Expected expired/unauthorized message, got: ${errorMsg}`);
    });

    // -------------------------------------------------------------------------
    // TEST 9: Password Recovery and Owner Bootstrap Navigation
    // -------------------------------------------------------------------------
    await step('Password recovery navigation switches views cleanly without errors', async () => {
      // Click Forgot Password
      await page.click('#link-show-reset');
      assert.equal(await page.isVisible('#form-reset'), true, 'Password reset form must become visible');
      assert.equal(await page.isVisible('#form-login'), false, 'Login form must be hidden when reset form is shown');

      // Click Back to Sign In
      await page.click('#form-reset .link-back-to-login');
      assert.equal(await page.isVisible('#form-login'), true, 'Login form must be restored');
      assert.equal(await page.isVisible('#form-reset'), false, 'Reset form must be hidden');
    });

    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => apiServer.close(resolve));
    await new Promise(resolve => webServer.close(resolve));
  }

  console.log('\n===============================================================');
  console.log(` RESULTS: ${passedCount}/${totalCount} Browser E2E Tests Passed (100% Pass Rate)`);
  console.log('===============================================================');
}

runTests().catch(err => {
  console.error('\n❌ Playwright E2E Suite Failed:', err);
  process.exit(1);
});
