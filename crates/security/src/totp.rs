//! TOTP (RFC 6238) : HMAC-SHA1, pas de 30 s, 6 chiffres. Port de `server/totp.mjs`.
//! Brique prête pour la MFA de l'administration (pas encore imposée, voir `docs/admin-mfa.md`).

use crate::random_bytes;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use subtle::ConstantTimeEq;

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(data: &[u8]) -> String {
    let (mut bits, mut value, mut out) = (0u32, 0u32, String::new());
    for byte in data {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn base32_decode(text: &str) -> Result<Vec<u8>, &'static str> {
    let (mut bits, mut value, mut out) = (0u32, 0u32, vec![]);
    for c in text
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=' && *c != '-')
    {
        let index = ALPHABET
            .iter()
            .position(|a| *a as char == c)
            .ok_or("Secret TOTP invalide (base32 attendu).")?;
        value = (value << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
    }
    Ok(out)
}

/// Nouveau secret aléatoire de 160 bits, en base32.
pub fn generate_secret() -> String {
    base32_encode(&random_bytes::<20>())
}

/// Code pour l'instant `time_ms`.
pub fn totp(
    secret_base32: &str,
    time_ms: i64,
    step: i64,
    digits: u32,
) -> Result<String, &'static str> {
    let counter = (time_ms / 1000 / step) as u64;
    let key = base32_decode(secret_base32)?;
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).expect("HMAC accepte toute taille de clé");
    mac.update(&counter.to_be_bytes());
    let hmac = mac.finalize().into_bytes();
    let offset = (hmac[hmac.len() - 1] & 15) as usize;
    let binary = (u32::from(hmac[offset] & 0x7f) << 24)
        | (u32::from(hmac[offset + 1]) << 16)
        | (u32::from(hmac[offset + 2]) << 8)
        | u32::from(hmac[offset + 3]);
    Ok(format!(
        "{:0width$}",
        u64::from(binary) % 10u64.pow(digits),
        width = digits as usize
    ))
}

/// Vérifie un code en tolérant `window` pas de décalage d'horloge (±30 s par défaut).
/// Comparaison en temps constant sur tous les pas.
pub fn verify_totp(secret_base32: &str, token: &str, time_ms: i64, window: i64) -> bool {
    let candidate: String = token.chars().filter(|c| !c.is_whitespace()).collect();
    if candidate.len() != 6 || !candidate.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let mut ok = false;
    for drift in -window..=window {
        if let Ok(expected) = totp(secret_base32, time_ms + drift * 30_000, 30, 6) {
            ok |= bool::from(expected.as_bytes().ct_eq(candidate.as_bytes()));
        }
    }
    ok
}

/// Équivalent de `encodeURIComponent` de JavaScript.
fn uri_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// URL `otpauth://` à encoder en QR code.
pub fn otpauth_url(secret: &str, account: &str, issuer: &str) -> String {
    format!(
        "otpauth://totp/{}:{}?secret={secret}&issuer={}&algorithm=SHA1&digits=6&period=30",
        uri_component(issuer),
        uri_component(account),
        uri_component(issuer)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // « 12345678901234567890 »

    #[test]
    fn base32() {
        assert_eq!(base32_encode(b"12345678901234567890"), SECRET);
        assert_eq!(
            base32_decode(&SECRET.to_lowercase().replace('Q', "q=")).unwrap(),
            b"12345678901234567890"
        );
        assert!(base32_decode("1!").is_err());
        assert_eq!(base32_decode(&generate_secret()).unwrap().len(), 20);
    }

    // Vecteurs de la RFC 6238 (SHA-1, 8 chiffres) et valeur calculée par le JS pour 6 chiffres.
    #[test]
    fn vecteurs_rfc_6238() {
        assert_eq!(totp(SECRET, 59_000, 30, 8).unwrap(), "94287082");
        assert_eq!(totp(SECRET, 1_111_111_109_000, 30, 8).unwrap(), "07081804");
        assert_eq!(totp(SECRET, 1_760_000_000_000, 30, 6).unwrap(), "466049");
    }

    #[test]
    fn verification_avec_tolerance() {
        let t = 1_760_000_000_000;
        assert!(verify_totp(SECRET, "466049", t, 1));
        assert!(verify_totp(SECRET, "466 049", t, 1));
        let next = totp(SECRET, t + 30_000, 30, 6).unwrap();
        assert!(verify_totp(SECRET, &next, t, 1), "pas suivant toléré");
        let far = totp(SECRET, t + 90_000, 30, 6).unwrap();
        assert!(!verify_totp(SECRET, &far, t, 1), "trop loin");
        assert!(!verify_totp(SECRET, "12345", t, 1) && !verify_totp(SECRET, "abcdef", t, 1));
    }

    #[test]
    fn url_otpauth_identique_au_js() {
        assert_eq!(
            otpauth_url("ABC", "a b@x.fr", "Lernoviq"),
            "otpauth://totp/Lernoviq:a%20b%40x.fr?secret=ABC&issuer=Lernoviq&algorithm=SHA1&digits=6&period=30"
        );
    }
}
