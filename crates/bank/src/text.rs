//! Normalisation, empreintes et similarité des questions. Port de `server/bank/text.mjs`.
//!
//! Les empreintes reproduisent EXACTEMENT les fonctions SQL `bank_question_hash` /
//! `bank_passage_hash` ; les bandes LSH sont identiques à celles du JS (tests de référence).

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// Même règle que `bank_norm` en SQL : minuscules, tout caractère hors [a-z0-9] devient un espace.
pub fn norm(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c);
        } else {
            pending_space = true;
        }
    }
    out
}

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Équivalent de `String(value ?? "")` pour une valeur JSON.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn body_text(body: &Value) -> String {
    match body {
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(" "),
        other => js_string(other),
    }
}

/// Empreinte d'un document (titre + documents), insensible à la casse et à la ponctuation.
pub fn passage_hash(part: u8, title: &str, documents: &[Value]) -> String {
    let docs: Vec<String> = documents
        .iter()
        .map(|d| {
            let t = d.get("title").map(js_string).unwrap_or_default();
            let b = d.get("body").map(body_text).unwrap_or_default();
            format!("{}~{}", norm(&t), norm(&b))
        })
        .collect();
    sha256(&format!("{part}|{}|{}", norm(title), docs.join("|")))
}

/// Empreinte d'une question : l'ordre des propositions n'a pas d'importance.
pub fn question_hash(
    part: u8,
    prompt: &str,
    option_texts: &[&str],
    passage_hash: Option<&str>,
) -> String {
    let mut texts: Vec<String> = option_texts.iter().map(|t| norm(t)).collect();
    texts.sort();
    sha256(&format!(
        "{part}|{}|{}|{}",
        norm(prompt),
        texts.join("|"),
        passage_hash.unwrap_or("")
    ))
}

// --- Similarité ---

/// Ensemble de « shingles » (mots et paires de mots) d'un texte.
pub fn shingles(text: &str) -> HashSet<String> {
    let n = norm(text);
    let words: Vec<&str> = n.split(' ').filter(|w| !w.is_empty()).collect();
    let mut set: HashSet<String> = words.iter().map(|w| (*w).to_string()).collect();
    for pair in words.windows(2) {
        set.insert(format!("{} {}", pair[0], pair[1]));
    }
    set
}

/// Similarité de Jaccard exacte entre deux textes (0 à 1).
pub fn jaccard(a: &str, b: &str) -> f64 {
    let (sa, sb) = (shingles(a), shingles(b));
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let common = sa.iter().filter(|s| sb.contains(*s)).count();
    common as f64 / (sa.len() + sb.len() - common) as f64
}

/// FNV-1a sur les unités UTF-16 (les shingles sont en ASCII, donc identiques aux octets).
fn fnv1a(text: &str, seed: u32) -> u32 {
    let mut h = seed;
    for unit in text.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(16_777_619);
    }
    h
}

pub const LSH_ROWS: usize = 4;
pub const LSH_BANDS: usize = 12;

/// Bandes LSH d'un texte : 12 entiers signés (compatibles `int[]` PostgreSQL).
/// Un texte de moins de 3 shingles n'a pas de bandes.
pub fn lsh_bands(text: &str) -> Vec<i32> {
    let set = shingles(text);
    if set.len() < 3 {
        return vec![];
    }
    let hashes: Vec<(u32, u32)> = set
        .iter()
        .map(|s| (fnv1a(s, 2_166_136_261), fnv1a(s, 0x9e37_79b1) | 1))
        .collect();
    let mins: Vec<u32> = (0..LSH_ROWS * LSH_BANDS)
        .map(|i| {
            hashes
                .iter()
                .map(|(h1, h2)| h1.wrapping_add((i as u32 + 1).wrapping_mul(*h2)))
                .min()
                .unwrap_or(u32::MAX)
        })
        .collect();
    (0..LSH_BANDS)
        .map(|b| {
            let mut h = 2_166_136_261u32 ^ b as u32;
            for r in 0..LSH_ROWS {
                h = (h ^ mins[b * LSH_ROWS + r]).wrapping_mul(16_777_619);
            }
            h as i32
        })
        .collect()
}

/// Texte comparé pour la similarité : la phrase seule en partie 5, énoncé + choix ensuite.
pub fn similarity_text(part: u8, prompt: &str, option_texts: &[&str]) -> String {
    if part == 5 {
        return prompt.to_string();
    }
    std::iter::once(prompt)
        .chain(option_texts.iter().copied())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Texte d'un document pour la similarité (titre + corps de tous les documents).
pub fn passage_text(title: &str, documents: &[Value]) -> String {
    let mut parts = vec![title.to_string()];
    for d in documents {
        let t = d.get("title").map(js_string).unwrap_or_default();
        let b = d.get("body").map(body_text).unwrap_or_default();
        parts.push(format!("{t} {b}"));
    }
    parts.join(" ")
}

/// Seuil à partir duquel deux questions sont signalées comme « trop proches ».
pub const SIMILAR_THRESHOLD: f64 = 0.7;

/// Vrai si au moins une bande est identique.
pub fn share_band(a: &[i32], b: &[i32]) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let set: HashSet<i32> = a.iter().copied().collect();
    b.iter().any(|x| set.contains(x))
}

