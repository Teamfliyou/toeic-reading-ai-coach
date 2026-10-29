//! Limiteur de débit à fenêtre glissante (en mémoire) et détermination fiable de l'IP cliente.
//! Port de `server/rate-limit.mjs`. En mémoire = un seul processus : sur un déploiement
//! multi-instances, les compteurs durables (quotas, tentatives de connexion) restent en base.

use std::collections::HashMap;
use std::sync::Mutex;

const MAX_BUCKETS: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub ok: bool,
    pub remaining: usize,
    pub retry_after_sec: u64,
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<String, Vec<i64>>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enregistre une requête pour `key` et indique si elle est autorisée.
    pub fn check(&self, key: &str, limit: usize, window_ms: i64, now_ms: i64) -> Decision {
        let (max, window_ms) = (
            if limit > 0 { limit } else { 60 },
            if window_ms > 0 { window_ms } else { 600_000 },
        );
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        let mut recent: Vec<i64> = buckets
            .get(key)
            .map(|v| {
                v.iter()
                    .copied()
                    .filter(|t| now_ms - t < window_ms)
                    .collect()
            })
            .unwrap_or_default();

        if recent.len() >= max {
            let retry = ((window_ms - (now_ms - recent[0])) as f64 / 1000.0)
                .ceil()
                .max(1.0) as u64;
            buckets.insert(key.to_string(), recent);
            return Decision {
                ok: false,
                remaining: 0,
                retry_after_sec: retry,
            };
        }
        recent.push(now_ms);
        let remaining = max - recent.len();
        buckets.insert(key.to_string(), recent);
        if buckets.len() > MAX_BUCKETS {
            buckets.retain(|_, ts| ts.iter().any(|t| now_ms - t < window_ms));
        }
        Decision {
            ok: true,
            remaining,
            retry_after_sec: 0,
        }
    }

    pub fn reset(&self) {
        self.buckets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

/// Adresse IP du client. Les en-têtes de proxy ne sont lus que s'ils sont fiables
/// (`trust_proxy`) : sinon un client pourrait les falsifier. Dans `x-forwarded-for`, on prend
/// la DERNIÈRE valeur (ajoutée par le proxy de confiance), pas la première (fournie par le client).
pub fn client_ip(
    header: impl Fn(&str) -> Option<String>,
    remote: Option<&str>,
    trust_proxy: bool,
) -> String {
    if trust_proxy {
        for name in ["x-vercel-forwarded-for", "x-real-ip"] {
            if let Some(v) = header(name).filter(|v| !v.trim().is_empty()) {
                return v.split(',').next().unwrap_or_default().trim().to_string();
            }
        }
        if let Some(v) = header("x-forwarded-for") {
            if let Some(last) = v.split(',').map(str::trim).rfind(|p| !p.is_empty()) {
                return last.to_string();
            }
        }
    }
    remote.unwrap_or("unknown").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fenetre_glissante() {
        let rl = RateLimiter::new();
        let t0 = 1_000_000;
        assert_eq!(
            rl.check("k", 2, 10_000, t0),
            Decision {
                ok: true,
                remaining: 1,
                retry_after_sec: 0
            }
        );
        assert!(rl.check("k", 2, 10_000, t0 + 1000).ok);
        let blocked = rl.check("k", 2, 10_000, t0 + 2000);
        assert_eq!(
            (blocked.ok, blocked.remaining, blocked.retry_after_sec),
            (false, 0, 8)
        );
        assert!(
            rl.check("autre", 2, 10_000, t0 + 2000).ok,
            "clés indépendantes"
        );
        assert!(
            rl.check("k", 2, 10_000, t0 + 10_001).ok,
            "la fenêtre a glissé"
        );
        rl.reset();
        assert!(rl.check("k", 1, 10_000, t0).ok);
    }

    #[test]
    fn valeurs_par_defaut() {
        let rl = RateLimiter::new();
        for i in 0..60 {
            assert!(rl.check("d", 0, 0, i).ok);
        }
        assert!(!rl.check("d", 0, 0, 61).ok);
    }

    #[test]
    fn ip_cliente_fiable() {
        let headers = |name: &str| match name {
            "x-forwarded-for" => Some("1.2.3.4, 5.6.7.8".to_string()),
            "x-real-ip" => Some("9.9.9.9".to_string()),
            _ => None,
        };
        assert_eq!(
            client_ip(headers, Some("10.0.0.1"), false),
            "10.0.0.1",
            "en-têtes ignorés sans proxy de confiance"
        );
        assert_eq!(client_ip(headers, Some("10.0.0.1"), true), "9.9.9.9");
        let only_xff = |n: &str| (n == "x-forwarded-for").then(|| "1.2.3.4, 5.6.7.8".to_string());
        assert_eq!(
            client_ip(only_xff, None, true),
            "5.6.7.8",
            "dernière valeur, pas la première"
        );
        assert_eq!(client_ip(|_| None, None, true), "unknown");
    }
}
