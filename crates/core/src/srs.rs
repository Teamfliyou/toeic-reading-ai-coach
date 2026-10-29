//! Répétition espacée de type Leitner (boîtes 1 à 5). Port de `src/lib/srs.ts`.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Délai (jours) avant la prochaine révision, selon la boîte d'arrivée.
pub const INTERVAL_DAYS: [i64; 5] = [1, 2, 4, 8, 16];
pub const MAX_BOX: u8 = INTERVAL_DAYS.len() as u8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCard {
    pub question_id: String,
    pub part: u8,
    /// Clé JSON d'origine : `box` (mot réservé en Rust).
    #[serde(rename = "box")]
    pub box_: u8,
    pub due: DateTime<Utc>,
    pub mastered: bool,
    pub lapses: u32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AnswerEvent {
    pub question_id: String,
    pub part: u8,
    pub correct: bool,
}

pub fn is_due(card: &ReviewCard, now: DateTime<Utc>) -> bool {
    !card.mastered && card.due <= now
}

pub fn due_cards(cards: &[ReviewCard], now: DateTime<Utc>) -> Vec<ReviewCard> {
    let mut due: Vec<ReviewCard> = cards.iter().filter(|c| is_due(c, now)).cloned().collect();
    due.sort_by(|a, b| a.box_.cmp(&b.box_).then(a.due.cmp(&b.due)));
    due
}

/// Compte des cartes par boîte (1..=5) et des cartes maîtrisées.
pub fn box_counts(cards: &[ReviewCard]) -> ([u32; 5], u32) {
    let (mut boxes, mut mastered) = ([0u32; 5], 0u32);
    for c in cards {
        if c.mastered {
            mastered += 1;
        } else {
            boxes[(c.box_.clamp(1, MAX_BOX) - 1) as usize] += 1;
        }
    }
    (boxes, mastered)
}

/// Applique une réponse et renvoie la nouvelle liste.
pub fn apply_answer(
    cards: &[ReviewCard],
    event: &AnswerEvent,
    now: DateTime<Utc>,
) -> Vec<ReviewCard> {
    let existing = cards.iter().find(|c| c.question_id == event.question_id);
    let replace = |next: ReviewCard| -> Vec<ReviewCard> {
        cards
            .iter()
            .map(|c| {
                if c.question_id == event.question_id {
                    next.clone()
                } else {
                    c.clone()
                }
            })
            .collect()
    };

    if !event.correct {
        let next = ReviewCard {
            question_id: event.question_id.clone(),
            part: event.part,
            box_: 1,
            due: now,
            mastered: false,
            lapses: existing.map_or(0, |c| c.lapses) + 1,
            updated_at: now,
        };
        return if existing.is_some() {
            replace(next)
        } else {
            std::iter::once(next).chain(cards.iter().cloned()).collect()
        };
    }

    let Some(existing) = existing.filter(|c| is_due(c, now)) else {
        return cards.to_vec();
    };
    let promoted = if existing.box_ >= MAX_BOX {
        ReviewCard {
            mastered: true,
            updated_at: now,
            ..existing.clone()
        }
    } else {
        ReviewCard {
            box_: existing.box_ + 1,
            due: now + Duration::days(INTERVAL_DAYS[existing.box_ as usize]),
            updated_at: now,
            ..existing.clone()
        }
    };
    replace(promoted)
}

/// Fusion de deux listes (appareils différents) : la plus récente gagne.
pub fn merge_cards(local: &[ReviewCard], remote: &[ReviewCard]) -> Vec<ReviewCard> {
    let mut by_id: HashMap<&str, &ReviewCard> = HashMap::new();
    let mut order: Vec<&str> = vec![];
    for c in local.iter().chain(remote) {
        match by_id.get(c.question_id.as_str()) {
            None => {
                order.push(&c.question_id);
                by_id.insert(&c.question_id, c);
            }
            Some(known) if c.updated_at > known.updated_at => {
                by_id.insert(&c.question_id, c);
            }
            _ => {}
        }
    }
    order.into_iter().map(|id| by_id[id].clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(day: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap() + Duration::days(day)
    }
    fn ev(id: &str, correct: bool) -> AnswerEvent {
        AnswerEvent {
            question_id: id.into(),
            part: 5,
            correct,
        }
    }

    #[test]
    fn erreur_cree_carte_en_boite_1() {
        let cards = apply_answer(&[], &ev("a", false), t(0));
        assert_eq!((cards[0].box_, cards[0].lapses, cards[0].due), (1, 1, t(0)));
        let again = apply_answer(&cards, &ev("a", false), t(1));
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].lapses, 2);
    }

    #[test]
    fn promotion_et_maitrise() {
        let mut cards = apply_answer(&[], &ev("a", false), t(0));
        let mut now = t(0);
        for expected_box in 2..=5u8 {
            cards = apply_answer(&cards, &ev("a", true), now);
            assert_eq!(cards[0].box_, expected_box);
            assert_eq!(
                cards[0].due,
                now + Duration::days(INTERVAL_DAYS[(expected_box - 1) as usize])
            );
            now = cards[0].due;
        }
        cards = apply_answer(&cards, &ev("a", true), now);
        assert!(cards[0].mastered);
        assert!(!is_due(&cards[0], t(10_000)));
    }

    #[test]
    fn bonne_reponse_hors_echeance_sans_effet() {
        let cards = apply_answer(&[], &ev("a", false), t(0));
        let promoted = apply_answer(&cards, &ev("a", true), t(0));
        let untouched = apply_answer(&promoted, &ev("a", true), t(0));
        assert_eq!(promoted, untouched);
        assert!(apply_answer(&[], &ev("zz", true), t(0)).is_empty());
    }

    #[test]
    fn comptage_fusion_et_json() {
        let a = apply_answer(&[], &ev("a", false), t(0));
        assert_eq!(box_counts(&a), ([1, 0, 0, 0, 0], 0));
        let newer = apply_answer(&a, &ev("a", false), t(5));
        let merged = merge_cards(&a, &newer);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].updated_at, t(5));
        let json = serde_json::to_string(&a[0]).unwrap();
        assert!(json.contains("\"box\":1") && json.contains("\"questionId\""));
    }
}
