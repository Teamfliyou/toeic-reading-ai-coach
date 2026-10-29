//! Sécurité : mots de passe (scrypt), sessions signées, TOTP (RFC 6238) et limitation de débit.
//! Port de `server/admin-users.mjs`, `server/totp.mjs` et `server/rate-limit.mjs`.
//! Les formats sont compatibles avec les comptes et cookies existants.

pub mod password;
pub mod ratelimit;
pub mod session;
pub mod totp;

/// Octets aléatoires du système d'exploitation.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("générateur aléatoire du système indisponible");
    buf
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}
