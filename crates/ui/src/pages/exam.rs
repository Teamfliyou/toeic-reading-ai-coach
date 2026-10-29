//! Examen blanc Reading (100 questions, 75 minutes). Port de `Exam.tsx`.
//! Composition, chronomètre, correction et score viennent de `lernoviq-core`.

use crate::bank::{self, key_char};
use crate::bridge;
use crate::components::*;
use crate::state::{use_ctx, ExamSession};
use dioxus::prelude::*;
use lernoviq_core::adaptive::recent_seen_ids;
use lernoviq_core::exam::{
    add_time, format_clock, grade_exam, new_exam_state, remaining_ms, set_answer, toggle_flag,
    EXAM_DURATION_MS,
};
use lernoviq_core::exam_builder::{
    build_reading_exam, reduced_notice, BuiltExam, EXAM_P5, EXAM_P6, EXAM_P7,
};
use lernoviq_core::goals::ExamRecord;
use lernoviq_models::{AttemptMode, ExamQuestionRef, Question};

fn refs(questions: &[Question]) -> Vec<ExamQuestionRef> {
    questions
        .iter()
        .map(|q| ExamQuestionRef {
            id: q.id.clone(),
            part: q.part,
            order_index: q.order_index,
            correct_key: key_char(q.correct_key).to_string(),
        })
        .collect()
}

fn prepare(seen: &[String]) -> BuiltExam {
    let mut rng = bridge::random;
    build_reading_exam(&bank::exam_pool(), seen, &mut rng)
}

fn now_ms() -> i64 {
    bridge::now().timestamp_millis()
}

