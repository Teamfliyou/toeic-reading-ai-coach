//! Configuration du serveur, lue depuis l'environnement (mêmes variables que le serveur Node).
//! Les secrets ne sont jamais journalisés : `Debug` les masque.

use std::fmt;

#[derive(Clone)]
pub struct Config {
    /// Clé DeepSeek du SERVICE (jamais envoyée au client).
    pub deepseek_api_key: Option<String>,
    pub deepseek_base_url: String,
    pub deepseek_model: String,
    pub deepseek_timeout_ms: u64,
    pub deepseek_max_tokens: u32,
    pub deepseek_thinking: bool,
    pub supabase_url: Option<String>,
    pub supabase_service_key: Option<String>,
    pub supabase_anon_key: Option<String>,
    pub trust_proxy: bool,
    pub restrict_origin: bool,
    /// Origines autorisées en plus de l'hôte du serveur (application de bureau Tauri).
    pub allowed_origins: Vec<String>,
    pub free_requires_auth: bool,
    pub server_key_fallback: bool,
    pub user_daily_limit: u32,
    pub user_per_minute: u32,
    pub anon_daily_limit: u32,
    pub anon_per_minute: u32,
    pub explain_rate_limit: usize,
    pub explain_rate_window_ms: i64,
    pub user_rate_window_ms: i64,
    pub estimated_call_usd: Option<f64>,
    pub budget_limit_usd: f64,
    pub budget_suspend_usd: f64,
    pub max_body_bytes: usize,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mask = |o: &Option<String>| if o.is_some() { "<défini>" } else { "<absent>" };
        f.debug_struct("Config")
            .field("deepseek_api_key", &mask(&self.deepseek_api_key))
            .field("supabase_service_key", &mask(&self.supabase_service_key))
            .field("supabase_url", &self.supabase_url)
            .field("trust_proxy", &self.trust_proxy)
            .field("free_requires_auth", &self.free_requires_auth)
            .finish_non_exhaustive()
    }
}

impl Default for Config {
    fn default() -> Self {
        Self::from_lookup(|_| None)
    }
}

/// `false` seulement pour la valeur « false » (insensible à la casse), comme le JS.
fn flag(v: Option<String>, fallback: bool) -> bool {
    match v.as_deref() {
        None | Some("") => fallback,
        Some(s) => !s.eq_ignore_ascii_case("false"),
    }
}

