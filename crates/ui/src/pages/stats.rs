//! Statistiques. Port de `Stats.tsx`.

use crate::bank::category_label;
use crate::bridge;
use crate::components::*;
use crate::state::use_ctx;
use dioxus::prelude::*;
use lernoviq_core::srs::{box_counts, INTERVAL_DAYS};
use lernoviq_core::stats::{compute_stats, current_streak, Rate};

fn tone(rate: Option<u32>) -> &'static str {
    match rate {
        None => "",
        Some(p) if p >= 75 => "high",
        Some(p) if p >= 50 => "mid",
        Some(_) => "low",
    }
}

#[component]
pub fn RateRow(label: String, rate: Rate) -> Element {
    let aria = rate.rate.map_or("Aucune donnée".to_string(), |r| {
        format!("{r} % de réussite")
    });
    let width = rate.rate.unwrap_or(0);
    let shown = rate.rate.map_or("—".to_string(), |r| format!("{r} %"));
    rsx! {
        div { class: "lexora-row",
            span { "{label}" }
            div { class: "lexora-bar", "data-tone": "{tone(rate.rate)}", role: "img", aria_label: "{aria}", div { style: "width: {width}%" } }
            span { "{shown} " span { class: "lexora-subtle", "({rate.correct}/{rate.total})" } }
        }
    }
}

