//! Routeur HTTP : `/api/health`, `/api/explain`, `/api/coach` et `/api/report`.
//! Port de `handleAiEndpoint`, `handleExplain`, `handleCoach` (`server/explain.mjs`, `coach.mjs`)
//! et `handleReport` (`server/report.mjs`) : contrôle d'origine, identité, débit, cache partagé,
//! réservation atomique de quota et de budget, appel DeepSeek, puis réconciliation du coût réel.
//!
//! Garantie centrale : un appel qui consomme la clé du SERVICE ne part jamais sans réservation
//! de budget réussie quand les quotas sont actifs ; si la réservation est impossible, l'appel
//! est refusé (503) plutôt que de risquer un dépassement non contrôlé.

#![allow(clippy::result_large_err)] // l'`Err` est une réponse HTTP prête à renvoyer

use crate::backend::{AiUser, Backend, ReportEntry, ReportResult, ReserveRequest, SaveEntry};
use crate::config::Config;
use crate::dataset;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use lernoviq_ai::client::{MAX_FOLLOW_ANSWER_CHARS, MAX_FOLLOW_QUESTION_CHARS, MAX_FOLLOW_UPS};
use lernoviq_ai::config::{estimate_cost_usd, PROMPT_VERSION};
use lernoviq_ai::{AiError, DeepSeekClient};
use lernoviq_security::ratelimit::{client_ip, RateLimiter};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
        .route("/api/coach", any(coach))
        .route("/api/report", any(report))
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
/// (curl, serveur à serveur, application de bureau native), la requête reste acceptée.
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

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Identité et clé d'un appel IA une fois les contrôles préalables passés.
struct Guard {
    user_key: Option<String>,
    ip: String,
    ai_user: Option<AiUser>,
}

impl Guard {
    fn has_user_key(&self) -> bool {
        self.user_key.is_some()
    }
}

fn ip_of(s: &AppState, headers: &HeaderMap, addr: &SocketAddr) -> String {
    client_ip(
        |n| header_str(headers, n),
        Some(&addr.ip().to_string()),
        s.config.trust_proxy,
    )
}

/// Méthode, origine, identité, politique de clé et limite de débit.
async fn preflight(
    s: &AppState,
    method: &Method,
    addr: &SocketAddr,
    headers: &HeaderMap,
) -> Result<Guard, Response> {
    let c = &s.config;
    if method != Method::POST {
        return Err(error_response(405, "Méthode non autorisée.", None));
    }
    if !origin_allowed(c, headers) {
        return Err(error_response(403, "Origine non autorisée.", None));
    }
    let user_key = header_str(headers, "x-deepseek-api-key")
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    let ip = ip_of(s, headers, addr);
    let ai_user = match bearer(headers) {
        Some(token) => s.backend.verify_user(&token).await,
        None => None,
    };

    if user_key.is_none() {
        if c.free_requires_auth && ai_user.is_none() {
            return Err(error_response(
                401,
                "Connexion requise pour l'explication gratuite.",
                Some("auth_required"),
            ));
        }
        if !c.free_requires_auth && !c.server_key_fallback {
            return Err(error_response(
                401,
                "Clé API DeepSeek requise. Ajoutez votre clé dans les Paramètres.",
                Some("key_required"),
            ));
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
            return Err(res);
        }
    }
    Ok(Guard {
        user_key,
        ip,
        ai_user,
    })
}

/// Corps JSON borné ; `{}` si vide.
async fn read_json(body: Body, max: usize) -> Result<Value, Response> {
    let Ok(bytes) = axum::body::to_bytes(body, max).await else {
        return Err(error_response(413, "Requête trop volumineuse.", None));
    };
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|_| error_response(400, "JSON invalide.", None))
}

fn question_id_of(body: &Value) -> Result<String, Response> {
    match body.get("questionId").and_then(Value::as_str) {
        Some(q) if !q.trim().is_empty() && q.chars().count() <= 200 => Ok(q.to_string()),
        _ => Err(error_response(
            400,
            "Champ `questionId` requis (chaîne de 200 caractères maximum).",
            None,
        )),
    }
}

