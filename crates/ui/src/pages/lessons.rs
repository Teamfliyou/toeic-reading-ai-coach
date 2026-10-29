//! Leçons personnalisées. Port de `Lessons.tsx`.

use crate::components::*;
use crate::state::use_ctx;
use dioxus::prelude::*;

#[component]
pub fn Lessons() -> Element {
    let ctx = use_ctx();
    let lessons = ctx.data.read().lessons.clone();
    let mut expanded = use_signal(|| lessons.first().map(|l| l.id.clone()));
    let ready = lessons.iter().filter(|l| l.status == "ready").count();
    let total = lessons.len();
    let todo = total - ready;
    rsx! {
        Page {
            main { class: "lexora-shell lexora-content",
                p { class: "lexora-eyebrow", "Mon parcours personnalisé" }
                h1 { class: "lexora-heading", "Mes leçons" }
                p { class: "lexora-muted", "Chaque erreur peut devenir une leçon ciblée : règle, exemple, exercice et astuce pour progresser." }
                section { class: "lexora-stats", aria_label: "Statistiques des leçons",
                    div { class: "lexora-card", p { class: "lexora-statlabel", "Leçons disponibles" } p { class: "lexora-statvalue", "{ready}" } }
                    div { class: "lexora-card", p { class: "lexora-statlabel", "Erreurs enregistrées" } p { class: "lexora-statvalue", "{total}" } }
                    div { class: "lexora-card", p { class: "lexora-statlabel", "À générer" } p { class: "lexora-statvalue", "{todo}" } }
                }
                if lessons.is_empty() {
                    section { class: "lexora-hero",
                        div { h2 { "Votre première leçon vous attend" } p { class: "lexora-muted", "Lors d’un entraînement, le coach analysera vos erreurs et préparera une fiche adaptée." } }
                        a { class: "lexora-primary", href: "#/practice/part5", "Commencer un exercice →" }
                    }
                } else {
                    section { class: "lexora-lesson-list", aria_label: "Leçons personnalisées",
                        for l in lessons.iter() {
                            {
                                let id = l.id.clone();
                                let open = expanded() == Some(l.id.clone());
                                rsx! {
                                    article { key: "{l.id}", class: "lexora-card lexora-lesson",
                                        button { r#type: "button", class: "lexora-lesson-toggle", aria_expanded: "{open}",
                                            onclick: { let id = id.clone(); move |_| expanded.set(if open { None } else { Some(id.clone()) }) },
                                            span { span { class: "lexora-partno", "Partie {l.part} · {l.topic}" } strong { "{l.title}" } }
                                            span { aria_hidden: "true", if open { "−" } else { "+" } }
                                        }
                                        if open {
                                            if l.status == "ready" {
                                                div { class: "lexora-lesson-content",
                                                    h3 { "La règle à retenir" } p { "{l.rule}" }
                                                    h3 { "Exemple expliqué" } p { "{l.example}" }
                                                    h3 { "À vous de jouer" } p { "{l.exercise}" }
                                                    details { summary { "Voir la correction" } p { "{l.answer}" } }
                                                    h3 { "Astuce du coach" } p { "{l.tip}" }
                                                    a { class: "lexora-secondary", href: "#/review/part{l.part}", "Réviser mes erreurs →" }
                                                }
                                            } else {
                                                p { class: "lexora-muted", if l.status == "pending" { "Génération en cours : revenez ici après l'explication du coach." } else { "Le coach n’a pas pu générer cette leçon. Vérifiez la connexion au serveur ou la clé DeepSeek puis reprenez cette question en révision." } }
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
}
