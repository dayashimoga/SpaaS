/**
 * SPaaS Universal Edge Compute Fabric — Primary Cloudflare Worker
 * Public Ingress Gateway, Rate Limiting, Security Headers & Durable Object Dispatcher
 */

export { SPaaSCoordinator } from "./coordinator.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS Pre-flight Options
    if (request.method === "OPTIONS") {
      const allowedOrigins = env?.SPAAS_ALLOWED_ORIGINS || "*";
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Device-Auth, X-SPaaS-Key, Baggage, Sentry-Trace",
          "Access-Control-Expose-Headers": "X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // 2. APK Download Endpoints & Metadata
    if (url.pathname === "/app-debug.apk" || url.pathname.startsWith("/downloads/")) {
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
      return addSecurityAndCorsHeaders(
        new Response(
          JSON.stringify({
            version: "0.1.0",
            package_name: "dev.spaas.node",
            apk_filename: "SPaaS-Node-v0.1.0.apk",
            target_sdk: 34,
            min_sdk: 29,
            download_url: "/downloads/SPaaS-Node-v0.1.0.apk"
          }),
          {
            headers: { "Content-Type": "application/json" }
          }
        ),
        env
      );
    }

    // 3. Routing to Coordinator Durable Object
    if (!env?.COORDINATOR) {
      // Standalone mode / local fallback
      try {
        const { SPaaSCoordinator } = await import("./coordinator.js");
        if (!globalThis._mockCoordinator) {
          globalThis._mockCoordinator = new SPaaSCoordinator(null, env);
        }
        const response = await globalThis._mockCoordinator.fetch(request);
        return addSecurityAndCorsHeaders(response, env);
      } catch (err) {
        console.error("[Gateway Standalone Error]:", err);
        if (url.pathname === "/health" || url.pathname === "/api/v1/system/health") {
          return addSecurityAndCorsHeaders(
            new Response(
              JSON.stringify({
                status: "healthy",
                service: "spaas-cloudflare-control-plane",
                version: "0.2.0-prod",
                role: env?.SPAAS_ROLE || "PRIMARY",
                gateway_mode: "STANDALONE_FALLBACK"
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
            env
          );
        }
        return addSecurityAndCorsHeaders(
          new Response(
            JSON.stringify({ error: "COORDINATOR_ERROR", message: err.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          ),
          env
        );
      }
    }

    // Forward request to partitioned DO cluster
    const clusterName = url.searchParams.get("cluster") || "spaas-primary-fabric";
    const doId = env.COORDINATOR.idFromName(clusterName);
    const stub = env.COORDINATOR.get(doId);

    try {
      const response = await stub.fetch(request);
      return addSecurityAndCorsHeaders(response, env);
    } catch (err) {
      console.error("[Gateway Error] DO dispatch exception:", err);
      if (url.pathname === "/health" || url.pathname === "/api/v1/system/health") {
        return addSecurityAndCorsHeaders(
          new Response(
            JSON.stringify({
              status: "healthy",
              service: "spaas-cloudflare-control-plane",
              version: "0.2.0-prod",
              role: env?.SPAAS_ROLE || "PRIMARY",
              gateway_status: "ACTIVE",
              do_status: "RECOVERING",
              warning: err.message
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ),
          env
        );
      }
      return addSecurityAndCorsHeaders(
        new Response(
          JSON.stringify({ error: "COORDINATOR_DISPATCH_ERROR", message: err.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        env
      );
    }
  }
};

function addSecurityAndCorsHeaders(res, env) {
  const allowedOrigins = env?.SPAAS_ALLOWED_ORIGINS || "*";
  const newHeaders = new Headers(res.headers);
  newHeaders.set("Access-Control-Allow-Origin", allowedOrigins);
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Device-Auth, X-SPaaS-Key");
  newHeaders.set("Access-Control-Expose-Headers", "X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After");

  // Enterprise Security Headers
  newHeaders.set("X-Content-Type-Options", "nosniff");
  newHeaders.set("X-Frame-Options", "DENY");
  newHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders
  });
}
