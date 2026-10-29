//! Composants partagés : navigation, document, progression, score, explication du coach,
//! signalement, carnet de mots, paramètres. Les classes CSS sont celles de l'ancienne interface
//! (liquid glass), reprises à l'identique dans `assets/app.css`.

use crate::ai;
use crate::bank::{key_char, kind_label};
use crate::bridge;
use crate::state::use_ctx;
use dioxus::prelude::*;
use lernoviq_core::vocab::{
    create_word, example_from_prompt, validate_word, WordInput, LIMIT_EXAMPLE, LIMIT_MEANING,
    LIMIT_TERM,
};
use lernoviq_models::{Passage, Question};

#[component]
pub fn SettingsButton(#[props(default = false)] with_label: bool) -> Element {
    let mut ctx = use_ctx();
    rsx! {
        button {
            r#type: "button",
            aria_label: "Paramètres",
            class: if with_label { "settings-trigger inline-flex items-center gap-2" } else { "settings-trigger inline-flex items-center gap-2 px-2.5 py-2" },
            onclick: move |_| ctx.settings.write().open = true,
            svg { view_box: "0 0 24 24", class: "h-4 w-4", fill: "none", stroke: "currentColor", stroke_width: "1.8", stroke_linecap: "round", stroke_linejoin: "round",
                circle { cx: "12", cy: "12", r: "3" }
                path { d: "M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" }
            }
            if with_label { span { "Paramètres" } }
        }
    }
}

#[component]
pub fn Header(#[props(default = false)] full: bool) -> Element {
    rsx! {
        header { class: "lexora-nav",
            div { class: "lexora-shell",
                a { href: "#/", class: "lexora-brand", span { class: "lexora-mark", "N" } " Lernoviq" }
                div { class: "lexora-navright",
                    if full {
                        a { class: "lexora-smalllink", href: "#/vocab", "Mes mots" }
                        a { class: "lexora-smalllink", href: "#/stats", "Statistiques" }
                        a { class: "lexora-smalllink", href: "#/lessons", "Mes leçons" }
                        a { class: "lexora-smalllink", href: "#/diagnostic", "Diagnostic" }
                    } else {
                        a { class: "lexora-smalllink", href: "#/", "Tableau de bord" }
                        a { class: "lexora-smalllink", href: "#/diagnostic", "Diagnostic" }
                    }
                    SettingsButton { with_label: true }
                }
            }
        }
    }
}

/// Page standard : en-tête + contenu.
#[component]
pub fn Page(
    #[props(default = false)] full: bool,
    #[props(default = "lexora-page")] class: &'static str,
    children: Element,
) -> Element {
    rsx! {
        div { class: "{class}",
            Header { full }
            {children}
        }
    }
}

#[component]
pub fn OfflineBanner() -> Element {
    let mut online = use_signal(bridge::online);
    use_future(move || async move {
        loop {
            gloo_sleep(3000).await;
            online.set(bridge::online());
        }
    });
    if online() {
        return rsx! {};
    }
    rsx! {
        div { class: "lexora-offline", role: "status", aria_live: "polite",
            strong { "Hors connexion." }
            " Les exercices restent disponibles ; les explications du coach IA reprendront dès le retour du réseau."
        }
    }
}

