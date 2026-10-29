//! Statistiques à partir de l'historique des tentatives. Port de `src/lib/stats.ts`.
//! Le « jour » est calculé dans le fuseau fourni par l'appelant (local en production).

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use lernoviq_models::{Attempt, MAX_COUNTED_TIME_MS};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rate {
    pub total: u32,
    pub correct: u32,
    /// Pourcentage entier, ou `None` s'il n'y a aucune tentative.
    pub rate: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CategoryRate {
    pub category: String,
    #[serde(flatten)]
    pub rate: Rate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DayRate {
    pub day: NaiveDate,
    #[serde(flatten)]
    pub rate: Rate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub overall: Rate,
    pub avg_time_ms: Option<i64>,
    pub by_part: BTreeMap<u8, Rate>,
    /// Catégories de la plus fragile à la plus solide.
    pub by_category: Vec<CategoryRate>,
    /// Taux par jour, ordre chronologique.
    pub progression: Vec<DayRate>,
}

fn rate(correct: u32, total: u32) -> Rate {
    Rate {
        total,
        correct,
        rate: (total > 0).then(|| (f64::from(correct) / f64::from(total) * 100.0).round() as u32),
    }
}

/// Jour calendaire de `at` dans le fuseau `tz`.
pub fn day_key<Tz: TimeZone>(at: DateTime<Utc>, tz: &Tz) -> NaiveDate {
    at.with_timezone(tz).date_naive()
}

#[derive(Default, Clone, Copy)]
struct Count {
    total: u32,
    correct: u32,
}

impl Count {
    fn add(&mut self, ok: bool) {
        self.total += 1;
        self.correct += u32::from(ok);
    }
}

pub fn compute_stats<Tz: TimeZone>(attempts: &[Attempt], max_days: usize, tz: &Tz) -> Stats {
    let mut parts: BTreeMap<u8, Count> = BTreeMap::new();
    let mut cat_index: HashMap<&str, usize> = HashMap::new();
    let mut cats: Vec<(&str, Count)> = vec![];
    let mut days: BTreeMap<NaiveDate, Count> = BTreeMap::new();
    let (mut correct, mut time_sum, mut time_count) = (0u32, 0i64, 0i64);

    for a in attempts {
        correct += u32::from(a.correct);
        parts.entry(a.part).or_default().add(a.correct);
        if let Some(cat) = a.category.as_deref().filter(|c| !c.is_empty()) {
            let i = *cat_index.entry(cat).or_insert_with(|| {
                cats.push((cat, Count::default()));
                cats.len() - 1
            });
            cats[i].1.add(a.correct);
        }
        days.entry(day_key(a.at, tz)).or_default().add(a.correct);
        if a.time_ms > 0 && a.time_ms <= MAX_COUNTED_TIME_MS {
            time_sum += a.time_ms;
            time_count += 1;
        }
    }

    let mut by_category: Vec<CategoryRate> = cats
        .into_iter()
        .map(|(c, v)| CategoryRate {
            category: c.to_string(),
            rate: rate(v.correct, v.total),
        })
        .collect();
    // Tri stable : taux croissant, puis effectif décroissant (comme en JS).
    by_category.sort_by(|a, b| {
        a.rate
            .rate
            .unwrap_or(0)
            .cmp(&b.rate.rate.unwrap_or(0))
            .then(b.rate.total.cmp(&a.rate.total))
    });

    let skip = days.len().saturating_sub(max_days);
    Stats {
        overall: rate(correct, attempts.len() as u32),
        avg_time_ms: (time_count > 0).then(|| (time_sum as f64 / time_count as f64).round() as i64),
        by_part: parts
            .into_iter()
            .map(|(p, v)| (p, rate(v.correct, v.total)))
            .collect(),
        by_category,
        progression: days
            .into_iter()
            .skip(skip)
            .map(|(day, v)| DayRate {
                day,
                rate: rate(v.correct, v.total),
            })
            .collect(),
    }
}

/// Série de jours consécutifs avec au moins une tentative, jusqu'à aujourd'hui (ou hier).
pub fn current_streak<Tz: TimeZone>(attempts: &[Attempt], now: DateTime<Utc>, tz: &Tz) -> u32 {
    let active: std::collections::HashSet<NaiveDate> =
        attempts.iter().map(|a| day_key(a.at, tz)).collect();
    let mut cursor = day_key(now, tz);
    if !active.contains(&cursor) {
        cursor -= Duration::days(1);
    }
    let mut streak = 0;
    while active.contains(&cursor) {
        streak += 1;
        cursor -= Duration::days(1);
    }
    streak
}

#[cfg(test)]
mod tests {
    use super::*;
    use lernoviq_models::AttemptMode;

    fn at(day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, day, hour, 0, 0).unwrap()
    }
    fn att(
        when: DateTime<Utc>,
        part: u8,
        cat: Option<&str>,
        correct: bool,
        time_ms: i64,
    ) -> Attempt {
        Attempt {
            id: format!("{when}-{part}"),
            question_id: "q".into(),
            part,
            category: cat.map(String::from),
            selected_key: "A".into(),
            correct,
            time_ms,
            at: when,
            mode: AttemptMode::Practice,
            owner: None,
            synced: false,
        }
    }

    #[test]
    fn statistiques_globales() {
        let list = vec![
            att(at(1, 10), 5, Some("grammar"), true, 4000),
            att(at(1, 11), 5, Some("grammar"), false, 6000),
            att(at(2, 10), 6, Some("vocab"), false, 600_000), // pause : ignorée
            att(at(2, 11), 7, None, true, 0),
        ];
        let s = compute_stats(&list, 30, &Utc);
        assert_eq!(
            s.overall,
            Rate {
                total: 4,
                correct: 2,
                rate: Some(50)
            }
        );
        assert_eq!(s.avg_time_ms, Some(5000));
        assert_eq!(s.by_part[&5].rate, Some(50));
        assert_eq!(s.by_category[0].category, "vocab"); // 0 % avant 50 %
        assert_eq!(s.progression.len(), 2);
        assert_eq!(
            s.progression[0].day,
            NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()
        );
        assert_eq!(compute_stats(&[], 30, &Utc).overall.rate, None);
    }

    #[test]
    fn progression_bornee() {
        let list: Vec<Attempt> = (1..=10)
            .map(|d| att(at(d, 9), 5, None, true, 1000))
            .collect();
        let s = compute_stats(&list, 3, &Utc);
        assert_eq!(s.progression.len(), 3);
        assert_eq!(
            s.progression[2].day,
            NaiveDate::from_ymd_opt(2026, 10, 10).unwrap()
        );
    }

    #[test]
    fn serie_de_jours() {
        let list = vec![
            att(at(8, 9), 5, None, true, 1),
            att(at(9, 9), 5, None, true, 1),
            att(at(10, 9), 5, None, true, 1),
        ];
        assert_eq!(current_streak(&list, at(10, 20), &Utc), 3);
        assert_eq!(current_streak(&list, at(11, 20), &Utc), 3); // hier compte
        assert_eq!(current_streak(&list, at(12, 20), &Utc), 0);
        assert_eq!(current_streak(&[], at(12, 20), &Utc), 0);
    }
}