#[component]
fn ProgressChart(points: Vec<(String, u32, u32)>) -> Element {
    if points.len() < 2 {
        return rsx! { p { class: "lexora-muted", "La courbe apparaîtra dès que vous aurez des réponses sur au moins deux jours différents." } };
    }
    let (w, h, pad) = (640.0, 220.0, 34.0);
    let n = points.len();
    let x = |i: usize| pad + (i as f64 * (w - pad * 2.0)) / (n - 1) as f64;
    let y = |pct: f64| h - pad - (pct / 100.0) * (h - pad * 2.0);
    let path: String = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            format!(
                "{}{:.1},{:.1}",
                if i > 0 { "L" } else { "M" },
                x(i),
                y(f64::from(p.1))
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let label = points
        .iter()
        .map(|p| format!("{} {} %", p.0, p.1))
        .collect::<Vec<_>>()
        .join(", ");
    let first = points[0].0.clone();
    let last = points[n - 1].0.clone();
    rsx! {
        svg { class: "lexora-chart", view_box: "0 0 {w} {h}", role: "img", "aria-label": "Courbe de progression : {label}",
            for g in [0.0f64, 50.0, 100.0] {
                g { key: "{g}",
                    line { x1: "{pad}", x2: "{w - pad}", y1: "{y(g)}", y2: "{y(g)}", stroke: "#e5eaf1" }
                    text { x: "{pad - 6.0}", y: "{y(g) + 4.0}", text_anchor: "end", font_size: "11", fill: "#566377", "{g} %" }
                }
            }
            path { d: "{path}", fill: "none", stroke: "#27456c", stroke_width: "2.5", stroke_linejoin: "round" }
            for (i, p) in points.iter().enumerate() {
                circle { key: "{p.0}", cx: "{x(i)}", cy: "{y(f64::from(p.1))}", r: "4", fill: "#27456c", title { "{p.0} : {p.1} % ({p.2} réponses)" } }
            }
            text { x: "{pad}", y: "{h - 8.0}", font_size: "11", fill: "#566377", "{first}" }
            text { x: "{w - pad}", y: "{h - 8.0}", text_anchor: "end", font_size: "11", fill: "#566377", "{last}" }
        }
    }
}

#[component]
pub fn Stats() -> Element {
    let ctx = use_ctx();
    let data = ctx.data.read();
    let tz = bridge::local_tz();
    let stats = compute_stats(&data.attempts, 30, &tz);
    let streak = current_streak(&data.attempts, bridge::now(), &tz);
    let (boxes, mastered) = box_counts(&data.cards);
    let seconds = stats
        .avg_time_ms
        .map(|ms| (ms as f64 / 1000.0).round() as i64);
    let none = data.attempts.is_empty();
    let overall_rate = stats.overall.rate.unwrap_or(0);
    let secs = seconds.map_or("—".to_string(), |s| format!("{s} s"));
    let points: Vec<(String, u32, u32)> = stats
        .progression
        .iter()
        .map(|p| (p.day.to_string(), p.rate.rate.unwrap_or(0), p.rate.total))
        .collect();
    rsx! {
        Page {
            main { class: "lexora-shell lexora-content",
                p { class: "lexora-eyebrow", "Mon suivi" }
                h1 { class: "lexora-heading", "Mes statistiques" }
                p { class: "lexora-muted", "Vos résultats sont enregistrés sur cet appareil (base locale SQLite dans l'application de bureau)." }
                if none {
                    section { class: "lexora-hero", style: "margin-top: 28px;",
                        div { h2 { "Pas encore de données" } p { class: "lexora-muted", "Chaque réponse donnée en entraînement, en révision ou en examen blanc alimente ces statistiques." } }
                        a { class: "lexora-primary", href: "#/practice/part5", "Commencer un exercice →" }
                    }
                } else {
                    section { class: "lexora-stats", style: "grid-template-columns: repeat(4,minmax(0,1fr));", aria_label: "Chiffres clés",
                        div { class: "lexora-card", p { class: "lexora-statlabel", "Réponses" } p { class: "lexora-statvalue", "{stats.overall.total}" } }
                        div { class: "lexora-card", p { class: "lexora-statlabel", "Taux de réussite" } p { class: "lexora-statvalue", "{overall_rate} %" } }
                        div { class: "lexora-card", p { class: "lexora-statlabel", "Temps moyen / question" } p { class: "lexora-statvalue", "{secs}" } }
                        div { class: "lexora-card", p { class: "lexora-statlabel", "Série en cours" } p { class: "lexora-statvalue", "{streak} j" } }
                    }
                    section { class: "lexora-card", style: "margin-bottom: 18px;",
                        h2 { style: "font-size: 19px;", "Réussite par partie" }
                        div { class: "lexora-rows",
                            for p in [2u8, 5, 6, 7] {
                                if let Some(rate) = stats.by_part.get(&p) {
                                    RateRow { key: "{p}", label: if p == 2 { "Listening · Partie 2".to_string() } else { format!("Partie {p} · {}", crate::parts::info(p).name) }, rate: rate.clone() }
                                }
                            }
                        }
                    }
                    section { class: "lexora-card", style: "margin-bottom: 18px;",
                        h2 { style: "font-size: 19px;", "Réussite par type de piège" }
                        p { class: "lexora-muted", "Du point le plus fragile au plus solide : commencez par le haut de la liste." }
                        if stats.by_category.is_empty() {
                            p { class: "lexora-subtle", "Les catégories apparaîtront avec vos prochaines réponses." }
                        } else {
                            div { class: "lexora-rows",
                                for c in stats.by_category.iter() { RateRow { key: "{c.category}", label: category_label(&c.category), rate: c.rate.clone() } }
                            }
                        }
                    }
                    section { class: "lexora-card", style: "margin-bottom: 18px;",
                        h2 { style: "font-size: 19px;", "Progression (taux de réussite par jour)" }
                        ProgressChart { points: points.clone() }
                        details { style: "margin-top: 10px;",
                            summary { "Voir les valeurs" }
                            ul { for p in stats.progression.iter() { li { key: "{p.day}", "{p.day} : {p.rate.rate.unwrap_or(0)} % ({p.rate.correct}/{p.rate.total})" } } }
                        }
                    }
                }
                section { class: "lexora-card",
                    h2 { style: "font-size: 19px;", "Mes révisions espacées" }
                    div { class: "lexora-boxes", role: "list",
                        for (i, n) in boxes.iter().enumerate() {
                            div { key: "{i}", role: "listitem", strong { "{n}" } span { "Boîte {i + 1}" br {} "revue tous les {INTERVAL_DAYS[i]} j" } }
                        }
                        div { role: "listitem", strong { "{mastered}" } span { "Maîtrisées" } }
                    }
                    a { class: "lexora-secondary", href: "#/review", "À réviser aujourd'hui →" }
                }
            }
        }
    }
}
