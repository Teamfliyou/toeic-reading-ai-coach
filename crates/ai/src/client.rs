//! Client HTTP DeepSeek avec validation de la réponse, un retry contrôlé et suivi du coût.
//! Port de `explainMistake` (`server/explain.mjs`).

use crate::config::{add_usage, compute_cost, Usage, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL};
use crate::prompt::{build_user_prompt, PromptQuestion, RETRY_NOTE, SYSTEM_PROMPT};
use crate::schema::{parse_explanation, Explanation, Lesson, Parsed};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ExplainQuestion {
    pub part: u8,
    pub prompt: String,
    pub options: Vec<(char, String)>,
    pub correct_key: char,
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AiError {
    #[error("Aucune clé API DeepSeek. Ajoutez votre clé dans les Paramètres.")]
    NoKey,
    /// Conservé pour distinguer budget (402), saturation (429) et clé refusée (401).
    #[error("DeepSeek a répondu {status}{}", if .message.is_empty() { String::new() } else { format!(" : {}", .message) })]
    Http { status: u16, message: String },
    #[error("Erreur réseau vers DeepSeek : {0}")]
    Network(String),
    #[error("DeepSeek n'a pas répondu à temps.")]
    Timeout,
    #[error("Le coach n'a pas pu formuler une explication lisible cette fois. Réessayez dans un instant ; la bonne réponse reste affichée.")]
    Unparsable,
}

impl AiError {
    /// Code HTTP à renvoyer au client.
    pub fn status_code(&self) -> u16 {
        match self {
            Self::NoKey => 400,
            Self::Http { status, .. } => *status,
            Self::Timeout => 504,
            Self::Network(_) | Self::Unparsable => 502,
        }
    }
}

/// Une erreur accompagnée du coût déjà engagé : toute tentative ayant reçu une réponse
/// est facturée, l'appelant en a besoin pour réconcilier le budget.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{error}")]
pub struct AiFailure {
    pub error: AiError,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone)]
pub struct ExplainOutcome {
    pub explanation: Explanation,
    pub lesson: Option<Lesson>,
    pub latency_ms: u64,
    pub usage: Usage,
}

/// Masque toute clé API présente dans un message et borne sa longueur.
pub fn mask_secret(text: &str) -> String {
    static KEY: OnceLock<Regex> = OnceLock::new();
    let re =
        KEY.get_or_init(|| Regex::new(r"(Bearer\s+|sk-)[A-Za-z0-9_-]{8,}").expect("regex valide"));
    re.replace_all(text, "[clé masquée]")
        .chars()
        .take(200)
        .collect()
}

#[derive(Clone)]
pub struct DeepSeekClient {
    http: reqwest::Client,
    base_url: String,
    model: String,
    timeout: Duration,
    max_tokens: u32,
    thinking_enabled: bool,
}

impl Default for DeepSeekClient {
    fn default() -> Self {
        Self::new()
    }
}

