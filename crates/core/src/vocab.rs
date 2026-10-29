//! Carnet de vocabulaire révisé avec les boîtes Leitner de `srs`. Port de `src/lib/vocab.ts`.

use crate::srs::{apply_answer, is_due, AnswerEvent, ReviewCard};
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabWord {
    pub id: String,
    pub term: String,
    pub meaning: String,
    pub example: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_question_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(rename = "box")]
    pub box_: u8,
    pub due: DateTime<Utc>,
    pub mastered: bool,
    pub lapses: u32,
    /// « Pierre tombale » : la suppression se synchronise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

pub const LIMIT_TERM: usize = 80;
pub const LIMIT_MEANING: usize = 300;
pub const LIMIT_EXAMPLE: usize = 300;

#[derive(Debug, Clone, Default)]
pub struct WordInput {
    pub term: String,
    pub meaning: String,
    pub example: String,
    pub source_question_id: Option<String>,
}

fn clean(value: &str, max: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

pub fn normalize_term(term: &str) -> String {
    term.nfc()
        .collect::<String>()
        .to_lowercase()
        .trim()
        .to_string()
}

/// Valide une saisie ; renvoie le mot nettoyé ou un message d'erreur en français.
pub fn validate_word(input: &WordInput, existing: &[VocabWord]) -> Result<WordInput, String> {
    let term = clean(&input.term, LIMIT_TERM);
    let meaning = clean(&input.meaning, LIMIT_MEANING);
    let example = clean(&input.example, LIMIT_EXAMPLE);
    if term.is_empty() {
        return Err("Saisissez le mot ou l'expression.".into());
    }
    if meaning.is_empty() {
        return Err("Ajoutez son sens en français pour pouvoir le réviser.".into());
    }
    let key = normalize_term(&term);
    if existing
        .iter()
        .any(|w| !w.deleted && normalize_term(&w.term) == key)
    {
        return Err("Ce mot est déjà dans votre carnet.".into());
    }
    Ok(WordInput {
        term,
        meaning,
        example,
        source_question_id: input.source_question_id.clone(),
    })
}

pub fn create_word(value: WordInput, id: String, now: DateTime<Utc>) -> VocabWord {
    VocabWord {
        id,
        term: value.term,
        meaning: value.meaning,
        example: value.example,
        source_question_id: value.source_question_id,
        created_at: now,
        updated_at: now,
        box_: 1,
        due: now, // à réviser dès maintenant
        mastered: false,
        lapses: 0,
        deleted: false,
    }
}

fn to_card(w: &VocabWord) -> ReviewCard {
    ReviewCard {
        question_id: w.id.clone(),
        part: 0,
        box_: w.box_,
        due: w.due,
        mastered: w.mastered,
        lapses: w.lapses,
        updated_at: w.updated_at,
    }
}

/// Applique une révision (« je savais » / « à revoir »).
pub fn review_word(word: &VocabWord, correct: bool, now: DateTime<Utc>) -> VocabWord {
    let event = AnswerEvent {
        question_id: word.id.clone(),
        part: 0,
        correct,
    };
    let cards = apply_answer(&[to_card(word)], &event, now);
    let card = &cards[0];
    VocabWord {
        box_: card.box_,
        due: card.due,
        mastered: card.mastered,
        lapses: card.lapses,
        updated_at: card.updated_at,
        ..word.clone()
    }
}

pub fn due_words(words: &[VocabWord], now: DateTime<Utc>) -> Vec<VocabWord> {
    let mut due: Vec<VocabWord> = words
        .iter()
        .filter(|w| !w.deleted && is_due(&to_card(w), now))
        .cloned()
        .collect();
    due.sort_by(|a, b| a.box_.cmp(&b.box_).then(a.due.cmp(&b.due)));
    due
}

pub fn active_words(words: &[VocabWord]) -> Vec<VocabWord> {
    words.iter().filter(|w| !w.deleted).cloned().collect()
}

pub fn mark_deleted(word: &VocabWord, now: DateTime<Utc>) -> VocabWord {
    VocabWord {
        deleted: true,
        updated_at: now,
        ..word.clone()
    }
}

/// Fusion de deux listes : la version la plus récente de chaque mot gagne.
pub fn merge_words(local: &[VocabWord], remote: &[VocabWord]) -> Vec<VocabWord> {
    let mut by_id: HashMap<&str, &VocabWord> = HashMap::new();
    let mut order: Vec<&str> = vec![];
    for w in local.iter().chain(remote) {
        match by_id.get(w.id.as_str()) {
            None => {
                order.push(&w.id);
                by_id.insert(&w.id, w);
            }
            Some(known) if w.updated_at > known.updated_at => {
                by_id.insert(&w.id, w);
            }
            _ => {}
        }
    }
    order.into_iter().map(|id| by_id[id].clone()).collect()
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("regex valide"))
}

