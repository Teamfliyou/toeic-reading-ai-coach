//! Objectif et plan d'étude. Port de `src/lib/goals.ts` (tests : `tests/goals.test.mjs`).

use crate::stats::day_key;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use lernoviq_models::Attempt;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goals {
    /// Date de l'examen (AAAA-MM-JJ).
    pub exam_date: Option<NaiveDate>,
    /// Score Reading visé (5 à 495).
    pub target_score: Option<u32>,
    pub daily_goal: u32,
    pub updated_at: DateTime<Utc>,
}

pub const DEFAULT_DAILY_GOAL: u32 = 10;

impl Default for Goals {
    fn default() -> Self {
        Self {
            exam_date: None,
            target_score: None,
            daily_goal: DEFAULT_DAILY_GOAL,
            updated_at: DateTime::UNIX_EPOCH,
        }
    }
}

/// Saisie brute du formulaire.
#[derive(Debug, Clone, Default)]
pub struct GoalsInput {
    pub exam_date: Option<String>,
    pub target_score: Option<f64>,
    pub daily_goal: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidGoals {
    pub exam_date: Option<NaiveDate>,
    pub target_score: Option<u32>,
    pub daily_goal: u32,
}

fn as_int(v: f64, min: f64, max: f64) -> Option<u32> {
    (v.fract() == 0.0 && v >= min && v <= max).then_some(v as u32)
}

/// Valide la saisie ; renvoie des objectifs cohérents ou un message en français.
pub fn validate_goals(input: &GoalsInput, today: NaiveDate) -> Result<ValidGoals, String> {
    let mut exam_date = None;
    if let Some(raw) = input.exam_date.as_deref().filter(|s| !s.is_empty()) {
        let invalid = || "Date d'examen invalide.".to_string();
        if raw.len() != 10 {
            return Err(invalid());
        }
        let date = NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| invalid())?;
        if date < today {
            return Err("La date d'examen doit être aujourd'hui ou plus tard.".into());
        }
        exam_date = Some(date);
    }

    let target_score = match input.target_score {
        None => None,
        Some(v) => {
            Some(as_int(v, 5.0, 495.0).ok_or("Le score visé doit être un entier entre 5 et 495.")?)
        }
    };

    let daily = input.daily_goal.unwrap_or(f64::from(DEFAULT_DAILY_GOAL));
    let daily_goal = as_int(daily, 1.0, 200.0)
        .ok_or("L'objectif quotidien doit être un entier entre 1 et 200 questions.")?;
    Ok(ValidGoals {
        exam_date,
        target_score,
        daily_goal,
    })
}

/// Jours restants jusqu'à l'examen (0 = aujourd'hui).
pub fn days_until(exam_date: Option<NaiveDate>, today: NaiveDate) -> Option<i64> {
    exam_date.map(|d| (d - today).num_days())
}

