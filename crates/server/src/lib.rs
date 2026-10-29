//! Serveur Lernoviq (axum) : API IA protégée (quotas, budget, limitation de débit).
//! La clé DeepSeek du service et la clé `service_role` Supabase ne vivent que dans ce processus.

pub mod app;
pub mod backend;
pub mod config;
pub mod dataset;

pub use app::{router, AppState};
pub use backend::{Backend, NoBackend, SupabaseBackend};
pub use config::Config;
