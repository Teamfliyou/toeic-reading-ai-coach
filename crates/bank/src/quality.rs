//! Contrôles de qualité des questions (import, génération IA, édition). Port de `server/bank/quality.mjs`.
//!
//! - ERREURS : la question est inutilisable → rejetée.
//! - ALERTES : peut-être défectueuse → brouillon `needs_review`, jamais publiée sans relecture.
//!
//! Écart volontaire avec le JS : `strip_blanks` reproduit l'INTENTION de l'original
//! (`\(\d{1,2}\)\s*_{2,}`), dont l'expression régulière avait perdu ses antislashs.

use crate::language::{looks_english, looks_french};
use crate::text::{mulberry32, norm};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub const OPTION_KEYS: [char; 4] = ['A', 'B', 'C', 'D'];
pub const DOCUMENT_KINDS: [&str; 7] = [
    "email", "memo", "article", "notice", "schedule", "letter", "message",
];

#[derive(Debug, Deserialize)]
struct Category {
    id: String,
    parts: Vec<u8>,
}

/// Catégories (types de piège) autorisées pour une partie (`data/categories.json`).
pub fn categories_for_part(part: u8) -> Vec<String> {
    static CATS: OnceLock<Vec<Category>> = OnceLock::new();
    let cats = CATS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../data/categories.json"))
            .expect("data/categories.json valide")
    });
    cats.iter()
        .filter(|c| c.parts.contains(&part))
        .map(|c| c.id.clone())
        .collect()
}

macro_rules! re {
    ($pat:expr) => {{
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| Regex::new($pat).expect("regex valide"))
    }};
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    /// Indice de la question concernée (contrôles de document).
    pub index: Option<usize>,
}

fn error(code: &'static str, message: impl Into<String>) -> Issue {
    Issue {
        severity: Severity::Error,
        code,
        message: message.into(),
        index: None,
    }
}
fn warning(code: &'static str, message: impl Into<String>) -> Issue {
    Issue {
        severity: Severity::Warning,
        code,
        message: message.into(),
        index: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QOption {
    pub key: char,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedQuestion {
    pub part: u8,
    pub prompt: String,
    pub options: Vec<QOption>,
    pub correct_key: char,
    pub difficulty: u8,
    pub category: Option<String>,
    pub theme: Option<String>,
    pub tags: Vec<String>,
    pub explanation: Option<String>,
    pub option_rationales: Option<BTreeMap<char, String>>,
    pub order_index: Option<u32>,
    pub external_id: Option<String>,
}

// --- Validation de schéma (équivalent du schéma zod) ---

fn str_field(
    v: &Value,
    key: &str,
    min: usize,
    max: usize,
    too_short: &str,
    too_long: &str,
    errs: &mut Vec<String>,
) -> String {
    match v.get(key).and_then(Value::as_str) {
        Some(s) => {
            let s = s.trim().to_string();
            let n = s.chars().count();
            if n < min {
                errs.push(format!("{key} : {too_short}"));
            } else if n > max {
                errs.push(format!("{key} : {too_long}"));
            }
            s
        }
        None => {
            errs.push(format!("{key} : valeur invalide"));
            String::new()
        }
    }
}

/// Champ texte optionnel et nullable, borné.
fn opt_str(v: &Value, key: &str, max: usize, errs: &mut Vec<String>) -> Option<String> {
    match v.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.chars().count() <= max => Some(s.clone()),
        Some(Value::String(_)) => {
            errs.push(format!("{key} : trop long ({max} caractères maximum)"));
            None
        }
        Some(_) => {
            errs.push(format!("{key} : valeur invalide"));
            None
        }
    }
}

fn key_of(v: &Value) -> Option<char> {
    let s = v.as_str()?;
    let mut it = s.chars();
    let c = it.next()?;
    (it.next().is_none() && OPTION_KEYS.contains(&c)).then_some(c)
}

fn int_in(v: Option<&Value>, min: i64, max: i64) -> Option<i64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && n >= min as f64 && n <= max as f64).then_some(n as i64)
}

