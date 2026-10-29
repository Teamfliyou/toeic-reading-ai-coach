//! Constantes DeepSeek, heures de pointe et coût d'un appel.

use chrono::{DateTime, Datelike, Timelike, Utc, Weekday};
use serde::Serialize;
use serde_json::Value;

pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
/// Modèle par défaut (DeepSeek-V4.1-Flash).
pub const DEEPSEEK_MODEL: &str = "deepseek-flash";
/// À incrémenter dès qu'un prompt change : les explications en cache d'une ancienne version
/// ne sont plus servies.
pub const PROMPT_VERSION: &str = "2026-10-22.1";

// Prix « deepseek-flash » hors heures de pointe, en USD par million de tokens.
const PRICE_CACHE_MISS: f64 = 0.15;
const PRICE_CACHE_HIT: f64 = 0.003;
const PRICE_OUTPUT: f64 = 0.6;

/// Estimation a priori d'un appel (réservation de budget), volontairement majorée.
pub const DEFAULT_ESTIMATED_CALL_USD: f64 = 0.004;

/// Heures de pointe DeepSeek : 01–04 h et 06–10 h UTC, du lundi au vendredi.
pub fn is_peak_utc(now: DateTime<Utc>) -> bool {
    let weekday = !matches!(now.weekday(), Weekday::Sat | Weekday::Sun);
    let hour = now.hour();
    weekday && ((1..4).contains(&hour) || (6..10).contains(&hour))
}

/// Estimation de la réservation : `override_usd` (variable d'environnement) si valide.
pub fn estimate_cost_usd(override_usd: Option<f64>) -> f64 {
    override_usd
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(DEFAULT_ESTIMATED_CALL_USD)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_hit_tokens: u64,
    pub estimated_usd: f64,
    pub rate_period: &'static str,
    pub model: String,
}

fn count(v: &Value, key: &str) -> u64 {
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map_or(0, |n| n as u64)
}

/// Coût réel d'un appel à partir de l'objet `usage` renvoyé par DeepSeek.
pub fn compute_cost(usage: &Value, now: DateTime<Utc>, model: &str) -> Usage {
    let input = count(usage, "prompt_tokens");
    let output = count(usage, "completion_tokens");
    let hit = input.min(count(usage, "prompt_cache_hit_tokens"));
    let miss = input - hit;
    let rate = if is_peak_utc(now) { 2.0 } else { 1.0 };
    let usd = (miss as f64 * PRICE_CACHE_MISS
        + hit as f64 * PRICE_CACHE_HIT
        + output as f64 * PRICE_OUTPUT)
        / 1e6
        * rate;
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_hit_tokens: hit,
        estimated_usd: round6(usd),
        rate_period: if rate == 2.0 { "peak" } else { "off-peak" },
        model: model.to_string(),
    }
}

fn round6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

/// Additionne deux relevés (tentatives successives d'un même appel).
pub fn add_usage(a: Option<Usage>, b: Usage) -> Usage {
    match a {
        None => b,
        Some(a) => Usage {
            input_tokens: a.input_tokens + b.input_tokens,
            output_tokens: a.output_tokens + b.output_tokens,
            cache_hit_tokens: a.cache_hit_tokens + b.cache_hit_tokens,
            estimated_usd: round6(a.estimated_usd + b.estimated_usd),
            ..a
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn at(day: u32, hour: u32) -> DateTime<Utc> {
        // 2026-10-26 est un lundi.
        Utc.with_ymd_and_hms(2026, 10, day, hour, 0, 0).unwrap()
    }

    #[test]
    fn heures_de_pointe() {
        assert!(is_peak_utc(at(26, 2)));
        assert!(is_peak_utc(at(26, 6)));
        assert!(!is_peak_utc(at(26, 4)));
        assert!(!is_peak_utc(at(26, 10)));
        assert!(!is_peak_utc(at(31, 2)), "samedi");
        assert!(!is_peak_utc(at(25, 7)), "dimanche");
    }

    #[test]
    fn cout_hors_pointe_et_pointe() {
        let usage = json!({"prompt_tokens": 1000, "completion_tokens": 500, "prompt_cache_hit_tokens": 400});
        let off = compute_cost(&usage, at(26, 12), "m");
        assert_eq!(
            (off.input_tokens, off.output_tokens, off.cache_hit_tokens),
            (1000, 500, 400)
        );
        assert_eq!(off.estimated_usd, 0.000391);
        assert_eq!(off.rate_period, "off-peak");
        let peak = compute_cost(&usage, at(26, 2), "m");
        assert_eq!(peak.estimated_usd, 0.000782);
        assert_eq!(peak.rate_period, "peak");
    }

    #[test]
    fn usage_invalide_ou_absent() {
        let u = compute_cost(
            &json!({"prompt_tokens": "x", "prompt_cache_hit_tokens": 50}),
            at(26, 12),
            "m",
        );
        assert_eq!(
            (u.input_tokens, u.cache_hit_tokens, u.estimated_usd),
            (0, 0, 0.0)
        );
        assert_eq!(
            compute_cost(&Value::Null, at(26, 12), "m").estimated_usd,
            0.0
        );
        let hit_over = compute_cost(
            &json!({"prompt_tokens": 10, "prompt_cache_hit_tokens": 99}),
            at(26, 12),
            "m",
        );
        assert_eq!(
            hit_over.cache_hit_tokens, 10,
            "le cache ne dépasse jamais l'entrée"
        );
    }

    #[test]
    fn cumul_et_estimation() {
        let a = compute_cost(
            &json!({"prompt_tokens": 100, "completion_tokens": 100}),
            at(26, 12),
            "m",
        );
        let sum = add_usage(Some(a.clone()), a.clone());
        assert_eq!((sum.input_tokens, sum.output_tokens), (200, 200));
        assert_eq!(sum.estimated_usd, round6(a.estimated_usd * 2.0));
        assert_eq!(add_usage(None, a.clone()), a);
        assert_eq!(estimate_cost_usd(None), 0.004);
        assert_eq!(estimate_cost_usd(Some(0.01)), 0.01);
        assert_eq!(estimate_cost_usd(Some(-1.0)), 0.004);
        assert_eq!(estimate_cost_usd(Some(f64::NAN)), 0.004);
    }
}
