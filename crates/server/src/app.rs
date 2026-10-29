//! Routeur HTTP : `/api/health` et `/api/explain`. Port de `handleAiEndpoint` / `handleExplain`
//! (`server/explain.mjs`) : contrôle d'origine, identité, débit, cache partagé, réservation
//! atomique de quota et de budget, appel DeepSeek, puis réconciliation du coût réel.
//!
//! Garantie centrale : un appel qui consomme la clé du SERVICE ne part jamais sans réservation
//! de budget réussie quand les quotas sont actifs ; si la réservation est impossible, l'appel
//! est refusé (503) plutôt que de risquer un dépassement non contrôlé.

use crate::backend::{Backend, ReserveRequest, SaveEntry};
use crate::config::Config;
use crate::dataset;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use lernoviq_ai::config::{estimate_cost_usd, PROMPT_VERSION};
use lernoviq_ai::{AiError, DeepSeekClient};
use lernoviq_security::ratelimit::{client_ip, RateLimiter};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;

pub struct AppState {
    pub config: Config,
    pub backend: Arc<dyn Backend>,
    pub limiter: RateLimiter,
    pub client: DeepSeekClient,
}

impl AppState {
    pub fn new(config: Config, backend: Arc<dyn Backend>) -> Self {
        let client = DeepSeekClient::new()
            .with_base_url(&config.deepseek_base_url)
            .with_model(&config.deepseek_model)
            .with_timeout(std::time::Duration::from_millis(config.deepseek_timeout_ms))
            .with_max_tokens(config.deepseek_max_tokens)
            .with_thinking(config.deepseek_thinking);
        Self {
            config,
            backend,
            limiter: RateLimiter::new(),
            client,
        }
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/explain", any(explain))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn security_headers(req: Request<Body>, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    for (k, v) in [
        (
            "content-security-policy",
            "default-src 'none'; frame-ancestors 'none'",
        ),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        ("cache-control", "no-store"),
    ] {
        h.insert(k, HeaderValue::from_static(v));
    }
    res
}

fn json_response(status: u16, body: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body.to_string(),
    )
        .into_response()
}

fn error_response(status: u16, message: &str, code: Option<&str>) -> Response {
    json_response(
        status,
        match code {
            Some(code) => json!({"error": message, "code": code}),
            None => json!({"error": message}),
        },
    )
}

async fn health(State(s): State<Arc<AppState>>) -> Response {
    json_response(
        200,
        json!({"hasDeepSeekKey": s.config.deepseek_api_key.is_some()}),
    )
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

fn origin_host(origin: &str) -> &str {
    origin
        .split_once("://")
        .map_or(origin, |(_, rest)| rest)
        .split('/')
        .next()
        .unwrap_or_default()
}

/// Refuse une requête navigateur d'une autre origine (proxy ouvert). Sans en-tête `Origin`
/// (curl, serveur à serveur), la requête reste acceptée.
fn origin_allowed(config: &Config, headers: &HeaderMap) -> bool {
    if !config.restrict_origin {
        return true;
    }
    let Some(origin) = header_str(headers, "origin") else {
        return true;
    };
    if config.allowed_origins.iter().any(|a| a == &origin) {
        return true;
    }
    let host = header_str(headers, "x-forwarded-host").or_else(|| header_str(headers, "host"));
    host.is_some_and(|h| origin_host(&origin) == h)
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = header_str(headers, "authorization")?;
    let (scheme, token) = v.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty())
        .then(|| token.trim().to_string())
}