fn parse_question(input: &Value) -> Result<NormalizedQuestion, Vec<String>> {
    let mut errs: Vec<String> = vec![];
    let part = match int_in(input.get("part"), 5, 7) {
        Some(p) => p as u8,
        None => {
            errs.push("part : valeur invalide".into());
            0
        }
    };
    let prompt = str_field(
        input,
        "prompt",
        10,
        1500,
        "énoncé trop court (10 caractères minimum)",
        "énoncé trop long",
        &mut errs,
    );

    let mut options: Vec<QOption> = vec![];
    match input.get("options").and_then(Value::as_array) {
        Some(list) => {
            for (i, o) in list.iter().enumerate() {
                let key = o.get("key").and_then(key_of);
                let text = o
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string();
                if key.is_none() {
                    errs.push(format!("options.{i}.key : valeur invalide"));
                }
                if text.is_empty() {
                    errs.push(format!("options.{i}.text : proposition vide"));
                } else if text.chars().count() > 400 {
                    errs.push(format!("options.{i}.text : trop long"));
                }
                if let Some(key) = key {
                    options.push(QOption { key, text });
                }
            }
            if list.len() != 4 {
                errs.push("options : quatre propositions A, B, C, D sont requises".into());
            } else if options.len() == 4
                && !options.iter().zip(OPTION_KEYS).all(|(o, k)| o.key == k)
            {
                errs.push("options : les propositions doivent être A, B, C, D dans l'ordre".into());
            }
        }
        None => errs.push("options : valeur invalide".into()),
    }

    let correct_key = input.get("correctKey").and_then(key_of);
    if correct_key.is_none() {
        errs.push("correctKey : valeur invalide".into());
    }
    let difficulty = int_in(input.get("difficulty"), 1, 3);
    if difficulty.is_none() {
        errs.push("difficulty : valeur invalide".into());
    }
    let category = opt_str(input, "category", 60, &mut errs);
    let theme = opt_str(input, "theme", 80, &mut errs);
    let explanation = opt_str(input, "explanation", 2000, &mut errs);
    let external_id = opt_str(input, "externalId", 80, &mut errs);

    let mut tags = vec![];
    match input.get("tags") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) if list.len() <= 10 => {
            for t in list {
                match t.as_str().filter(|s| s.chars().count() <= 40) {
                    Some(s) => tags.push(s.to_string()),
                    None => errs.push("tags : valeur invalide".into()),
                }
            }
        }
        Some(_) => errs.push("tags : valeur invalide".into()),
    }

    let mut rationales = None;
    match input.get("optionRationales") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            let mut out = BTreeMap::new();
            for (k, v) in map {
                match (
                    k.chars()
                        .next()
                        .filter(|_| k.len() == 1)
                        .filter(|c| OPTION_KEYS.contains(c)),
                    v.as_str(),
                ) {
                    (Some(key), Some(text)) if text.chars().count() <= 600 => {
                        out.insert(key, text.to_string());
                    }
                    _ => errs.push(format!("optionRationales.{k} : valeur invalide")),
                }
            }
            rationales = Some(out);
        }
        Some(_) => errs.push("optionRationales : valeur invalide".into()),
    }

    let order_index = match input.get("orderIndex") {
        None | Some(Value::Null) => None,
        v => match int_in(v, 0, 1000) {
            Some(n) => Some(n as u32),
            None => {
                errs.push("orderIndex : valeur invalide".into());
                None
            }
        },
    };

    if !errs.is_empty() {
        return Err(errs);
    }
    Ok(NormalizedQuestion {
        part,
        prompt,
        options,
        correct_key: correct_key.unwrap_or('A'),
        difficulty: difficulty.unwrap_or(1) as u8,
        category,
        theme,
        tags,
        explanation,
        option_rationales: rationales,
        order_index,
        external_id,
    })
}

// --- Blancs ---

/// Remplace tout trou (numéroté ou non) par un mot neutre, pour comparer des phrases.
pub fn strip_blanks(text: &str) -> String {
    let numbered = re!(r"\([0-9]{1,2}\)\s*_{2,}").replace_all(text, " blank ");
    re!(r"_{2,}").replace_all(&numbered, " blank ").into_owned()
}

/// Numéros de trous « (1)______ » d'un texte.
pub fn blank_numbers(text: &str) -> Vec<u32> {
    re!(r"\(([0-9]{1,2})\)\s*_{2,}")
        .captures_iter(text)
        .filter_map(|c| c[1].parse().ok())
        .collect()
}

// --- Difficulté ---

/// Estimation GROSSIÈRE de la difficulté (1 à 3), pour repérer les écarts manifestes.
pub fn estimate_difficulty(q: &NormalizedQuestion, passage_words: usize) -> u8 {
    let n = norm(&q.prompt);
    let words: Vec<&str> = n.split(' ').filter(|w| !w.is_empty()).collect();
    let avg_word = if words.is_empty() {
        0.0
    } else {
        words.iter().map(|w| w.len()).sum::<usize>() as f64 / words.len() as f64
    };
    let avg_option = q
        .options
        .iter()
        .map(|o| o.text.encode_utf16().count())
        .sum::<usize>() as f64
        / q.options.len().max(1) as f64;
    let mut score = 1.0;
    if words.len() >= 18 || avg_word >= 6.0 {
        score += 0.6;
    }
    if re!(r"(?i)(?-u:\b)(although|whereas|unless|provided that|notwithstanding|nevertheless|hence|thereby|whereby|despite|in spite of|had it not|were it|not only|no sooner)(?-u:\b)").is_match(&q.prompt) {
        score += 0.6;
    }
    if avg_option >= 14.0 {
        score += 0.4;
    }
    if q.part == 7 {
        if passage_words >= 180 {
            score += 0.6;
        }
        if matches!(
            q.category.as_deref(),
            Some("reading-inference" | "reading-cross")
        ) {
            score += 0.8;
        }
    }
    if q.part == 6 && passage_words >= 160 {
        score += 0.3;
    }
    // Math.round de JS : arrondi vers +∞ sur .5
    ((score + 0.5f64).floor()).clamp(1.0, 3.0) as u8
}

