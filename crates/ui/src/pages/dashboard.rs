//! Tableau de bord. Port de `Dashboard.tsx` et `GoalSummary.tsx`.

use crate::bridge;
use crate::components::*;
use crate::parts::PARTS;
use crate::state::use_ctx;
use dioxus::prelude::*;
use lernoviq_core::goals::{answered_today, days_until, latest_exam_score};
use lernoviq_core::srs::due_cards;
use lernoviq_core::stats::current_streak;

#[component]
pub fn GoalSummary() -> Element {
    let ctx = use_ctx();
    let data = ctx.data.read();
    let goals = data.goals();
    let tz = bridge::local_tz();
    let today = answered_today(&data.attempts, bridge::today(), &tz);
    let streak = current_streak(&data.attempts, bridge::now(), &tz);
    let days_left = days_until(goals.exam_date, bridge::today());
    let last = latest_exam_score(&data.exams);
    let daily = goals.daily_goal.max(1) as usize;
    let pct = (today * 100 / daily).min(100);
    let reached = today >= daily;
    let never_set = goals.updated_at.timestamp() == 0;
    let title = match days_left {
        None => "Fixez votre date d'examen".to_string(),
        Some(0) => "C'est aujourd'hui !".to_string(),
        Some(d) if d < 0 => "Examen passé".to_string(),
        Some(d) => format!("J-{d} avant l'examen"),
    };
    let score = goals
        .target_score
        .map_or("Aucun score visé".to_string(), |s| {
            format!("Score visé : {s}/495")
        });
    let last_text = last
        .map(|l| format!(" · dernier examen blanc estimé : {l}"))
        .unwrap_or_default();
    let plural = if streak > 1 { "s" } else { "" };
    rsx! {
        section { class: "lexora-card", aria_label: "Mon objectif", style: "margin-top: 22px;",
            div { class: "lexora-actions", style: "align-items: flex-start;",
                div {
                    p { class: "lexora-eyebrow", "Mon objectif" }
                    h2 { style: "font-size: 20px; margin: 0 0 6px;", "{title}" }
                    p { class: "lexora-muted", style: "margin: 0;", "{score}{last_text}" }
                }
                a { class: "lexora-secondary", href: "#/goals", if never_set { "Définir mon objectif" } else { "Modifier" } }
            }
            div { style: "margin-top: 16px;",
                div { class: "lexora-actions",
                    span { if reached { "Objectif du jour atteint ✓" } else { "Aujourd'hui" } }
                    strong { "{today} / {daily} questions" }
                }
                div { class: "lexora-progressline", role: "progressbar", aria_valuemin: "0", aria_valuemax: "{daily}", aria_valuenow: "{today.min(daily)}", aria_label: "Objectif quotidien", style: "margin: 8px 0;",
                    div { style: "width: {pct}%" }
                }
                span { class: "lexora-subtle", "Série : {streak} jour{plural} consécutif{plural}" }
            }
        }
    }
}

