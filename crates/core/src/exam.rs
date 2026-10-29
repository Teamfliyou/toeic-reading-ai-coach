//! Examen blanc Reading : composition, chronomètre, correction, score estimé.
//! Port de `src/lib/exam.ts`.

use lernoviq_models::ExamQuestionRef;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub const EXAM_DURATION_MS: i64 = 75 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamState {
    pub started_at: i64,
    pub deadline: i64,
    pub question_ids: Vec<String>,
    pub answers: HashMap<String, String>,
    pub flagged: Vec<String>,
    pub time_spent: HashMap<String, i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorded: Option<bool>,
}

/// Table de conversion APPROXIMATIVE (bonnes réponses sur 100 → score 5..495).
const CONVERSION: [(f64, f64); 11] = [
    (0.0, 5.0),
    (10.0, 40.0),
    (20.0, 90.0),
    (30.0, 140.0),
    (40.0, 190.0),
    (50.0, 240.0),
    (60.0, 290.0),
    (70.0, 345.0),
    (80.0, 400.0),
    (90.0, 455.0),
    (100.0, 495.0),
];

/// Score Reading estimé (5 à 495, par pas de 5), extrapolé si moins de 100 questions.
pub fn estimate_reading_score(correct: u32, total: u32) -> u32 {
    if total == 0 {
        return 5;
    }
    let ratio = (f64::from(correct) / f64::from(total)).clamp(0.0, 1.0) * 100.0;
    for i in 1..CONVERSION.len() {
        let (x1, y1) = CONVERSION[i];
        if ratio <= x1 {
            let (x0, y0) = CONVERSION[i - 1];
            let value = y0 + ((ratio - x0) / (x1 - x0)) * (y1 - y0);
            return ((value / 5.0).round() * 5.0).clamp(5.0, 495.0) as u32;
        }
    }
    495
}

/// Ordre de l'examen : parties 5, 6, 7, chacune dans l'ordre du jeu de données.
pub fn build_exam(questions: &[ExamQuestionRef]) -> Vec<String> {
    let mut qs: Vec<&ExamQuestionRef> = questions
        .iter()
        .filter(|q| (5..=7).contains(&q.part))
        .collect();
    qs.sort_by_key(|q| (q.part, q.order_index));
    qs.into_iter().map(|q| q.id.clone()).collect()
}

pub fn new_exam_state(question_ids: Vec<String>, now: i64, duration_ms: i64) -> ExamState {
    ExamState {
        started_at: now,
        deadline: now + duration_ms,
        question_ids,
        answers: HashMap::new(),
        flagged: vec![],
        time_spent: HashMap::new(),
        finished_at: None,
        recorded: None,
    }
}

pub fn remaining_ms(state: &ExamState, now: i64) -> i64 {
    if state.finished_at.is_some() {
        return 0;
    }
    (state.deadline - now).max(0)
}