// --- Contrôle d'une question ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Ai,
    Import,
    Manual,
}

#[derive(Debug, Clone, Default)]
pub struct CheckResult {
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    pub question: Option<NormalizedQuestion>,
}

pub fn check_question(input: &Value, source: Source, passage_words: usize) -> CheckResult {
    let mut res = CheckResult::default();
    let mut q = match parse_question(input) {
        Ok(q) => q,
        Err(msgs) => {
            res.errors = msgs.into_iter().map(|m| error("schema", m)).collect();
            return res;
        }
    };

    if let Some(cat) = q.category.clone().filter(|c| !c.is_empty()) {
        if !categories_for_part(q.part).contains(&cat) {
            res.warnings.push(warning(
                "unknown_category",
                format!(
                    "Catégorie « {cat} » inconnue pour la partie {} : ignorée.",
                    q.part
                ),
            ));
            q.category = None;
        }
    }

    let normalized: std::collections::HashSet<String> =
        q.options.iter().map(|o| norm(&o.text)).collect();
    if normalized.len() < 4 {
        res.errors.push(error(
            "duplicate_options",
            "Deux propositions sont identiques.",
        ));
    }
    let blank = re!(r"_{3,}");
    if q.part != 7 && !blank.is_match(&q.prompt) {
        res.errors.push(error(
            "blank_missing",
            "L'énoncé doit contenir un trou (______).",
        ));
    }
    if q.part == 6 && blank.is_match(&q.prompt) && blank_numbers(&q.prompt).is_empty() {
        res.warnings.push(warning(
            "blank_unnumbered",
            "Le trou n'est pas numéroté « (1)______ » : le lien avec le document est incertain.",
        ));
    }
    if looks_french(&q.prompt) || q.options.iter().any(|o| looks_french(&o.text)) {
        res.errors.push(error(
            "not_english",
            "Le contenu de la question doit être entièrement en anglais.",
        ));
    }
    let all_text: String = q.prompt.clone()
        + &q.options
            .iter()
            .map(|o| o.text.as_str())
            .collect::<String>();
    let odd = all_text
        .chars()
        .filter(|c| {
            let code = *c as u32;
            code > 0xff && !(0x2010..=0x2027).contains(&code) && code != 0x20ac
        })
        .count();
    if odd > 3 {
        res.warnings.push(warning(
            "unusual_characters",
            "Caractères inhabituels (encodage ?) dans l'énoncé ou les propositions.",
        ));
    }

    // Réponses multiples potentiellement correctes.
    let correct = q
        .options
        .iter()
        .find(|o| o.key == q.correct_key)
        .map(|o| o.text.clone())
        .unwrap_or_default();
    let prompt_norm = format!(" {} ", norm(&q.prompt));
    let correct_norm = norm(&correct);
    if q.part == 5 && correct_norm.len() >= 5 && prompt_norm.contains(&format!(" {correct_norm} "))
    {
        res.warnings.push(warning(
            "answer_in_prompt",
            "La bonne réponse apparaît déjà dans l'énoncé.",
        ));
    }
    let empty = BTreeMap::new();
    let rationales = q.option_rationales.as_ref().unwrap_or(&empty);
    let wrong_keys: Vec<char> = OPTION_KEYS
        .into_iter()
        .filter(|k| *k != q.correct_key)
        .collect();
    let contradicting = re!(
        r"(?i)(?-u:\b)(est (aussi |également )?(correct|possible|acceptable)|bonne réponse|convient (aussi|parfaitement)|aussi valable)(?-u:\b)"
    );
    let negated = re!(
        r"(?i)(?-u:\b)(in|n'est pas|ne convient pas|pas (correct|possible|acceptable)|faux|incorrect)"
    );
    let multi = re!(
        r"(?i)(également|aussi|les deux|plusieurs|deux réponses)[^.]{0,40}(correct|possible|acceptable|valable)|(correct|possible|acceptable|valable)[^.]{0,20}(aussi|également)"
    );
    let suspect_rationale = wrong_keys.iter().any(|k| {
        rationales
            .get(k)
            .is_some_and(|t| !t.is_empty() && contradicting.is_match(t) && !negated.is_match(t))
    });
    if suspect_rationale || q.explanation.as_deref().is_some_and(|e| multi.is_match(e)) {
        res.warnings.push(warning(
            "multiple_correct_suspect",
            "L'explication suggère qu'une autre proposition pourrait aussi être correcte.",
        ));
    }
    let joined = q
        .options
        .iter()
        .map(|o| o.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if re!(r"(?i)(?-u:\b)(all of the above|none of the above|both [a-d] and [a-d]|\([a-d]\) and \([a-d]\))(?-u:\b)").is_match(&joined) {
        res.warnings.push(warning("option_refers_to_options", "Une proposition renvoie à d'autres propositions (« all of the above »…) : format non-TOEIC."));
    }

    // Explications.
    if source == Source::Ai {
        if q.explanation
            .as_deref()
            .is_none_or(|e| e.chars().count() < 25)
        {
            res.warnings.push(warning(
                "explanation_missing",
                "Explication pédagogique absente ou trop courte.",
            ));
        }
        let missing: Vec<String> = wrong_keys
            .iter()
            .filter(|k| rationales.get(k).is_none_or(|t| t.chars().count() < 8))
            .map(|k| k.to_string())
            .collect();
        if !missing.is_empty() {
            res.warnings.push(warning(
                "rationales_missing",
                format!("Justification manquante pour : {}.", missing.join(", ")),
            ));
        }
    }
    if q.explanation
        .as_deref()
        .is_some_and(|e| !e.is_empty() && looks_english(e))
    {
        res.warnings.push(warning(
            "explanation_language",
            "L'explication semble rédigée en anglais : elle doit être en français.",
        ));
    }
    if q.explanation.as_deref().is_some_and(|e| !e.is_empty())
        && rationales.values().any(|r| looks_english(r))
    {
        res.warnings.push(warning(
            "explanation_language",
            "Une justification semble rédigée en anglais : elle doit être en français.",
        ));
    }

    // Difficulté.
    let estimated = estimate_difficulty(&q, passage_words);
    if (i16::from(estimated) - i16::from(q.difficulty)).abs() >= 2 {
        res.warnings.push(warning(
            "difficulty_mismatch",
            format!(
                "Difficulté annoncée {}/3, estimée {estimated}/3.",
                q.difficulty
            ),
        ));
    }

    res.question = Some(q);
    res
}

// --- Document et questions ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDocument {
    pub kind: String,
    pub title: String,
    pub body: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPassage {
    pub title: String,
    pub documents: Vec<ParsedDocument>,
}

fn parse_passage(input: &Value) -> Result<ParsedPassage, Vec<String>> {
    let mut errs = vec![];
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if title.is_empty() {
        errs.push("title : titre du document manquant".to_string());
    } else if title.chars().count() > 250 {
        errs.push("title : trop long".to_string());
    }
    let mut documents = vec![];
    match input.get("documents").and_then(Value::as_array) {
        Some(list) if !list.is_empty() && list.len() <= 4 => {
            for (i, d) in list.iter().enumerate() {
                let kind = d.get("kind").and_then(Value::as_str).unwrap_or_default();
                if !DOCUMENT_KINDS.contains(&kind) {
                    errs.push(format!("documents.{i}.kind : valeur invalide"));
                }
                let dtitle = d
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string();
                if dtitle.chars().count() > 250 {
                    errs.push(format!("documents.{i}.title : trop long"));
                }
                let mut body = vec![];
                match d.get("body").and_then(Value::as_array) {
                    Some(lines) if !lines.is_empty() => {
                        for (j, l) in lines.iter().enumerate() {
                            let t = l.as_str().map(str::trim).unwrap_or_default();
                            if t.is_empty() {
                                errs.push(format!("documents.{i}.body.{j} : valeur invalide"));
                            }
                            body.push(t.to_string());
                        }
                    }
                    _ => errs.push(format!("documents.{i}.body : texte du document vide")),
                }
                documents.push(ParsedDocument {
                    kind: kind.to_string(),
                    title: dtitle,
                    body,
                });
            }
        }
        Some(list) if list.is_empty() => errs.push("documents : au moins un document".into()),
        _ => errs.push("documents : valeur invalide".into()),
    }
    if errs.is_empty() {
        Ok(ParsedPassage { title, documents })
    } else {
        Err(errs)
    }
}

pub fn passage_word_count(p: &ParsedPassage) -> usize {
    p.documents
        .iter()
        .map(|d| {
            norm(&d.body.join(" "))
                .split(' ')
                .filter(|w| !w.is_empty())
                .count()
        })
        .sum()
}

#[derive(Debug, Clone, Default)]
pub struct PassageCheck {
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    pub passage: Option<ParsedPassage>,
    pub words: usize,
}

pub fn check_passage_group(
    part: u8,
    passage: &Value,
    questions: &[NormalizedQuestion],
    expected_questions: Option<usize>,
) -> PassageCheck {
    let mut res = PassageCheck::default();
    let passage = match parse_passage(passage) {
        Ok(p) => p,
        Err(msgs) => {
            res.errors = msgs
                .into_iter()
                .map(|m| error("passage_schema", format!("document {m}")))
                .collect();
            return res;
        }
    };
    let texts: Vec<&str> = std::iter::once(passage.title.as_str())
        .chain(passage.documents.iter().flat_map(|d| {
            std::iter::once(d.title.as_str()).chain(d.body.iter().map(String::as_str))
        }))
        .collect();
    if texts.iter().any(|t| looks_french(t)) {
        res.errors.push(error(
            "passage_not_english",
            "Le document doit être entièrement en anglais.",
        ));
    }
    let words = passage_word_count(&passage);
    if let Some(expected) = expected_questions.filter(|e| *e != questions.len()) {
        res.errors.push(error(
            "passage_question_count",
            format!(
                "{} question(s) pour ce document au lieu de {expected}.",
                questions.len()
            ),
        ));
    }

    if part == 6 {
        let body: String = passage
            .documents
            .iter()
            .flat_map(|d| d.body.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");
        let blanks = blank_numbers(&body);
        let mut sorted = blanks.clone();
        sorted.sort_unstable();
        let unique: std::collections::HashSet<_> = blanks.iter().collect();
        if blanks.is_empty() {
            res.errors.push(error(
                "passage_blanks_missing",
                "Le texte à trous ne contient aucun trou numéroté « (1)______ ».",
            ));
        } else if unique.len() != blanks.len()
            || sorted.iter().enumerate().any(|(i, n)| *n != i as u32 + 1)
        {
            let list = blanks
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            res.errors.push(error(
                "passage_blanks_invalid",
                format!("Numérotation des trous incohérente ({list})."),
            ));
        }
        if !blanks.is_empty() && questions.len() != blanks.len() {
            res.errors.push(error(
                "passage_blank_mismatch",
                format!(
                    "Le document contient {} trou(s) mais {} question(s) y sont rattachées.",
                    blanks.len(),
                    questions.len()
                ),
            ));
        }
        let text = format!(" {} ", norm(&strip_blanks(&body)));
        let mut seen = std::collections::HashSet::new();
        for (index, q) in questions.iter().enumerate() {
            let n = blank_numbers(&q.prompt).first().copied();
            if let Some(n) = n {
                if !blanks.is_empty() && !blanks.contains(&n) {
                    res.errors.push(error(
                        "question_blank_unknown",
                        format!("La question renvoie au trou ({n}), absent du document."),
                    ));
                }
                if !seen.insert(n) {
                    res.errors.push(error(
                        "question_blank_duplicate",
                        format!("Deux questions portent sur le trou ({n})."),
                    ));
                }
            }
            let sentence = norm(&strip_blanks(&q.prompt));
            if sentence.len() > 20 && !text.contains(&format!(" {sentence} ")) {
                let label = n.map_or("?".to_string(), |n| n.to_string());
                let mut w = warning(
                    "prompt_not_in_passage",
                    format!("L'énoncé du trou {label} ne figure pas tel quel dans le document."),
                );
                w.index = Some(index);
                res.warnings.push(w);
            }
        }
    } else {
        if words < 40 {
            res.warnings.push(warning(
                "passage_too_short",
                format!("Document très court ({words} mots)."),
            ));
        }
        if questions.len() < 2 || questions.len() > 5 {
            res.warnings.push(warning(
                "question_count",
                format!(
                    "{} question(s) pour ce document : 2 à 5 sont attendues.",
                    questions.len()
                ),
            ));
        }
    }
    res.passage = Some(passage);
    res.words = words;
    res
}

// --- Lot : équilibre des réponses ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnswerBalance {
    pub distribution: BTreeMap<char, usize>,
    pub total: usize,
    pub balanced: bool,
}

/// Répartition des bonnes réponses ; déséquilibré si une lettre dépasse 40 % (lots de 8+).
pub fn answer_balance(questions: &[NormalizedQuestion]) -> AnswerBalance {
    let mut distribution: BTreeMap<char, usize> = OPTION_KEYS.iter().map(|k| (*k, 0)).collect();
    for q in questions {
        if let Some(n) = distribution.get_mut(&q.correct_key) {
            *n += 1;
        }
    }
    let total = questions.len();
    let max = distribution.values().copied().max().unwrap_or(0);
    AnswerBalance {
        distribution,
        total,
        balanced: total < 8 || max as f64 / total as f64 <= 0.4,
    }
}

/// Une question dont les propositions renvoient les unes aux autres ne peut pas être permutée.
pub fn can_shuffle(q: &NormalizedQuestion) -> bool {
    let dep = re!(
        r"(?i)(?-u:\b)(all of the above|none of the above|both|neither|either of)(?-u:\b)|(?-u:\b)(options?|choices?|answers?)\s+[A-D](?-u:\b)|\([A-D]\)"
    );
    !q.options.iter().any(|o| dep.is_match(&o.text))
}

/// Rééquilibre les bonnes réponses en échangeant deux propositions (justifications incluses).
pub fn rebalance_answers(questions: &[NormalizedQuestion], seed: u32) -> Vec<NormalizedQuestion> {
    let mut rng = mulberry32(seed);
    let target = questions.len() as f64 / 4.0;
    let mut counts: BTreeMap<char, f64> = OPTION_KEYS.iter().map(|k| (*k, 0.0)).collect();
    for q in questions {
        *counts.entry(q.correct_key).or_insert(0.0) += 1.0;
    }
    questions
        .iter()
        .map(|q| {
            if !can_shuffle(q) {
                return q.clone();
            }
            let surplus = counts[&q.correct_key] - target;
            if surplus <= 0.5 {
                return q.clone();
            }
            let others: Vec<char> = OPTION_KEYS
                .into_iter()
                .filter(|k| *k != q.correct_key)
                .collect();
            let deficit: Vec<f64> = others
                .iter()
                .map(|k| target - counts[k] + rng() * 0.01)
                .collect();
            let mut best_i = 0;
            for (i, d) in deficit.iter().enumerate() {
                if *d > deficit[best_i] {
                    best_i = i;
                }
            }
            let best = others[best_i];
            if counts[&best] >= target {
                return q.clone();
            }
            let mut texts: Vec<String> = q.options.iter().map(|o| o.text.clone()).collect();
            let from = q.correct_key as usize - 'A' as usize;
            let to = best as usize - 'A' as usize;
            texts.swap(from, to);
            let options = texts
                .into_iter()
                .zip(OPTION_KEYS)
                .map(|(text, key)| QOption { key, text })
                .collect();
            let rationales = q.option_rationales.as_ref().map(|r| {
                let mut next = r.clone();
                match r.get(&q.correct_key) {
                    Some(v) => next.insert(best, v.clone()),
                    None => next.remove(&best),
                };
                match r.get(&best) {
                    Some(v) => next.insert(q.correct_key, v.clone()),
                    None => next.remove(&q.correct_key),
                };
                next
            });
            *counts.entry(q.correct_key).or_insert(0.0) -= 1.0;
            *counts.entry(best).or_insert(0.0) += 1.0;
            NormalizedQuestion {
                options,
                correct_key: best,
                option_rationales: rationales,
                ..q.clone()
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Rejected,
    Flagged,
    Accepted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutcomeDecision {
    pub outcome: Outcome,
    pub status: Option<&'static str>,
    pub needs_review: bool,
}

/// Erreurs → rejetée ; alertes → brouillon à vérifier ; sinon `clean` ("draft" ou "review").
pub fn outcome_for(errors: &[Issue], warnings: &[Issue], clean: &'static str) -> OutcomeDecision {
    if !errors.is_empty() {
        OutcomeDecision {
            outcome: Outcome::Rejected,
            status: None,
            needs_review: false,
        }
    } else if !warnings.is_empty() {
        OutcomeDecision {
            outcome: Outcome::Flagged,
            status: Some("draft"),
            needs_review: true,
        }
    } else {
        OutcomeDecision {
            outcome: Outcome::Accepted,
            status: Some(clean),
            needs_review: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opts(a: &str, b: &str, c: &str, d: &str) -> Value {
        json!([{"key":"A","text":a},{"key":"B","text":b},{"key":"C","text":c},{"key":"D","text":d}])
    }
    fn q5(over: Value) -> Value {
        let mut base = json!({
            "part": 5,
            "prompt": "All invoices must be submitted ______ the end of the month.",
            "options": opts("by", "until", "since", "during"),
            "correctKey": "A", "difficulty": 1, "category": "prepositions"
        });
        for (k, v) in over.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }
    fn codes(r: &CheckResult) -> Vec<&'static str> {
        r.errors.iter().chain(&r.warnings).map(|i| i.code).collect()
    }
    fn check(v: Value) -> CheckResult {
        check_question(&v, Source::Import, 0)
    }

    #[test]
    fn question_valide() {
        let r = check(q5(json!({})));
        assert!(codes(&r).is_empty(), "{:?}", codes(&r));
        assert!(r.question.unwrap().tags.is_empty());
    }

    #[test]
    fn erreurs_bloquantes() {
        assert!(codes(&check(q5(json!({"correctKey": "E"})))).contains(&"schema"));
        assert!(codes(&check(q5(
            json!({"options": json!([{"key":"A","text":"by"},{"key":"B","text":"until"},{"key":"C","text":"since"}])})
        )))
        .contains(&"schema"));
        assert!(codes(&check(q5(json!({"prompt": "Vous devez envoyer les factures pour les clients dans une semaine ______."})))).contains(&"not_english"));
        assert!(codes(&check(q5(
            json!({"prompt": "All invoices must be submitted by the end of the month."})
        )))
        .contains(&"blank_missing"));
        assert!(codes(&check(q5(
            json!({"options": opts("by", "By", "since ", "during")})
        )))
        .contains(&"duplicate_options"));
        assert!(codes(&check(q5(json!({"difficulty": 5})))).contains(&"schema"));
    }

    #[test]
    fn categorie_d_une_autre_partie() {
        let r = check(q5(json!({"category": "reading-detail"})));
        assert!(r.errors.is_empty());
        assert!(codes(&r).contains(&"unknown_category"));
        assert_eq!(r.question.unwrap().category, None);
    }

    #[test]
    fn reponses_multiples_et_renvois() {
        let r = check_question(
            &q5(
                json!({"optionRationales": {"B": "« until » est aussi correct dans ce contexte."}}),
            ),
            Source::Ai,
            0,
        );
        assert!(codes(&r).contains(&"multiple_correct_suspect"));
        let r = check(q5(
            json!({"explanation": "Les deux réponses A et B sont possibles ici, mais A est plus naturelle."}),
        ));
        assert!(codes(&r).contains(&"multiple_correct_suspect"));
        let r = check(q5(
            json!({"optionRationales": {"B": "« until » exprime une durée, pas une échéance."}}),
        ));
        assert!(!codes(&r).contains(&"multiple_correct_suspect"));
        let r = check(q5(
            json!({"options": opts("all of the above", "until", "since", "during")}),
        ));
        assert!(codes(&r).contains(&"option_refers_to_options"));
    }

    #[test]
    fn fuite_langue_et_justifications() {
        let r = check(q5(
            json!({"prompt": "The end of the month is the deadline, ______ the end of the month.", "options": opts("the end of the month", "until", "since", "during")}),
        ));
        assert!(codes(&r).contains(&"answer_in_prompt"));
        let r = check(q5(
            json!({"explanation": "This is the correct answer because the sentence needs a preposition of time."}),
        ));
        assert!(codes(&r).contains(&"explanation_language"));
        let ai = check_question(&q5(json!({})), Source::Ai, 0);
        assert!(
            codes(&ai).contains(&"explanation_missing")
                && codes(&ai).contains(&"rationales_missing")
        );
        let complete = check_question(
            &q5(json!({
                "explanation": "« by » indique une échéance : la facture doit arriver au plus tard à cette date.",
                "optionRationales": {"B": "« until » décrit une durée continue.", "C": "« since » marque un point de départ.", "D": "« during » précède une période."}
            })),
            Source::Ai,
            0,
        );
        assert!(codes(&complete).is_empty(), "{:?}", codes(&complete));
    }

    #[test]
    fn difficulte() {
        let easy = q5(json!({"difficulty": 3}));
        let nq = check(easy.clone()).question.unwrap();
        assert_eq!(estimate_difficulty(&nq, 0), 1);
        assert!(codes(&check(easy)).contains(&"difficulty_mismatch"));
        let hard = q5(json!({
            "prompt": "Notwithstanding the unanticipated restructuring of the department, the committee decided that all outstanding reimbursements ______ processed promptly.",
            "options": opts("must be", "must have", "must to be", "must being"), "difficulty": 3
        }));
        let hq = check(hard.clone()).question.unwrap();
        assert!(estimate_difficulty(&hq, 0) >= 2);
        assert!(!codes(&check(hard)).contains(&"difficulty_mismatch"));
        assert!(!codes(&check(q5(json!({"difficulty": 2})))).contains(&"difficulty_mismatch"));
    }

    fn p6doc(body: &[&str]) -> Value {
        json!({"title": "Memo — Move", "documents": [{"kind": "memo", "title": "To: Staff", "body": body}]})
    }
    fn p6q(n: u32, sentence: &str) -> NormalizedQuestion {
        check(json!({"part": 6, "prompt": sentence, "options": opts("w1", "w2", "w3", "w4"), "correctKey": "A", "difficulty": 2, "orderIndex": n}))
            .question
            .unwrap_or_else(|| panic!("question invalide : {sentence}"))
    }
    fn pcodes(r: &PassageCheck) -> Vec<&'static str> {
        r.errors.iter().chain(&r.warnings).map(|i| i.code).collect()
    }

    #[test]
    fn partie_6_trous() {
        let three = ["We (1)______ move in March. Please (2)______ your boxes by Friday and (3)______ the desk."];
        let r = check_passage_group(
            6,
            &p6doc(&three),
            &[
                p6q(1, "We (1)______ move in March."),
                p6q(2, "Please (2)______ your boxes by Friday"),
            ],
            None,
        );
        assert!(r.errors.iter().any(|e| e.code == "passage_blank_mismatch"));

        let body = ["We (1)______ move in March. Please (2)______ your boxes by Friday."];
        let good = check_passage_group(
            6,
            &p6doc(&body),
            &[
                p6q(1, "We (1)______ move in March."),
                p6q(2, "Please (2)______ your boxes by Friday."),
            ],
            None,
        );
        assert!(
            good.errors.is_empty() && good.warnings.is_empty(),
            "{:?}",
            pcodes(&good)
        );

        let para = check_passage_group(
            6,
            &p6doc(&body),
            &[
                p6q(1, "We (1)______ move in March."),
                p6q(2, "Kindly (2)______ every box before the weekend arrives."),
            ],
            None,
        );
        assert!(para
            .warnings
            .iter()
            .any(|w| w.code == "prompt_not_in_passage" && w.index == Some(1)));

        let none = check_passage_group(
            6,
            &p6doc(&["No blanks here at all in this document."]),
            &[p6q(1, "Prompt with ______ blank here")],
            None,
        );
        assert!(none
            .errors
            .iter()
            .any(|e| e.code == "passage_blanks_missing"));
        let skipped = check_passage_group(
            6,
            &p6doc(&["We (1)______ and (3)______ now."]),
            &[
                p6q(1, "We (1)______ and now."),
                p6q(3, "and (3)______ now."),
            ],
            None,
        );
        assert!(skipped
            .errors
            .iter()
            .any(|e| e.code == "passage_blanks_invalid"));
        let french = check_passage_group(
            6,
            &p6doc(&["Nous allons (1)______ dans les nouveaux locaux pour une réunion avec vous."]),
            &[p6q(1, "Nous allons (1)______ dans")],
            None,
        );
        assert!(french
            .errors
            .iter()
            .any(|e| e.code == "passage_not_english"));
    }

    #[test]
    fn partie_7() {
        let passage = json!({"title": "Notice", "documents": [{"kind": "notice", "title": "Closed", "body": ["The office is closed on Monday."]}]});
        let q = check(json!({"part": 7, "prompt": "Question 1?????", "options": opts("a", "b", "c", "d"), "correctKey": "A", "difficulty": 1})).question.unwrap();
        let r = check_passage_group(7, &passage, &[q], None);
        assert!(r.errors.is_empty());
        let mut c = pcodes(&r);
        c.sort_unstable();
        assert_eq!(c, ["passage_too_short", "question_count"]);
        assert!(
            !check_passage_group(7, &json!({"title": "", "documents": []}), &[], None)
                .errors
                .is_empty()
        );
    }

    #[test]
    fn equilibre_des_reponses() {
        let questions: Vec<NormalizedQuestion> = (0..20)
            .map(|i| {
                check(q5(json!({
                    "prompt": format!("Question {i} ______ here for everyone"),
                    "options": opts(&format!("right{i}"), &format!("x{i}"), &format!("y{i}"), &format!("z{i}")),
                    "optionRationales": {"A": "ok", "B": "b", "C": "c", "D": "d"}
                })))
                .question
                .unwrap()
            })
            .collect();
        assert!(!answer_balance(&questions).balanced);
        let rebalanced = rebalance_answers(&questions, 42);
        let balance = answer_balance(&rebalanced);
        assert!(balance.balanced);
        assert!(
            balance.distribution.values().all(|n| (3..=8).contains(n)),
            "{:?}",
            balance.distribution
        );
        for (i, r) in rebalanced.iter().enumerate() {
            let correct = &r
                .options
                .iter()
                .find(|o| o.key == r.correct_key)
                .unwrap()
                .text;
            assert_eq!(correct, &format!("right{i}"));
            assert_eq!(r.option_rationales.as_ref().unwrap()[&r.correct_key], "ok");
            assert_eq!(
                r.options.iter().map(|o| o.key).collect::<Vec<_>>(),
                ['A', 'B', 'C', 'D']
            );
        }
        assert_eq!(rebalance_answers(&questions, 42), rebalanced);
        assert!(answer_balance(&questions[..5]).balanced);
        let dep = check(q5(
            json!({"options": opts("all of the above", "b", "c", "d")}),
        ))
        .question
        .unwrap();
        assert!(!can_shuffle(&dep));
        let both = check(q5(json!({"options": opts("Both A and B", "b", "c", "d")})))
            .question
            .unwrap();
        assert!(!can_shuffle(&both));
    }

    #[test]
    fn issue_du_controle() {
        let e = [error("x", "m")];
        let w = [warning("x", "m")];
        assert_eq!(outcome_for(&e, &[], "draft").outcome, Outcome::Rejected);
        assert_eq!(
            outcome_for(&[], &w, "draft"),
            OutcomeDecision {
                outcome: Outcome::Flagged,
                status: Some("draft"),
                needs_review: true
            }
        );
        assert_eq!(outcome_for(&[], &[], "review").status, Some("review"));
        assert_eq!(strip_blanks("We (1)______ move"), "We  blank  move");
    }
}
