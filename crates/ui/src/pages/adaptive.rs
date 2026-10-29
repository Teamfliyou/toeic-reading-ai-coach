//! Entraînement adaptatif. Port de `Adaptive.tsx`.

use crate::bank::{categories, category_label};
use crate::bridge;
use crate::components::*;
use crate::state::use_ctx;
use dioxus::prelude::*;
use lernoviq_core::adaptive::{build_adaptive_plan, PlanInput, RecommendationKind};
use lernoviq_core::goals::{answered_today, latest_exam_score};
use lernoviq_core::srs::due_cards;
use std::collections::HashMap;

fn kind_label(k: RecommendationKind) -> &'static str {
    match k {
        RecommendationKind::Review => "Révision espacée",
        RecommendationKind::Targeted => "Exercice ciblé",
        RecommendationKind::Mixed => "Séance mixte",
        RecommendationKind::Unseen => "Jamais vues",
        RecommendationKind::Progressive => "Difficulté progressive",
        RecommendationKind::Exam => "Examen blanc",
    }
}

#[component]
pub fn Adaptive() -> Element {
    let ctx = use_ctx();
    let data = ctx.data.read();
    let goals = data.goals();
    let labels: HashMap<String, String> = categories()
        .iter()
        .map(|c| (c.id.clone(), c.label.clone()))
        .collect();
    let now = bridge::now();
    let plan = build_adaptive_plan(&PlanInput {
        attempts: &data.attempts,
        due_count: due_cards(&data.cards, now).len(),
        goals: Some(&goals),
        last_exam_score: latest_exam_score(&data.exams),
        now,
        labels: Some(&labels),
    });
    let today = answered_today(&data.attempts, bridge::today(), &bridge::local_tz());
    let daily = goals.daily_goal.max(1) as usize;
    let daily_pct = (today * 100 / daily).min(100);
    rsx! {
        Page { class: "lexora-page lexora-exercises",
            main { class: "lexora-shell lexora-content", style: "max-width: 900px;",
                p { class: "lexora-eyebrow", "Entraînement adaptatif" }
                h1 { class: "lexora-heading", "Votre séance du jour." }
                p { class: "lexora-muted", "{plan.summary}" }
                section { class: "lexora-card", style: "margin: 22px 0;", aria_label: "Objectif du jour",
                    p { class: "lexora-statlabel", "Objectif du jour" }
                    p { class: "lexora-statvalue", "{today} / {goals.daily_goal} questions" }
                    div { class: "lexora-bar", role: "img", aria_label: "{daily_pct} % de l'objectif du jour", div { style: "width: {daily_pct}%" } }
                }
                h2 { style: "font-size: 20px;", "Recommandé pour vous" }
                div { class: "lexora-stack", style: "margin: 14px 0 30px;",
                    for (i, r) in plan.recommendations.iter().enumerate() {
                        a { key: "{i}", href: "{r.href}", class: "lexora-card lexora-part", style: "padding: 20px;",
                            span { class: "lexora-pill", style: "align-self: flex-start;", "{kind_label(r.kind)}" }
                            h3 { style: "margin: 10px 0 6px; font-size: 18px;", "{r.title}" }
                            p { class: "lexora-muted", style: "margin: 0; font-size: 14px;", "{r.reason}" }
                            div { class: "lexora-arrow", style: "margin-top: 12px;", "Commencer " span { aria_hidden: "true", "↗" } }
                        }
                    }
                }
                h2 { style: "font-size: 20px;", "Vos compétences" }
                if plan.skills.is_empty() {
                    p { class: "lexora-muted", "Vos compétences apparaîtront après quelques réponses." }
                } else {
                    div { class: "lexora-card", style: "margin-top: 12px;",
                        div { class: "lexora-rows",
                            for s in plan.skills.iter().take(12) {
                                {
                                    let pct = (s.accuracy * 100.0).round() as u32;
                                    let tone = if pct >= 75 { "high" } else if pct >= 50 { "mid" } else { "low" };
                                    let time = s.avg_time_ms.map(|t| format!(" · {} s", (t as f64 / 1000.0).round())).unwrap_or_default();
                                    let trend = s.trend.map_or("", |t| if t > 0.1 { " ↗" } else if t < -0.1 { " ↘" } else { " →" });
                                    rsx! {
                                        div { key: "{s.part}-{s.category}", class: "lexora-row", style: "grid-template-columns: 1fr 160px 150px;",
                                            span { "{category_label(&s.category)} " span { class: "lexora-subtle", "· partie {s.part}" } }
                                            div { class: "lexora-bar", "data-tone": "{tone}", role: "img", aria_label: "{pct} % de réussite", div { style: "width: {pct}%" } }
                                            span { class: "lexora-subtle", "{pct} % · {s.attempts} rép.{time}{trend}" }
                                        }
                                    }
                                }
                            }
                        }
                        p { class: "lexora-disclaimer", "La précision est pondérée par l'ancienneté des réponses (demi-vie de 14 jours) et prudente sur les petits échantillons. Les recommandations sont des suggestions : vous restez libre de votre parcours." }
                    }
                }
                div { class: "lexora-actions", style: "margin-top: 26px;",
                    a { class: "lexora-secondary", href: "#/", "Tableau de bord" }
                    a { class: "lexora-secondary", href: "#/stats", "Mes statistiques" }
                }
            }
        }
    }
}
