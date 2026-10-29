//! Coach IA DeepSeek : prompts, coût, validation de la réponse et client HTTP.
//! Port de `server/deepseek-config.mjs`, `server/explanation-schema.mjs` et du cœur de
//! `server/explain.mjs`.
//!
//! La clé du service n'est JAMAIS dans ce crate : elle est fournie à l'appel par le serveur
//! (ou par l'utilisateur, pour sa clé personnelle). Aucune clé n'est journalisée.

pub mod client;
pub mod config;
pub mod prompt;
pub mod schema;

pub use client::{
    AiError, AiFailure, DeepSeekClient, ExplainOutcome, ExplainQuestion, FollowOutcome,
};
pub use config::{compute_cost, Usage};
pub use schema::{parse_explanation, Explanation, Lesson, ParseFailure, Parsed};
