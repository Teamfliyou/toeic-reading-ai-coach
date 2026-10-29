//! Entraînement adaptatif : compétences pondérées par l'ancienneté, vitesse, tendance,
//! répétitions, difficulté progressive et recommandations. Port de `src/lib/adaptive.ts`
//! (tests de référence : `tests/adaptive.test.mjs`).

use crate::goals::Goals;
use chrono::{DateTime, Utc};
use lernoviq_models::{Attempt, MAX_COUNTED_TIME_MS};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

const DAY_MS: f64 = 86_400_000.0;
/// Une réponse perd la moitié de son poids tous les 14 jours.
pub const HALF_LIFE_DAYS: f64 = 14.0;
const PRIOR: f64 = 0.6;
const PRIOR_WEIGHT: f64 = 3.0;

/// Temps moyen visé par question (ms) : ordre de grandeur d'un examen de 75 minutes.
pub fn target_time_ms(part: u8) -> f64 {
    match part {
        5 => 25_000.0,
        6 => 35_000.0,
        7 => 60_000.0,
        _ => 40_000.0,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStat {
    pub part: u8,
    pub category: String,
    pub attempts: usize,
    pub correct: usize,
    /// Précision pondérée par l'ancienneté et lissée par l'a priori (0 à 1).
    pub accuracy: f64,
    pub avg_time_ms: Option<i64>,
    /// > 1 : plus lent que la cible de la partie.
    pub speed_ratio: Option<f64>,
    /// Variation entre les 5 dernières réponses et les 5 précédentes (-1 à 1).
    pub trend: Option<f64>,
    /// Questions ratées au moins deux fois.
    pub repeated_errors: usize,
    pub last_at: DateTime<Utc>,
    /// Besoin de travail (0 à 1).
    pub need: f64,
}

fn is_answered(a: &Attempt) -> bool {
    a.selected_key != "-" && a.category.as_deref().is_some_and(|c| !c.is_empty())
}

fn newest_first(attempts: &[Attempt]) -> Vec<&Attempt> {
    let mut sorted: Vec<&Attempt> = attempts.iter().collect();
    sorted.sort_by_key(|a| std::cmp::Reverse(a.at));
    sorted
}

/// Identifiants des dernières questions vues (récentes d'abord).
pub fn recent_seen_ids(attempts: &[Attempt], parts: &[u8], max: usize) -> Vec<String> {
    let mut ids = vec![];
    let mut known: HashSet<&str> = HashSet::new();
    for a in newest_first(attempts) {
        if !parts.contains(&a.part) || !known.insert(a.question_id.as_str()) {
            continue;
        }
        ids.push(a.question_id.clone());
        if ids.len() >= max {
            break;
        }
    }
    ids
}

fn rate(xs: &[&Attempt]) -> f64 {
    xs.iter().filter(|a| a.correct).count() as f64 / xs.len() as f64
}

/// Compétences (partie × catégorie) de la plus urgente à la plus solide.
pub fn analyze_skills(attempts: &[Attempt], now: DateTime<Utc>) -> Vec<SkillStat> {
    let mut index: HashMap<(u8, &str), usize> = HashMap::new();
    let mut groups: Vec<((u8, &str), Vec<Attempt>)> = vec![];
    for a in attempts.iter().filter(|a| is_answered(a) && a.part != 2) {
        let key = (a.part, a.category.as_deref().unwrap_or_default());
        let i = *index.entry(key).or_insert_with(|| {
            groups.push((key, vec![]));
            groups.len() - 1
        });
        groups[i].1.push(a.clone());
    }

    let mut stats: Vec<SkillStat> = vec![];
    for ((part, category), list) in &groups {
        let sorted = newest_first(list);
        let (mut weighted, mut weights, mut correct) = (0.0, 0.0, 0usize);
        let (mut time, mut timed) = (0i64, 0i64);
        let mut wrong_by_question: HashMap<&str, usize> = HashMap::new();
        for a in &sorted {
            let age = ((now - a.at).num_milliseconds() as f64 / DAY_MS).max(0.0);
            let w = 0.5f64.powf(age / HALF_LIFE_DAYS);
            weighted += if a.correct { w } else { 0.0 };
            weights += w;
            if a.correct {
                correct += 1;
            } else {
                *wrong_by_question.entry(a.question_id.as_str()).or_insert(0) += 1;
            }
            if a.time_ms > 0 {
                time += a.time_ms.min(MAX_COUNTED_TIME_MS);
                timed += 1;
            }
        }
        let n = sorted.len();
        let nf = n as f64;
        let accuracy = (weighted + PRIOR * PRIOR_WEIGHT * (weights / nf))
            / (weights + PRIOR_WEIGHT * (weights / nf));
        let avg_time_ms = (timed > 0).then(|| (time as f64 / timed as f64).round() as i64);
        let speed_ratio = avg_time_ms.map(|t| t as f64 / target_time_ms(*part));
        let trend = (n >= 8).then(|| rate(&sorted[..5]) - rate(&sorted[5..n.min(10)]));
        let last_at = sorted[0].at;
        let stale_days = (now - last_at).num_milliseconds() as f64 / DAY_MS;
        let repeated_errors = wrong_by_question.values().filter(|c| **c >= 2).count();

        let need = (1.0 - accuracy) * 0.62
            + speed_ratio
                .filter(|r| *r > 1.3)
                .map_or(0.0, |r| ((r - 1.3) * 0.15).min(0.15))
            + (stale_days / 30.0 * 0.12).min(0.12)
            + trend
                .filter(|t| *t < 0.0)
                .map_or(0.0, |t| (-t * 0.2).min(0.1))
            + (repeated_errors as f64 * 0.03).min(0.1);

        stats.push(SkillStat {
            part: *part,
            category: (*category).to_string(),
            attempts: n,
            correct,
            accuracy,
            avg_time_ms,
            speed_ratio,
            trend,
            repeated_errors,
            last_at,
            need,
        });
    }
    stats.sort_by(|a, b| b.need.total_cmp(&a.need));
    stats
}

/// Difficulté progressive : on monte d'un niveau quand la catégorie est maîtrisée.
/// `skill` = (précision, nombre de réponses).
pub fn difficulty_for(skill: Option<(f64, usize)>) -> u8 {
    match skill {
        Some((accuracy, attempts)) if attempts >= 3 => {
            if accuracy < 0.5 {
                1
            } else if accuracy < 0.8 {
                2
            } else {
                3
            }
        }
        _ => 2,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecommendationKind {
    Review,
    Targeted,
    Mixed,
    Unseen,
    Progressive,
    Exam,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Recommendation {
    pub kind: RecommendationKind,
    pub title: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub difficulty: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    pub href: String,
}

/// Paramètres d'une série, transportés dans l'adresse (`#/practice/part5?category=…`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeriesParams {
    pub category: Option<String>,
    pub categories: Vec<String>,
    pub difficulty: Option<u8>,
    pub limit: Option<u32>,
    pub unseen: bool,
}

fn encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len()
                && bytes[i + 1].is_ascii_hexdigit()
                && bytes[i + 2].is_ascii_hexdigit() =>
            {
                out.push(u8::from_str_radix(&value[i + 1..i + 3], 16).unwrap_or(b'%'));
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn series_href(part: u8, params: &SeriesParams) -> String {
    let mut q: Vec<String> = vec![];
    if !params.categories.is_empty() {
        q.push(format!(
            "categories={}",
            encode(&params.categories.join(","))
        ));
    } else if let Some(c) = params.category.as_deref().filter(|c| !c.is_empty()) {
        q.push(format!("category={}", encode(c)));
    }
    if let Some(d) = params.difficulty.filter(|d| *d > 0) {
        q.push(format!("difficulty={d}"));
    }
    if let Some(l) = params.limit.filter(|l| *l > 0) {
        q.push(format!("limit={l}"));
    }
    if params.unseen {
        q.push("unseen=1".into());
    }
    let query = q.join("&");
    if query.is_empty() {
        format!("#/practice/part{part}")
    } else {
        format!("#/practice/part{part}?{query}")
    }
}

/// Lit les paramètres d'une série ; toute valeur invalide est ignorée.
pub fn parse_series_params(search: &str, part: u8, valid_categories: &[&str]) -> SeriesParams {
    let search = search.strip_prefix('?').unwrap_or(search);
    let get = |name: &str| -> Option<String> {
        search.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(k) == name).then(|| decode(v))
        })
    };
    let mut out = SeriesParams::default();
    if let Some(c) = get("category").filter(|c| valid_categories.contains(&c.as_str())) {
        out.category = Some(c);
    }
    out.categories = get("categories")
        .unwrap_or_default()
        .split(',')
        .filter(|c| valid_categories.contains(c))
        .take(4)
        .map(String::from)
        .collect();
    let number = |name: &str| get(name).and_then(|v| v.trim().parse::<f64>().ok());
    if let Some(d) = number("difficulty").filter(|d| [1.0, 2.0, 3.0].contains(d)) {
        out.difficulty = Some(d as u8);
    }
    let max = if part == 5 { 40.0 } else { 6.0 };
    if let Some(l) = number("limit").filter(|l| l.fract() == 0.0 && *l >= 1.0 && *l <= max) {
        out.limit = Some(l as u32);
    }
    out.unseen = get("unseen").as_deref() == Some("1");
    out
}

pub struct PlanInput<'a> {
    pub attempts: &'a [Attempt],
    /// Cartes à revoir maintenant (répétition espacée).
    pub due_count: usize,
    pub goals: Option<&'a Goals>,
    pub last_exam_score: Option<u32>,
    pub now: DateTime<Utc>,
    pub labels: Option<&'a HashMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaptivePlan {
    pub skills: Vec<SkillStat>,
    pub recommendations: Vec<Recommendation>,
    pub daily_target: u32,
    pub summary: String,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n > 1 {
        many.into()
    } else {
        one.into()
    }
}

/// Plan de séance : révisions dues, exercices ciblés, séance mixte, questions jamais vues,
/// difficulté progressive, examen blanc.
pub fn build_adaptive_plan(input: &PlanInput) -> AdaptivePlan {
    let label = |c: &str| {
        input
            .labels
            .and_then(|l| l.get(c))
            .cloned()
            .unwrap_or_else(|| c.to_string())
    };
    let skills = analyze_skills(input.attempts, input.now);
    let daily = input.goals.map_or(10, |g| g.daily_goal);
    let mut recs: Vec<Recommendation> = vec![];
    let rec = |kind, title: String, reason: String, href: String| Recommendation {
        kind,
        title,
        reason,
        part: None,
        category: None,
        difficulty: None,
        limit: None,
        href,
    };
    let per_series = |part: u8, big: u32| if part == 5 { big } else { 2 };

    if input.due_count > 0 {
        let n = input.due_count;
        recs.push(rec(
            RecommendationKind::Review,
            format!("Réviser {n} question{} à revoir", plural(n, "", "s")),
            "Répétition espacée : ces questions reviennent au moment où vous risquez de les oublier.".into(),
            "#/review".into(),
        ));
    }

    let weak: Vec<&SkillStat> = skills
        .iter()
        .filter(|s| s.attempts >= 2 && s.accuracy < 0.85)
        .take(3)
        .collect();
    for s in &weak {
        let difficulty = difficulty_for(Some((s.accuracy, s.attempts)));
        let mut why = vec![format!(
            "{} % de réussite sur {} réponse{}",
            (s.accuracy * 100.0).round(),
            s.attempts,
            plural(s.attempts, "", "s")
        )];
        if let Some(r) = s.speed_ratio.filter(|r| *r > 1.3) {
            why.push(format!(
                "réponses {} % plus lentes que la cible",
                ((r - 1.0) * 100.0).round()
            ));
        }
        if s.trend.is_some_and(|t| t < -0.1) {
            why.push("en baisse récemment".into());
        }
        if s.repeated_errors > 0 {
            let n = s.repeated_errors;
            why.push(format!(
                "{n} question{} ratée{} plusieurs fois",
                plural(n, "", "s"),
                plural(n, "", "s")
            ));
        }
        let limit = per_series(s.part, 10);
        let mut r = rec(
            RecommendationKind::Targeted,
            format!("Cibler : {} (partie {})", label(&s.category), s.part),
            why.join(" · "),
            series_href(
                s.part,
                &SeriesParams {
                    category: Some(s.category.clone()),
                    difficulty: Some(difficulty),
                    limit: Some(limit),
                    unseen: true,
                    ..Default::default()
                },
            ),
        );
        (r.part, r.category, r.difficulty, r.limit) = (
            Some(s.part),
            Some(s.category.clone()),
            Some(difficulty),
            Some(limit),
        );
        recs.push(r);
    }

    let p5_weak: Vec<String> = skills
        .iter()
        .filter(|s| s.part == 5 && s.accuracy < 0.9)
        .take(3)
        .map(|s| s.category.clone())
        .collect();
    if p5_weak.len() >= 2 {
        let limit = daily.clamp(10, 20);
        let names: Vec<String> = p5_weak.iter().map(|c| label(c)).collect();
        let mut r = rec(
            RecommendationKind::Mixed,
            "Séance mixte de partie 5".into(),
            format!("Mélange de {} pour alterner les pièges.", names.join(", ")),
            series_href(
                5,
                &SeriesParams {
                    categories: p5_weak.clone(),
                    limit: Some(limit),
                    unseen: true,
                    ..Default::default()
                },
            ),
        );
        (r.part, r.limit) = (Some(5), Some(limit));
        recs.push(r);
    }

    let mut by_part: HashMap<u8, usize> = HashMap::new();
    for a in input.attempts {
        *by_part.entry(a.part).or_insert(0) += 1;
    }
    let count = |p: u8| by_part.get(&p).copied().unwrap_or(0);
    let least = [5u8, 6, 7]
        .into_iter()
        .min_by_key(|p| count(*p))
        .unwrap_or(5);
    let limit = if least == 5 { 15 } else { 2 };
    let mut r = rec(
        RecommendationKind::Unseen,
        format!("Questions jamais vues · partie {least}"),
        if count(least) == 0 {
            "Vous n'avez pas encore travaillé cette partie.".into()
        } else {
            "La partie la moins travaillée : de nouvelles questions pour élargir votre entraînement.".into()
        },
        series_href(
            least,
            &SeriesParams {
                unseen: true,
                limit: Some(limit),
                ..Default::default()
            },
        ),
    );
    (r.part, r.limit) = (Some(least), Some(limit));
    recs.push(r);

    if let Some(s) = skills.iter().find(|s| s.attempts >= 5 && s.accuracy >= 0.8) {
        let limit = per_series(s.part, 10);
        let mut r = rec(
            RecommendationKind::Progressive,
            format!(
                "Monter d'un cran : {} (partie {})",
                label(&s.category),
                s.part
            ),
            format!(
                "{} % de réussite : place aux questions avancées.",
                (s.accuracy * 100.0).round()
            ),
            series_href(
                s.part,
                &SeriesParams {
                    category: Some(s.category.clone()),
                    difficulty: Some(3),
                    limit: Some(limit),
                    unseen: true,
                    ..Default::default()
                },
            ),
        );
        (r.part, r.category, r.difficulty, r.limit) =
            (Some(s.part), Some(s.category.clone()), Some(3), Some(limit));
        recs.push(r);
    }

    if let Some(g) = input
        .goals
        .filter(|g| g.exam_date.is_some() || g.target_score.is_some_and(|t| t > 0))
    {
        let reason = match (
            g.target_score.filter(|t| *t > 0),
            input.last_exam_score.filter(|s| *s > 0),
        ) {
            (Some(goal), Some(last)) => {
                format!("Objectif {goal}, dernier score estimé {last} : mesurez votre progression.")
            }
            _ => "Mesurez votre niveau en conditions réelles (100 questions, 75 minutes).".into(),
        };
        recs.push(rec(
            RecommendationKind::Exam,
            "Examen blanc complet".into(),
            reason,
            "#/exam".into(),
        ));
    }

    let summary = if skills.is_empty() {
        "Pas encore d'historique : commencez par une série découverte, vos recommandations s'adapteront à vos réponses."
            .to_string()
    } else if weak.is_empty() {
        "Vos résultats sont solides : consolidez avec des questions avancées ou un examen blanc."
            .to_string()
    } else {
        let names: Vec<String> = weak.iter().map(|s| label(&s.category)).collect();
        format!("Priorité du moment : {}.", names.join(", "))
    };
    AdaptivePlan {
        skills,
        recommendations: recs,
        daily_target: daily,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, NaiveDate, TimeZone};
    use lernoviq_models::AttemptMode;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 25, 12, 0, 0).unwrap()
    }
    fn days_ago(d: i64) -> DateTime<Utc> {
        now() - Duration::days(d)
    }

    #[derive(Clone)]
    struct Spec {
        part: u8,
        category: Option<&'static str>,
        correct: bool,
        time_ms: i64,
        at: DateTime<Utc>,
        selected: &'static str,
    }
    fn spec() -> Spec {
        Spec {
            part: 5,
            category: Some("prepositions"),
            correct: true,
            time_ms: 15_000,
            at: days_ago(1),
            selected: "A",
        }
    }
    fn make(id: &str, s: &Spec) -> Attempt {
        Attempt {
            id: format!("a-{id}"),
            question_id: id.to_string(),
            part: s.part,
            category: s.category.map(String::from),
            selected_key: s.selected.into(),
            correct: s.correct,
            time_ms: s.time_ms,
            at: s.at,
            mode: AttemptMode::Practice,
            owner: None,
            synced: true,
        }
    }
    fn many(count: usize, s: Spec) -> Vec<Attempt> {
        (0..count)
            .map(|i| make(&format!("{}-{}-{i}", s.category.unwrap_or("c"), s.part), &s))
            .collect()
    }
    fn skill<'a>(stats: &'a [SkillStat], category: &str) -> &'a SkillStat {
        stats.iter().find(|s| s.category == category).unwrap()
    }

    #[test]
    fn competences_precision_ponderee() {
        let mut all = many(
            12,
            Spec {
                category: Some("connectors"),
                ..spec()
            },
        );
        all.extend(many(
            12,
            Spec {
                category: Some("prepositions"),
                correct: false,
                ..spec()
            },
        ));
        all.extend(many(
            1,
            Spec {
                category: Some("vocabulary"),
                correct: false,
                ..spec()
            },
        ));
        let stats = analyze_skills(&all, now());
        assert!(skill(&stats, "connectors").accuracy > 0.85);
        assert!(skill(&stats, "prepositions").accuracy < 0.25);
        assert!(skill(&stats, "vocabulary").accuracy > skill(&stats, "prepositions").accuracy);
        assert_eq!(stats[0].category, "prepositions");
        assert_eq!(stats.last().unwrap().category, "connectors");
    }

    #[test]
    fn anciennete() {
        let mut old = many(
            5,
            Spec {
                correct: false,
                at: days_ago(90),
                ..spec()
            },
        );
        old.extend(many(
            5,
            Spec {
                correct: true,
                at: days_ago(1),
                ..spec()
            },
        ));
        let mut recent = many(
            5,
            Spec {
                correct: true,
                at: days_ago(90),
                ..spec()
            },
        );
        recent.extend(many(
            5,
            Spec {
                correct: false,
                at: days_ago(1),
                ..spec()
            },
        ));
        assert!(
            analyze_skills(&old, now())[0].accuracy > analyze_skills(&recent, now())[0].accuracy
        );
    }

    #[test]
    fn vitesse_tendance_repetitions_oubli() {
        let base = many(
            10,
            Spec {
                time_ms: 12_000,
                at: days_ago(2),
                ..spec()
            },
        );
        let slow = many(
            10,
            Spec {
                time_ms: 60_000,
                at: days_ago(2),
                ..spec()
            },
        );
        let (b, s) = (
            &analyze_skills(&base, now())[0],
            &analyze_skills(&slow, now())[0],
        );
        assert!(s.speed_ratio.unwrap() > 2.0 && s.need > b.need);
        let forgotten = many(
            10,
            Spec {
                at: days_ago(40),
                ..spec()
            },
        );
        assert!(analyze_skills(&forgotten, now())[0].need > b.need);
        let mut sliding = many(
            6,
            Spec {
                at: days_ago(10),
                ..spec()
            },
        );
        sliding.extend(many(
            5,
            Spec {
                correct: false,
                at: days_ago(1),
                ..spec()
            },
        ));
        // Les identifiants doivent différer entre les deux lots.
        sliding
            .iter_mut()
            .skip(6)
            .enumerate()
            .for_each(|(i, a)| a.question_id = format!("w{i}"));
        assert!(analyze_skills(&sliding, now())[0].trend.unwrap() < -0.5);
        assert_eq!(analyze_skills(&many(4, spec()), now())[0].trend, None);

        let repeated = vec![
            make(
                "same",
                &Spec {
                    correct: false,
                    ..spec()
                },
            ),
            make(
                "same",
                &Spec {
                    correct: false,
                    ..spec()
                },
            ),
            make("other", &spec()),
        ];
        assert_eq!(analyze_skills(&repeated, now())[0].repeated_errors, 1);
        let ignored = vec![
            make("l", &Spec { part: 2, ..spec() }),
            make(
                "d",
                &Spec {
                    selected: "-",
                    ..spec()
                },
            ),
            make(
                "n",
                &Spec {
                    category: None,
                    ..spec()
                },
            ),
        ];
        assert!(analyze_skills(&ignored, now()).is_empty());
    }

    #[test]
    fn difficulte_progressive() {
        assert_eq!(difficulty_for(None), 2);
        assert_eq!(difficulty_for(Some((0.3, 10))), 1);
        assert_eq!(difficulty_for(Some((0.65, 10))), 2);
        assert_eq!(difficulty_for(Some((0.9, 10))), 3);
        assert_eq!(difficulty_for(Some((0.9, 2))), 2);
    }

    #[test]
    fn questions_deja_vues() {
        let attempts = vec![
            make(
                "a",
                &Spec {
                    at: days_ago(5),
                    ..spec()
                },
            ),
            make(
                "b",
                &Spec {
                    at: days_ago(1),
                    ..spec()
                },
            ),
            make(
                "a",
                &Spec {
                    at: days_ago(2),
                    ..spec()
                },
            ),
            make("z", &Spec { part: 7, ..spec() }),
            make("l", &Spec { part: 2, ..spec() }),
        ];
        assert_eq!(recent_seen_ids(&attempts, &[5], 10), ["b", "a"]);
        assert_eq!(recent_seen_ids(&attempts, &[5, 7], 2).len(), 2);
        assert_eq!(recent_seen_ids(&attempts, &[5, 6, 7], 1).len(), 1);
    }

    #[test]
    fn plan_complet() {
        let mut attempts = many(
            10,
            Spec {
                category: Some("prepositions"),
                correct: false,
                ..spec()
            },
        );
        attempts.extend(many(
            10,
            Spec {
                category: Some("connectors"),
                correct: false,
                at: days_ago(3),
                ..spec()
            },
        ));
        attempts.extend(many(
            8,
            Spec {
                category: Some("vocabulary"),
                ..spec()
            },
        ));
        attempts.extend(many(
            8,
            Spec {
                category: Some("reading-detail"),
                part: 7,
                time_ms: 50_000,
                ..spec()
            },
        ));
        let labels: HashMap<String, String> = [
            ("prepositions", "Prépositions"),
            ("connectors", "Connecteurs"),
        ]
        .map(|(k, v)| (k.into(), v.into()))
        .into();
        let goals = Goals {
            exam_date: NaiveDate::from_ymd_opt(2026, 12, 1),
            target_score: Some(400),
            daily_goal: 12,
            ..Goals::default()
        };
        let plan = build_adaptive_plan(&PlanInput {
            attempts: &attempts,
            due_count: 7,
            goals: Some(&goals),
            last_exam_score: Some(300),
            now: now(),
            labels: Some(&labels),
        });
        let kinds: Vec<_> = plan.recommendations.iter().map(|r| r.kind).collect();
        assert_eq!(kinds[0], RecommendationKind::Review);
        assert!(plan.recommendations[0].title.contains("7 questions"));
        assert_eq!(
            kinds
                .iter()
                .filter(|k| **k == RecommendationKind::Targeted)
                .count(),
            2
        );
        for k in [
            RecommendationKind::Mixed,
            RecommendationKind::Unseen,
            RecommendationKind::Progressive,
            RecommendationKind::Exam,
        ] {
            assert!(kinds.contains(&k), "{k:?}");
        }
        let targeted: Vec<_> = plan
            .recommendations
            .iter()
            .filter(|r| r.kind == RecommendationKind::Targeted)
            .collect();
        assert!(targeted.iter().all(|r| r.difficulty == Some(1)));
        assert!(targeted
            .iter()
            .any(|r| r.category.as_deref() == Some("prepositions")));
        assert!(targeted
            .iter()
            .all(|r| r.href.starts_with("#/practice/part5?") && r.href.contains("unseen=1")));
        let mixed = plan
            .recommendations
            .iter()
            .find(|r| r.kind == RecommendationKind::Mixed)
            .unwrap();
        assert!(mixed.href.contains("categories=") && mixed.href.contains("%2C"));
        let progressive = plan
            .recommendations
            .iter()
            .find(|r| r.kind == RecommendationKind::Progressive)
            .unwrap();
        assert_eq!(progressive.difficulty, Some(3));
        assert_eq!(plan.daily_target, 12);
        assert!(plan.summary.contains("Prépositions"));
        let exam = plan
            .recommendations
            .iter()
            .find(|r| r.kind == RecommendationKind::Exam)
            .unwrap();
        assert!(exam.reason.contains("400") && exam.reason.contains("300"));
    }

    #[test]
    fn plan_sans_historique() {
        let plan = build_adaptive_plan(&PlanInput {
            attempts: &[],
            due_count: 0,
            goals: None,
            last_exam_score: None,
            now: now(),
            labels: None,
        });
        assert!(plan.summary.contains("Pas encore d'historique"));
        assert_eq!(
            plan.recommendations
                .iter()
                .map(|r| r.kind)
                .collect::<Vec<_>>(),
            [RecommendationKind::Unseen]
        );
        assert!(plan.skills.is_empty());
    }

    #[test]
    fn adresse_de_serie() {
        let valid = ["prepositions", "connectors", "vocabulary"];
        let params = SeriesParams {
            categories: vec!["prepositions".into(), "connectors".into()],
            difficulty: Some(2),
            limit: Some(15),
            unseen: true,
            ..Default::default()
        };
        let href = series_href(5, &params);
        assert_eq!(
            href,
            "#/practice/part5?categories=prepositions%2Cconnectors&difficulty=2&limit=15&unseen=1"
        );
        assert_eq!(
            parse_series_params(href.split_once('?').unwrap().1, 5, &valid),
            params
        );
        let none = SeriesParams::default();
        assert_eq!(
            parse_series_params("category=hack&difficulty=9&limit=9999&unseen=0", 5, &valid),
            none
        );
        assert_eq!(parse_series_params("limit=50", 5, &valid), none);
        assert_eq!(parse_series_params("limit=7", 7, &valid), none);
        assert_eq!(
            parse_series_params("?category=vocabulary", 5, &valid)
                .category
                .as_deref(),
            Some("vocabulary")
        );
        assert_eq!(series_href(7, &none), "#/practice/part7");
    }
}
