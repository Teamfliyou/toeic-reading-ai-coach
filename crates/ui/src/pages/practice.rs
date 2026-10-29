//! Entraînement (parties 5, 6 et 7) et révision. Port de `Practice.tsx`, `PracticeClient.tsx`,
//! `Part6Inline.tsx` et `InlineSelect.tsx`.

use crate::ai;
use crate::bank::{self, key_char, Series};
use crate::bridge;
use crate::components::*;
use crate::state::use_ctx;
use dioxus::prelude::*;
use lernoviq_core::adaptive::{parse_series_params, recent_seen_ids};
use lernoviq_models::{AttemptMode, Passage, Question};
use std::collections::HashSet;

#[component]
pub fn PracticePage(
    part: u8,
    #[props(default = false)] review_mode: bool,
    #[props(default = String::new())] search: String,
) -> Element {
    let ctx = use_ctx();
    let info = crate::parts::info(part);
    let valid = bank::category_ids_for(part);
    let valid_refs: Vec<&str> = valid.iter().map(String::as_str).collect();
    let params = parse_series_params(&search, part, &valid_refs);

    let mut dataset = use_signal({
        let params = params.clone();
        move || {
            let data = ctx.data.peek();
            if review_mode {
                let ids: HashSet<String> = data
                    .cards
                    .iter()
                    .filter(|c| c.part == part && !c.mastered)
                    .map(|c| c.question_id.clone())
                    .collect();
                bank::load_by_ids(&ids)
            } else {
                let seen = recent_seen_ids(&data.attempts, &[part], 400);
                bank::load_series(part, &params, &seen)
            }
        }
    });
    let mut series_no = use_signal(|| 0u32);
    let new_series = {
        let params = params.clone();
        move |_| {
            let data = ctx.data.peek();
            let seen = recent_seen_ids(&data.attempts, &[part], 400);
            dataset.set(bank::load_series(part, &params, &seen));
            series_no += 1;
        }
    };

    let category_label = params
        .category
        .as_deref()
        .map(bank::category_label)
        .or_else(|| {
            (!params.categories.is_empty()).then(|| {
                params
                    .categories
                    .iter()
                    .map(|c| bank::category_label(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
        });
    let data: Series = dataset();
    let empty = data.questions.is_empty();

    rsx! {
        Page { class: "lexora-page lexora_exercises",
            main { class: "lexora-shell lexora-practice-main",
                div { class: "lexora-practice-heading",
                    p { class: "lexora-eyebrow", "Partie {part} · {info.tagline}" }
                    h1 { if review_mode { "Réviser mes erreurs" } else { "{info.name}" } }
                    p { class: "lexora-muted",
                        if review_mode { "Une bonne réponse retire la question de vos erreurs à revoir." } else { "Prenez votre temps, choisissez votre réponse et progressez à votre rythme." }
                    }
                    if !review_mode {
                        p { class: "lexora-subtle", role: "status", style: "margin-top: 8px;",
                            if let Some(label) = &category_label {
                                "Série ciblée : {label}"
                                if let Some(d) = params.difficulty { " · niveau {d}/3" }
                                ". "
                            } else { "Série tirée au hasard dans la banque. " }
                            "Les questions que vous n'avez jamais vues passent en premier."
                            if !data.relaxed.is_empty() { " La banque manque de questions pour tous vos filtres : {data.relaxed.join(\", \")} élargi(s)." }
                        }
                    }
                }
                if empty {
                    if review_mode {
                        div { class: "glass p-8 text-center text-slate-700", "Aucune erreur à réviser pour cette partie. " a { class: "text-blue-700 underline", href: "#/", "Retour à l’accueil" } }
                    } else {
                        div { class: "glass p-8 text-center text-white/70", "Aucune question disponible pour cette partie." }
                    }
                } else if part == 6 {
                    Part6Inline { key: "{part}-{series_no}", questions: data.questions.clone(), passages: data.passages.clone(), on_new_series: new_series }
                } else if review_mode {
                    PracticeClient { key: "{part}-review", part, questions: data.questions.clone(), passages: data.passages.clone(), review_mode: true }
                } else {
                    PracticeClient { key: "{part}-{series_no}", part, questions: data.questions.clone(), passages: data.passages.clone(), on_new_series: new_series }
                }
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Status {
    Idle,
    Correct,
    Incorrect,
}

#[component]
pub fn PracticeClient(
    part: u8,
    questions: Vec<Question>,
    passages: Vec<Passage>,
    #[props(default = false)] review_mode: bool,
    on_new_series: Option<EventHandler<()>>,
) -> Element {
    let mut ctx = use_ctx();
    let mut index = use_signal(|| 0usize);
    let mut selected = use_signal(|| Option::<char>::None);
    let mut status = use_signal(|| Status::Idle);
    let mut explain = use_signal(|| Option::<ExplainState>::None);
    let mut latency = use_signal(|| Option::<u64>::None);
    let mut finished = use_signal(|| false);
    let mut correct_count = use_signal(|| 0u32);
    let mut shown_at = use_signal(bridge::perf_now);
    let total = questions.len();

    let go_next = {
        move || {
            if index() + 1 >= total {
                finished.set(true);
            } else {
                index += 1;
                selected.set(None);
                status.set(Status::Idle);
                explain.set(None);
                latency.set(None);
                shown_at.set(bridge::perf_now());
            }
        }
    };

    if finished() {
        let restart = on_new_series;
        return rsx! {
            ScoreBoard {
                part, correct: correct_count(), total: total as u32,
                restart_label: if restart.is_some() { "Nouvelle série de questions".to_string() } else { "Recommencer cette partie".to_string() },
                on_restart: move |_| {
                    if let Some(h) = restart { h.call(()); } else {
                        index.set(0); finished.set(false); correct_count.set(0); selected.set(None);
                        status.set(Status::Idle); explain.set(None); shown_at.set(bridge::perf_now());
                    }
                },
            }
        };
    }

    let Some(question) = questions.get(index()).cloned() else {
        return rsx! { div { class: "glass p-8 text-center text-white/70", "Aucune question disponible pour cette partie." } };
    };
    let passage = question
        .passage_id
        .as_ref()
        .and_then(|id| passages.iter().find(|p| &p.id == id))
        .cloned();
    let is_part7 = part == 7;
    let correct_key = key_char(question.correct_key);

    let validate = {
        let question = question.clone();
        move |_| {
            let Some(key) = selected() else { return };
            if status() != Status::Idle {
                return;
            }
            let is_correct = key == correct_key;
            status.set(if is_correct {
                Status::Correct
            } else {
                Status::Incorrect
            });
            let mode = if review_mode {
                AttemptMode::Review
            } else {
                AttemptMode::Practice
            };
            ctx.data.write().record_answer(
                &question,
                key,
                bridge::perf_now() - shown_at(),
                mode,
                true,
            );
            if is_correct {
                correct_count += 1;
                let at = index();
                let mut go_next = go_next;
                spawn(async move {
                    gloo_sleep(1200).await;
                    if index() == at && status() == Status::Correct {
                        go_next();
                    }
                });
            } else {
                let at = index();
                let q = question.clone();
                let user_key = ctx.settings.peek().api_key.clone();
                let lesson_id = ctx.data.write().start_lesson(&q, key);
                explain.set(Some(ExplainState::Loading));
                spawn(async move {
                    let started = bridge::perf_now();
                    let result = ai::explain(&q.id, key, user_key.as_deref()).await;
                    if index() != at {
                        // La question a changé pendant l'appel : on ne touche pas à la suivante.
                        ctx.data.write().finish_lesson(&lesson_id, None);
                        return;
                    }
                    match result {
                        Ok(reply) => {
                            ctx.data
                                .write()
                                .finish_lesson(&lesson_id, reply.lesson.as_ref());
                            latency.set(
                                reply
                                    .latency_ms
                                    .or(Some((bridge::perf_now() - started) as u64)),
                            );
                            explain.set(Some(ExplainState::Ready(reply.explanation)));
                        }
                        Err(message) => {
                            ctx.data.write().finish_lesson(&lesson_id, None);
                            explain.set(Some(ExplainState::Error(message)));
                        }
                    }
                });
            }
        }
    };

    let number = index() + 1;
    let layout = if is_part7 {
        "grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_1fr]"
    } else {
        "flex flex-col gap-5"
    };
    let passage_class = if is_part7 {
        "lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto scrollbar-thin lg:pr-1"
    } else {
        ""
    };
    let current_status = status();

    rsx! {
        div { class: "mx-auto w-full max-w-5xl",
            div { class: "mb-5", ProgressBar { current: number, total } }
            div { class: "{layout}",
                if let Some(p) = passage {
                    div { role: "region", aria_label: "Document à lire", tabindex: if is_part7 { "0" } else { "-1" }, class: "{passage_class}", PassageView { passage: p } }
                }
                div { class: "flex flex-col gap-4", role: "region", aria_label: "Question et réponses",
                    div { class: "glass-strong animate-fade-up p-5 sm:p-6", key: "{question.id}",
                        div { class: "mb-4 flex items-center justify-between gap-3",
                            span { class: "chip", if part == 6 { "Complétez le texte" } else { "Question" } " n° {number}" }
                            if let (Some(ms), Status::Incorrect) = (latency(), current_status) {
                                span { class: "text-[11px] text-white/40", "Réponse IA en {ms} ms" }
                            }
                        }
                        p { class: "text-lg leading-relaxed text-white/95", "{question.prompt}" }
                        div { class: "mt-5 space-y-2.5", role: "group", aria_label: "Choix de réponse",
                            for opt in question.options.iter() {
                                {
                                    let key = key_char(opt.key);
                                    let is_sel = selected() == Some(key);
                                    let is_correct_opt = correct_key == key;
                                    let revealed = current_status != Status::Idle;
                                    let style = if revealed && is_correct_opt {
                                        "w-full justify-start text-left rounded-xl border border-emerald-400/50 bg-emerald-500/15 px-4 py-3 text-sm font-medium text-emerald-100"
                                    } else if revealed && is_sel && !is_correct_opt {
                                        "w-full justify-start text-left rounded-xl border border-red-400/50 bg-red-500/15 px-4 py-3 text-sm font-medium text-red-100"
                                    } else if !revealed && is_sel {
                                        "w-full justify-start text-left rounded-xl border border-violet-400/50 bg-violet-500/15 px-4 py-3 text-sm font-medium text-white"
                                    } else {
                                        "glass-btn w-full justify-start text-left"
                                    };
                                    let hover = if current_status == Status::Idle { "hover:bg-white/[0.12]" } else { "cursor-default" };
                                    rsx! {
                                        button {
                                            key: "{key}", disabled: current_status != Status::Idle, aria_pressed: "{is_sel}",
                                            class: "{style} flex items-center gap-3 transition-all duration-150 {hover}",
                                            onclick: move |_| selected.set(Some(key)),
                                            span { class: "lexora-answer-key flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold", "{key}" }
                                            span { class: "flex-1", "{opt.text}" }
                                            if revealed && is_correct_opt { span { class: "text-emerald-300", aria_hidden: "true", "✓" } }
                                            if revealed && is_sel && !is_correct_opt { span { class: "text-red-300", aria_hidden: "true", "✗" } }
                                        }
                                    }
                                }
                            }
                        }
                        if current_status == Status::Idle {
                            button {
                                disabled: selected().is_none(),
                                class: "mt-5 w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
                                onclick: validate, "Valider ma réponse"
                            }
                        } else {
                            div { class: "mt-5", role: "status", aria_live: "polite",
                                ReportButton { key: "{question.id}", question_id: question.id.clone(), part: question.part }
                                if current_status == Status::Correct {
                                    div { class: "animate-fade-up flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-200", "✓ Bonne réponse ! Passage à la question suivante…" }
                                }
                            }
                        }
                    }
                    if current_status == Status::Incorrect {
                        div { class: "space-y-4", role: "status", aria_live: "polite",
                            a { href: "#/lessons", class: "lexora-secondary", "Voir mes leçons →" }
                            if let (Some(state), Some(sel)) = (explain(), selected()) {
                                AiExplanation { state, question: question.clone(), selected: sel }
                            }
                            button { class: "w-full rounded-xl bg-white/[0.08] px-4 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-white/[0.14]", onclick: move |_| { let mut g = go_next; g(); }, "Question suivante" }
                        }
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum BlankStatus {
    Correct,
    Incorrect,
}

#[component]
fn InlineSelect(
    question: Question,
    number: usize,
    state: Option<(char, bool)>,
    on_select: EventHandler<char>,
) -> Element {
    let mut open = use_signal(|| false);
    let answered = state.is_some();
    let selected_opt = state.and_then(|(k, _)| {
        question
            .options
            .iter()
            .find(|o| key_char(o.key) == k)
            .cloned()
    });
    let status = state.map(|(_, ok)| {
        if ok {
            BlankStatus::Correct
        } else {
            BlankStatus::Incorrect
        }
    });
    let tone = match status {
        Some(BlankStatus::Correct) => "border-emerald-400/60 bg-emerald-900/90 text-emerald-100",
        Some(BlankStatus::Incorrect) => "border-red-400/60 bg-red-900/90 text-red-100",
        None => {
            "border-white/20 bg-slate-900/95 text-white hover:border-white/40 hover:bg-slate-800/95"
        }
    };
    let label = match (&selected_opt, status) {
        (Some(o), Some(BlankStatus::Correct)) => {
            format!("Blanc {number} : {}, bonne réponse", o.text)
        }
        (Some(o), _) => format!("Blanc {number} : {}, réponse incorrecte", o.text),
        _ => format!("Blanc {number} : choisir une réponse"),
    };
    let cursor = if answered {
        "cursor-default"
    } else {
        "cursor-pointer"
    };
    let data_status = match status {
        Some(BlankStatus::Correct) => "correct",
        Some(BlankStatus::Incorrect) => "incorrect",
        None => "idle",
    };
    rsx! {
        span { class: "relative inline-flex align-middle",
            button {
                r#type: "button", aria_haspopup: "listbox", aria_expanded: "{open()}", aria_label: "{label}", disabled: answered, "data-status": "{data_status}",
                class: "lexora-inline-trigger inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition-all duration-150 align-middle {tone} {cursor}",
                onclick: move |_| if !answered { open.toggle() },
                onkeydown: move |e| if e.key() == Key::Escape { open.set(false) },
                if let Some(o) = &selected_opt { span { class: "font-semibold", "{key_char(o.key)}. {o.text}" } } else { span { class: "text-white/70", "n°{number}" } }
                if status == Some(BlankStatus::Correct) { span { class: "text-emerald-300", "✓" } }
                if status == Some(BlankStatus::Incorrect) { span { class: "text-red-300", "✗" } }
                if !answered { span { class: "opacity-60", "▾" } }
            }
            if open() && !answered {
                div {
                    role: "listbox", aria_label: "Choix pour le blanc {number}",
                    class: "lexora-inline-menu absolute left-0 top-full z-30 mt-2 w-72 max-w-[80vw] overflow-hidden rounded-xl border border-white/20 bg-slate-900 p-1.5 shadow-2xl shadow-black/60",
                    onkeydown: move |e| if e.key() == Key::Escape { open.set(false) },
                    for opt in question.options.iter() {
                        {
                            let key = key_char(opt.key);
                            rsx! {
                                button {
                                    key: "{key}", r#type: "button", role: "option",
                                    class: "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-white transition-colors hover:bg-white/15",
                                    onclick: move |_| { on_select.call(key); open.set(false); },
                                    span { class: "flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/15 text-xs font-bold text-white", "{key}" }
                                    span { "{opt.text}" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[derive(Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // valeur éphémère de rendu
enum Node {
    Text(String),
    Blank {
        question: Question,
        number: usize,
        label: String,
    },
}

/// Découpe un paragraphe autour des trous `(n)____`.
fn split_blanks(para: &str) -> Vec<(String, Option<()>)> {
    let mut out = vec![];
    let mut rest = para;
    while let Some(start) = rest.find('(') {
        let tail = &rest[start + 1..];
        let digits = tail.chars().take_while(char::is_ascii_digit).count();
        let after = &tail[digits..];
        let underscores = after
            .strip_prefix(')')
            .map_or(0, |a| a.chars().take_while(|c| *c == '_').count());
        if digits > 0 && underscores >= 2 {
            if start > 0 {
                out.push((rest[..start].to_string(), None));
            }
            out.push((String::new(), Some(())));
            rest = &after[1 + underscores..];
        } else {
            out.push((rest[..=start].to_string(), None));
            rest = &rest[start + 1..];
        }
    }
    if !rest.is_empty() {
        out.push((rest.to_string(), None));
    }
    out
}

#[component]
pub fn Part6Inline(
    questions: Vec<Question>,
    passages: Vec<Passage>,
    on_new_series: Option<EventHandler<()>>,
) -> Element {
    let mut ctx = use_ctx();
    let mut answers = use_signal(std::collections::HashMap::<String, (char, bool)>::new);
    let mut passage_index = use_signal(|| 0usize);
    let mut finished = use_signal(|| false);
    let mut expl = use_signal(|| Option::<(String, String, ExplainState)>::None);
    let mut last_event = use_signal(bridge::perf_now);

    let groups: Vec<(Passage, Vec<Question>)> = passages
        .iter()
        .map(|p| {
            let mut qs: Vec<Question> = questions
                .iter()
                .filter(|q| q.passage_id.as_deref() == Some(&p.id))
                .cloned()
                .collect();
            qs.sort_by_key(|q| q.order_index);
            (p.clone(), qs)
        })
        .filter(|(_, qs)| !qs.is_empty())
        .collect();
    let total_blanks = questions.len();
    let correct_total = answers.read().values().filter(|(_, ok)| *ok).count();

    if finished() {
        let restart = on_new_series;
        return rsx! {
            ScoreBoard {
                part: 6, correct: correct_total as u32, total: total_blanks as u32,
                restart_label: if restart.is_some() { "Nouvelle série de textes".to_string() } else { "Recommencer cette partie".to_string() },
                on_restart: move |_| {
                    if let Some(h) = restart { h.call(()); } else {
                        answers.write().clear(); passage_index.set(0); finished.set(false); expl.set(None); last_event.set(bridge::perf_now());
                    }
                },
            }
        };
    }
    let Some((passage, group)) = groups.get(passage_index()).cloned() else {
        return rsx! { div { class: "glass p-8 text-center text-white/70", "Aucun texte disponible pour cette partie." } };
    };
    let is_last = passage_index() + 1 >= groups.len();
    let current_total = group.len();
    let current_answered = group
        .iter()
        .filter(|q| answers.read().contains_key(&q.id))
        .count();
    let current_done = current_total > 0 && current_answered >= current_total;
    let fill = (current_answered * 100)
        .checked_div(current_total)
        .unwrap_or(0);

    // Affectation des trous aux questions, dans l'ordre d'apparition.
    let mut pos = 0usize;
    let pidx = passage_index();
    let docs: Vec<(String, String, String, Vec<Vec<Node>>)> = passage
        .documents
        .iter()
        .map(|doc| {
            let paragraphs = doc
                .body
                .iter()
                .map(|para| {
                    split_blanks(para)
                        .into_iter()
                        .map(|(text, blank)| {
                            if blank.is_some() {
                                if let Some(question) = group.get(pos) {
                                    pos += 1;
                                    return Node::Blank {
                                        question: question.clone(),
                                        number: pos,
                                        label: format!("Texte {} · Trou {pos}", pidx + 1),
                                    };
                                }
                                return Node::Text("(…)".into());
                            }
                            Node::Text(text)
                        })
                        .collect()
                })
                .collect();
            (
                doc.id.clone(),
                doc.title.clone(),
                bank::kind_label(&doc.kind).to_string(),
                paragraphs,
            )
        })
        .collect();

    let mut on_select = move |(q, key, label): (Question, char, String)| {
        if answers.read().contains_key(&q.id) {
            return;
        }
        let ok = key == key_char(q.correct_key);
        answers.write().insert(q.id.clone(), (key, ok));
        let now = bridge::perf_now();
        ctx.data
            .write()
            .record_answer(&q, key, now - last_event(), AttemptMode::Practice, true);
        last_event.set(now);
        if !ok {
            let user_key = ctx.settings.peek().api_key.clone();
            let lesson_id = ctx.data.write().start_lesson(&q, key);
            expl.set(Some((q.id.clone(), label, ExplainState::Loading)));
            let at = passage_index();
            spawn(async move {
                let result = ai::explain(&q.id, key, user_key.as_deref()).await;
                let still = passage_index() == at
                    && expl.read().as_ref().is_some_and(|(id, _, _)| id == &q.id);
                match result {
                    Ok(reply) => {
                        ctx.data
                            .write()
                            .finish_lesson(&lesson_id, reply.lesson.as_ref());
                        if still {
                            let label = expl
                                .read()
                                .as_ref()
                                .map(|e| e.1.clone())
                                .unwrap_or_default();
                            expl.set(Some((
                                q.id.clone(),
                                label,
                                ExplainState::Ready(reply.explanation),
                            )));
                        }
                    }
                    Err(message) => {
                        ctx.data.write().finish_lesson(&lesson_id, None);
                        if still {
                            let label = expl
                                .read()
                                .as_ref()
                                .map(|e| e.1.clone())
                                .unwrap_or_default();
                            expl.set(Some((q.id.clone(), label, ExplainState::Error(message))));
                        }
                    }
                }
            });
        }
    };

    let groups_len = groups.len();
    let shown = passage_index() + 1;
    rsx! {
        div { class: "mx-auto w-full max-w-4xl",
            div { class: "mb-5 flex items-center justify-between gap-3",
                span { class: "chip", "Texte {shown} sur {groups_len}" }
                span { class: "text-sm text-white/70", span { class: "font-semibold text-white", "{correct_total}" } span { class: "text-white/40", " / {total_blanks} bonnes réponses" } }
            }
            div { class: "lexora-progress-track mb-3 h-1.5 w-full overflow-hidden rounded-full",
                div { class: "lexora-progress-fill h-full rounded-full transition-all duration-500 ease-out", style: "width: {fill}%" }
            }
            div { class: "flex flex-col gap-4",
                for (doc_id, title, kind, paragraphs) in docs {
                    article { key: "{doc_id}", class: "glass animate-fade-up p-5 sm:p-7",
                        div { class: "mb-4 flex items-start justify-between gap-3",
                            h3 { class: "text-sm font-semibold text-white/90", "{title}" }
                            span { class: "chip uppercase tracking-wide", "{kind}" }
                        }
                        div { class: "space-y-4",
                            for (pi, nodes) in paragraphs.into_iter().enumerate() {
                                p { key: "{pi}", class: "text-[15px] leading-loose text-white/85 sm:text-base",
                                    for (ni, node) in nodes.into_iter().enumerate() {
                                        match node {
                                            Node::Text(t) => rsx! { span { key: "{ni}", "{t}" } },
                                            Node::Blank { question, number, label } => {
                                                let state = answers.read().get(&question.id).copied();
                                                let correct_opt = question.options.iter().find(|o| o.key == question.correct_key).cloned();
                                                let wrong = state.is_some_and(|(_, ok)| !ok);
                                                let q2 = question.clone();
                                                rsx! {
                                                    span { key: "{ni}",
                                                        InlineSelect { question: question.clone(), number, state, on_select: move |k| on_select((q2.clone(), k, label.clone())) }
                                                        if let (true, Some(o)) = (wrong, correct_opt) {
                                                            span { class: "mx-1 inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 align-middle text-xs font-medium text-emerald-200", "✓ {key_char(o.key)}. {o.text}" }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some((qid, label, state)) = expl() {
                    if let Some(q) = questions.iter().find(|q| q.id == qid).cloned() {
                        div { class: "animate-fade-up space-y-3",
                            div { class: "glass-strong p-5",
                                div { class: "mb-3 flex items-center justify-between gap-3", span { class: "text-xs font-medium uppercase tracking-wider text-white/45", "{label}" } }
                                a { class: "lexora-secondary", href: "#/lessons", "Voir mes leçons →" }
                                if let Some((sel, _)) = answers.read().get(&qid).copied() { AiExplanation { state, question: q, selected: sel } }
                            }
                        }
                    }
                }
                if current_done {
                    button {
                        class: "w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90",
                        onclick: move |_| {
                            if is_last { finished.set(true); } else { passage_index += 1; expl.set(None); last_event.set(bridge::perf_now()); }
                        },
                        if is_last { "Voir mon score" } else { "Texte suivant" }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoupe_des_trous() {
        let parts = split_blanks("We (1)______ move in (2)___ March.");
        let blanks = parts.iter().filter(|(_, b)| b.is_some()).count();
        assert_eq!(blanks, 2);
        let text: String = parts.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(text, "We  move in  March.");
        assert_eq!(
            split_blanks("Pas de trou (ici) 5")
                .iter()
                .filter(|(_, b)| b.is_some())
                .count(),
            0
        );
        assert_eq!(
            split_blanks("(1)_ seul")
                .iter()
                .filter(|(_, b)| b.is_some())
                .count(),
            0,
            "un seul _ n'est pas un trou"
        );
    }
}
