# Cloudflare Deployment & Automation Guide

This guide explains how the SPaaS Management Console is deployed to **Cloudflare Pages** (100% Free Tier) via GitHub Actions, and how to expose your local Control Plane using **Cloudflare Tunnel** for global smartphone reachability without router port-forwarding.

---

## 1. Required GitHub Secrets

To enable automatic deployment on every push to `main`, you must create the following **2 Repository Secrets** in your GitHub repository:

| Secret Name | Value Description | Example Format |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | An API token generated in your Cloudflare profile with Pages Edit permissions | `vF8sX9..._aB3c4D` (40 chars) |
| `CLOUDFLARE_ACCOUNT_ID` | Your unique 32-character Cloudflare Account ID | `3b598d1234567890abcdef1234567890` |

---

## 2. Step-by-Step: How to Get Your Cloudflare Secrets

### A. How to Get Your `CLOUDFLARE_ACCOUNT_ID`
1. Log in to your free [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Look at your browser URL or dashboard home screen:
   - From any domain/zone overview: look in the right-hand sidebar under **API** &rarr; **Account ID**.
   - Or from the dashboard URL: `https://dash.cloudflare.com/<YOUR_ACCOUNT_ID>/workers-and-pages`.
3. Click the **Click to copy** icon next to **Account ID**.
4. Save this 32-character hexadecimal string as `CLOUDFLARE_ACCOUNT_ID`.

---

### B. How to Create Your `CLOUDFLARE_API_TOKEN`
1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) (or click your User Icon &rarr; **My Profile** &rarr; **API Tokens**).
2. Click **Create Token**.
3. Scroll down to the **Create Custom Token** section and click **Get started**.
4. Configure the token:
   * **Token name:** `SPaaS GitHub Actions Pages Deploy`
   * **Permissions:**
     * `Account` &rarr; `Cloudflare Pages` &rarr; `Edit`
   * **Account Resources:**
     * `Include` &rarr; `All accounts` (or select your specific account)
   * **TTL (Optional):** Leave blank for permanent or set desired expiration.
5. Click **Continue to summary** at the bottom.
6. Click **Create Token**.
7. **Copy your token immediately** (Cloudflare will only display it once). Save this as `CLOUDFLARE_API_TOKEN`.

---

### C. How to Add These Secrets to Your GitHub Repository
1. Navigate to your GitHub repository: [`https://github.com/dayashimoga/SpaaS`](https://github.com/dayashimoga/SpaaS).
2. Click **Settings** (tab at the top right of the repo).
3. In the left sidebar, expand **Secrets and variables** &rarr; click **Actions**.
4. Under **Repository secrets**, click the green button **New repository secret**:
   * **Name:** `CLOUDFLARE_API_TOKEN`
   * **Secret:** Paste the token copied in Step B.
   * Click **Add secret**.
5. Click **New repository secret** again:
   * **Name:** `CLOUDFLARE_ACCOUNT_ID`
   * **Secret:** Paste the account ID copied in Step A.
   * Click **Add secret**.

Once both secrets are saved, every subsequent push to the `main` branch will build and deploy the Web Console directly to Cloudflare Pages!

---

## 3. How the Automated GitHub Actions Workflow Works

In `.github/workflows/ci.yml`, the `web-console-build` job automatically triggers:

```yaml
      - name: Deploy to Cloudflare Pages
        if: github.ref == 'refs/heads/main' && env.CLOUDFLARE_API_TOKEN != ''
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: spaas-console
          directory: apps/web-console/dist
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

Your web console will be live at:
**`https://spaas-console.pages.dev`** (with free SSL, instant global edge routing, and unlimited bandwidth).

---

## 4. Connecting the Physical Phone & Cloudflare Pages via Cloudflare Tunnel (100% Free)

Because home Wi-Fi routers (especially Guest Wi-Fi like `TP-Link_Guest`) block local device-to-device communication via **AP Isolation**, Cloudflare Tunnel provides an ideal, production-grade zero-trust solution:

```
[ Android Smartphone ] ──(HTTPS/WSS)──> [ Cloudflare Global Edge ] ──(Tunnel)──> [ Local Control Plane (8080) ]
```

### Quick 1-Command Tunnel Setup (No Domain Required)
Download and run the free `cloudflared` CLI on your PC:
```bash
# Windows (via winget or direct binary)
winget install Cloudflare.cloudflared

# Launch an instant public HTTPS tunnel to port 8080:
cloudflared tunnel --url http://127.0.0.1:8080
```
This generates a temporary public HTTPS URL (e.g. `https://random-subdomain.trycloudflare.com`).

* Enter this URL into your Android app or scan the QR code.
* The phone connects securely over Wi-Fi, 4G, or 5G, bypassing all local router firewall / Guest Wi-Fi isolation restrictions!
