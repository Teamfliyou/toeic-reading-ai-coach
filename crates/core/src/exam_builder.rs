//! Composition d'un examen Reading complet : 100 questions, 75 minutes.
//! Partie 5 : 30 · Partie 6 : 16 (4 documents de 4 trous) · Partie 7 : 54 (ensembles de 2 à 5 questions).
//! Un document n'est JAMAIS coupé. Port de `src/lib/examBuilder.ts`.

use lernoviq_models::{Passage, Question};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const EXAM_P5: usize = 30;
pub const EXAM_P6: usize = 16;
pub const EXAM_P7: usize = 54;
pub const EXAM_TOTAL: usize = EXAM_P5 + EXAM_P6 + EXAM_P7;
/// Répartition cible des difficultés (facile / intermédiaire / avancée) en partie 5.
const P5_MIX: [f64; 3] = [0.3, 0.45, 0.25];

/// Générateur de nombres dans [0, 1) (injecté pour des tests déterministes).
pub type Rng<'a> = &'a mut dyn FnMut() -> f64;

#[derive(Debug, Clone, Default)]
pub struct PassagePool {
    pub passages: Vec<Passage>,
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, Default)]
pub struct Pool {
    pub p5: Vec<Question>,
    pub p6: PassagePool,
    pub p7: PassagePool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PartCounts {
    pub p5: usize,
    pub p6: usize,
    pub p7: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Shortfall {
    pub p5: isize,
    pub p6: isize,
    pub p7: isize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DifficultyMix {
    pub easy: usize,
    pub medium: usize,
    pub hard: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuiltExam {
    /// Questions dans l'ordre de l'examen (parties 5, 6 puis 7).
    pub questions: Vec<Question>,
    pub passages: Vec<Passage>,
    pub counts: PartCounts,
    /// Vrai si l'examen ne compte pas exactement 30 + 16 + 54 questions.
    pub reduced: bool,
    pub shortfall: Shortfall,
    /// Questions déjà vues (la banque n'avait pas assez d'inédites).
    pub repeated: usize,
    pub difficulty: DifficultyMix,
}

fn shuffle<T: Clone>(list: &[T], rng: Rng) -> Vec<T> {
    let mut copy = list.to_vec();
    for i in (1..copy.len()).rev() {
        let j = (rng() * (i + 1) as f64).floor() as usize;
        copy.swap(i, j.min(i));
    }
    copy
}

/// Inédites d'abord (mélangées), puis déjà vues (mélangées).
fn ordered(items: Vec<&Question>, seen: &HashSet<String>, rng: Rng) -> Vec<Question> {
    let (unseen, seen_items): (Vec<&Question>, Vec<&Question>) =
        items.into_iter().partition(|q| !seen.contains(&q.id));
    let unseen: Vec<Question> = unseen.into_iter().cloned().collect();
    let seen_items: Vec<Question> = seen_items.into_iter().cloned().collect();
    let mut out = shuffle(&unseen, rng);
    out.extend(shuffle(&seen_items, rng));
    out
}

/// Partie 5 : 30 questions, inédites d'abord, difficultés réparties 30 % / 45 % / 25 %.
pub fn pick_part5(pool: &[Question], seen: &HashSet<String>, rng: Rng) -> Vec<Question> {
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut all: Vec<&Question> = vec![];
    for q in pool
        .iter()
        .filter(|q| q.part == 5 && q.passage_id.is_none())
    {
        match index.get(q.id.as_str()) {
            Some(&i) => all[i] = q,
            None => {
                index.insert(&q.id, all.len());
                all.push(q);
            }
        }
    }
    let target = EXAM_P5;
    let easy = (P5_MIX[0] * target as f64).round() as usize;
    let hard = (P5_MIX[2] * target as f64).floor() as usize;
    let quotas = [easy, target - easy - hard, hard];

    let mut chosen: Vec<Question> = vec![];
    let mut used: HashSet<String> = HashSet::new();
    for (i, level) in [1u8, 2, 3].into_iter().enumerate() {
        let at_level = all
            .iter()
            .copied()
            .filter(|q| q.difficulty == level)
            .collect();
        for q in ordered(at_level, seen, rng).into_iter().take(quotas[i]) {
            used.insert(q.id.clone());
            chosen.push(q);
        }
    }
    // Un niveau en manque est complété par les autres niveaux (inédites d'abord).
    let rest = all
        .iter()
        .copied()
        .filter(|q| !used.contains(&q.id))
        .collect();
    for q in ordered(rest, seen, rng) {
        if chosen.len() >= target {
            break;
        }
        chosen.push(q);
    }
    chosen.truncate(target);
    shuffle(&chosen, rng)
}

#[derive(Debug, Clone)]
pub struct PassageSet {
    pub passage: Passage,
    pub questions: Vec<Question>,
    pub unseen: bool,
}

fn group_sets(data: &PassagePool, seen: &HashSet<String>) -> Vec<PassageSet> {
    let by_id: HashMap<&str, &Passage> = data.passages.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut order: Vec<&str> = vec![];
    let mut groups: HashMap<&str, Vec<Question>> = HashMap::new();
    for q in &data.questions {
        if let Some(pid) = q.passage_id.as_deref().filter(|p| by_id.contains_key(p)) {
            groups.entry(pid).or_insert_with(|| {
                order.push(pid);
                vec![]
            });
            if let Some(g) = groups.get_mut(pid) {
                g.push(q.clone());
            }
        }
    }
    order
        .into_iter()
        .map(|id| {
            let mut questions = groups.remove(id).unwrap_or_default();
            let unseen = questions.iter().all(|q| !seen.contains(&q.id));
            questions.sort_by_key(|q| q.order_index);
            PassageSet {
                passage: by_id[id].clone(),
                questions,
                unseen,
            }
        })
        .collect()
}

fn level(s: &PassageSet) -> f64 {
    s.questions
        .iter()
        .map(|q| f64::from(q.difficulty))
        .sum::<f64>()
        / s.questions.len() as f64
}

/// Partie 6 : 4 documents de 4 trous, inédits d'abord, niveaux variés.
pub fn pick_part6(data: &PassagePool, seen: &HashSet<String>, rng: Rng) -> Vec<PassageSet> {
    let candidates: Vec<PassageSet> = group_sets(data, seen)
        .into_iter()
        .filter(|s| s.questions.len() == 4)
        .collect();
    let sets = shuffle(&candidates, rng);
    let mut ordered: Vec<PassageSet> = sets.iter().filter(|s| s.unseen).cloned().collect();
    ordered.extend(sets.iter().filter(|s| !s.unseen).cloned());

    let mut picked: Vec<PassageSet> = vec![];
    while picked.len() < EXAM_P6 / 4 && !ordered.is_empty() {
        let n = picked.len() as f64;
        let avg = if picked.is_empty() {
            2.0
        } else {
            picked.iter().map(level).sum::<f64>() / n
        };
        let distance = |s: &PassageSet| ((avg * n + level(s)) / (n + 1.0) - 2.0).abs();
        // Parmi les 3 meilleurs candidats, on garde celui qui rapproche la moyenne de 2.
        let mut best = 0;
        for i in 1..ordered.len().min(3) {
            if distance(&ordered[best]) > distance(&ordered[i]) {
                best = i;
            }
        }
        picked.push(ordered.remove(best));
    }
    picked
}

/// Partie 7 : ensembles de documents dont le total vaut EXACTEMENT 54 questions (sac à dos).
/// Si 54 est inatteignable, le plus grand total possible est retenu (examen réduit).
pub fn pick_part7(data: &PassagePool, seen: &HashSet<String>, rng: Rng) -> Vec<PassageSet> {
    let target = EXAM_P7;
    let candidates: Vec<PassageSet> = group_sets(data, seen)
        .into_iter()
        .filter(|s| (2..=5).contains(&s.questions.len()))
        .collect();
    let sets = shuffle(&candidates, rng);

    let mut best = vec![f64::NEG_INFINITY; target + 1];
    best[0] = 0.0;
    let mut take = vec![vec![false; target + 1]; sets.len()];
    for (i, s) in sets.iter().enumerate() {
        let size = s.questions.len();
        let w = (if s.unseen { 10.0 } else { 0.0 })
            + (if s.passage.documents.len() > 1 {
                3.0
            } else {
                0.0
            })
            + rng();
        for t in (size..=target).rev() {
            if best[t - size] + w > best[t] {
                best[t] = best[t - size] + w;
                take[i][t] = true;
            }
        }
    }
    let mut total = target;
    while total > 0 && best[total] == f64::NEG_INFINITY {
        total -= 1;
    }
    let mut chosen: Vec<PassageSet> = vec![];
    let mut t = total;
    for i in (0..sets.len()).rev() {
        if t == 0 {
            break;
        }
        if take[i][t] {
            chosen.push(sets[i].clone());
            t -= sets[i].questions.len();
        }
    }
    // Documents simples d'abord, puis ensembles à plusieurs documents.
    chosen.sort_by_key(|s| s.passage.documents.len());
    chosen
}

/// Compose l'examen à partir d'un lot de candidats.
pub fn build_reading_exam(pool: &Pool, seen_ids: &[String], rng: Rng) -> BuiltExam {
    let seen: HashSet<String> = seen_ids.iter().cloned().collect();
    let p5 = pick_part5(&pool.p5, &seen, rng);
    let p6 = pick_part6(&pool.p6, &seen, rng);
    let p7 = pick_part7(&pool.p7, &seen, rng);

    let mut questions = p5.clone();
    questions.extend(p6.iter().flat_map(|s| s.questions.clone()));
    questions.extend(p7.iter().flat_map(|s| s.questions.clone()));
    let counts = PartCounts {
        p5: p5.len(),
        p6: p6.iter().map(|s| s.questions.len()).sum(),
        p7: p7.iter().map(|s| s.questions.len()).sum(),
    };
    let count_level = |l: u8| questions.iter().filter(|q| q.difficulty == l).count();
    BuiltExam {
        passages: p6.iter().chain(&p7).map(|s| s.passage.clone()).collect(),
        reduced: counts.p5 != EXAM_P5 || counts.p6 != EXAM_P6 || counts.p7 != EXAM_P7,
        shortfall: Shortfall {
            p5: EXAM_P5 as isize - counts.p5 as isize,
            p6: EXAM_P6 as isize - counts.p6 as isize,
            p7: EXAM_P7 as isize - counts.p7 as isize,
        },
        repeated: questions.iter().filter(|q| seen.contains(&q.id)).count(),
        difficulty: DifficultyMix {
            easy: count_level(1),
            medium: count_level(2),
            hard: count_level(3),
        },
        counts,
        questions,
    }
}

/// Explique pourquoi l'examen est réduit (vide si complet).
pub fn reduced_notice(exam: &BuiltExam) -> String {
    if !exam.reduced {
        return String::new();
    }
    let PartCounts { p5, p6, p7 } = exam.counts;
    let total = p5 + p6 + p7;
    format!(
        "Examen RÉDUIT : {total} question{} au lieu de 100 (partie 5 : {p5}/30 · partie 6 : {p6}/16 · partie 7 : {p7}/54). La banque ne contient pas encore assez de questions publiées : ce n'est pas un examen complet et le score est seulement extrapolé.",
        if total > 1 { "s" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use lernoviq_models::{OptionKey, PassageDocument, QuestionOption};

    /// LCG déterministe.
    fn lcg(seed: u64) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((s >> 11) as f64) / ((1u64 << 53) as f64)
        }
    }

    fn q(id: &str, part: u8, passage: Option<&str>, order: u32, difficulty: u8) -> Question {
        Question {
            id: id.into(),
            part,
            passage_id: passage.map(String::from),
            order_index: order,
            prompt: "p".into(),
            options: ["A", "B", "C", "D"]
                .iter()
                .zip([OptionKey::A, OptionKey::B, OptionKey::C, OptionKey::D])
                .map(|(t, key)| QuestionOption {
                    key,
                    text: (*t).into(),
                })
                .collect(),
            correct_key: OptionKey::A,
            difficulty,
            category: None,
            tags: vec![],
            theme: None,
            explanation: None,
        }
    }
    fn passage(id: &str, part: u8, docs: usize) -> Passage {
        Passage {
            id: id.into(),
            part,
            title: id.into(),
            documents: (0..docs)
                .map(|i| PassageDocument {
                    id: format!("{id}-d{i}"),
                    kind: "email".into(),
                    title: "t".into(),
                    body: vec!["b".into()],
                })
                .collect(),
        }
    }
    fn p5_pool(n: usize) -> Vec<Question> {
        (0..n)
            .map(|i| q(&format!("p5-{i}"), 5, None, i as u32, (i % 3) as u8 + 1))
            .collect()
    }
    fn p6_pool(n: usize) -> PassagePool {
        let mut pool = PassagePool::default();
        for i in 0..n {
            let id = format!("p6-{i}");
            pool.passages.push(passage(&id, 6, 1));
            for k in 0..4 {
                pool.questions
                    .push(q(&format!("{id}-{k}"), 6, Some(&id), k, (i % 3) as u8 + 1));
            }
        }
        pool
    }
    fn p7_pool(n: usize) -> PassagePool {
        let mut pool = PassagePool::default();
        for i in 0..n {
            let id = format!("p7-{i}");
            pool.passages.push(passage(&id, 7, 1 + i % 3));
            for k in 0..(2 + i % 4) {
                pool.questions
                    .push(q(&format!("{id}-{k}"), 7, Some(&id), k as u32, 2));
            }
        }
        pool
    }

    #[test]
    fn examen_complet_100_questions() {
        let pool = Pool {
            p5: p5_pool(80),
            p6: p6_pool(8),
            p7: p7_pool(40),
        };
        let mut rng = lcg(7);
        let exam = build_reading_exam(&pool, &[], &mut rng);
        assert_eq!(
            exam.counts,
            PartCounts {
                p5: 30,
                p6: 16,
                p7: 54
            }
        );
        assert!(!exam.reduced);
        assert_eq!(exam.questions.len(), EXAM_TOTAL);
        assert_eq!(
            exam.shortfall,
            Shortfall {
                p5: 0,
                p6: 0,
                p7: 0
            }
        );
        assert_eq!(reduced_notice(&exam), "");
        // Ordre des parties : 5 puis 6 puis 7 ; aucun doublon.
        let parts: Vec<u8> = exam.questions.iter().map(|q| q.part).collect();
        assert!(parts.windows(2).all(|w| w[0] <= w[1]));
        let ids: HashSet<&str> = exam.questions.iter().map(|q| q.id.as_str()).collect();
        assert_eq!(ids.len(), 100);
        // Répartition 9 / 14 / 7 en partie 5 quand la banque est équilibrée.
        let p5 = &exam.questions[..30];
        let at = |l| p5.iter().filter(|q| q.difficulty == l).count();
        assert_eq!((at(1), at(2), at(3)), (9, 14, 7));
    }

    #[test]
    fn documents_jamais_coupes() {
        let pool = Pool {
            p5: p5_pool(40),
            p6: p6_pool(6),
            p7: p7_pool(40),
        };
        let mut rng = lcg(3);
        let exam = build_reading_exam(&pool, &[], &mut rng);
        for p in &exam.passages {
            let in_exam = exam
                .questions
                .iter()
                .filter(|q| q.passage_id.as_deref() == Some(&p.id))
                .count();
            let in_pool = pool
                .p6
                .questions
                .iter()
                .chain(&pool.p7.questions)
                .filter(|q| q.passage_id.as_deref() == Some(&p.id))
                .count();
            assert_eq!(in_exam, in_pool, "{}", p.id);
        }
    }

    #[test]
    fn inedites_d_abord() {
        let pool = Pool {
            p5: p5_pool(60),
            p6: p6_pool(8),
            p7: p7_pool(40),
        };
        let seen: Vec<String> = (0..10).map(|i| format!("p5-{i}")).collect();
        let mut rng = lcg(11);
        let exam = build_reading_exam(&pool, &seen, &mut rng);
        assert_eq!(
            exam.repeated, 0,
            "assez d'inédites : aucune question déjà vue"
        );
        let mut rng = lcg(11);
        let all_seen: Vec<String> = pool.p5.iter().map(|q| q.id.clone()).collect();
        let exam = build_reading_exam(
            &Pool {
                p5: p5_pool(30),
                ..pool.clone()
            },
            &all_seen[..30],
            &mut rng,
        );
        assert!(
            exam.repeated >= 30,
            "banque épuisée : questions déjà vues réutilisées"
        );
        assert_eq!(exam.counts.p5, 30);
    }

    #[test]
    fn examen_reduit_si_banque_insuffisante() {
        let pool = Pool {
            p5: p5_pool(10),
            p6: p6_pool(2),
            p7: p7_pool(3),
        };
        let mut rng = lcg(1);
        let exam = build_reading_exam(&pool, &[], &mut rng);
        assert!(exam.reduced);
        assert_eq!(exam.counts.p5, 10);
        assert_eq!(exam.counts.p6, 8);
        assert_eq!(exam.shortfall.p5, 20);
        let notice = reduced_notice(&exam);
        assert!(notice.starts_with("Examen RÉDUIT") && notice.contains("partie 5 : 10/30"));
        assert_eq!(
            build_reading_exam(&Pool::default(), &[], &mut lcg(1))
                .questions
                .len(),
            0
        );
    }

    #[test]
    fn partie_7_total_exact_ou_maximal() {
        for seed in 0..10 {
            let mut rng = lcg(seed);
            let sets = pick_part7(&p7_pool(40), &HashSet::new(), &mut rng);
            assert_eq!(sets.iter().map(|s| s.questions.len()).sum::<usize>(), 54);
            let docs: Vec<usize> = sets.iter().map(|s| s.passage.documents.len()).collect();
            assert!(docs.windows(2).all(|w| w[0] <= w[1]));
        }
        let mut rng = lcg(5);
        let few = pick_part7(&p7_pool(4), &HashSet::new(), &mut rng);
        assert!(few.iter().map(|s| s.questions.len()).sum::<usize>() <= 54);
    }
}