fn selected_key_of(body: &Value) -> Result<char, Response> {
    match body.get("selectedKey").and_then(Value::as_str) {
        Some(k @ ("A" | "B" | "C" | "D")) => Ok(k.chars().next().unwrap_or('A')),
        _ => Err(error_response(400, "`selectedKey` invalide.", None)),
    }
}

/// Réserve quota et budget pour un appel de la clé du service. `Ok(None)` : rien à réserver.
async fn reserve_budget(
    s: &AppState,
    g: &Guard,
    estimated_usd: f64,
) -> Result<Option<String>, Response> {
    if g.has_user_key() || !s.backend.quota_enabled() {
        return Ok(None);
    }
    let c = &s.config;
    let (daily, per_minute) = match &g.ai_user {
        Some(_) => (c.user_daily_limit, c.user_per_minute),
        None => (c.anon_daily_limit, c.anon_per_minute),
    };
    let reservation = s
        .backend
        .reserve(ReserveRequest {
            actor: g
                .ai_user
                .as_ref()
                .map_or_else(|| format!("ip:{}", g.ip), |u| format!("user:{}", u.id)),
            daily_limit: daily,
            per_minute,
            window_seconds: 60,
            estimated_usd,
            limit_usd: c.budget_limit_usd,
            suspend_usd: c.budget_suspend_usd,
            month: chrono::Utc::now().format("%Y-%m").to_string(),
        })
        .await;
    let reservation = match reservation {
        Ok(r) => r,
        Err(error) => {
            // Migration absente ou Supabase indisponible : on refuse l'appel de clé serveur.
            tracing::warn!(%error, "réservation de quota impossible");
            return Err(error_response(
                503,
                "Service d'explications IA temporairement indisponible ; les exercices restent accessibles.",
                Some("unavailable"),
            ));
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
        return Err(error_response(429, message, Some(reason)));
    }
    Ok(reservation.event_id)
}

/// Réconcilie la réservation : coût réel si DeepSeek a facturé, sinon remboursement.
async fn settle(s: &AppState, event_id: &Option<String>, billed_usd: Option<f64>) {
    let Some(id) = event_id else { return };
    match billed_usd.filter(|b| *b > 0.0) {
        Some(usd) => s.backend.finalize(id, usd).await,
        None => s.backend.release(id).await,
    }
}

fn map_ai_error(error: &AiError, unparsable_message: &str) -> Response {
    match error {
        AiError::Unparsable => error_response(502, unparsable_message, Some("unparsable")),
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

/// Question du jeu local, sinon de la banque Supabase.
async fn find_question(
    s: &AppState,
    id: &str,
) -> Result<Option<lernoviq_ai::ExplainQuestion>, String> {
    match dataset::find_local(id) {
        Some(q) => Ok(Some(q)),
        None => s.backend.find_question(id).await,
    }
}

async fn explain(
    State(s): State<Arc<AppState>>,
    method: Method,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let g = match preflight(&s, &method, &addr, &headers).await {
        Ok(g) => g,
        Err(r) => return r,
    };
    let parsed = match read_json(body, s.config.max_body_bytes).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (question_id, selected) = match (question_id_of(&parsed), selected_key_of(&parsed)) {
        (Ok(q), Ok(k)) => (q, k),
        (Err(r), _) | (_, Err(r)) => return r,
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

    let event_id =
        match reserve_budget(&s, &g, estimate_cost_usd(s.config.estimated_call_usd)).await {
            Ok(e) => e,
            Err(r) => return r,
        };
    let question = match find_question(&s, &question_id).await {
        Ok(Some(q)) => q,
        Ok(None) => {
            settle(&s, &event_id, None).await;
            return error_response(404, "Question introuvable.", None);
        }
        Err(message) => {
            settle(&s, &event_id, None).await;
            return error_response(500, &message, None);
        }
    };

    let api_key = g
        .user_key
        .clone()
        .or_else(|| s.config.deepseek_api_key.clone())
        .unwrap_or_default();
    match s
        .client
        .explain(
            &api_key,
            &question,
            selected,
            g.ai_user.as_ref().map(|u| u.id.as_str()),
        )
        .await
    {
        Ok(out) => {
            settle(&s, &event_id, Some(out.usage.estimated_usd)).await;
            s.backend
                .save(SaveEntry {
                    question_id,
                    selected_key: selected,
                    prompt_version: PROMPT_VERSION.to_string(),
                    model: s.client.model().to_string(),
                    explanation: out.explanation.clone(),
                    lesson: out.lesson.clone(),
                    user_id: g.ai_user.map(|u| u.id),
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
            settle(
                &s,
                &event_id,
                failure.usage.as_ref().map(|u| u.estimated_usd),
            )
            .await;
            map_ai_error(&failure.error, &failure.error.to_string())
        }
    }
}

/// Valide une question de relance : texte et historique bornés (jamais des consignes).
type FollowInput = (String, char, String, Vec<(String, String)>);

fn parse_follow_up(body: &Value) -> Result<FollowInput, Response> {
    let question_id = question_id_of(body)?;
    let selected = selected_key_of(body)?;
    let text = body
        .get("question")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let n = text.chars().count();
    if !(3..=MAX_FOLLOW_QUESTION_CHARS).contains(&n) {
        return Err(error_response(
            400,
            &format!(
                "Votre question doit faire entre 3 et {MAX_FOLLOW_QUESTION_CHARS} caractères."
            ),
            None,
        ));
    }
    let turns = match body.get("history") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) if a.len() < MAX_FOLLOW_UPS => a.clone(),
        Some(_) => {
            return Err(error_response(
                400,
                &format!(
                    "Limite de {MAX_FOLLOW_UPS} questions de relance atteinte pour cette question."
                ),
                None,
            ))
        }
    };
    let mut history = vec![];
    for turn in &turns {
        let (q, a) = (
            turn.get("q").and_then(Value::as_str),
            turn.get("a").and_then(Value::as_str),
        );
        match (q, a) {
            (Some(q), Some(a))
                if q.chars().count() <= MAX_FOLLOW_QUESTION_CHARS
                    && a.chars().count() <= MAX_FOLLOW_ANSWER_CHARS =>
            {
                history.push((q.to_string(), a.to_string()))
            }
            _ => return Err(error_response(400, "Historique invalide.", None)),
        }
    }
    Ok((question_id, selected, text, history))
}

async fn coach(
    State(s): State<Arc<AppState>>,
    method: Method,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let g = match preflight(&s, &method, &addr, &headers).await {
        Ok(g) => g,
        Err(r) => return r,
    };
    let parsed = match read_json(body, s.config.max_body_bytes).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (question_id, selected, text, history) = match parse_follow_up(&parsed) {
        Ok(v) => v,
        Err(r) => return r,
    };
    // Réponse courte (400 tokens maximum) : réservation plus faible qu'une explication.
    let event_id =
        match reserve_budget(&s, &g, s.config.estimated_followup_usd.unwrap_or(0.002)).await {
            Ok(e) => e,
            Err(r) => return r,
        };
    let question = match find_question(&s, &question_id).await {
        Ok(Some(q)) => q,
        Ok(None) => {
            settle(&s, &event_id, None).await;
            return error_response(404, "Question introuvable.", None);
        }
        Err(message) => {
            settle(&s, &event_id, None).await;
            return error_response(500, &message, None);
        }
    };
    let api_key = g
        .user_key
        .clone()
        .or_else(|| s.config.deepseek_api_key.clone())
        .unwrap_or_default();
    match s
        .client
        .follow_up(
            &api_key,
            &question,
            selected,
            &text,
            &history,
            g.ai_user.as_ref().map(|u| u.id.as_str()),
        )
        .await
    {
        Ok(out) => {
            settle(&s, &event_id, Some(out.usage.estimated_usd)).await;
            json_response(
                200,
                json!({"answer": out.answer, "latencyMs": out.latency_ms}),
            )
        }
        Err(failure) => {
            settle(
                &s,
                &event_id,
                failure.usage.as_ref().map(|u| u.estimated_usd),
            )
            .await;
            map_ai_error(
                &failure.error,
                "Le coach n'a pas pu répondre cette fois. Réessayez dans un instant.",
            )
        }
    }
}

pub const REPORT_REASONS: [&str; 5] = [
    "wrong_answer",
    "typo",
    "ambiguous",
    "unclear_audio",
    "other",
];
const MAX_COMMENT: usize = 500;
const MAX_REPORT_BODY: usize = 4 * 1024;

/// Empreinte salée d'une IP : limite les abus sans conserver l'adresse.
fn reporter_hash(salt: &str, ip: &str) -> String {
    let digest = Sha256::digest(format!("{salt}|{ip}").as_bytes());
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..24]
        .to_string()
}

async fn report(
    State(s): State<Arc<AppState>>,
    method: Method,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if method != Method::POST {
        return error_response(405, "Méthode non autorisée.", None);
    }
    if !origin_allowed(&s.config, &headers) {
        return error_response(403, "Origine non autorisée.", None);
    }
    if !s.backend.reports_enabled() {
        return error_response(
            503,
            "Le signalement n'est pas disponible pour le moment.",
            Some("unavailable"),
        );
    }
    let ip = ip_of(&s, &headers, &addr);
    let gate = s
        .limiter
        .check(&format!("report:{ip}"), 10, 3_600_000, now_ms());
    if !gate.ok {
        let mut res = error_response(
            429,
            "Trop de signalements. Merci de réessayer plus tard.",
            Some("rate"),
        );
        if let Ok(v) = HeaderValue::from_str(&gate.retry_after_sec.to_string()) {
            res.headers_mut().insert(header::RETRY_AFTER, v);
        }
        return res;
    }
    let parsed = match read_json(body, MAX_REPORT_BODY).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let question_id = match parsed
        .get("questionId")
        .and_then(Value::as_str)
        .map(str::trim)
    {
        Some(q) if !q.is_empty() && q.chars().count() <= 200 => q.to_string(),
        _ => return error_response(400, "Question à signaler invalide.", None),
    };
    let reason = match parsed.get("reason").and_then(Value::as_str) {
        Some(r) if REPORT_REASONS.contains(&r) => r.to_string(),
        _ => return error_response(400, "Motif invalide.", None),
    };
    let comment = parsed
        .get("comment")
        .and_then(Value::as_str)
        .map(|c| c.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    if comment.chars().count() > MAX_COMMENT {
        return error_response(
            400,
            &format!("Commentaire trop long ({MAX_COMMENT} caractères maximum)."),
            None,
        );
    }
    if reason == "other" && comment.chars().count() < 5 {
        return error_response(400, "Décrivez brièvement le problème.", None);
    }
    let part = parsed
        .get("part")
        .and_then(Value::as_u64)
        .filter(|p| [2, 5, 6, 7].contains(p))
        .map(|p| p as u8);

    // Capture de l'énoncé au moment du signalement (la question peut être modifiée ensuite).
    let Some((qpart, prompt)) = dataset::find_reportable(&question_id) else {
        return error_response(404, "Question introuvable.", None);
    };
    let reporter_id = match bearer(&headers) {
        Some(token) => s.backend.verify_user(&token).await.map(|u| u.id),
        None => None,
    };
    let entry = ReportEntry {
        question_id,
        part: part.or(Some(qpart)),
        prompt: prompt.chars().take(600).collect(),
        reason,
        comment,
        reporter_id,
        reporter_hash: reporter_hash(&s.config.report_salt, &ip),
    };
    match s.backend.save_report(entry).await {
        Ok(ReportResult::Created) => json_response(201, json!({"ok": true})),
        Ok(ReportResult::Duplicate) => json_response(200, json!({"ok": true, "duplicate": true})),
        Ok(ReportResult::RateLimited) => error_response(
            429,
            "Trop de signalements. Merci de réessayer plus tard.",
            Some("rate"),
        ),
        Err(error) => {
            tracing::warn!(%error, "signalement non enregistré");
            error_response(
                503,
                "Le signalement n'a pas pu être enregistré. Réessayez plus tard.",
                Some("unavailable"),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empreinte_de_signalement() {
        let h = reporter_hash("sel", "1.2.3.4");
        assert_eq!(h.len(), 24);
        assert_eq!(h, reporter_hash("sel", "1.2.3.4"));
        assert_ne!(h, reporter_hash("autre", "1.2.3.4"));
        assert!(!h.contains("1.2.3.4"));
    }
}
