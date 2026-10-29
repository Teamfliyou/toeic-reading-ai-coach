//! Banque de questions embarquée (`data/questions.json`, `data/categories.json`) : fonctionne
//! entièrement hors ligne. Port de `pickLocal` (`src/lib/bank/practice.ts`).
//! La banque Supabase (plusieurs milliers de questions) n'est pas encore branchée.

use crate::bridge;
use lernoviq_core::adaptive::SeriesParams;
use lernoviq_models::{OptionKey, Passage, Question};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Dataset {
    pub passages: Vec<Passage>,
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Category {
    pub id: String,
    pub label: String,
    pub parts: Vec<u8>,
}

pub fn dataset() -> &'static Dataset {
    static D: OnceLock<Dataset> = OnceLock::new();
    D.get_or_init(|| {
        serde_json::from_str(include_str!("../../../data/questions.json"))
            .expect("data/questions.json valide")
    })
}

pub fn categories() -> &'static [Category] {
    static C: OnceLock<Vec<Category>> = OnceLock::new();
    C.get_or_init(|| {
        serde_json::from_str(include_str!("../../../data/categories.json"))
            .expect("data/categories.json valide")
    })
}

pub fn category_label(id: &str) -> String {
    categories()
        .iter()
        .find(|c| c.id == id)
        .map_or_else(|| id.to_string(), |c| c.label.clone())
}

pub fn category_ids_for(part: u8) -> Vec<String> {
    categories()
        .iter()
        .filter(|c| c.parts.contains(&part))
        .map(|c| c.id.clone())
        .collect()
}

pub fn key_char(k: OptionKey) -> char {
    match k {
        OptionKey::A => 'A',
        OptionKey::B => 'B',
        OptionKey::C => 'C',
        OptionKey::D => 'D',
    }
}

pub fn passage_of(q: &Question) -> Option<&'static Passage> {
    let id = q.passage_id.as_deref()?;
    dataset().passages.iter().find(|p| p.id == id)
}

pub fn kind_label(kind: &str) -> &str {
    match kind {
        "email" => "E-mail",
        "memo" => "Note interne",
        "article" => "Article",
        "notice" => "Avis",
        "schedule" => "Programme",
        "letter" => "Lettre",
        "message" => "Message",
        other => other,
    }
}

pub fn default_limit(part: u8) -> usize {
    if part == 5 {
        20
    } else {
        3
    }
}

fn shuffle<T: Clone>(items: &[T]) -> Vec<T> {
    let mut v = items.to_vec();
    for i in (1..v.len()).rev() {
        let j = ((bridge::random() * (i + 1) as f64).floor() as usize).min(i);
        v.swap(i, j);
    }
    v
}

#[derive(Debug, Clone, Default)]
pub struct Series {
    pub questions: Vec<Question>,
    pub passages: Vec<Passage>,
    /// Filtres abandonnés faute de questions suffisantes.
    pub relaxed: Vec<String>,
}

fn matches(q: &Question, difficulty: Option<u8>, category: Option<&str>) -> bool {
    difficulty.is_none_or(|d| q.difficulty == d)
        && category.is_none_or(|c| q.category.as_deref() == Some(c))
}

fn pick(
    part: u8,
    limit: usize,
    difficulty: Option<u8>,
    category: Option<&str>,
    seen: &HashSet<&str>,
) -> Series {
    let data = dataset();
    let in_part = data.questions.iter().filter(|q| q.part == part);
    if part == 5 {
        let pool: Vec<Question> = in_part
            .filter(|q| q.passage_id.is_none() && matches(q, difficulty, category))
            .cloned()
            .collect();
        let (fresh, old): (Vec<_>, Vec<_>) = pool
            .into_iter()
            .partition(|q| !seen.contains(q.id.as_str()));
        let mut ordered = shuffle(&fresh);
        ordered.extend(shuffle(&old));
        ordered.truncate(limit);
        return Series {
            questions: ordered,
            ..Series::default()
        };
    }
    let mut order: Vec<String> = vec![];
    let mut by_passage: HashMap<String, Vec<Question>> = HashMap::new();
    for q in in_part {
        if let Some(pid) = &q.passage_id {
            by_passage
                .entry(pid.clone())
                .or_insert_with(|| {
                    order.push(pid.clone());
                    vec![]
                })
                .push(q.clone());
        }
    }
    let eligible: Vec<(String, Vec<Question>)> = order
        .into_iter()
        .filter_map(|id| by_passage.remove(&id).map(|qs| (id, qs)))
        .filter(|(_, qs)| qs.iter().any(|q| matches(q, difficulty, category)))
        .collect();
    let (fresh, old): (Vec<_>, Vec<_>) = eligible
        .into_iter()
        .partition(|(_, qs)| !qs.iter().any(|q| seen.contains(q.id.as_str())));
    let mut ordered = shuffle(&fresh);
    ordered.extend(shuffle(&old));
    ordered.truncate(limit);
    let ids: HashSet<&str> = ordered.iter().map(|(id, _)| id.as_str()).collect();
    let passages = data
        .passages
        .iter()
        .filter(|p| ids.contains(p.id.as_str()))
        .cloned()
        .collect();
    let questions = ordered
        .into_iter()
        .flat_map(|(_, mut qs)| {
            qs.sort_by_key(|q| q.order_index);
            qs
        })
        .collect();
    Series {
        questions,
        passages,
        relaxed: vec![],
    }
}