#[component]
pub fn Dashboard() -> Element {
    let ctx = use_ctx();
    let data = ctx.data.read();
    let has_key = ctx.settings.read().api_key.is_some();
    let attempted: u32 = data.sessions.iter().map(|s| s.total).sum();
    let correct: u32 = data.sessions.iter().map(|s| s.correct).sum();
    let average =
        (attempted > 0).then(|| (f64::from(correct) / f64::from(attempted) * 100.0).round() as u32);
    let diag = data.diagnostic.clone();
    let due = due_cards(&data.cards, bridge::now()).len();
    let open_cards: Vec<_> = data.cards.iter().filter(|c| !c.mastered).collect();
    let lesson_count = data.lessons.iter().filter(|l| l.status == "ready").count();
    let sessions = data.sessions.len();
    let avg_text = average.map_or("—".to_string(), |a| format!("{a} %"));
    let avg_sub = if attempted > 0 {
        format!("{correct} réponses correctes sur {attempted}")
    } else {
        "À découvrir après votre séance".into()
    };
    let diag_text = diag.as_ref().map_or("—".to_string(), |d| {
        format!(
            "{} %",
            (f64::from(d.correct) / f64::from(d.total.max(1)) * 100.0).round()
        )
    });
    let diag_sub = diag.as_ref().map_or("Pas encore réalisé".to_string(), |d| {
        format!("{} bonnes réponses sur {}", d.correct, d.total)
    });
    let has_diag = diag.is_some();
    let n_cards = open_cards.len();
    rsx! {
        Page { full: true,
            main { class: "lexora-shell lexora-content",
                p { class: "lexora-eyebrow", "Mon espace d'apprentissage" }
                h1 { class: "lexora-heading", "Votre anglais, à votre rythme." }
                p { class: "lexora-muted", "Un espace clair pour vous entraîner, comprendre vos erreurs et mesurer vos progrès." }
                section { class: "lexora-stats", aria_label: "Votre progression",
                    div { class: "lexora-card", p { class: "lexora-statlabel", "Sessions terminées" } p { class: "lexora-statvalue", "{sessions}" } span { class: "lexora-subtle", "Entraînements réalisés" } }
                    div { class: "lexora-card", p { class: "lexora-statlabel", "Taux de réussite" } p { class: "lexora-statvalue", "{avg_text}" } span { class: "lexora-subtle", "{avg_sub}" } }
                    div { class: "lexora-card", p { class: "lexora-statlabel", "Diagnostic initial" } p { class: "lexora-statvalue", "{diag_text}" } span { class: "lexora-subtle", "{diag_sub}" } }
                }
                GoalSummary {}
                section { class: "lexora-hero", style: "margin-top: 22px;",
                    div {
                        p { class: "lexora-eyebrow", "Votre prochaine étape" }
                        h2 { if has_diag { "Continuez à progresser" } else { "Découvrez vos points forts" } }
                        p { class: "lexora-muted", if has_diag { "Entraînez-vous sur les questions de grammaire, les textes à trous et la compréhension écrite." } else { "Commencez par un diagnostic de 15 questions maximum pour faire un premier point sur votre grammaire et votre vocabulaire." } }
                    }
                    a { class: "lexora-primary", href: if has_diag { "#/practice/part5" } else { "#/diagnostic" }, if has_diag { "Reprendre une séance" } else { "Commencer le diagnostic" } " " span { aria_hidden: "true", "→" } }
                }
                section { class: "lexora-hero lexora-lesson-hero",
                    div { p { class: "lexora-eyebrow", "Votre coach personnel" } h2 { "Mes leçons personnalisées" } p { class: "lexora-muted", "Chaque mauvaise réponse est analysée par thème pour vous expliquer la règle et proposer un exercice ciblé. {lesson_count} leçon(s) disponible(s)." } }
                    a { class: "lexora-primary", href: "#/lessons", "Voir mes leçons →" }
                }
                section { class: "lexora-hero lexora-lesson-hero",
                    div { p { class: "lexora-eyebrow", "Sur mesure" } h2 { "Entraînement adaptatif" } p { class: "lexora-muted", "Des séances ciblées sur vos points faibles, des questions jamais vues et une difficulté qui progresse avec vous." } }
                    a { class: "lexora-primary", href: "#/adaptive", "Voir ma séance →" }
                }
                section { class: "lexora-hero lexora-lesson-hero",
                    div { p { class: "lexora-eyebrow", "Conditions réelles" } h2 { "Examen blanc Reading" } p { class: "lexora-muted", "100 questions (30 + 16 + 54) en 75 minutes, avec navigation libre, marquage « à revoir » et score estimé sur 495. Un examen réduit est signalé comme tel." } }
                    a { class: "lexora-primary", href: "#/exam", "Passer l'examen →" }
                }
                section { class: "lexora-hero", style: "margin-top: 22px;",
                    div { p { class: "lexora-eyebrow", "Répétition espacée" } h2 { "À réviser aujourd'hui" }
                        p { class: "lexora-muted", if due > 0 { "{due} question(s) à revoir maintenant, selon un rythme qui s'espace à chaque réussite." } else { "Aucune révision en attente. Vos erreurs reviennent ici automatiquement au bon moment." } } }
                    a { class: "lexora-primary", href: "#/review", if due > 0 { "Commencer la révision →" } else { "Voir mes révisions →" } }
                }
                section { class: "lexora-hero lexora-lesson-hero", style: "margin-top: 22px;",
                    div { p { class: "lexora-eyebrow", "Nouveau · Listening" } h2 { "Partie 2 · Question-réponse" } p { class: "lexora-muted", "Écoutez une question, choisissez la meilleure réponse parmi trois. Un seul jeu de lecture, transcription après chaque réponse." } }
                    a { class: "lexora-primary", href: "#/listening/part2", "S'entraîner à l'oral →" }
                }
                div { class: "lexora-sectionhead", h2 { "Choisir un entraînement" } span { class: "lexora-subtle", "Compréhension écrite" } }
                section { class: "lexora-grid", aria_label: "Exercices disponibles",
                    for p in PARTS.iter() {
                        a { key: "{p.part}", href: "#/practice/{p.slug}", class: "lexora-card lexora-part",
                            span { class: "lexora-partno", "Partie {p.part}" }
                            h3 { "{p.name}" }
                            p { class: "lexora-muted", "{p.description}" }
                            div { class: "lexora-arrow", "S'entraîner " span { aria_hidden: "true", "↗" } }
                        }
                    }
                }
                section { class: "lexora-card lexora-review",
                    h2 { "Réviser mes erreurs" }
                    p { class: "lexora-muted", if n_cards > 0 { "{n_cards} question(s) en cours de révision." } else { "Vos erreurs seront enregistrées au fil de vos séances, pour faciliter vos révisions." } }
                    div { class: "lexora-reviewlinks",
                        for part in [5u8, 6, 7] {
                            {
                                let count = open_cards.iter().filter(|c| c.part == part).count();
                                rsx! { if count > 0 { a { key: "{part}", href: "#/review/part{part}", class: "lexora-secondary", "Partie {part} · {count} →" } } }
                            }
                        }
                    }
                }
                if !has_key && !crate::bridge::in_tauri() {
                    div { class: "lexora-notice", role: "status", "Les explications personnalisées nécessitent l'application de bureau ou une clé DeepSeek dans les paramètres. Les exercices restent accessibles." }
                }
                footer { class: "lexora-subtle", style: "margin-top: 42px;", "Lernoviq · Préparation indépendante à l'anglais professionnel. Nom de marque provisoire." }
            }
        }
    }
}