/// Attente asynchrone (setTimeout).
pub async fn gloo_sleep(ms: i32) {
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        if let Some(w) = web_sys::window() {
            let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms);
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

#[component]
pub fn ProgressBar(current: usize, total: usize) -> Element {
    let pct = if total > 0 {
        ((current as f64 / total as f64) * 100.0).round() as usize
    } else {
        0
    };
    let shown = current.min(total);
    rsx! {
        div { class: "w-full",
            div { class: "mb-1.5 flex items-center justify-between text-xs text-white/60",
                span { "Question {shown} sur {total}" }
                span { class: "font-mono tabular-nums", "{pct}%" }
            }
            div { class: "h-1.5 w-full overflow-hidden rounded-full bg-white/10",
                div { class: "h-full rounded-full bg-gradient-to-r from-violet-400 to-cyan-400 transition-all duration-500 ease-out", style: "width: {pct}%" }
            }
        }
    }
}

#[component]
pub fn PassageView(passage: Passage) -> Element {
    rsx! {
        div { class: "flex flex-col gap-4",
            for doc in passage.documents.iter() {
                article { key: "{doc.id}", class: "glass animate-fade-up p-5 sm:p-6",
                    div { class: "mb-3 flex items-start justify-between gap-3",
                        h3 { class: "text-sm font-semibold text-white/90", "{doc.title}" }
                        span { class: "chip uppercase tracking-wide", "{kind_label(&doc.kind)}" }
                    }
                    if doc.kind == "schedule" {
                        ul { class: "space-y-2",
                            for (i, line) in doc.body.iter().enumerate() {
                                li { key: "{i}", class: "flex items-baseline gap-3 rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-white/80", "{line}" }
                            }
                        }
                    } else {
                        div { class: "space-y-3 text-[15px] leading-relaxed text-white/85",
                            for (i, para) in doc.body.iter().enumerate() {
                                p { key: "{i}", "{para}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[component]
pub fn ScoreBoard(
    part: u8,
    correct: u32,
    total: u32,
    on_restart: EventHandler<()>,
    #[props(default = "Recommencer cette partie".to_string())] restart_label: String,
) -> Element {
    let mut ctx = use_ctx();
    use_hook(|| ctx.data.write().save_session(part, correct, total));
    let info = crate::parts::info(part);
    let pct = if total > 0 {
        (f64::from(correct) / f64::from(total) * 100.0).round() as u32
    } else {
        0
    };
    let errors = total - correct.min(total);
    let message = if pct >= 80 {
        "Excellent travail ! Vous maîtrisez cette partie."
    } else if pct >= 50 {
        "Bon début ! Continuez à vous entraîner pour progresser."
    } else {
        "Chaque erreur est une occasion d'apprendre. Persévérez !"
    };
    let plural = if correct > 1 { "s" } else { "" };
    rsx! {
        div { class: "mx-auto w-full max-w-xl",
            div { class: "glass-strong animate-fade-up p-8 text-center",
                span { class: "chip mb-5", "{info.name} — {info.tagline}" }
                div { class: "my-8 rounded-2xl border border-white/10 bg-white/[0.035] px-6 py-8",
                    div { class: "text-6xl font-bold tracking-tight text-white", "{pct}" span { class: "text-3xl text-cyan-300", "%" } }
                    p { class: "mt-2 text-sm text-white/55", "Taux de réussite" }
                    div { class: "mt-6 h-2.5 overflow-hidden rounded-full bg-white/10",
                        div { class: "h-full rounded-full bg-cyan-400 transition-all duration-500", style: "width: {pct}%" }
                    }
                    div { class: "mt-4 flex justify-between text-sm text-white/65",
                        span { "{correct} bonnes réponses" }
                        span { "{errors} erreurs" }
                    }
                }
                p { class: "text-lg font-semibold text-white/90", "{correct} bonne{plural} réponse{plural} sur {total}" }
                p { class: "mt-2 text-sm text-white/60", "{message}" }
                div { class: "mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center",
                    button {
                        class: "rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90",
                        onclick: move |_| on_restart.call(()),
                        "{restart_label}"
                    }
                    a { href: "#/", class: "glass-btn px-6 py-3 text-center text-sm font-semibold", "Retour au tableau de bord" }
                }
            }
        }
    }
}

#[component]
fn PointCard(
    index: &'static str,
    title: &'static str,
    body: String,
    tone: &'static str,
) -> Element {
    rsx! {
        div { class: "glass p-4",
            div { class: "mb-1.5 flex items-center gap-2",
                span { class: "flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold {tone}", "{index}" }
                span { class: "text-sm font-semibold text-white/90", "{title}" }
            }
            p { class: "text-sm leading-relaxed text-white/75", "{body}" }
        }
    }
}

#[derive(Clone, PartialEq)]
pub enum ExplainState {
    Loading,
    Error(String),
    Ready(ai::Explanation),
}

#[component]
pub fn AiExplanation(state: ExplainState, question: Question, selected: char) -> Element {
    let mut vote = use_signal(|| 0i8);
    rsx! {
        div { class: "animate-fade-up",
            div { class: "mb-3 flex items-center gap-2",
                span { class: "flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-cyan-500 text-xs", "IA" }
                h3 { class: "text-sm font-semibold text-white/90", "Explication du coach" }
            }
            match &state {
                ExplainState::Loading => rsx! {
                    div { class: "glass space-y-3 p-4",
                        for i in 0..3 {
                            div { key: "{i}", class: "space-y-2",
                                div { class: "h-3 w-1/3 rounded-full bg-white/10", style: "background-image: linear-gradient(90deg, rgba(255,255,255,0.06), rgba(255,255,255,0.16), rgba(255,255,255,0.06)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite;" }
                                div { class: "h-3 w-full rounded-full bg-white/[0.06]" }
                                div { class: "h-3 w-2/3 rounded-full bg-white/[0.06]" }
                            }
                        }
                    }
                },
                ExplainState::Error(message) => rsx! {
                    div { class: "glass border-red-400/30 p-4 text-sm text-red-200", "{message}" }
                },
                ExplainState::Ready(e) => rsx! {
                    div { class: "space-y-3",
                        PointCard { index: "1", title: "Diagnostic", body: e.diagnostic.clone(), tone: "bg-red-500/20 text-red-300" }
                        PointCard { index: "2", title: "Résolution", body: e.resolution.clone(), tone: "bg-emerald-500/20 text-emerald-300" }
                        PointCard { index: "3", title: "Tip TOEIC", body: e.tip.clone(), tone: "bg-cyan-500/20 text-cyan-300" }
                        AddWordForm { key: "word-{question.id}", question: question.clone() }
                        FollowUp { key: "{question.id}:{selected}", question: question.clone(), selected }
                        div { class: "flex items-center gap-2 pt-1",
                            span { class: "text-xs text-white/50", "Cette explication vous a-t-elle été utile ?" }
                            button { aria_label: "Utile", class: if vote() == 1 { "glass-btn px-2.5 py-1 text-sm border-emerald-400/50 bg-emerald-500/20" } else { "glass-btn px-2.5 py-1 text-sm" }, onclick: move |_| vote.set(1), "👍" }
                            button { aria_label: "Pas utile", class: if vote() == -1 { "glass-btn px-2.5 py-1 text-sm border-red-400/50 bg-red-500/20" } else { "glass-btn px-2.5 py-1 text-sm" }, onclick: move |_| vote.set(-1), "👎" }
                        }
                    }
                },
            }
        }
    }
}

const MAX_FOLLOW_UPS: usize = 3;
const MAX_CHARS: usize = 300;

#[component]
pub fn FollowUp(question: Question, selected: char) -> Element {
    let ctx = use_ctx();
    let mut turns = use_signal(Vec::<(String, String)>::new);
    let mut draft = use_signal(String::new);
    let mut loading = use_signal(|| false);
    let mut error = use_signal(|| Option::<String>::None);
    let online = bridge::online();
    let text = draft().trim().to_string();
    let reached = turns.read().len() >= MAX_FOLLOW_UPS;
    let can_ask = online
        && !loading()
        && !reached
        && text.chars().count() >= 3
        && text.chars().count() <= MAX_CHARS;
    let qid = question.id.clone();
    let remaining = MAX_FOLLOW_UPS - turns.read().len();
    let count = draft().chars().count();

    rsx! {
        section { class: "glass p-4", aria_label: "Question de relance au coach",
            h4 { class: "mb-2 text-sm font-semibold text-white/90", "Une question sur cette explication ?" }
            if !turns.read().is_empty() {
                ol { class: "mb-3 space-y-3",
                    for (i, (q, a)) in turns.read().iter().enumerate() {
                        li { key: "{i}", class: "space-y-1 text-sm",
                            p { class: "font-medium text-white/90", "Vous : {q}" }
                            p { class: "whitespace-pre-line text-white/75", "Coach : {a}" }
                        }
                    }
                }
            }
            if reached {
                p { class: "text-sm text-white/60", "Limite de {MAX_FOLLOW_UPS} questions atteinte pour cette question. Passez à la suivante !" }
            } else {
                form {
                    class: "space-y-2",
                    onsubmit: move |evt| {
                        evt.prevent_default();
                        if !can_ask { return; }
                        let text = draft().trim().to_string();
                        let qid = qid.clone();
                        let key = ctx.settings.read().api_key.clone();
                        loading.set(true);
                        error.set(None);
                        spawn(async move {
                            match ai::follow_up(&qid, selected, &text, key.as_deref()).await {
                                Ok(r) => { turns.write().push((text, r.answer)); draft.set(String::new()); }
                                Err(e) => error.set(Some(e)),
                            }
                            loading.set(false);
                        });
                    },
                    label { r#for: "followup", class: "sr-only", "Votre question au coach" }
                    textarea {
                        id: "followup", value: "{draft}", maxlength: "{MAX_CHARS}", rows: "2", disabled: !online || loading(),
                        placeholder: "Ex : pourquoi pas « because of » ici ?",
                        class: "w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40",
                        oninput: move |e| draft.set(e.value()),
                    }
                    div { class: "flex items-center justify-between gap-3",
                        span { class: "text-xs text-white/50", "{count}/{MAX_CHARS} · {remaining} question(s) restante(s)" }
                        button { r#type: "submit", disabled: !can_ask, class: "glass-btn px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40",
                            if loading() { "Le coach réfléchit…" } else { "Poser ma question" }
                        }
                    }
                }
            }
            if !online { p { class: "mt-2 text-xs text-red-300", role: "status", "{ai::OFFLINE_MESSAGE}" } }
            if let Some(e) = error() { p { class: "mt-2 text-sm text-red-300", role: "alert", "{e}" } }
        }
    }
}

#[component]
pub fn AddWordForm(question: Question) -> Element {
    let mut ctx = use_ctx();
    let correct = question
        .options
        .iter()
        .find(|o| o.key == question.correct_key)
        .map(|o| o.text.clone())
        .unwrap_or_default();
    let mut open = use_signal(|| false);
    let mut term = use_signal(|| correct.clone());
    let mut meaning = use_signal(String::new);
    let mut example = use_signal(|| example_from_prompt(&question.prompt, &correct));
    let mut error = use_signal(|| Option::<String>::None);
    let mut saved = use_signal(|| false);
    let qid = question.id.clone();

    if saved() {
        return rsx! { p { class: "text-sm text-emerald-300", role: "status", "Ajouté à vos mots ✓ · " a { class: "underline", href: "#/vocab", "Voir mon carnet" } } };
    }
    if !open() {
        return rsx! { button { r#type: "button", class: "glass-btn px-3 py-2 text-sm font-semibold", onclick: move |_| open.set(true), "＋ Ajouter à mes mots" } };
    }
    rsx! {
        form {
            class: "glass space-y-2 p-4", aria_label: "Ajouter un mot à mon carnet",
            onsubmit: move |evt| {
                evt.prevent_default();
                let input = WordInput { term: term(), meaning: meaning(), example: example(), source_question_id: Some(qid.clone()) };
                let existing = ctx.data.read().vocab.clone();
                match validate_word(&input, &existing) {
                    Ok(valid) => {
                        ctx.data.write().vocab.push(create_word(valid, bridge::uuid(), bridge::now()));
                        error.set(None);
                        saved.set(true);
                    }
                    Err(e) => error.set(Some(e)),
                }
            },
            label { class: "block text-sm font-medium text-white/80", r#for: "vw-term", "Mot ou expression" }
            input { id: "vw-term", value: "{term}", maxlength: "{LIMIT_TERM}", class: "w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm text-white", oninput: move |e| term.set(e.value()) }
            label { class: "block text-sm font-medium text-white/80", r#for: "vw-meaning", "Sens en français" }
            input { id: "vw-meaning", value: "{meaning}", maxlength: "{LIMIT_MEANING}", placeholder: "Ex : rentable", class: "w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm text-white", oninput: move |e| meaning.set(e.value()) }
            label { class: "block text-sm font-medium text-white/80", r#for: "vw-example", "Exemple (facultatif)" }
            input { id: "vw-example", value: "{example}", maxlength: "{LIMIT_EXAMPLE}", class: "w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm text-white", oninput: move |e| example.set(e.value()) }
            if let Some(e) = error() { p { class: "text-sm text-red-300", role: "alert", "{e}" } }
            div { class: "flex gap-2",
                button { r#type: "submit", class: "glass-btn px-4 py-2 text-sm font-semibold", "Enregistrer" }
                button { r#type: "button", class: "glass-btn px-4 py-2 text-sm", onclick: move |_| open.set(false), "Annuler" }
            }
        }
    }
}

#[component]
pub fn ReportButton(question_id: String, part: u8) -> Element {
    let mut open = use_signal(|| false);
    let mut reason = use_signal(|| "wrong_answer".to_string());
    let mut comment = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut message = use_signal(|| Option::<(bool, String)>::None);
    let qid = question_id.clone();

    if let Some((true, text)) = message() {
        return rsx! { p { class: "lexora-subtle", role: "status", "{text}" } };
    }
    rsx! {
        div { class: "lexora-report",
            if !open() {
                button { r#type: "button", class: "lexora-linkbutton", onclick: move |_| open.set(true), "⚑ Signaler une erreur dans cette question" }
            } else {
                form {
                    class: "lexora-card", aria_label: "Signaler une question erronée", style: "display: grid; gap: 10px; margin-top: 8px;",
                    onsubmit: move |evt| {
                        evt.prevent_default();
                        busy.set(true);
                        message.set(None);
                        let args = serde_json::json!({"questionId": qid, "part": part, "reason": reason(), "comment": comment()});
                        spawn(async move {
                            match bridge::invoke::<_, serde_json::Value>("report", &args).await {
                                Ok(_) => { message.set(Some((true, "Merci ! Votre signalement a été transmis.".into()))); open.set(false); }
                                Err(e) => message.set(Some((false, e))),
                            }
                            busy.set(false);
                        });
                    },
                    label { r#for: "rp-reason", "Motif" }
                    select { id: "rp-reason", value: "{reason}", class: "lexora-admin-input", onchange: move |e| reason.set(e.value()),
                        option { value: "wrong_answer", "La bonne réponse me semble fausse" }
                        option { value: "typo", "Faute de frappe ou texte incorrect" }
                        option { value: "ambiguous", "Plusieurs réponses possibles" }
                        option { value: "other", "Autre problème" }
                    }
                    label { r#for: "rp-comment", "Précisions (facultatif)" }
                    textarea { id: "rp-comment", value: "{comment}", maxlength: "500", rows: "3", class: "lexora-admin-input", oninput: move |e| comment.set(e.value()) }
                    if let Some((false, text)) = message() { p { role: "alert", style: "color: #9a3232; margin: 0;", "{text}" } }
                    div { style: "display: flex; gap: 8px;",
                        button { r#type: "submit", class: "lexora-primary", disabled: busy(), if busy() { "Envoi…" } else { "Envoyer" } }
                        button { r#type: "button", class: "lexora-secondary", onclick: move |_| open.set(false), "Annuler" }
                    }
                }
            }
        }
    }
}

#[component]
pub fn SettingsModal() -> Element {
    let mut ctx = use_ctx();
    let open = ctx.settings.read().open;
    let mut draft = use_signal(String::new);
    let mut remember = use_signal(|| false);
    let mut show = use_signal(|| false);
    let mut update = use_signal(|| Option::<String>::None);
    use_effect(move || {
        if ctx.settings.read().open {
            draft.set(ctx.settings.peek().api_key.clone().unwrap_or_default());
            remember.set(ctx.settings.peek().remembered);
            show.set(false);
        }
    });
    if !open {
        return rsx! {};
    }
    let has_key = ctx.settings.read().api_key.is_some();
    let can_save = !draft().trim().is_empty();
    rsx! {
        div {
            class: "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm",
            role: "dialog", aria_modal: "true", aria_label: "Paramètres",
            onclick: move |_| ctx.settings.write().open = false,
            onkeydown: move |e| if e.key() == Key::Escape { ctx.settings.write().open = false },
            div { class: "glass-strong w-full max-w-md animate-fade-up p-6", onclick: move |e| e.stop_propagation(),
                div { class: "mb-5 flex items-center justify-between",
                    h2 { class: "text-lg font-bold text-white/95", "Paramètres" }
                    button { r#type: "button", aria_label: "Fermer", class: "glass-btn px-2.5 py-1.5", onclick: move |_| ctx.settings.write().open = false, "✕" }
                }
                div { class: "mb-5 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm",
                    span { aria_hidden: "true", if has_key { "🟢" } else { "🔵" } }
                    span { class: "font-medium text-white/90", if has_key { "Clé personnelle active" } else { "Clé du serveur par défaut" } }
                }
                label { r#for: "deepseek-key", class: "mb-2 block text-sm font-medium text-white/80", "Clé API DeepSeek" }
                div { class: "relative",
                    input {
                        id: "deepseek-key", r#type: if show() { "text" } else { "password" }, value: "{draft}", placeholder: "sk-...", autocomplete: "off", spellcheck: false,
                        class: "w-full rounded-xl border border-white/20 bg-slate-900/95 px-3 py-2.5 pr-11 text-sm text-white placeholder:text-white/40 outline-none transition-colors focus:border-violet-400/60",
                        oninput: move |e| draft.set(e.value()),
                    }
                    button { r#type: "button", aria_label: if show() { "Masquer la clé" } else { "Afficher la clé" }, class: "absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white", onclick: move |_| show.toggle(), if show() { "🙈" } else { "👁" } }
                }
                label { class: "mt-3 flex cursor-pointer items-start gap-2 text-sm text-white/80",
                    input { r#type: "checkbox", checked: remember(), class: "mt-0.5 h-4 w-4 accent-violet-500", onchange: move |e| remember.set(e.checked()) }
                    span { "Mémoriser sur cet appareil"
                        span { class: "block text-xs text-white/55", "Désactivé : la clé reste en mémoire et disparaît à la fermeture. Activé : elle est conservée dans le stockage local de l'application, non chiffré (à éviter sur un ordinateur partagé)." }
                    }
                }
                div { class: "mt-5 flex flex-col gap-3",
                    button {
                        r#type: "button", disabled: !can_save,
                        class: "w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
                        onclick: move |_| { let (k, r) = (draft(), remember()); let mut w = ctx.settings.write(); w.save_key(&k, r); w.open = false; },
                        "Enregistrer"
                    }
                    button {
                        r#type: "button", disabled: !has_key,
                        class: "w-full rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-200 transition-all duration-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40",
                        onclick: move |_| { ctx.settings.write().clear_key(); draft.set(String::new()); },
                        "Supprimer / Réinitialiser la clé"
                    }
                    hr { class: "border-white/10" }
                    button {
                        r#type: "button", class: "glass-btn w-full px-4 py-3 text-sm font-semibold",
                        onclick: move |_| {
                            update.set(Some("Recherche en cours…".into()));
                            spawn(async move {
                                let text = match bridge::invoke::<_, serde_json::Value>("check_update", &serde_json::json!({})).await {
                                    Ok(v) if v.is_null() => "Lernoviq est à jour.".to_string(),
                                    Ok(v) => format!("Nouvelle version disponible : {} (installée : {}).", v["version"].as_str().unwrap_or("?"), v["currentVersion"].as_str().unwrap_or("?")),
                                    Err(e) => format!("Recherche impossible : {e}"),
                                };
                                update.set(Some(text));
                            });
                        },
                        "Rechercher des mises à jour"
                    }
                    if let Some(text) = update() {
                        p { class: "text-sm text-white/80", role: "status", "{text}" }
                        if text.starts_with("Nouvelle version") {
                            button {
                                r#type: "button", class: "w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white",
                                onclick: move |_| { update.set(Some("Téléchargement et installation (l'application redémarre)…".into())); spawn(async move { let r = bridge::invoke::<_, serde_json::Value>("install_update", &serde_json::json!({})).await; if let Err(e) = r { update.set(Some(format!("Échec de la mise à jour : {e}"))); } }); },
                                "Installer la mise à jour"
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Affichage d'une question de lecture avec son document (examen, révision, diagnostic).
#[component]
pub fn QuestionView(
    question: Question,
    passage: Option<Passage>,
    selected: Option<char>,
    on_select: EventHandler<char>,
    #[props(default = false)] reveal: bool,
    #[props(default = false)] disabled: bool,
    number: Option<usize>,
) -> Element {
    let split = question.part == 7 && passage.is_some();
    let correct = key_char(question.correct_key);
    rsx! {
        div { class: if split { "lexora-split" } else { "lexora-stack" },
            if let Some(p) = passage {
                div { class: if split { "lexora-split-passage" } else { "" }, tabindex: if split { "0" } else { "-1" }, aria_label: "Document à lire", PassageView { passage: p } }
            }
            section { class: "lexora-card", aria_label: "Question",
                p { class: "lexora-eyebrow", if let Some(n) = number { "Question {n} · " } "Partie {question.part}" }
                p { class: "lexora-question", "{question.prompt}" }
                div { class: "lexora-options", role: "group", aria_label: "Choix de réponse",
                    for opt in question.options.iter() {
                        {
                            let key = key_char(opt.key);
                            let state = if !reveal { "" } else if key == correct { "correct" } else if selected == Some(key) { "wrong" } else { "" };
                            rsx! {
                                button { key: "{key}", r#type: "button", class: "lexora-option", aria_pressed: "{selected == Some(key)}", "data-state": "{state}", disabled, onclick: move |_| on_select.call(key),
                                    span { class: "lexora-optionkey", "{key}" }
                                    "{opt.text}"
                                    if state == "correct" { span { class: "lexora-sr", " (bonne réponse)" } }
                                    if state == "wrong" { span { class: "lexora-sr", " (votre réponse, incorrecte)" } }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