/// Série d'entraînement avec filtres ; les questions déjà vues ne passent qu'en dernier.
/// Si les filtres ne laissent rien, la difficulté puis la catégorie sont abandonnées.
pub fn load_series(part: u8, params: &SeriesParams, exclude: &[String]) -> Series {
    let seen: HashSet<&str> = exclude.iter().map(String::as_str).collect();
    let limit = params
        .limit
        .map_or_else(|| default_limit(part), |l| l as usize);

    if part == 5 && params.categories.len() >= 2 {
        let per = limit.div_ceil(params.categories.len());
        let mut all: Vec<Question> = vec![];
        let mut known: HashSet<String> = HashSet::new();
        for c in &params.categories {
            for q in pick(part, per, params.difficulty, Some(c), &seen).questions {
                if known.insert(q.id.clone()) {
                    all.push(q);
                }
            }
        }
        let mut mixed = shuffle(&all);
        mixed.truncate(limit);
        return Series {
            questions: mixed,
            ..Series::default()
        };
    }

    let category = params
        .category
        .as_deref()
        .or(params.categories.first().map(String::as_str));
    let mut series = pick(part, limit, params.difficulty, category, &seen);
    if series.questions.is_empty() && params.difficulty.is_some() {
        series = pick(part, limit, None, category, &seen);
        series.relaxed.push("difficulté".into());
    }
    if series.questions.is_empty() && category.is_some() {
        series = pick(part, limit, None, None, &seen);
        series.relaxed.push("catégorie".into());
    }
    series
}

/// Questions retrouvées par identifiant (révision espacée), avec leurs documents.
pub fn load_by_ids(ids: &HashSet<String>) -> Series {
    let data = dataset();
    let questions: Vec<Question> = data
        .questions
        .iter()
        .filter(|q| ids.contains(&q.id))
        .cloned()
        .collect();
    let pids: HashSet<&str> = questions
        .iter()
        .filter_map(|q| q.passage_id.as_deref())
        .collect();
    let passages = data
        .passages
        .iter()
        .filter(|p| pids.contains(p.id.as_str()))
        .cloned()
        .collect();
    Series {
        questions,
        passages,
        relaxed: vec![],
    }
}

/// Tous les candidats pour composer un examen.
pub fn exam_pool() -> lernoviq_core::exam_builder::Pool {
    use lernoviq_core::exam_builder::{PassagePool, Pool};
    let data = dataset();
    let part = |p: u8| PassagePool {
        passages: data
            .passages
            .iter()
            .filter(|x| x.part == p)
            .cloned()
            .collect(),
        questions: data
            .questions
            .iter()
            .filter(|q| q.part == p && q.passage_id.is_some())
            .cloned()
            .collect(),
    };
    Pool {
        p5: data
            .questions
            .iter()
            .filter(|q| q.part == 5 && q.passage_id.is_none())
            .cloned()
            .collect(),
        p6: part(6),
        p7: part(7),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn donnees_embarquees() {
        assert!(dataset().questions.len() >= 30);
        assert!(!categories().is_empty());
        assert_eq!(key_char(OptionKey::C), 'C');
        assert!(!category_label("prepositions").is_empty());
    }
}
