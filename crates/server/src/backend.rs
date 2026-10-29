//! Accès aux services externes (Supabase) derrière un trait, pour pouvoir tester le serveur
//! sans réseau. `SupabaseBackend` parle à PostgREST avec la clé `service_role` (côté serveur
//! uniquement) ; sans Supabase configuré, `NoBackend` laisse l'application fonctionner en local.

use crate::config::Config;
use async_trait::async_trait;
use lernoviq_ai::{ExplainQuestion, Explanation, Lesson, Usage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiUser {
    pub id: String,
}

#[derive(Debug, Clone)]
pub struct ReserveRequest {
    pub actor: String,
    pub daily_limit: u32,
    pub per_minute: u32,
    pub window_seconds: u32,
    pub estimated_usd: f64,
    pub limit_usd: f64,
    pub suspend_usd: f64,
    pub month: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reservation {
    pub ok: bool,
    /// `quota`, `rate`, `budget`, `in_flight` ou `unavailable`.
    pub reason: Option<String>,
    pub event_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CachedExplanation {
    pub id: String,
    pub explanation: Value,
    pub lesson: Value,
}

#[derive(Debug, Clone)]
pub struct SaveEntry {
    pub question_id: String,
    pub selected_key: char,
    pub prompt_version: String,
    pub model: String,
    pub explanation: Explanation,
    pub lesson: Option<Lesson>,
    pub user_id: Option<String>,
    pub usage: Usage,
}

pub type BackendResult<T> = Result<T, String>;

#[async_trait]
pub trait Backend: Send + Sync {
    /// Quotas et budget actifs (Supabase `service_role` configuré).
    fn quota_enabled(&self) -> bool;
    /// Valide un jeton Supabase Auth.
    async fn verify_user(&self, token: &str) -> Option<AiUser>;
    /// Question absente du jeu local (banque Supabase).
    async fn find_question(&self, id: &str) -> BackendResult<Option<ExplainQuestion>>;
    async fn cached(
        &self,
        question_id: &str,
        selected_key: char,
        prompt_version: &str,
        model: &str,
    ) -> Option<CachedExplanation>;
    async fn touch(&self, id: &str);
    async fn save(&self, entry: SaveEntry);
    async fn reserve(&self, request: ReserveRequest) -> BackendResult<Reservation>;
    async fn finalize(&self, event_id: &str, actual_usd: f64);
    async fn release(&self, event_id: &str);
}

/// Aucun service externe : pas de quota, pas de cache, pas d'utilisateurs.
pub struct NoBackend;

#[async_trait]
impl Backend for NoBackend {
    fn quota_enabled(&self) -> bool {
        false
    }
    async fn verify_user(&self, _: &str) -> Option<AiUser> {
        None
    }
    async fn find_question(&self, _: &str) -> BackendResult<Option<ExplainQuestion>> {
        Ok(None)
    }
    async fn cached(&self, _: &str, _: char, _: &str, _: &str) -> Option<CachedExplanation> {
        None
    }
    async fn touch(&self, _: &str) {}
    async fn save(&self, _: SaveEntry) {}
    async fn reserve(&self, _: ReserveRequest) -> BackendResult<Reservation> {
        Ok(Reservation {
            ok: true,
            reason: None,
            event_id: None,
        })
    }
    async fn finalize(&self, _: &str, _: f64) {}
    async fn release(&self, _: &str) {}
}

pub struct SupabaseBackend {
    http: reqwest::Client,
    base: String,
    service_key: Option<String>,
    anon_key: Option<String>,
    users: Mutex<HashMap<String, (AiUser, Instant)>>,
}

const USER_CACHE_TTL: Duration = Duration::from_secs(60);
const USER_CACHE_MAX: usize = 1000;

impl SupabaseBackend {
    /// `None` si Supabase n'est pas configuré.
    pub fn from_config(config: &Config) -> Option<Self> {
        let base = config
            .supabase_url
            .clone()?
            .trim_end_matches('/')
            .to_string();
        Some(Self {
            http: reqwest::Client::new(),
            base,
            service_key: config.supabase_service_key.clone(),
            anon_key: config.supabase_anon_key.clone(),
            users: Mutex::new(HashMap::new()),
        })
    }

    fn service(&self, req: reqwest::RequestBuilder) -> Option<reqwest::RequestBuilder> {
        let key = self.service_key.as_ref()?;
        Some(
            req.header("apikey", key)
                .bearer_auth(key)
                .timeout(Duration::from_secs(6)),
        )
    }

    async fn rpc(&self, name: &str, body: Value) -> BackendResult<Value> {
        let req = self
            .service(self.http.post(format!("{}/rest/v1/rpc/{name}", self.base)))
            .ok_or("clé service absente")?;
        let res = req
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Supabase RPC {name} : {e}"))?;
        if !res.status().is_success() {
            return Err(format!("Supabase RPC {name} : {}", res.status().as_u16()));
        }
        let text = res.text().await.unwrap_or_default();
        Ok(if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        })
    }

    async fn rest_get(&self, path: &str, anon: bool) -> BackendResult<Value> {
        let key = if anon {
            self.anon_key.as_ref()
        } else {
            self.service_key.as_ref()
        }
        .ok_or("clé absente")?;
        let res = self
            .http
            .get(format!("{}/rest/v1/{path}", self.base))
            .header("apikey", key)
            .bearer_auth(key)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("Supabase {} sur {path}", res.status().as_u16()));
        }
        res.json().await.map_err(|e| e.to_string())
    }
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn fingerprint(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Met en forme les documents d'un passage JSON (`documents: [{title, body[]}]`).
pub fn render_documents_json(documents: &Value) -> String {
    let docs: Vec<(String, Vec<String>)> = documents
        .as_array()
        .map(|list| {
            list.iter()
                .map(|d| {
                    let title = d["title"].as_str().unwrap_or_default().to_string();
                    let body = d["body"]
                        .as_array()
                        .map(|b| {
                            b.iter()
                                .filter_map(|l| l.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    (title, body)
                })
                .collect()
        })
        .unwrap_or_default();
    lernoviq_ai::prompt::render_documents(&docs)
}

#[async_trait]
impl Backend for SupabaseBackend {
    fn quota_enabled(&self) -> bool {
        self.service_key.is_some()
    }

    async fn verify_user(&self, token: &str) -> Option<AiUser> {
        let anon = self.anon_key.as_ref()?;
        let key = fingerprint(token);
        if let Some((user, until)) = self.users.lock().ok()?.get(&key) {
            if *until > Instant::now() {
                return Some(user.clone());
            }
        }
        let res = self
            .http
            .get(format!("{}/auth/v1/user", self.base))
            .header("apikey", anon)
            .bearer_auth(token)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        let body: Value = res.json().await.ok()?;
        let user = AiUser {
            id: body.get("id")?.as_str()?.to_string(),
        };
        let mut cache = self.users.lock().ok()?;
        if cache.len() >= USER_CACHE_MAX {
            cache.clear();
        }
        cache.insert(key, (user.clone(), Instant::now() + USER_CACHE_TTL));
        Some(user)
    }

    async fn find_question(&self, id: &str) -> BackendResult<Option<ExplainQuestion>> {
        let rows = self
            .rest_get(&format!("questions?id=eq.{}&select=id,part,prompt,options,correct_key,passage_id&limit=1", enc(id)), true)
            .await
            .map_err(|_| "Impossible de récupérer la question Supabase.".to_string())?;
        let Some(row) = rows.get(0) else {
            return Ok(None);
        };
        let mut context = String::new();
        if let Some(pid) = row["passage_id"].as_str() {
            // Un passage indisponible ne bloque pas la correction.
            if let Ok(p) = self
                .rest_get(
                    &format!("passages?id=eq.{}&select=documents&limit=1", enc(pid)),
                    true,
                )
                .await
            {
                context = render_documents_json(&p[0]["documents"]);
            }
        }
        let options = row["options"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|o| {
                        Some((
                            o["key"].as_str()?.chars().next()?,
                            o["text"].as_str()?.to_string(),
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(Some(ExplainQuestion {
            part: row["part"].as_u64().unwrap_or(5) as u8,
            prompt: row["prompt"].as_str().unwrap_or_default().to_string(),
            options,
            correct_key: row["correct_key"]
                .as_str()
                .and_then(|s| s.chars().next())
                .unwrap_or('A'),
            context,
        }))
    }

    async fn cached(
        &self,
        question_id: &str,
        selected_key: char,
        prompt_version: &str,
        model: &str,
    ) -> Option<CachedExplanation> {
        let path = format!(
            "ai_explanations?question_id=eq.{}&selected_key=eq.{selected_key}&prompt_version=eq.{}&model=eq.{}&select=id,payload,lesson&limit=1",
            enc(question_id),
            enc(prompt_version),
            enc(model)
        );
        let rows = self.rest_get(&path, false).await.ok()?;
        let row = rows.get(0)?;
        Some(CachedExplanation {
            id: row["id"].as_str()?.to_string(),
            explanation: row["payload"].clone(),
            lesson: row["lesson"].clone(),
        })
    }

    async fn touch(&self, id: &str) {
        let _ = self.rpc("ai_touch_explanation", json!({"p_id": id})).await;
    }

    async fn save(&self, e: SaveEntry) {
        let Some(req) = self.service(self.http.post(format!(
            "{}/rest/v1/ai_explanations?on_conflict=question_id,selected_key,prompt_version,model",
            self.base
        ))) else {
            return;
        };
        let body = json!([{
            "question_id": e.question_id, "selected_key": e.selected_key.to_string(),
            "prompt_version": e.prompt_version, "model": e.model,
            "payload": {"diagnostic": e.explanation.diagnostic, "resolution": e.explanation.resolution, "tip": e.explanation.tip},
            "lesson": e.lesson.as_ref().map(|l| json!({"topic": l.topic, "title": l.title, "rule": l.rule, "example": l.example,
                                                      "exercise": l.exercise, "answer": l.answer, "tip": l.tip})),
            "user_id": e.user_id, "prompt_tokens": e.usage.input_tokens, "completion_tokens": e.usage.output_tokens,
            "cache_hit_tokens": e.usage.cache_hit_tokens, "cost_usd": e.usage.estimated_usd,
        }]);
        let _ = req
            .header("Prefer", "resolution=merge-duplicates,return=minimal")
            .json(&body)
            .send()
            .await;
    }

    async fn reserve(&self, r: ReserveRequest) -> BackendResult<Reservation> {
        let v = self
            .rpc(
                "ai_reserve_explain",
                json!({"p_actor": r.actor, "p_daily_limit": r.daily_limit, "p_per_minute": r.per_minute,
                       "p_window_seconds": r.window_seconds, "p_estimated_usd": r.estimated_usd, "p_month": r.month,
                       "p_limit_usd": r.limit_usd, "p_suspend_usd": r.suspend_usd}),
            )
            .await?;
        if v.is_null() {
            return Ok(Reservation {
                ok: false,
                reason: Some("unavailable".into()),
                event_id: None,
            });
        }
        Ok(Reservation {
            ok: v["ok"].as_bool().unwrap_or(false),
            reason: v["reason"].as_str().map(String::from),
            event_id: v["event_id"]
                .as_str()
                .or_else(|| v["eventId"].as_str())
                .map(String::from),
        })
    }

    async fn finalize(&self, event_id: &str, actual_usd: f64) {
        let _ = self
            .rpc(
                "ai_finalize_explain",
                json!({"p_event": event_id, "p_actual_usd": actual_usd}),
            )
            .await;
    }

    async fn release(&self, event_id: &str) {
        let _ = self
            .rpc("ai_release_explain", json!({"p_event": event_id}))
            .await;
    }
}
