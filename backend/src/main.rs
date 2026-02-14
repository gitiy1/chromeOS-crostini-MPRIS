mod model;
mod mpris_bridge;
mod state;

use std::{net::SocketAddr, path::PathBuf, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{sse::Event, IntoResponse, Response, Sse},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;

use crate::{
    model::{BridgeState, ControlAction},
    mpris_bridge::{perform_action, run_poll_loop},
    state::SharedState,
};

#[derive(Clone)]
struct AppState {
    shared: SharedState,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "crostini_mpris_bridge=info,tower_http=info".to_string()),
        )
        .init();

    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:5000".to_string());
    let addr: SocketAddr = bind.parse().expect("BIND_ADDR must be host:port");
    let interval_ms = std::env::var("POLL_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(500);

    let shared = SharedState::new();
    let app_state = AppState {
        shared: shared.clone(),
    };

    tokio::spawn(run_poll_loop(
        shared,
        Duration::from_millis(interval_ms.max(200)),
    ));

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/state", get(get_state))
        .route("/events", get(sse_events))
        .route("/control/:action", post(control))
        .route("/art", get(proxy_art))
        .with_state(app_state)
        .layer(middleware::from_fn(pna_middleware))
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    info!("starting crostini mpris bridge on {addr}");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind failed");

    axum::serve(listener, app).await.expect("server failed");
}

async fn get_state(State(state): State<AppState>) -> Json<BridgeState> {
    Json(state.shared.snapshot().await)
}

async fn sse_events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let initial = state.shared.snapshot().await;
    let rx = state.shared.subscribe();

    let init_event = tokio_stream::once(Ok(Event::default()
        .event("state")
        .json_data(initial)
        .unwrap()));

    let updates = BroadcastStream::new(rx).filter_map(|msg| {
        msg.ok()
            .map(|payload| Ok(Event::default().event("state").json_data(payload).unwrap()))
    });

    Sse::new(init_event.chain(updates))
}

async fn control(Path(action): Path<String>) -> impl IntoResponse {
    let action = match action.as_str() {
        "play" => ControlAction::Play,
        "pause" => ControlAction::Pause,
        "play-pause" | "toggle" => ControlAction::PlayPause,
        "next" => ControlAction::Next,
        "previous" | "prev" => ControlAction::Previous,
        "stop" => ControlAction::Stop,
        _ => return (StatusCode::BAD_REQUEST, "unknown action").into_response(),
    };

    match perform_action(action) {
        Ok(_) => (StatusCode::OK, "ok").into_response(),
        Err(err) => (StatusCode::BAD_GATEWAY, err.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct ArtQuery {
    src: String,
}

async fn proxy_art(Query(query): Query<ArtQuery>) -> impl IntoResponse {
    if !query.src.starts_with("file://") {
        return (StatusCode::BAD_REQUEST, "src must start with file://").into_response();
    }

    let Ok(url) = url::Url::parse(&query.src) else {
        return (StatusCode::BAD_REQUEST, "invalid url").into_response();
    };

    let Ok(path) = url.to_file_path() else {
        return (StatusCode::BAD_REQUEST, "not a local file url").into_response();
    };

    let canonical = match tokio::fs::canonicalize(&path).await {
        Ok(path) => path,
        Err(_) => return (StatusCode::NOT_FOUND, "artwork not found").into_response(),
    };

    if !is_user_file(&canonical) {
        return (StatusCode::FORBIDDEN, "path not allowed").into_response();
    }

    match tokio::fs::read(canonical).await {
        Ok(bytes) => (
            [(header::CONTENT_TYPE, HeaderValue::from_static("image/*"))],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "artwork not found").into_response(),
    }
}

fn is_user_file(path: &PathBuf) -> bool {
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    path.starts_with(home)
}

async fn pna_middleware(req: axum::http::Request<axum::body::Body>, next: Next) -> Response {
    let mut response = next.run(req).await;
    response.headers_mut().insert(
        "Access-Control-Allow-Private-Network",
        HeaderValue::from_static("true"),
    );
    response
}
