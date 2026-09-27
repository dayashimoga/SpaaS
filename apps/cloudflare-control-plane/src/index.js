/**
 * SPaaS Universal Edge Compute Fabric — Primary Cloudflare Worker
 * Public Ingress Gateway & Durable Object Dispatcher
 */

export { SPaaSCoordinator } from "./coordinator.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS Pre-flight Options
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Baggage, Sentry-Trace",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // 2. APK Download Endpoints & Metadata
    if (url.pathname === "/app-debug.apk" || url.pathname.startsWith("/downloads/")) {
      // In production, Worker can stream from R2 bucket or redirect to GitHub Releases
      const apkName = "SPaaS-Node-v0.1.0.apk";
      if (url.pathname.endsWith(".apk")) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": `https://github.com/spaas-edge/spaas/releases/latest/download/${apkName}`,
            "Content-Disposition": `attachment; filename="${apkName}"`,
            "Content-Type": "application/vnd.android.package-archive"
          }
        });
      }
    }

    if (url.pathname === "/api/v1/downloads/apk-info") {
      return new Response(
        JSON.stringify({
          version: "0.1.0",
          package_name: "dev.spaas.node",
          apk_filename: "SPaaS-Node-v0.1.0.apk",
          target_sdk: 34,
          min_sdk: 29,
          download_url: "/downloads/SPaaS-Node-v0.1.0.apk"
        }),
        {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        }
      );
    }

    // 3. Routing to Coordinator Durable Object
    if (!env?.COORDINATOR) {
      // Standalone mode / local fallback mock
      const { SPaaSCoordinator } = await import("./coordinator.js");
      if (!globalThis._mockCoordinator) {
        globalThis._mockCoordinator = new SPaaSCoordinator(null, env);
      }
      const response = await globalThis._mockCoordinator.fetch(request);
      return addCorsHeaders(response);
    }

    // Forward request to partitioned DO cluster
    const clusterName = url.searchParams.get("cluster") || "spaas-primary-fabric";
    const doId = env.COORDINATOR.idFromName(clusterName);
    const stub = env.COORDINATOR.get(doId);

    const response = await stub.fetch(request);
    return addCorsHeaders(response);
  }
};

function addCorsHeaders(res) {
  const newHeaders = new Headers(res.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders
  });
}
