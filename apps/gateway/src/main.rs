use axum::{
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::any,
    Router,
};
use clap::Parser;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[derive(Parser, Debug)]
#[command(
    name = "spaas-gateway",
    author,
    version,
    about = "SPaaS Ingress Gateway & Edge Reverse Proxy"
)]
struct Args {
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    #[arg(short, long, default_value_t = 8000)]
    port: u16,

    #[arg(long, default_value = "http://127.0.0.1:8080")]
    upstream_url: String,
}

#[derive(Clone)]
struct GatewayState {
    upstream_url: String,
    client: reqwest::Client,
}

async fn proxy_handler(
    State(state): State<Arc<GatewayState>>,
    req: Request,
) -> Result<Response, (StatusCode, String)> {
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_url = format!("{}{}", state.upstream_url, path);

    let method = req.method().clone();
    let headers = req.headers().clone();
    let body_bytes = axum::body::to_bytes(req.into_body(), 10 * 1024 * 1024)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Body read error: {e}")))?;

    let mut upstream_req = state.client.request(method, &target_url);
    for (k, v) in headers.iter() {
        if k != "host" {
            upstream_req = upstream_req.header(k, v);
        }
    }

    let upstream_resp = upstream_req.body(body_bytes).send().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Upstream connection error: {e}"),
        )
    })?;

    let status = StatusCode::from_u16(upstream_resp.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    let resp_headers = upstream_resp.headers().clone();
    let resp_bytes = upstream_resp.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Upstream body read error: {e}"),
        )
    })?;

    let mut response = Response::builder().status(status);
    for (k, v) in resp_headers.iter() {
        response = response.header(k, v);
    }

    response
        .body(Body::from(resp_bytes))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    spaas_telemetry::init_telemetry("spaas-gateway");
    let args = Args::parse();
    let addr = format!("{}:{}", args.host, args.port);

    let state = Arc::new(GatewayState {
        upstream_url: args.upstream_url.clone(),
        client: reqwest::Client::new(),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .fallback(any(proxy_handler))
        .layer(cors)
        .with_state(state);

    info!(
        "SPaaS Ingress Gateway listening on http://{} -> Upstream {}",
        addr, args.upstream_url
    );
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
