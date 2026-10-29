//! Carnet de vocabulaire et flashcards. Port de `Vocab.tsx`.

use crate::bridge;
use crate::components::Page;
use crate::state::use_ctx;
use dioxus::prelude::*;
use lernoviq_core::vocab::{active_words, due_words, mark_deleted, review_word};

#[component]
pub fn Vocab() -> Element {
    let mut ctx = use_ctx();
    let mut cards_mode = use_signal(|| false);
    let mut queue = use_signal(Vec::<String>::new);
    let mut revealed = use_signal(|| false);
    let mut done = use_signal(|| 0usize);

    let words = active_words(&ctx.data.read().vocab);
    let due = due_words(&ctx.data.read().vocab, bridge::now()).len();
    let current = queue
        .read()
        .first()
        .and_then(|id| words.iter().find(|w| &w.id == id).cloned());
    let remaining = queue.read().len();
    let total = words.len();

    let mut answer = move |correct: bool| {
        let Some(id) = queue.read().first().cloned() else {
            return;
        };
        {
            let mut data = ctx.data.write();
            if let Some(w) = data.vocab.iter_mut().find(|w| w.id == id) {
                *w = review_word(w, correct, bridge::now());
            }
        }
        revealed.set(false);
        let mut q = queue.write();
        let first = q.remove(0);
        if !correct && !q.contains(&first) {
            q.push(first);
        }
        if correct {
            done += 1;
        }
    };

    rsx! {
        Page {
            main { class: "lexora-shell lexora-content", style: "max-width: 820px;",
                p { class: "lexora-eyebrow", "Mon vocabulaire" }
                h1 { class: "lexora-heading", "Mes mots" }
                p { class: "lexora-muted", "Ajoutez des mots depuis les explications du coach, puis révisez-les en flashcards avec le même rythme espacé que vos erreurs." }
                if cards_mode() {
                    section { class: "lexora-card", aria_live: "polite",
                        if let Some(w) = current {
                            p { class: "lexora-eyebrow", "Flashcard · {remaining} restante(s)" }
                            p { class: "lexora-scorebig", style: "font-size: 40px; letter-spacing: -1px;", "{w.term}" }
                            if revealed() {
                                div { class: "lexora-transcript",
                                    p { style: "margin: 0;", strong { "{w.meaning}" } }
                                    if !w.example.is_empty() { p { style: "margin: 8px 0 0;", em { "{w.example}" } } }
                                }
                            } else {
                                p { class: "lexora-muted", style: "margin-top: 14px;", "Cherchez le sens, puis révélez-le." }
                            }
                            div { class: "lexora-actions", style: "margin-top: 20px;",
                                button { r#type: "button", class: "lexora-secondary", onclick: move |_| cards_mode.set(false), "Arrêter" }
                                if revealed() {
                                    span { style: "display: flex; gap: 10px;",
                                        button { r#type: "button", class: "lexora-secondary", onclick: move |_| answer(false), "À revoir" }
                                        button { r#type: "button", class: "lexora-primary", onclick: move |_| answer(true), "Je savais ✓" }
                                    }
                                } else {
                                    button { r#type: "button", class: "lexora-primary", autofocus: true, onclick: move |_| revealed.set(true), "Afficher le sens" }
                                }
                            }
                        } else {
                            p { class: "lexora-scorebig", "{done}" }
                            p { class: "lexora-muted", style: "margin-top: 12px;", "mot(s) validé(s) pour cette séance. Les mots reviendront à intervalles croissants." }
                            div { class: "lexora-actions", span {} button { r#type: "button", class: "lexora-primary", onclick: move |_| cards_mode.set(false), "Retour à mes mots" } }
                        }
                    }
                } else {
                    section { class: "lexora-hero", style: "margin: 24px 0;",
                        div {
                            h2 { if due > 0 { "{due} mot(s) à réviser" } else { "Aucun mot à réviser maintenant" } }
                            p { class: "lexora-muted", if total > 0 { "{total} mot(s) dans votre carnet." } else { "Votre carnet est vide : utilisez « Ajouter à mes mots » sous une explication." } }
                        }
                        button { r#type: "button", class: "lexora-primary", disabled: due == 0,
                            onclick: move |_| {
                                let ids = due_words(&ctx.data.read().vocab, bridge::now()).into_iter().map(|w| w.id).collect();
                                queue.set(ids); done.set(0); revealed.set(false); cards_mode.set(true);
                            },
                            "Réviser en flashcards →"
                        }
                    }
                    if total > 0 {
                        ul { class: "lexora-wrong-list", aria_label: "Mes mots",
                            for w in words.iter() {
                                {
                                let badge = if w.mastered { "Maîtrisé".to_string() } else { format!("Boîte {}", w.box_) };
                                rsx! { li { key: "{w.id}", style: "list-style: none;",
                                    article {
                                        div { class: "lexora-actions", strong { "{w.term}" } span { class: "lexora-pill", "{badge}" } }
                                        p { style: "margin: 6px 0;", "{w.meaning}" }
                                        if !w.example.is_empty() { p { class: "lexora-subtle", style: "margin: 0;", em { "{w.example}" } } }
                                        button { r#type: "button", class: "lexora-secondary", style: "margin-top: 10px;", aria_label: "Supprimer {w.term}",
                                            onclick: { let id = w.id.clone(); move |_| { let mut d = ctx.data.write(); if let Some(x) = d.vocab.iter_mut().find(|x| x.id == id) { *x = mark_deleted(x, bridge::now()); } } },
                                            "Supprimer"
                                        }
                                    }
                                } }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
