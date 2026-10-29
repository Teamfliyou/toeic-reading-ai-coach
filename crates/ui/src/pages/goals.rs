//! Objectif et plan d'étude. Port de `Goals.tsx`.

use crate::bank::category_label;
use crate::bridge;
use crate::components::*;
use crate::pages::dashboard::GoalSummary;
use crate::state::use_ctx;
use dioxus::prelude::*;
use lernoviq_core::goals::{build_plan, latest_exam_score, validate_goals, Goals, GoalsInput};
use lernoviq_core::stats::compute_stats;

#[component]
pub fn GoalsPage() -> Element {
    let mut ctx = use_ctx();
    let saved = ctx.data.read().goals();
    let mut exam_date = use_signal(|| saved.exam_date.map(|d| d.to_string()).unwrap_or_default());
    let mut target = use_signal(|| {
        saved
            .target_score
            .map(|t| t.to_string())
            .unwrap_or_default()
    });
    let mut daily = use_signal(|| saved.daily_goal.to_string());
    let mut error = use_signal(|| Option::<String>::None);
    let mut notice = use_signal(|| false);

    let data = ctx.data.read();
    let goals = data.goals();
    let weak: Vec<String> = compute_stats(&data.attempts, 30, &bridge::local_tz())
        .by_category
        .into_iter()
        .filter(|c| c.rate.total >= 3 && c.rate.rate.unwrap_or(100) < 80)
        .map(|c| c.category)
        .collect();
    let plan = build_plan(
        &goals,
        latest_exam_score(&data.exams),
        &weak,
        bridge::today(),
    );
    drop(data);

    rsx! {
        Page {
            main { class: "lexora-shell lexora-content", style: "max-width: 820px;",
                p { class: "lexora-eyebrow", "Mon plan d'étude" }
                h1 { class: "lexora-heading", "Mon objectif" }
                p { class: "lexora-muted", "Fixez votre date d'examen, le score que vous visez et un nombre de questions par jour : le tableau de bord suit votre avancement et votre série." }
                form {
                    class: "lexora-card", style: "display: grid; gap: 14px; margin: 24px 0;", novalidate: true,
                    onsubmit: move |evt| {
                        evt.prevent_default();
                        let num = |s: String| { let t = s.trim().to_string(); if t.is_empty() { None } else { Some(t.parse::<f64>().unwrap_or(f64::NAN)) } };
                        let input = GoalsInput {
                            exam_date: Some(exam_date()).filter(|d| !d.is_empty()),
                            target_score: num(target()),
                            daily_goal: num(daily()),
                        };
                        match validate_goals(&input, bridge::today()) {
                            Ok(v) => {
                                ctx.data.write().goals = Some(Goals { exam_date: v.exam_date, target_score: v.target_score, daily_goal: v.daily_goal, updated_at: bridge::now() });
                                error.set(None);
                                notice.set(true);
                            }
                            Err(e) => { error.set(Some(e)); notice.set(false); }
                        }
                    },
                    label { "Date de l'examen" input { class: "lexora-admin-input", r#type: "date", value: "{exam_date}", oninput: move |e| exam_date.set(e.value()) } }
                    label { "Score Reading visé (5 à 495)" input { class: "lexora-admin-input", r#type: "number", min: "5", max: "495", step: "5", value: "{target}", placeholder: "Ex : 400", oninput: move |e| target.set(e.value()) } }
                    label { "Objectif quotidien (questions par jour)" input { class: "lexora-admin-input", r#type: "number", min: "1", max: "200", value: "{daily}", oninput: move |e| daily.set(e.value()) } }
                    if let Some(e) = error() { p { role: "alert", class: "lexora-notice", style: "margin: 0;", "{e}" } }
                    if notice() { p { role: "status", class: "lexora-subtle", style: "margin: 0;", "Objectifs enregistrés ✓" } }
                    div { class: "lexora-actions", span {} button { r#type: "submit", class: "lexora-primary", "Enregistrer" } }
                }
                GoalSummary {}
                section { class: "lexora-card", style: "margin-top: 22px;", aria_label: "Plan d'étude",
                    h2 { style: "font-size: 19px;", "Plan d'étude" }
                    p { "{plan.summary}" }
                    if !plan.focus.is_empty() {
                        p { class: "lexora-muted", style: "margin-bottom: 6px;", "Pièges à travailler en priorité :" }
                        ul { for c in plan.focus.iter() { li { key: "{c}", "{category_label(c)}" } } }
                    }
                    p { class: "lexora-disclaimer", "Plan indicatif : il suppose environ deux questions travaillées par point de score à gagner. Il ne garantit aucun résultat à l'examen." }
                    div { style: "display: flex; gap: 10px; flex-wrap: wrap;",
                        a { class: "lexora-secondary", href: "#/exam", "Examen blanc" }
                        a { class: "lexora-secondary", href: "#/review", "À réviser aujourd'hui" }
                    }
                }
            }
        }
    }
}