/// Questions traitées aujourd'hui (Reading et Listening).
pub fn answered_today<Tz: TimeZone>(attempts: &[Attempt], today: NaiveDate, tz: &Tz) -> usize {
    attempts
        .iter()
        .filter(|a| day_key(a.at, tz) == today)
        .count()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExamRecord {
    pub at: DateTime<Utc>,
    pub score: u32,
    pub correct: u32,
    pub total: u32,
}

pub fn latest_exam_score(history: &[ExamRecord]) -> Option<u32> {
    history.iter().max_by_key(|r| r.at).map(|r| r.score)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyPlan {
    pub days_left: Option<i64>,
    pub weeks_left: Option<i64>,
    /// Écart entre le score visé et le dernier examen blanc.
    pub gap: Option<u32>,
    pub recommended_daily: u32,
    pub mock_exams_per_week: u32,
    pub focus: Vec<String>,
    pub summary: String,
}

/// Plan d'étude INDICATIF : chaque point à gagner demande environ deux questions
/// travaillées, réparties sur les jours restants sans descendre sous l'objectif choisi.
pub fn build_plan(
    goals: &Goals,
    last_exam_score: Option<u32>,
    weak_categories: &[String],
    today: NaiveDate,
) -> StudyPlan {
    let days_left = days_until(goals.exam_date, today);
    let gap = goals
        .target_score
        .zip(last_exam_score)
        .map(|(t, s)| t.saturating_sub(s));

    let mut recommended = goals.daily_goal;
    if let (Some(days), Some(g)) = (days_left, gap) {
        if days > 0 && g > 0 {
            let needed = (i64::from(g) * 2 + days - 1) / days;
            recommended = needed.max(i64::from(goals.daily_goal)).min(60) as u32;
        }
    }
    let weeks_left = days_left.map(|d| ((d + 6) / 7).max(0));
    let mock = u32::from(days_left.is_some_and(|d| d >= 14));

    let summary = match (days_left, gap) {
        (None, _) => "Ajoutez une date d'examen pour obtenir un plan jusqu'au jour J.".to_string(),
        (Some(0), _) => "L'examen est aujourd'hui : relisez vos fiches et reposez-vous. Bonne chance !".to_string(),
        (Some(d), None) => format!("Il reste {d} jour(s). Passez un examen blanc pour mesurer votre point de départ."),
        (Some(d), Some(0)) => format!(
            "Il reste {d} jour(s) : votre dernier examen blanc atteint déjà l'objectif, consolidez avec {recommended} questions par jour."
        ),
        (Some(d), Some(g)) => format!(
            "Il reste {d} jour(s) et {g} points à gagner : environ {recommended} questions par jour{}.",
            if mock > 0 { " et un examen blanc par semaine" } else { "" }
        ),
    };

    StudyPlan {
        days_left,
        weeks_left,
        gap,
        recommended_daily: recommended,
        mock_exams_per_week: mock,
        focus: weak_categories.iter().take(3).cloned().collect(),
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }
    fn today() -> NaiveDate {
        d(2026, 10, 10)
    }
    fn goals(exam: Option<NaiveDate>, target: Option<u32>, daily: u32) -> Goals {
        Goals {
            exam_date: exam,
            target_score: target,
            daily_goal: daily,
            ..Goals::default()
        }
    }
    fn input(date: Option<&str>, target: Option<f64>, daily: Option<f64>) -> GoalsInput {
        GoalsInput {
            exam_date: date.map(String::from),
            target_score: target,
            daily_goal: daily,
        }
    }

    #[test]
    fn validation_acceptee() {
        let ok =
            validate_goals(&input(Some("2026-12-15"), Some(400.0), Some(15.0)), today()).unwrap();
        assert_eq!(
            ok,
            ValidGoals {
                exam_date: Some(d(2026, 12, 15)),
                target_score: Some(400),
                daily_goal: 15
            }
        );
        assert_eq!(
            validate_goals(&GoalsInput::default(), today()).unwrap(),
            ValidGoals {
                exam_date: None,
                target_score: None,
                daily_goal: 10
            }
        );
        assert!(validate_goals(&input(Some("2026-10-10"), None, None), today()).is_ok());
    }

    #[test]
    fn validation_refusee() {
        let err = |i: GoalsInput| validate_goals(&i, today()).unwrap_err();
        assert!(err(input(Some("2026-10-09"), None, None)).contains("aujourd'hui ou plus tard"));
        assert!(err(input(Some("2026-02-30"), None, None)).contains("invalide"));
        assert!(err(input(Some("demain"), None, None)).contains("invalide"));
        assert!(err(input(None, Some(500.0), None)).contains("entre 5 et 495"));
        assert!(err(input(None, Some(12.5), None)).contains("entre 5 et 495"));
        assert!(err(input(None, None, Some(0.0))).contains("entre 1 et 200"));
        assert!(err(input(None, None, Some(1000.0))).contains("entre 1 et 200"));
    }

    #[test]
    fn jours_restants() {
        assert_eq!(days_until(None, today()), None);
        assert_eq!(days_until(Some(d(2026, 10, 10)), today()), Some(0));
        assert_eq!(days_until(Some(d(2026, 12, 15)), today()), Some(66));
        assert_eq!(days_until(Some(d(2026, 10, 9)), today()), Some(-1));
    }

    #[test]
    fn dernier_examen() {
        let at = |m, day| Utc.with_ymd_and_hms(2026, m, day, 10, 0, 0).unwrap();
        assert_eq!(latest_exam_score(&[]), None);
        let h = vec![
            ExamRecord {
                at: at(9, 1),
                score: 300,
                correct: 0,
                total: 0,
            },
            ExamRecord {
                at: at(10, 1),
                score: 340,
                correct: 0,
                total: 0,
            },
        ];
        assert_eq!(latest_exam_score(&h), Some(340));
    }

    #[test]
    fn plan_guide_vers_la_prochaine_etape() {
        let p = build_plan(&goals(None, None, 10), None, &[], today());
        assert!(p.summary.contains("date d'examen"));
        let p = build_plan(
            &goals(Some(d(2026, 12, 15)), Some(400), 10),
            None,
            &[],
            today(),
        );
        assert!(p.summary.contains("examen blanc"));
        assert_eq!((p.gap, p.recommended_daily), (None, 10));
    }

    #[test]
    fn plan_rythme_et_plafond() {
        let weak: Vec<String> = ["prepositions", "connectors", "vocabulary", "clauses"]
            .map(String::from)
            .to_vec();
        let p = build_plan(
            &goals(Some(d(2026, 12, 15)), Some(400), 10),
            Some(330),
            &weak,
            today(),
        );
        assert_eq!(
            (
                p.gap,
                p.days_left,
                p.recommended_daily,
                p.mock_exams_per_week
            ),
            (Some(70), Some(66), 10, 1)
        );
        assert_eq!(p.focus, ["prepositions", "connectors", "vocabulary"]);

        let tight = build_plan(
            &goals(Some(d(2026, 10, 20)), Some(450), 10),
            Some(250),
            &[],
            today(),
        );
        assert_eq!(
            (tight.recommended_daily, tight.mock_exams_per_week),
            (40, 0)
        );
        let capped = build_plan(
            &goals(Some(d(2026, 10, 11)), Some(495), 10),
            Some(5),
            &[],
            today(),
        );
        assert_eq!(capped.recommended_daily, 60);
    }

    #[test]
    fn plan_objectif_atteint_et_jour_j() {
        let r = build_plan(
            &goals(Some(d(2026, 11, 10)), Some(300), 10),
            Some(320),
            &[],
            today(),
        );
        assert_eq!(r.gap, Some(0));
        assert!(r.summary.contains("atteint déjà l'objectif"));
        assert!(
            build_plan(&goals(Some(today()), None, 10), None, &[], today())
                .summary
                .contains("aujourd'hui")
        );
    }
}