/// Format « 74:59 » (ou « 1:14:59 » au-delà d'une heure).
pub fn format_clock(ms: i64) -> String {
    let total = ((ms as f64) / 1000.0).ceil().max(0.0) as i64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

pub fn toggle_flag(state: &mut ExamState, id: &str) {
    if let Some(pos) = state.flagged.iter().position(|x| x == id) {
        state.flagged.remove(pos);
    } else {
        state.flagged.push(id.to_string());
    }
}

/// Sans effet une fois l'examen terminé.
pub fn set_answer(state: &mut ExamState, id: &str, key: &str) {
    if state.finished_at.is_none() {
        state.answers.insert(id.to_string(), key.to_string());
    }
}

pub fn add_time(state: &mut ExamState, id: &str, ms: i64) {
    if state.finished_at.is_some() || ms <= 0 {
        return;
    }
    *state.time_spent.entry(id.to_string()).or_insert(0) += ms;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartScore {
    pub total: u32,
    pub correct: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamResult {
    pub total: u32,
    pub correct: u32,
    pub answered: u32,
    pub unanswered: Vec<String>,
    pub wrong: Vec<String>,
    pub by_part: BTreeMap<u8, PartScore>,
    pub score: u32,
    /// Vrai si l'examen compte moins de 100 questions (score extrapolé).
    pub reduced: bool,
}

/// Corrige l'examen : une question sans réponse compte comme fausse.
pub fn grade_exam(state: &ExamState, questions: &[ExamQuestionRef]) -> ExamResult {
    let by_id: HashMap<&str, &ExamQuestionRef> =
        questions.iter().map(|q| (q.id.as_str(), q)).collect();
    let mut by_part: BTreeMap<u8, PartScore> = BTreeMap::new();
    let (mut wrong, mut unanswered) = (vec![], vec![]);
    let (mut correct, mut answered, mut total) = (0u32, 0u32, 0u32);
    for id in &state.question_ids {
        let Some(q) = by_id.get(id.as_str()) else {
            continue;
        };
        total += 1;
        let part = by_part.entry(q.part).or_default();
        part.total += 1;
        let Some(answer) = state.answers.get(id).filter(|a| !a.is_empty()) else {
            unanswered.push(id.clone());
            continue;
        };
        answered += 1;
        if *answer == q.correct_key {
            correct += 1;
            part.correct += 1;
        } else {
            wrong.push(id.clone());
        }
    }
    ExamResult {
        total,
        correct,
        answered,
        unanswered,
        wrong,
        by_part,
        score: estimate_reading_score(correct, total),
        reduced: total < 100,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(id: &str, part: u8, order: u32, key: &str) -> ExamQuestionRef {
        ExamQuestionRef {
            id: id.into(),
            part,
            order_index: order,
            correct_key: key.into(),
        }
    }
    fn sample() -> Vec<ExamQuestionRef> {
        vec![
            q("p7-b", 7, 2, "A"),
            q("p5-b", 5, 2, "B"),
            q("p6-a", 6, 1, "A"),
            q("p5-a", 5, 1, "A"),
            q("p7-a", 7, 1, "A"),
            q("l2", 2, 1, "A"),
        ]
    }

    #[test]
    fn score_bornes_et_monotonie() {
        assert_eq!(estimate_reading_score(0, 100), 5);
        assert_eq!(estimate_reading_score(100, 100), 495);
        assert_eq!(estimate_reading_score(50, 100), 240);
        let mut prev = 0;
        for c in 0..=100 {
            let s = estimate_reading_score(c, 100);
            assert!(
                s >= prev && s.is_multiple_of(5) && (5..=495).contains(&s),
                "c={c} s={s}"
            );
            prev = s;
        }
    }

    #[test]
    fn score_extrapole() {
        assert_eq!(estimate_reading_score(33, 33), 495);
        assert_eq!(
            estimate_reading_score(15, 30),
            estimate_reading_score(50, 100)
        );
        assert_eq!(estimate_reading_score(0, 0), 5);
        assert_eq!(estimate_reading_score(200, 100), 495);
    }

    #[test]
    fn composition_sans_listening() {
        assert_eq!(
            build_exam(&sample()),
            ["p5-a", "p5-b", "p6-a", "p7-a", "p7-b"]
        );
    }

    #[test]
    fn chronometre() {
        let s = new_exam_state(vec!["a".into()], 1_000, EXAM_DURATION_MS);
        assert_eq!(s.deadline - s.started_at, EXAM_DURATION_MS);
        assert_eq!(remaining_ms(&s, 1_000), 75 * 60_000);
        assert_eq!(remaining_ms(&s, 61_000), 74 * 60_000);
        assert_eq!(remaining_ms(&s, s.deadline + 5000), 0);
        let mut done = s.clone();
        done.finished_at = Some(5);
        assert_eq!(remaining_ms(&done, 2_000), 0);
        assert_eq!(format_clock(75 * 60_000), "1:15:00");
        assert_eq!(format_clock(59_001), "01:00");
        assert_eq!(format_clock(-5), "00:00");
    }

    #[test]
    fn reponses_drapeaux_temps() {
        let mut s = new_exam_state(vec!["a".into(), "b".into()], 0, EXAM_DURATION_MS);
        set_answer(&mut s, "a", "C");
        set_answer(&mut s, "a", "D");
        toggle_flag(&mut s, "b");
        assert_eq!(s.answers["a"], "D");
        assert_eq!(s.flagged, ["b"]);
        toggle_flag(&mut s, "b");
        assert!(s.flagged.is_empty());
        add_time(&mut s, "a", 1500);
        add_time(&mut s, "a", 500);
        add_time(&mut s, "a", -5);
        assert_eq!(s.time_spent["a"], 2000);
        s.finished_at = Some(10);
        set_answer(&mut s, "b", "A");
        assert!(!s.answers.contains_key("b"));
    }

    #[test]
    fn correction() {
        let qs = sample();
        let mut s = new_exam_state(build_exam(&qs), 0, EXAM_DURATION_MS);
        set_answer(&mut s, "p5-a", "A");
        set_answer(&mut s, "p5-b", "A");
        set_answer(&mut s, "p7-a", "A");
        let r = grade_exam(&s, &qs);
        assert_eq!((r.total, r.correct, r.answered), (5, 2, 3));
        assert_eq!(r.wrong, ["p5-b"]);
        assert_eq!(r.unanswered, ["p6-a", "p7-b"]);
        assert_eq!(
            r.by_part[&5],
            PartScore {
                total: 2,
                correct: 1
            }
        );
        assert_eq!(
            r.by_part[&6],
            PartScore {
                total: 1,
                correct: 0
            }
        );
        assert!(r.reduced);
        assert_eq!(r.score, estimate_reading_score(2, 5));
    }

    #[test]
    fn json_camel_case_compatible() {
        let s = new_exam_state(vec!["a".into()], 1, 10);
        let v = serde_json::to_string(&s).unwrap();
        assert!(
            v.contains("\"startedAt\"")
                && v.contains("\"questionIds\"")
                && !v.contains("finishedAt")
        );
    }
}