/// Exemple à partir d'une phrase à trous : le blanc est remplacé par la bonne réponse.
/// Chaîne vide si l'énoncé n'a pas de blanc (Part 7).
pub fn example_from_prompt(prompt: &str, answer: &str) -> String {
    static BLANK: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    static PUNCT: OnceLock<Regex> = OnceLock::new();
    let blank = re(&BLANK, r"(\(\d+\))?\s*_{3,}");
    if !blank.is_match(prompt) {
        return String::new();
    }
    let replaced = blank.replace(prompt, regex::NoExpand(&format!(" {answer}")));
    let collapsed = re(&SPACES, r"\s+").replace_all(&replaced, " ");
    re(&PUNCT, r"\s+([.,;:!?])")
        .replace_all(&collapsed, "$1")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 25, 12, 0, 0).unwrap()
    }
    fn input(term: &str, meaning: &str) -> WordInput {
        WordInput {
            term: term.into(),
            meaning: meaning.into(),
            ..Default::default()
        }
    }
    fn word(term: &str) -> VocabWord {
        create_word(input(term, "sens"), format!("id-{term}"), now())
    }

    #[test]
    fn validation() {
        let ok = validate_word(&input("  hand   over ", " remettre "), &[]).unwrap();
        assert_eq!(
            (ok.term.as_str(), ok.meaning.as_str()),
            ("hand over", "remettre")
        );
        assert!(validate_word(&input("", "x"), &[])
            .unwrap_err()
            .contains("mot ou l'expression"));
        assert!(validate_word(&input("a", " "), &[])
            .unwrap_err()
            .contains("sens en français"));
        let existing = vec![word("Invoice")];
        assert!(validate_word(&input(" invoice ", "facture"), &existing)
            .unwrap_err()
            .contains("déjà"));
        let mut gone = word("invoice");
        gone.deleted = true;
        assert!(validate_word(&input("invoice", "facture"), &[gone]).is_ok());
        let long = validate_word(&input(&"x".repeat(200), "m"), &[]).unwrap();
        assert_eq!(long.term.chars().count(), LIMIT_TERM);
    }

    #[test]
    fn revision_leitner() {
        let w = word("deadline");
        assert!(due_words(std::slice::from_ref(&w), now()).len() == 1);
        let good = review_word(&w, true, now());
        assert_eq!(good.box_, 2);
        assert_eq!(good.due, now() + Duration::days(2));
        assert!(due_words(&[good], now()).is_empty());
        let bad = review_word(&w, false, now());
        assert_eq!((bad.box_, bad.lapses), (1, 1));
    }

    #[test]
    fn suppression_et_fusion() {
        let w = word("a");
        let gone = mark_deleted(&w, now() + Duration::seconds(5));
        assert!(active_words(std::slice::from_ref(&gone)).is_empty());
        let merged = merge_words(&[w], &[gone]);
        assert_eq!(merged.len(), 1);
        assert!(merged[0].deleted);
    }

    #[test]
    fn exemple_depuis_phrase_a_trous() {
        assert_eq!(
            example_from_prompt("The report must be ______ by Friday .", "submitted"),
            "The report must be submitted by Friday."
        );
        assert_eq!(
            example_from_prompt("Please (101) ____ the form.", "sign"),
            "Please sign the form."
        );
        assert_eq!(example_from_prompt("Which email is true?", "x"), "");
    }

    #[test]
    fn json_compatible() {
        let json = serde_json::to_string(&word("a")).unwrap();
        assert!(
            json.contains("\"box\":1")
                && json.contains("\"createdAt\"")
                && !json.contains("deleted")
        );
    }
}
