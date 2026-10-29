//! Mots de passe : scrypt (N=16384, r=8, p=1, 64 octets), sel hexadécimal utilisé comme texte,
//! exactement comme `scryptSync(password, salt, 64)` de Node : les hachages existants restent valides.

use crate::{from_hex, random_bytes, to_hex};
use regex::Regex;
use std::sync::OnceLock;
use subtle::ConstantTimeEq;

fn derive(password: &str, salt: &str) -> Vec<u8> {
    let params = scrypt::Params::new(14, 8, 1, 64).expect("paramètres scrypt valides");
    let mut out = vec![0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out)
        .expect("sortie scrypt valide");
    out
}

/// Nouveau sel (24 octets, en hexadécimal) et hachage hexadécimal.
pub fn hash_password(password: &str) -> (String, String) {
    let salt = to_hex(&random_bytes::<24>());
    let hash = to_hex(&derive(password, &salt));
    (salt, hash)
}

/// Vérification en temps constant.
pub fn verify_password(password: &str, salt: &str, hash_hex: &str) -> bool {
    let computed = derive(password, salt);
    match from_hex(hash_hex) {
        Some(expected) => expected.len() == computed.len() && bool::from(expected.ct_eq(&computed)),
        None => false,
    }
}

/// Calcul factice pour un compte inexistant : même durée, aucune fuite d'existence du compte.
pub fn dummy_verify(password: &str) {
    let _ = derive(password, "bca923edcb90df23d4ef42abc123aaa3");
}

pub fn validate_username(username: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$").expect("regex valide"))
        .is_match(username)
}

/// 12 à 256 caractères.
pub fn validate_password(password: &str) -> bool {
    (12..=256).contains(&password.chars().count())
}

pub fn valid_role(role: &str) -> bool {
    matches!(role, "admin" | "editor")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Valeur produite par `scryptSync("correct horse battery", "bca9…aaa3", 64)` de Node.
    const NODE_HASH: &str = "b5f6742ca93a5da6767f60eae22bc4039832c664e12c74c3b6c0d9b3d881393bd7f648f8ce8f92f74fe04713aa5cc184e51e7767b65bc6635c3ff545a7c4059a";
    const SALT: &str = "bca923edcb90df23d4ef42abc123aaa3";

    #[test]
    fn compatible_avec_les_hachages_node() {
        assert!(verify_password("correct horse battery", SALT, NODE_HASH));
        assert!(!verify_password("correct horse batterz", SALT, NODE_HASH));
        assert!(!verify_password(
            "correct horse battery",
            "autre",
            NODE_HASH
        ));
        assert!(!verify_password("x", SALT, "pas-hex"));
        assert!(!verify_password("x", SALT, "abcd"));
    }

    #[test]
    fn aller_retour_et_sels_distincts() {
        let (salt1, hash1) = hash_password("un mot de passe solide");
        let (salt2, hash2) = hash_password("un mot de passe solide");
        assert_eq!(salt1.len(), 48);
        assert_ne!(salt1, salt2);
        assert_ne!(hash1, hash2);
        assert!(verify_password("un mot de passe solide", &salt1, &hash1));
        dummy_verify("x");
    }

    #[test]
    fn regles_de_validation() {
        assert!(validate_username("admin") && validate_username("a.b-c_9"));
        assert!(
            !validate_username("1admin") && !validate_username("ab") && !validate_username("a b c")
        );
        assert!(!validate_username(&format!("a{}", "b".repeat(32))));
        assert!(validate_password("exactement12!") && !validate_password("trop court"));
        assert!(!validate_password(&"x".repeat(257)));
        assert!(valid_role("admin") && valid_role("editor") && !valid_role("root"));
    }
}
