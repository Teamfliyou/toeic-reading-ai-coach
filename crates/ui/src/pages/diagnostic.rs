//! Diagnostic initial (15 questions de partie 5). Port de `Diagnostic.tsx`.

use crate::bank;
use crate::bridge;
use crate::state::{use_ctx, Diagnostic as DiagnosticResult};
use dioxus::prelude::*;
use lernoviq_models::AttemptMode;

#[component]
pub fn Diagnostic() -> Element {
    let mut ctx = use_ctx();
    let questions = use_hook(|| {
        let mut s = bank::load_series(5, &Default::default(), &[]);
        s.questions.truncate(15);
        s.questions
    });
    let mut index = use_signal(|| 0usize);
    let mut selected = use_signal(|| Option::<char>::None);
    let mut correct = use_signal(|| 0u32);
    let mut finished = use_signal(|| false);
    let mut shown_at = use_signal(bridge::perf_now);
    let total = questions.len();
    let pct = if total > 0 {
        (f64::from(correct()) / total as f64 * 100.0).round() as u32
    } else {
        0
    };
    let current = questions.get(index()).cloned();
    let progress = (index() * 100).checked_div(total).unwrap_or(0);

    rsx! {
        div { class: "lexora-page",
            header { class: "lexora-nav", div { class: "lexora-shell",
                a { class: "lexora-brand", href: "#/", span { class: "lexora-mark", "N" } " Lernoviq" }
                span { class: "lexora-subtle", "Évaluation initiale · Reading" }
            } }
            main { class: "lexora-shell",
                div { class: "lexora-assessment",
                    if questions.is_empty() {
                        div { class: "lexora-card", h1 { "Diagnostic indisponible" } p { class: "lexora-muted", "Aucune question disponible." } a { class: "lexora-secondary", href: "#/", "Retour à l'accueil" } }
                    } else if finished() {
                        section { class: "lexora-card", aria_live: "polite",
                            p { class: "lexora-eyebrow", "Votre diagnostic est terminé" }
                            h1 { class: "lexora-heading", "Votre point de départ" }
                            span { class: "lexora-resultmark", "{pct} %" }
                            p { class: "lexora-muted", "{correct()} bonnes réponses sur {total}. Vos erreurs rejoignent vos révisions espacées." }
                            div { class: "lexora-actions", a { class: "lexora-secondary", href: "#/", "Tableau de bord" } a { class: "lexora-primary", href: "#/practice/part5", "Continuer à m'entraîner →" } }
                        }
                    } else if let Some(q) = current {
                        p { class: "lexora-eyebrow", "Évaluation initiale" }
                        h1 { class: "lexora-heading", "Faisons le point sur votre anglais." }
                        p { class: "lexora-muted", "Un diagnostic court, sans chronomètre. Choisissez une réponse par question." }
                        div { class: "lexora-progressline", role: "progressbar", aria_valuemin: "0", aria_valuemax: "{total}", aria_valuenow: "{index()}", div { style: "width: {progress}%" } }
                        div { class: "lexora-card",
                            p { class: "lexora-eyebrow", "Question {index() + 1} / {total}" }
                            p { class: "lexora-question", "{q.prompt}" }
                            div { class: "lexora-options",
                                for opt in q.options.iter() {
                                    {
                                        let key = bank::key_char(opt.key);
                                        rsx! { button { key: "{key}", r#type: "button", class: "lexora-option", aria_pressed: "{selected() == Some(key)}", onclick: move |_| selected.set(Some(key)), span { class: "lexora-optionkey", "{key}" } "{opt.text}" } }
                                    }
                                }
                            }
                            div { class: "lexora-actions",
                                a { class: "lexora-secondary", href: "#/", "Quitter" }
                                button { r#type: "button", class: "lexora-primary", disabled: selected().is_none(),
                                    onclick: {
                                        let q = q.clone();
                                        move |_| {
                                            let Some(key) = selected() else { return };
                                            let ok = key == bank::key_char(q.correct_key);
                                            ctx.data.write().record_answer(&q, key, bridge::perf_now() - shown_at(), AttemptMode::Diagnostic, true);
                                            shown_at.set(bridge::perf_now());
                                            if ok { correct += 1; }
                                            selected.set(None);
                                            if index() + 1 >= total {
                                                ctx.data.write().diagnostic = Some(DiagnosticResult { correct: correct(), total: total as u32, date: bridge::now() });
                                                finished.set(true);
                                            } else {
                                                index += 1;
                                            }
                                        }
                                    },
                                    if index() + 1 == total { "Terminer" } else { "Question suivante" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