#[component]
pub fn Exam() -> Element {
    let mut ctx = use_ctx();
    let mut prepared = use_signal(|| Option::<BuiltExam>::None);
    let mut now = use_signal(now_ms);
    let mut confirm_end = use_signal(|| false);
    let mut entered_at = use_signal(bridge::perf_now);

    let seen: Vec<String> = recent_seen_ids(&ctx.data.peek().attempts, &[5, 6, 7], 600);
    use_hook({
        let seen = seen.clone();
        move || {
            if ctx.data.peek().exam.is_none() {
                prepared.set(Some(prepare(&seen)));
            }
        }
    });

    let running = ctx
        .data
        .read()
        .exam
        .as_ref()
        .is_some_and(|e| e.state.finished_at.is_none());
    use_future(move || async move {
        loop {
            gloo_sleep(1000).await;
            if ctx
                .data
                .peek()
                .exam
                .as_ref()
                .is_some_and(|e| e.state.finished_at.is_none())
            {
                now.set(now_ms());
            }
        }
    });

    // Ajoute le temps passé sur la question affichée avant de changer d'écran.
    let mut flush = move || {
        let elapsed = (bridge::perf_now() - entered_at()) as i64;
        entered_at.set(bridge::perf_now());
        let mut d = ctx.data.write();
        if let Some(e) = d.exam.as_mut() {
            if let Some(id) = e.state.question_ids.get(e.index).cloned() {
                add_time(&mut e.state, &id, elapsed);
            }
        }
    };

    let mut finish = move || {
        flush();
        let mut guard = ctx.data.write();
        let data = &mut *guard;
        let Some(session) = data.exam.as_mut() else {
            return;
        };
        if session.state.finished_at.is_some() {
            return;
        }
        session.state.finished_at = Some(now_ms());
        if session.state.recorded != Some(true) {
            let questions = session.questions.clone();
            let ids = session.state.question_ids.clone();
            let answers = session.state.answers.clone();
            let spent = session.state.time_spent.clone();
            let graded = grade_exam(&session.state, &refs(&questions));
            session.state.recorded = Some(true);
            for id in ids {
                if let Some(q) = questions.iter().find(|x| x.id == id) {
                    let key = answers
                        .get(&id)
                        .and_then(|a| a.chars().next())
                        .unwrap_or('-');
                    data.record_answer(
                        q,
                        key,
                        spent.get(&id).copied().unwrap_or(0) as f64,
                        AttemptMode::Exam,
                        true,
                    );
                }
            }
            data.exams.insert(
                0,
                ExamRecord {
                    at: bridge::now(),
                    score: graded.score,
                    correct: graded.correct,
                    total: graded.total,
                },
            );
        }
        confirm_end.set(false);
    };

    // Temps écoulé : l'examen se termine seul.
    let expired = ctx
        .data
        .read()
        .exam
        .as_ref()
        .is_some_and(|e| e.state.finished_at.is_none() && remaining_ms(&e.state, now()) <= 0);
    use_effect(move || {
        if expired {
            finish();
        }
    });

    let session = ctx.data.read().exam.clone();

    // --- Accueil ---
    let Some(session) = session else {
        let Some(p) = prepared() else {
            return rsx! { Page { class: "lexora-page lexora-exercises", main { class: "lexora-shell lexora-content", div { class: "lexora-card", role: "status", "Préparation de l'examen…" } } } };
        };
        let total = p.questions.len();
        let plural = if total > 1 { "s" } else { "" };
        let notice = reduced_notice(&p);
        let mins = EXAM_DURATION_MS / 60_000;
        let (n5, n6, n7) = (p.counts.p5, p.counts.p6, p.counts.p7);
        let (d1, d2, d3) = (p.difficulty.easy, p.difficulty.medium, p.difficulty.hard);
        return rsx! {
            Page { class: "lexora-page lexora-exercises",
                main { class: "lexora-shell lexora-content", style: "max-width: 780px;",
                    p { class: "lexora-eyebrow", "Examen blanc · Reading" }
                    h1 { class: "lexora-heading", "Conditions d'examen, sans explication en cours de route." }
                    p { class: "lexora-muted", "Parties 5, 6 et 7 à la suite, avec un minuteur de {mins} minutes pour un examen complet. Vous pouvez naviguer librement, revenir aux questions précédentes, modifier vos réponses et marquer des questions « à revoir »." }
                    section { class: "lexora-card", style: "margin: 24px 0;",
                        p { class: "lexora-statlabel", "Contenu de cet examen" }
                        p { class: "lexora-statvalue", "{total} question{plural}" if p.reduced { " · examen réduit" } else { " · examen complet" } }
                        p { class: "lexora-subtle", "Partie 5 : {n5}/{EXAM_P5} · Partie 6 : {n6}/{EXAM_P6} · Partie 7 : {n7}/{EXAM_P7} · niveaux {d1} faciles, {d2} intermédiaires, {d3} avancées" }
                        if p.reduced { p { class: "lexora-disclaimer", role: "alert", strong { "Examen réduit. " } "{notice} La durée est ajustée en proportion." } }
                        if !p.reduced && p.repeated > 0 { p { class: "lexora-disclaimer", "{p.repeated} question(s) de cet examen vous ont déjà été proposées : la banque n'a pas assez de questions inédites pour cette composition." } }
                        if !p.reduced && p.repeated == 0 { p { class: "lexora-subtle", "Aucune question déjà vue : tirage varié à chaque examen." } }
                    }
                    div { class: "lexora-actions",
                        a { class: "lexora-secondary", href: "#/", "Retour" }
                        span { style: "display: flex; gap: 10px; flex-wrap: wrap;",
                            button { r#type: "button", class: "lexora-secondary", onclick: { let seen = seen.clone(); move |_| prepared.set(Some(prepare(&seen))) }, "Tirer un autre examen" }
                            button { r#type: "button", class: "lexora-primary", disabled: total == 0,
                                onclick: {
                                    let p = p.clone();
                                    move |_| {
                                        let duration = if p.reduced { (EXAM_DURATION_MS * p.questions.len() as i64 / 100).max(10 * 60_000) } else { EXAM_DURATION_MS };
                                        let ids = p.questions.iter().map(|q| q.id.clone()).collect();
                                        let state = new_exam_state(ids, now_ms(), duration);
                                        ctx.data.write().exam = Some(ExamSession { state, questions: p.questions.clone(), passages: p.passages.clone(), reduced: p.reduced, notice: reduced_notice(&p), index: 0 });
                                        entered_at.set(bridge::perf_now());
                                        now.set(now_ms());
                                    }
                                },
                                "Commencer l'examen →"
                            }
                        }
                    }
                }
            }
        };
    };

    let reset = move |_| {
        ctx.data.write().exam = None;
        let seen = recent_seen_ids(&ctx.data.peek().attempts, &[5, 6, 7], 600);
        prepared.set(Some(prepare(&seen)));
    };

    // --- Résultats ---
    if let Some(finished_at) = session.state.finished_at {
        let result = grade_exam(&session.state, &refs(&session.questions));
        let spent = (finished_at - session.state.started_at).clamp(0, EXAM_DURATION_MS);
        let clock = format_clock(spent);
        let extra = if result.reduced {
            format!(
                " L'examen compte {} questions : le score est extrapolé à 100.",
                result.total
            )
        } else {
            String::new()
        };
        let wrong: Vec<String> = result
            .wrong
            .iter()
            .chain(&result.unanswered)
            .cloned()
            .collect();
        let n_wrong = wrong.len();
        let unanswered = result.unanswered.len();
        return rsx! {
            Page { class: "lexora-page lexora-exercises",
                main { class: "lexora-shell lexora-content", style: "max-width: 860px;",
                    p { class: "lexora-eyebrow", "Examen terminé" }
                    h1 { class: "lexora-heading", "Vos résultats" }
                    section { class: "lexora-card", aria_live: "polite",
                        p { class: "lexora-statlabel", "Score Reading estimé (sur 495)" }
                        p { class: "lexora-scorebig", "{result.score}" }
                        p { class: "lexora-muted", style: "margin-top: 12px;", "{result.correct} bonnes réponses sur {result.total} · {unanswered} sans réponse · temps utilisé {clock}" }
                        p { class: "lexora-disclaimer", "Estimation indicative issue d'une table de conversion approximative : le barème officiel varie d'une session à l'autre et n'est pas publié. Ce n'est pas un score officiel ETS.{extra}" }
                        if result.reduced || session.reduced { p { class: "lexora-disclaimer", role: "note", strong { "Examen réduit : " } "{session.notice}" } }
                        div { class: "lexora-rows",
                            for p in [5u8, 6, 7] {
                                if let Some(r) = result.by_part.get(&p) {
                                    {
                                        let pct = (f64::from(r.correct) / f64::from(r.total) * 100.0).round() as u32;
                                        let tone = if pct >= 75 { "high" } else if pct >= 50 { "mid" } else { "low" };
                                        rsx! {
                                            div { key: "{p}", class: "lexora-row",
                                                span { "Partie {p} · {crate::parts::info(p).name}" }
                                                div { class: "lexora-bar", "data-tone": "{tone}", role: "img", aria_label: "{pct} % de réussite", div { style: "width: {pct}%" } }
                                                span { "{r.correct}/{r.total} ({pct} %)" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if n_wrong > 0 {
                        section { style: "margin-top: 28px;",
                            h2 { "À retravailler ({n_wrong})" }
                            p { class: "lexora-muted", "Ces questions ont été ajoutées à vos révisions espacées." }
                            div { class: "lexora-wrong-list",
                                for id in wrong {
                                    if let Some(q) = session.questions.iter().find(|q| q.id == id) {
                                        {
                                            let mine = session.state.answers.get(&id).and_then(|a| a.chars().next()).and_then(|c| q.options.iter().find(|o| key_char(o.key) == c));
                                            let good = q.options.iter().find(|o| o.key == q.correct_key);
                                            let mine_text = mine.map_or("aucune".to_string(), |o| format!("{}. {}", key_char(o.key), o.text));
                                            let good_text = good.map_or(String::new(), |o| format!("{}. {}", key_char(o.key), o.text));
                                            rsx! {
                                                article { key: "{id}",
                                                    span { class: "lexora-pill", "Partie {q.part}" }
                                                    p { style: "margin: 8px 0;", "{q.prompt}" }
                                                    p { style: "margin: 0; color: #9a3232;", "Votre réponse : {mine_text}" }
                                                    p { style: "margin: 0; color: #176443;", "Bonne réponse : {good_text}" }
                                                    if let Some(e) = &q.explanation { p { class: "lexora-subtle", style: "margin: 6px 0 0;", "{e}" } }
                                                    ReportButton { question_id: q.id.clone(), part: q.part }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    div { class: "lexora-actions", style: "margin-top: 28px;",
                        button { r#type: "button", class: "lexora-secondary", onclick: reset, "Refaire un examen" }
                        span { style: "display: flex; gap: 10px; flex-wrap: wrap;",
                            a { class: "lexora-secondary", href: "#/stats", "Mes statistiques" }
                            a { class: "lexora-primary", href: "#/review", "Réviser mes erreurs →" }
                        }
                    }
                }
            }
        };
    }

    // --- Examen en cours ---
    let ids: Vec<String> = session
        .state
        .question_ids
        .iter()
        .filter(|id| session.questions.iter().any(|q| &q.id == *id))
        .cloned()
        .collect();
    let index = session.index.min(ids.len().saturating_sub(1));
    let Some(question) = ids
        .get(index)
        .and_then(|id| session.questions.iter().find(|q| &q.id == id))
        .cloned()
    else {
        return rsx! { Page { main { class: "lexora-shell lexora-content", div { class: "lexora-card", "Questions de cet examen introuvables. " button { r#type: "button", class: "lexora-secondary", onclick: reset, "Recommencer" } } } } };
    };
    let passage = bank::passage_of(&question).cloned().or_else(|| {
        question
            .passage_id
            .as_ref()
            .and_then(|pid| session.passages.iter().find(|p| &p.id == pid).cloned())
    });
    let remaining = remaining_ms(&session.state, now());
    let answered = ids
        .iter()
        .filter(|id| session.state.answers.contains_key(*id))
        .count();
    let unanswered = ids.len() - answered;
    let flagged = session.state.flagged.len();
    let clock = format_clock(remaining);
    let minutes_left = (remaining as f64 / 60_000.0).ceil() as i64;
    let announce = if [10, 5, 1].contains(&minutes_left) && remaining % 60_000 > 0 {
        format!(
            "Il reste {minutes_left} minute{}.",
            if minutes_left > 1 { "s" } else { "" }
        )
    } else {
        String::new()
    };
    let total = ids.len();
    let selected = session
        .state
        .answers
        .get(&question.id)
        .and_then(|a| a.chars().next());
    let is_flagged = session.state.flagged.contains(&question.id);
    let qid = question.id.clone();
    let _ = running;

    let mut go_to = move |target: usize| {
        if target >= total {
            return;
        }
        flush();
        if let Some(e) = ctx.data.write().exam.as_mut() {
            e.index = target;
        }
    };

    rsx! {
        div { class: "lexora-page lexora-exercises",
            div { class: "lexora-exam-bar", div { class: "lexora-shell",
                span { strong { "Examen blanc" } " " span { class: "lexora-subtle", "· {answered}/{total} répondues" } }
                span { class: "lexora-clock", "data-low": "{remaining < 5 * 60_000}", role: "timer", aria_label: "Temps restant {clock}", "{clock}" }
                button { r#type: "button", class: "lexora-primary", onclick: move |_| confirm_end.set(true), "Terminer l'examen" }
            } }
            div { class: "lexora-sr", role: "status", aria_live: "polite", "{announce}" }
            main { class: "lexora-shell lexora-content", style: "padding-top: 28px;",
                if confirm_end() {
                    div { class: "lexora-card", role: "alertdialog", aria_labelledby: "end-title", style: "margin-bottom: 18px; border-color: #d98b1f;",
                        h2 { id: "end-title", style: "font-size: 18px;", "Terminer l'examen ?" }
                        p { class: "lexora-muted",
                            if unanswered > 0 { "{unanswered} question(s) sans réponse compteront comme fausses. " } else { "Toutes les questions ont une réponse. " }
                            if flagged > 0 { "{flagged} question(s) sont marquées « à revoir »." }
                        }
                        div { class: "lexora-actions",
                            button { r#type: "button", class: "lexora-secondary", onclick: move |_| confirm_end.set(false), "Continuer l'examen" }
                            button { r#type: "button", class: "lexora-primary", onclick: move |_| finish(), "Oui, terminer" }
                        }
                    }
                }
                QuestionView {
                    key: "{question.id}", question: question.clone(), passage, number: index + 1, selected,
                    on_select: {
                        let qid = qid.clone();
                        move |k: char| { if let Some(e) = ctx.data.write().exam.as_mut() { set_answer(&mut e.state, &qid, &k.to_string()); } }
                    },
                }
                div { class: "lexora-actions", style: "margin-top: 16px;",
                    button { r#type: "button", class: "lexora-secondary", disabled: index == 0, onclick: move |_| go_to(index.saturating_sub(1)), "← Précédente" }
                    button {
                        r#type: "button", class: if is_flagged { "lexora-secondary lexora-flag-on" } else { "lexora-secondary" }, aria_pressed: "{is_flagged}",
                        onclick: { let qid = qid.clone(); move |_| { if let Some(e) = ctx.data.write().exam.as_mut() { toggle_flag(&mut e.state, &qid); } } },
                        if is_flagged { "Marquée à revoir" } else { "Marquer à revoir" }
                    }
                    button { r#type: "button", class: "lexora-primary", disabled: index + 1 >= total, onclick: move |_| go_to(index + 1), "Suivante →" }
                }
                nav { aria_label: "Navigation entre les questions", style: "margin-top: 26px;",
                    div { class: "lexora-palette",
                        for (i, id) in ids.iter().enumerate() {
                            {
                                let answered = session.state.answers.contains_key(id);
                                let flagged = session.state.flagged.contains(id);
                                let label = format!("Question {}{}{}", i + 1, if answered { ", répondue" } else { ", sans réponse" }, if flagged { ", à revoir" } else { "" });
                                rsx! { button { key: "{id}", r#type: "button", aria_current: "{i == index}", "data-answered": "{answered}", "data-flagged": "{flagged}", aria_label: "{label}", onclick: move |_| go_to(i), "{i + 1}" } }
                            }
                        }
                    }
                    p { class: "lexora-legend", span { "Fond bleu : répondue" } span { "Point orange : à revoir" } span { "Contour : question affichée" } }
                }
            }
        }
    }
}