fn month_key() -> String {
    chrono::Utc::now().format("%Y-%m").to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn explain(
    State(s): State<Arc<AppState>>,
    method: Method,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let c = &s.config;
    if method != Method::POST {
        return error_response(405, "Méthode non autorisée.", None);
    }
    if !origin_allowed(c, &headers) {
        return error_response(403, "Origine non autorisée.", None);
    }

    let user_key = header_str(&headers, "x-deepseek-api-key")
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    let has_user_key = user_key.is_some();
    let ip = client_ip(
        |n| header_str(&headers, n),
        Some(&addr.ip().to_string()),
        c.trust_proxy,
    );

    // Identité Supabase (facultative) : sert au quota par utilisateur.
    let ai_user = match bearer(&headers) {
        Some(token) => s.backend.verify_user(&token).await,
        None => None,
    };

    if !has_user_key {
        if c.free_requires_auth && ai_user.is_none() {
            return error_response(
                401,
                "Connexion requise pour l'explication gratuite.",
                Some("auth_required"),
            );
        }
        if !c.free_requires_auth && !c.server_key_fallback {
            return error_response(
                401,
                "Clé API DeepSeek requise. Ajoutez votre clé dans les Paramètres.",
                Some("key_required"),
            );
        }
        // Débit : par utilisateur connecté, sinon par IP (aussi appliqué atomiquement en base).
        let (key, limit, window) = match &ai_user {
            Some(u) => (
                format!("user:{}", u.id),
                c.user_per_minute as usize,
                c.user_rate_window_ms,
            ),
            None => (
                format!("explain:{ip}"),
                c.explain_rate_limit,
                c.explain_rate_window_ms,
            ),
        };
        let rate = s.limiter.check(&key, limit, window, now_ms());
        if !rate.ok {
            let mut res = error_response(
                429,
                "Trop de requêtes vers le coach IA. Merci de patienter quelques instants.",
                Some("rate"),
            );
            if let Ok(v) = HeaderValue::from_str(&rate.retry_after_sec.to_string()) {
                res.headers_mut().insert(header::RETRY_AFTER, v);
            }
            return res;
        }
    }

    let Ok(bytes) = axum::body::to_bytes(body, c.max_body_bytes).await else {
        return error_response(413, "Requête trop volumineuse.", None);
    };
    let parsed: Value = if bytes.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return error_response(400, "JSON invalide.", None),
        }
    };
    let question_id = match parsed.get("questionId").and_then(Value::as_str) {
        Some(q) if !q.trim().is_empty() && q.chars().count() <= 200 => q.to_string(),
        _ => {
            return error_response(
                400,
                "Champ `questionId` requis (chaîne de 200 caractères maximum).",
                None,
            )
        }
    };
    let selected = match parsed.get("selectedKey").and_then(Value::as_str) {
        Some(k @ ("A" | "B" | "C" | "D")) => k.chars().next().unwrap_or('A'),
        _ => return error_response(400, "`selectedKey` invalide.", None),
    };

    // Réponse déjà disponible (cache partagé) : ni quota ni appel DeepSeek.
    if let Some(hit) = s
        .backend
        .cached(&question_id, selected, PROMPT_VERSION, s.client.model())
        .await
    {
        s.backend.touch(&hit.id).await;
        return json_response(
            200,
            json!({"explanation": hit.explanation, "lesson": hit.lesson, "latencyMs": 0, "cached": true}),
        );
    }

    // Réservation atomique du quota et du budget (clé du service uniquement).
    let mut event_id: Option<String> = None;
    if !has_user_key && s.backend.quota_enabled() {
        let (daily, per_minute) = match &ai_user {
            Some(_) => (c.user_daily_limit, c.user_per_minute),
            None => (c.anon_daily_limit, c.anon_per_minute),
        };
        let reservation = s
            .backend
            .reserve(ReserveRequest {
                actor: ai_user
                    .as_ref()
                    .map_or_else(|| format!("ip:{ip}"), |u| format!("user:{}", u.id)),
                daily_limit: daily,
                per_minute,
                window_seconds: 60,
                estimated_usd: estimate_cost_usd(c.estimated_call_usd),
                limit_usd: c.budget_limit_usd,
                suspend_usd: c.budget_suspend_usd,
                month: month_key(),
            })
            .await;
        let reservation = match reservation {
            Ok(r) => r,
            Err(error) => {
                // Migration absente ou Supabase indisponible : on refuse l'appel de clé serveur.
                tracing::warn!(%error, "réservation de quota impossible");
                return error_response(503, "Service d'explications IA temporairement indisponible ; les exercices restent accessibles.", Some("unavailable"));
            }
        };
        if !reservation.ok {
            let reason = reservation.reason.as_deref().unwrap_or("unavailable");
            let message = match reason {
                "quota" => "Quota quotidien d'explications IA atteint. Réessayez demain ; les exercices restent accessibles.",
                "rate" => "Trop de requêtes vers le coach IA. Merci de patienter quelques instants.",
                "budget" => "Le budget mensuel d'explications IA est atteint ; les exercices restent accessibles.",
                "in_flight" => "Une explication est déjà en cours pour ce compte.",
                _ => "Service d'explications IA temporairement indisponible.",
            };
            return error_response(429, message, Some(reason));
        }
        event_id = reservation.event_id;
    }

    // Question : jeu local d'abord, banque Supabase ensuite.
    let question = match dataset::find_local(&question_id) {
        Some(q) => Some(q),
        None => match s.backend.find_question(&question_id).await {
            Ok(q) => q,
            Err(message) => {
                release(&s, &event_id, None).await;
                return error_response(500, &message, None);
            }
        },
    };
    let Some(question) = question else {
        release(&s, &event_id, None).await;
        return error_response(404, "Question introuvable.", None);
    };

    let api_key = user_key
        .clone()
        .or_else(|| c.deepseek_api_key.clone())
        .unwrap_or_default();
    match s
        .client
        .explain(
            &api_key,
            &question,
            selected,
            ai_user.as_ref().map(|u| u.id.as_str()),
        )
        .await
    {
        Ok(out) => {
            if let Some(id) = &event_id {
                s.backend.finalize(id, out.usage.estimated_usd).await;
            }
            s.backend
                .save(SaveEntry {
                    question_id,
                    selected_key: selected,
                    prompt_version: PROMPT_VERSION.to_string(),
                    model: s.client.model().to_string(),
                    explanation: out.explanation.clone(),
                    lesson: out.lesson.clone(),
                    user_id: ai_user.map(|u| u.id),
                    usage: out.usage.clone(),
                })
                .await;
            json_response(
                200,
                json!({"explanation": out.explanation, "lesson": out.lesson, "latencyMs": out.latency_ms}),
            )
        }
        Err(failure) => {
            // Si DeepSeek a répondu (donc facturé) mais que le résultat est inutilisable, le coût
            // réel reste imputé au budget ; sinon la réservation est rendue.
            release(
                &s,
                &event_id,
                failure.usage.as_ref().map(|u| u.estimated_usd),
            )
            .await;
            map_ai_error(&failure.error)
        }
    }
}

async fn release(s: &AppState, event_id: &Option<String>, billed: Option<f64>) {
    let Some(id) = event_id else { return };
    match billed.filter(|b| *b > 0.0) {
        Some(usd) => s.backend.finalize(id, usd).await,
        None => s.backend.release(id).await,
    }
}

fn map_ai_error(error: &AiError) -> Response {
    match error {
        AiError::Unparsable => error_response(502, &error.to_string(), Some("unparsable")),
        AiError::Http { status: 401, .. } => error_response(
            401,
            "Clé API DeepSeek refusée. Vérifiez-la dans les Paramètres.",
            Some("key_invalid"),
        ),
        AiError::Http { status: 402, .. } => error_response(
            503,
            "Le budget d'explications IA est épuisé ; les exercices restent accessibles.",
            Some("budget"),
        ),
        AiError::Http { status: 429, .. } => error_response(
            429,
            "Le service d'explications IA est momentanément saturé. Réessayez dans un instant.",
            Some("rate"),
        ),
        other => error_response(
            500,
            &lernoviq_ai::client::mask_secret(&other.to_string()),
            None,
        ),
    }
}
