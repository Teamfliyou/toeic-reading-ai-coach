//! Jeton de session administrateur : `base64url(JSON{id,at,version}).hex(HMAC-SHA256)`.
//! Même format que `admin-users.mjs` : les cookies existants restent valides.

use crate::to_hex;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const COOKIE_NAME: &str = "lexora_admin";
/// Durée de vie d'une session : 8 heures.
pub const SESSION_MAX_AGE_MS: i64 = 28_800_000;
/// Taille minimale du secret de session (le serveur refuse de démarrer en dessous).
pub const MIN_SECRET_LEN: usize = 32;

fn base64url(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = vec![];
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        value = (value << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

fn sign(secret: &str, data: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepte toute taille de clé");
    mac.update(data.as_bytes());
    to_hex(&mac.finalize().into_bytes())
}

/// Émet un jeton pour l'utilisateur `id` (version de session `version`) à l'instant `now_ms`.
pub fn issue(secret: &str, id: &str, version: i64, now_ms: i64) -> String {
    // Ordre des clés identique au JS (id, at, version) : jetons octet pour octet identiques.
    let id_json = serde_json::to_string(id).expect("chaîne sérialisable");
    let payload = format!(r#"{{"id":{id_json},"at":{now_ms},"version":{version}}}"#);
    let raw = base64url(payload.as_bytes());
    let sig = sign(secret, &raw);
    format!("{raw}.{sig}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    pub id: String,
    pub version: i64,
}

/// Vérifie signature (temps constant), âge (8 h) et absence de date future.
/// L'appelant doit ensuite confirmer que le compte est actif et que `version` est à jour.
pub fn verify(secret: &str, token: &str, now_ms: i64) -> Option<Claims> {
    let (raw, sig) = token.split_once('.')?;
    if raw.is_empty() || sig.is_empty() {
        return None;
    }
    let expected = sign(secret, raw);
    if sig.len() != expected.len() || !bool::from(sig.as_bytes().ct_eq(expected.as_bytes())) {
        return None;
    }
    let payload: serde_json::Value = serde_json::from_slice(&base64url_decode(raw)?).ok()?;
    let id = payload
        .get("id")?
        .as_str()
        .filter(|s| !s.is_empty())?
        .to_string();
    let at = payload.get("at")?.as_i64()?;
    if now_ms - at > SESSION_MAX_AGE_MS || at > now_ms {
        return None;
    }
    Some(Claims {
        id,
        version: payload.get("version")?.as_i64()?,
    })
}

/// En-tête `Set-Cookie` (`None` = effacement). `HttpOnly`, `SameSite=Strict`, `Secure` si HTTPS.
pub fn session_cookie(token: Option<&str>, secure: bool) -> String {
    format!(
        "{COOKIE_NAME}={}; Path=/api/admin; HttpOnly; {}SameSite=Strict; Max-Age={}",
        token.unwrap_or(""),
        if secure { "Secure; " } else { "" },
        if token.is_some() {
            SESSION_MAX_AGE_MS / 1000
        } else {
            0
        }
    )
}

/// Extrait le jeton du cookie `lexora_admin` d'un en-tête `Cookie`.
pub fn token_from_cookie_header(header: &str) -> Option<&str> {
    header
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("lexora_admin="))
        .filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    const NOW: i64 = 1_760_000_000_000;

    #[test]
    fn jeton_identique_a_celui_de_node() {
        // Valeurs produites par `tokenFor` / `sign` du JS pour {id:"user-1", at:NOW, version:3}.
        let token = issue(SECRET, "user-1", 3, NOW);
        assert_eq!(
            token,
            "eyJpZCI6InVzZXItMSIsImF0IjoxNzYwMDAwMDAwMDAwLCJ2ZXJzaW9uIjozfQ.a47f2f655192585c92cbaf8365dbb17dea86bdf0167f3e946fdd36cceec50ede"
        );
        assert_eq!(
            verify(SECRET, &token, NOW + 1000),
            Some(Claims {
                id: "user-1".into(),
                version: 3
            })
        );
    }

    #[test]
    fn refus_signature_age_et_futur() {
        let token = issue(SECRET, "u", 1, NOW);
        assert!(verify("un-autre-secret-de-32-caracteres!", &token, NOW).is_none());
        let (raw, sig) = token.split_once('.').unwrap();
        let mut forged = sig.to_string();
        forged.replace_range(0..1, if sig.starts_with('a') { "b" } else { "a" });
        assert!(verify(SECRET, &format!("{raw}.{forged}"), NOW).is_none());
        assert!(
            verify(SECRET, &token, NOW + SESSION_MAX_AGE_MS + 1).is_none(),
            "expiré"
        );
        assert!(verify(SECRET, &token, NOW + SESSION_MAX_AGE_MS).is_some());
        assert!(verify(SECRET, &token, NOW - 1).is_none(), "date future");
        for bad in ["", ".", "abc", "a.", ".b", "!!.sig"] {
            assert!(verify(SECRET, bad, NOW).is_none(), "{bad}");
        }
    }

    #[test]
    fn cookies() {
        assert_eq!(
            session_cookie(Some("tok"), true),
            "lexora_admin=tok; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800"
        );
        assert!(
            session_cookie(None, false).ends_with("Max-Age=0")
                && !session_cookie(None, false).contains("Secure")
        );
        assert_eq!(
            token_from_cookie_header("a=1; lexora_admin=abc.def; b=2"),
            Some("abc.def")
        );
        assert_eq!(token_from_cookie_header("a=1"), None);
        assert_eq!(token_from_cookie_header("lexora_admin="), None);
    }
}