/// Pour chaque indice, les indices plus anciens qui lui ressemblent (Jaccard >= seuil).
pub fn similar_within(texts: &[&str], threshold: f64) -> Vec<Vec<(usize, f64)>> {
    let bands: Vec<Vec<i32>> = texts.iter().map(|t| lsh_bands(t)).collect();
    let mut index: HashMap<i32, Vec<usize>> = HashMap::new();
    let mut result: Vec<Vec<(usize, f64)>> = vec![vec![]; texts.len()];
    for (i, text) in texts.iter().enumerate() {
        let mut candidates: Vec<usize> = bands[i]
            .iter()
            .flat_map(|b| index.get(b).into_iter().flatten().copied())
            .collect();
        candidates.sort_unstable();
        candidates.dedup();
        for j in candidates {
            let score = jaccard(text, texts[j]);
            if score >= threshold {
                result[i].push((j, score));
            }
        }
        for b in &bands[i] {
            index.entry(*b).or_default().push(i);
        }
    }
    result
}

/// Générateur pseudo-aléatoire déterministe (identique au JS).
pub fn mulberry32(seed: u32) -> impl FnMut() -> f64 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b_79f5);
        let mut t = a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const OPTS: [&str; 4] = ["a b", "ab", "a-c", "Été & 9 Zoo"];

    #[test]
    fn normalisation() {
        assert_eq!(
            norm("  The Manager's   REPORT — due (Friday)! "),
            "the manager s report due friday"
        );
        assert_eq!(norm(""), "");
    }

    // Valeurs de référence produites par l'implémentation JavaScript (server/bank/text.mjs).
    #[test]
    fn empreintes_identiques_au_js() {
        assert_eq!(
            question_hash(
                5,
                "All invoices must be submitted ______ the end of the month.",
                &OPTS,
                None
            ),
            "4dda20caff349022c8918fec73de29741a0f7887ec135d8d1fc3c6569fb290c9"
        );
        assert_eq!(
            question_hash(
                6,
                "We (1)______ the café’s “new” menu — it’s été!",
                &OPTS,
                Some("abc123")
            ),
            "9a3f2161eb3ab5d125095f155feee112c776622edae5669590ffa79fb806066e"
        );
        let docs = vec![
            json!({"kind": "email", "title": "To: All Staff", "body": ["From: HR", "Meeting at 9:00 — bring your laptop."]}),
            json!({"kind": "schedule", "title": "Day 1", "body": "9:00 Registration"}),
        ];
        assert_eq!(
            passage_hash(7, "Memo — Café", &docs),
            "656ba40b5fe1984da3af5f5d19ee69963708b638e51f03d9076b8ca26528bd8e"
        );
        let mut reversed = OPTS;
        reversed.reverse();
        assert_eq!(
            question_hash(5, "x ______ y", &OPTS, None),
            question_hash(5, "x ______ y", &reversed, None)
        );
    }

    #[test]
    fn bandes_lsh_identiques_au_js() {
        let a =
            "The quarterly report must be submitted by Friday afternoon to the finance department.";
        assert_eq!(
            lsh_bands(a),
            [
                163419075,
                1340369693,
                -788236685,
                223989263,
                -1531100209,
                -889350709,
                211691053,
                620633134,
                1185783543,
                181811232,
                831982979,
                -797538464
            ]
        );
        let near =
            "The quarterly report must be submitted by Friday morning to the finance department.";
        assert!((jaccard(a, near) - 0.7777777777777778).abs() < 1e-12);
        assert!(lsh_bands("Hello").is_empty());
    }

    #[test]
    fn similarite() {
        let a =
            "The quarterly report must be submitted by Friday afternoon to the finance department.";
        let near =
            "The quarterly report must be submitted by Friday morning to the finance department.";
        let far = "Please remind all employees to wear their identification badges at the reception desk.";
        assert!(jaccard(a, far) < 0.2);
        assert!(share_band(&lsh_bands(a), &lsh_bands(a)));
        assert!(!share_band(&lsh_bands(a), &lsh_bands(far)));
        let padded = format!("{a} ");
        let result = similar_within(&[a, far, near, &padded], SIMILAR_THRESHOLD);
        assert!(result[1].is_empty());
        assert_eq!(result[2].iter().map(|r| r.0).collect::<Vec<_>>(), [0]);
        assert!(result[3].iter().any(|r| r.0 == 0 && r.1 == 1.0));
        assert_eq!(similarity_text(5, "P ______", &["by", "until"]), "P ______");
        assert_eq!(
            similarity_text(7, "Why?", &["by", "until"]),
            "Why? by until"
        );
    }

    #[test]
    fn mulberry_identique_au_js() {
        let mut r = mulberry32(42);
        let got = [r(), r(), r()];
        let want = [0.6011037519201636, 0.44829055899754167, 0.8524657934904099];
        for (g, w) in got.iter().zip(want) {
            assert!((g - w).abs() < 1e-15, "{g} != {w}");
        }
    }
}