impl Config {
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let text = |k: &str| {
            get(k)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let num = |k: &str| {
            text(k)
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|n| n.is_finite() && *n > 0.0)
        };
        let rate = num("AI_USD_EUR_RATE").unwrap_or(0.93);
        let to_usd = |eur: f64| (eur / rate * 10_000.0).round() / 10_000.0;
        let mut allowed = vec![
            "tauri://localhost".to_string(),
            "http://tauri.localhost".into(),
            "https://tauri.localhost".into(),
        ];
        if let Some(extra) = text("ALLOWED_ORIGINS") {
            allowed.extend(
                extra
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            );
        }
        Self {
            deepseek_api_key: text("DEEPSEEK_API_KEY"),
            deepseek_base_url: text("DEEPSEEK_BASE_URL")
                .unwrap_or_else(|| lernoviq_ai::config::DEEPSEEK_BASE_URL.into()),
            deepseek_model: text("DEEPSEEK_MODEL")
                .unwrap_or_else(|| lernoviq_ai::config::DEEPSEEK_MODEL.into()),
            deepseek_timeout_ms: num("DEEPSEEK_TIMEOUT_MS").map_or(22_000, |n| n as u64),
            deepseek_max_tokens: num("DEEPSEEK_MAX_TOKENS").map_or(1024, |n| n as u32),
            deepseek_thinking: flag(get("DEEPSEEK_THINKING_ENABLED"), false),
            supabase_url: text("SUPABASE_URL").or_else(|| text("VITE_SUPABASE_URL")),
            supabase_service_key: text("SUPABASE_SERVICE_ROLE_KEY"),
            supabase_anon_key: text("SUPABASE_ANON_KEY")
                .or_else(|| text("VITE_SUPABASE_PUBLISHABLE_KEY")),
            trust_proxy: get("TRUST_PROXY").as_deref() == Some("true")
                || get("VERCEL").is_some_and(|v| !v.is_empty()),
            restrict_origin: flag(get("EXPLAIN_RESTRICT_ORIGIN"), true),
            allowed_origins: allowed,
            free_requires_auth: flag(get("AI_FREE_REQUIRES_AUTH"), false),
            server_key_fallback: flag(get("ALLOW_SERVER_KEY_FALLBACK"), true),
            user_daily_limit: num("AI_DAILY_LIMIT").map_or(10, |n| n as u32),
            user_per_minute: num("AI_PER_MINUTE").map_or(3, |n| n as u32),
            anon_daily_limit: num("AI_ANON_DAILY_LIMIT").map_or(5, |n| n as u32),
            anon_per_minute: num("AI_ANON_PER_MINUTE").map_or(2, |n| n as u32),
            explain_rate_limit: num("EXPLAIN_RATE_LIMIT").map_or(60, |n| n as usize),
            explain_rate_window_ms: num("EXPLAIN_RATE_WINDOW_MS").map_or(600_000, |n| n as i64),
            user_rate_window_ms: num("AI_PER_MINUTE_WINDOW_MS").map_or(60_000, |n| n as i64),
            estimated_call_usd: num("AI_ESTIMATED_CALL_USD"),
            budget_limit_usd: num("AI_MONTHLY_LIMIT_USD")
                .unwrap_or_else(|| to_usd(num("AI_MONTHLY_LIMIT_EUR").unwrap_or(10.0))),
            budget_suspend_usd: num("AI_MONTHLY_SUSPEND_USD")
                .unwrap_or_else(|| to_usd(num("AI_MONTHLY_SUSPEND_EUR").unwrap_or(8.0))),
            max_body_bytes: 16 * 1024,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn valeurs_par_defaut() {
        let c = Config::default();
        assert!(
            c.deepseek_api_key.is_none()
                && !c.free_requires_auth
                && c.server_key_fallback
                && c.restrict_origin
        );
        assert_eq!(
            (
                c.user_daily_limit,
                c.user_per_minute,
                c.anon_daily_limit,
                c.anon_per_minute
            ),
            (10, 3, 5, 2)
        );
        assert_eq!(c.budget_limit_usd, 10.7527); // 10 € / 0,93
        assert_eq!(c.budget_suspend_usd, 8.6022);
        assert!(c.allowed_origins.contains(&"tauri://localhost".to_string()));
    }

    #[test]
    fn surcharges_et_indicateurs() {
        let c = cfg(&[
            ("AI_FREE_REQUIRES_AUTH", "TRUE"),
            ("ALLOW_SERVER_KEY_FALLBACK", "False"),
            ("AI_DAILY_LIMIT", "25"),
            ("TRUST_PROXY", "true"),
            ("AI_MONTHLY_LIMIT_USD", "5"),
            ("ALLOWED_ORIGINS", "https://a.fr, https://b.fr"),
        ]);
        assert!(c.free_requires_auth && !c.server_key_fallback && c.trust_proxy);
        assert_eq!((c.user_daily_limit, c.budget_limit_usd), (25, 5.0));
        assert!(c.allowed_origins.contains(&"https://b.fr".to_string()));
        assert!(
            cfg(&[("AI_DAILY_LIMIT", "abc")]).user_daily_limit == 10,
            "valeur invalide : défaut"
        );
    }

    #[test]
    fn secrets_masques_dans_debug() {
        let c = cfg(&[
            ("DEEPSEEK_API_KEY", "sk-super-secret-123456"),
            ("SUPABASE_SERVICE_ROLE_KEY", "service-secret-xyz"),
        ]);
        let shown = format!("{c:?}");
        assert!(
            !shown.contains("super-secret")
                && !shown.contains("service-secret")
                && shown.contains("<défini>")
        );
    }
}
