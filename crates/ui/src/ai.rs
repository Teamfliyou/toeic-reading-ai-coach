//! Appels au coach IA. Ils passent par une commande native Tauri (reqwest) : pas de CORS, pas
//! d'en-tête `Origin` du navigateur, et la clé personnelle ne transite que vers le serveur Lernoviq.

use crate::bridge;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Explanation {
    pub diagnostic: String,
    pub resolution: String,
    pub tip: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainReply {
    pub explanation: Explanation,
    pub lesson: Option<serde_json::Value>,
    #[serde(default)]
    pub latency_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplainArgs<'a> {
    question_id: &'a str,
    selected_key: &'a str,
    user_key: Option<&'a str>,
}

pub const OFFLINE_MESSAGE: &str = "Vous êtes hors ligne : l'explication du coach nécessite une connexion. Les exercices restent accessibles.";

pub async fn explain(
    question_id: &str,
    selected: char,
    user_key: Option<&str>,
) -> Result<ExplainReply, String> {
    if !bridge::online() {
        return Err(OFFLINE_MESSAGE.into());
    }
    bridge::invoke(
        "explain",
        &ExplainArgs {
            question_id,
            selected_key: &selected.to_string(),
            user_key,
        },
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FollowArgs<'a> {
    question_id: &'a str,
    selected_key: &'a str,
    message: &'a str,
    user_key: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FollowReply {
    pub answer: String,
}

/// Question de relance sur une explication.
pub async fn follow_up(
    question_id: &str,
    selected: char,
    message: &str,
    user_key: Option<&str>,
) -> Result<FollowReply, String> {
    if !bridge::online() {
        return Err(OFFLINE_MESSAGE.into());
    }
    bridge::invoke(
        "follow_up",
        &FollowArgs {
            question_id,
            selected_key: &selected.to_string(),
            message,
            user_key,
        },
    )
    .await
}