impl DeepSeekClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: DEEPSEEK_BASE_URL.to_string(),
            model: DEEPSEEK_MODEL.to_string(),
            timeout: Duration::from_millis(22_000),
            max_tokens: 1024,
            thinking_enabled: false,
        }
    }

    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into().trim_end_matches('/').to_string();
        self
    }
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }
    /// Le mode « thinking » facture des tokens de raisonnement : désactivé par défaut.
    pub fn with_thinking(mut self, enabled: bool) -> Self {
        self.thinking_enabled = enabled;
        self
    }
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Explique une erreur. `api_key` est la clé du service (serveur) ou celle de l'utilisateur.
    pub async fn explain(
        &self,
        api_key: &str,
        question: &ExplainQuestion,
        selected_key: char,
        user_id: Option<&str>,
    ) -> Result<ExplainOutcome, AiFailure> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err(AiFailure {
                error: AiError::NoKey,
                usage: None,
            });
        }
        let started = Instant::now();
        let user_prompt = build_user_prompt(
            &PromptQuestion {
                part: question.part,
                prompt: &question.prompt,
                options: &question.options,
                correct_key: question.correct_key,
                context: &question.context,
            },
            selected_key,
        );
        let mut usage: Option<Usage> = None;

        for attempt in 1..=2 {
            let mut messages = vec![
                json!({"role": "system", "content": SYSTEM_PROMPT}),
                json!({"role": "user", "content": user_prompt}),
            ];
            if attempt == 2 {
                messages.push(json!({"role": "user", "content": RETRY_NOTE}));
            }
            let mut payload = json!({
                "model": self.model,
                "messages": messages,
                "response_format": {"type": "json_object"},
                "max_tokens": self.max_tokens,
                "stream": false,
            });
            if !self.thinking_enabled {
                payload["thinking"] = json!({"type": "disabled"});
            }
            if let Some(id) = user_id.filter(|s| !s.is_empty()) {
                payload["user_id"] = json!(id.chars().take(512).collect::<String>());
            }

            let fail = |error: AiError, usage: &Option<Usage>| AiFailure {
                error,
                usage: usage.clone(),
            };
            let response = self
                .http
                .post(format!("{}/chat/completions", self.base_url))
                .bearer_auth(api_key)
                .timeout(self.timeout)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    let error = if e.is_timeout() {
                        AiError::Timeout
                    } else {
                        AiError::Network(mask_secret(&e.to_string()))
                    };
                    fail(error, &usage)
                })?;

            let status = response.status();
            if !status.is_success() {
                let raw = response.text().await.unwrap_or_default();
                return Err(fail(
                    AiError::Http {
                        status: status.as_u16(),
                        message: mask_secret(&raw),
                    },
                    &usage,
                ));
            }
            let data: Value = response.json().await.map_err(|e| {
                let error = if e.is_timeout() {
                    AiError::Timeout
                } else {
                    AiError::Network(mask_secret(&e.to_string()))
                };
                fail(error, &usage)
            })?;

            let cost = compute_cost(
                data.get("usage").unwrap_or(&Value::Null),
                chrono::Utc::now(),
                &self.model,
            );
            usage = Some(add_usage(usage.take(), cost));
            let content = data["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or_default();
            if let Parsed::Ok {
                explanation,
                lesson,
            } = parse_explanation(content)
            {
                return Ok(ExplainOutcome {
                    explanation,
                    lesson: if attempt == 1 { lesson } else { None },
                    latency_ms: started.elapsed().as_millis() as u64,
                    usage: usage.unwrap_or_else(|| {
                        compute_cost(&Value::Null, chrono::Utc::now(), &self.model)
                    }),
                });
            }
        }
        Err(AiFailure {
            error: AiError::Unparsable,
            usage,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::Router;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Mock {
        script: VecDeque<(u16, String, u64)>,
        seen: Vec<(String, Value)>,
    }
    type Shared = Arc<Mutex<Mock>>;

    async fn handler(
        State(m): State<Shared>,
        headers: HeaderMap,
        body: String,
    ) -> (StatusCode, String) {
        let (status, reply, delay) = {
            let mut m = m.lock().unwrap();
            let auth = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            m.seen
                .push((auth, serde_json::from_str(&body).unwrap_or(Value::Null)));
            m.script.pop_front().expect("réponse prévue")
        };
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        (StatusCode::from_u16(status).unwrap(), reply)
    }

    async fn start(script: Vec<(u16, String, u64)>) -> (DeepSeekClient, Shared) {
        let shared: Shared = Arc::new(Mutex::new(Mock {
            script: script.into(),
            seen: vec![],
        }));
        let app = Router::new()
            .route("/chat/completions", post(handler))
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (
            DeepSeekClient::new().with_base_url(format!("http://{addr}")),
            shared,
        )
    }

    fn reply(content: &str, prompt: u64, completion: u64) -> (u16, String, u64) {
        let body = json!({"choices": [{"message": {"content": content}}],
                          "usage": {"prompt_tokens": prompt, "completion_tokens": completion}});
        (200, body.to_string(), 0)
    }
    fn question() -> ExplainQuestion {
        ExplainQuestion {
            part: 5,
            prompt: "Pay ______ Friday.".into(),
            options: vec![('A', "by".into()), ('B', "until".into())],
            correct_key: 'A',
            context: String::new(),
        }
    }
    const GOOD: &str = r#"{"diagnostic":"d","resolution":"r","tip":"t","lesson":{"title":"T","rule":"R","exercise":"X","answer":"A"}}"#;

    #[tokio::test]
    async fn succes_a_la_premiere_tentative() {
        let (client, mock) = start(vec![reply(GOOD, 1000, 200)]).await;
        let out = client
            .explain("sk-secret-key-123456", &question(), 'B', Some("user-1"))
            .await
            .unwrap();
        assert_eq!(out.explanation.diagnostic, "d");
        assert!(out.lesson.is_some());
        assert_eq!(
            (out.usage.input_tokens, out.usage.output_tokens),
            (1000, 200)
        );
        let m = mock.lock().unwrap();
        let (auth, body) = &m.seen[0];
        assert_eq!(auth, "Bearer sk-secret-key-123456");
        assert_eq!(body["thinking"]["type"], "disabled");
        assert_eq!(body["response_format"]["type"], "json_object");
        assert_eq!(body["user_id"], "user-1");
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn retry_apres_reponse_invalide_les_deux_appels_sont_factures() {
        let (client, mock) = start(vec![
            reply("```json {\"diagnostic\": \"tron", 1000, 1024),
            reply(GOOD, 1100, 150),
        ])
        .await;
        let out = client
            .explain("k-12345678", &question(), 'B', None)
            .await
            .unwrap();
        assert!(out.lesson.is_none(), "cours ignoré après un retry");
        assert_eq!(
            (out.usage.input_tokens, out.usage.output_tokens),
            (2100, 1174)
        );
        let m = mock.lock().unwrap();
        assert_eq!(m.seen.len(), 2);
        let second = m.seen[1].1["messages"].as_array().unwrap();
        assert_eq!(second.len(), 3);
        assert!(second[2]["content"]
            .as_str()
            .unwrap()
            .contains("COMPLET et COMPACT"));
    }

    #[tokio::test]
    async fn deux_reponses_illisibles() {
        let (client, mock) = start(vec![reply("rien", 10, 10), reply("encore rien", 10, 10)]).await;
        let failure = client
            .explain("k-12345678", &question(), 'B', None)
            .await
            .unwrap_err();
        assert_eq!(failure.error, AiError::Unparsable);
        assert_eq!(failure.error.status_code(), 502);
        assert_eq!(
            failure.usage.unwrap().input_tokens,
            20,
            "les deux appels sont facturés"
        );
        assert_eq!(mock.lock().unwrap().seen.len(), 2);
    }

    #[tokio::test]
    async fn erreur_http_sans_retry_et_cle_masquee() {
        let (client, mock) = start(vec![(401, "bad key sk-abcdefghijklmnop".into(), 0)]).await;
        let failure = client
            .explain("k-12345678", &question(), 'B', None)
            .await
            .unwrap_err();
        assert_eq!(failure.error.status_code(), 401);
        let message = failure.error.to_string();
        assert!(
            message.contains("401")
                && message.contains("[clé masquée]")
                && !message.contains("abcdefghijklmnop")
        );
        assert!(failure.usage.is_none());
        assert_eq!(mock.lock().unwrap().seen.len(), 1);
    }

    #[tokio::test]
    async fn sans_cle_et_timeout() {
        let client = DeepSeekClient::new();
        assert_eq!(
            client
                .explain("  ", &question(), 'A', None)
                .await
                .unwrap_err()
                .error,
            AiError::NoKey
        );
        let (slow, _) = start(vec![(200, "{}".into(), 500)]).await;
        let slow = slow.with_timeout(Duration::from_millis(100));
        let failure = slow
            .explain("k-12345678", &question(), 'A', None)
            .await
            .unwrap_err();
        assert_eq!(failure.error, AiError::Timeout);
        assert_eq!(failure.error.status_code(), 504);
    }

    #[test]
    fn masquage() {
        assert_eq!(
            mask_secret("Authorization: Bearer abcdefgh1234"),
            "Authorization: [clé masquée]"
        );
        assert_eq!(
            mask_secret("sk-12345678 et sk-court"),
            "[clé masquée] et sk-court"
        );
        assert_eq!(mask_secret(&"x".repeat(500)).chars().count(), 200);
    }
}
