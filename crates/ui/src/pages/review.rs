//! Révision espacée. Port de `Review.tsx`.

use crate::bank;
use crate::bridge;
use crate::components::*;
use crate::pages::fr_date;
use crate::state::use_ctx;
use dioxus::prelude::*;
use lernoviq_core::srs::{due_cards, INTERVAL_DAYS};
use lernoviq_models::{AttemptMode, Question};
use std::collections::HashSet;

#[component]
pub fn Review() -> Element {
    let mut ctx = use_ctx();
    // File figée au début de la séance : répondre ne la fait pas bouger sous les pieds.
    let queue: Vec<String> = use_hook(|| {
        due_cards(&ctx.data.peek().cards, bridge::now())
            .into_iter()
            .map(|c| c.question_id)
            .collect()
    });
    let set: HashSet<String> = queue.iter().cloned().collect();
    let series = bank::load_by_ids(&set);
    let questions: Vec<Question> = queue
        .iter()
        .filter_map(|id| series.questions.iter().find(|q| &q.id == id).cloned())
        .collect();

    let mut index = use_signal(|| 0usize);
    let mut selected = use_signal(|| Option::<char>::None);
    let mut checked = use_signal(|| false);
    let mut correct_count = use_signal(|| 0usize);
    let mut shown_at = use_signal(bridge::perf_now);
    let total = questions.len();

    let next_due = {
        let now = bridge::now();
        ctx.data
            .read()
            .cards
            .iter()
            .filter(|c| !c.mastered && c.due > now)
            .map(|c| c.due)
            .min()
    };
    let done = index() >= total;
    let question = questions.get(index()).cloned();
    let interval = INTERVAL_DAYS[1];
    let width = (index() * 100).checked_div(total).unwrap_or(0);

    rsx! {
        Page { class: "lexora-page lexora-exercises",
            main { class: "lexora-shell lexora-content",
                p { class: "lexora-eyebrow", "Répétition espacée" }
                h1 { class: "lexora-heading", "À réviser aujourd'hui" }
                if total == 0 {
                    section { class: "lexora-hero",
                        div {
                            h2 { "Rien à réviser pour le moment" }
                            p { class: "lexora-muted",
                                if let Some(d) = next_due { "Prochaine révision le {fr_date(d.with_timezone(&bridge::local_tz()).date_naive())}." } else { "Les questions que vous ratez reviennent ici automatiquement, à intervalles croissants." }
                            }
                        }
                        a { class: "lexora-primary", href: "#/practice/part5", "S'entraîner →" }
                    }
                } else if done {
                    section { class: "lexora-card", aria_live: "polite",
                        p { class: "lexora-scorebig", "{correct_count}/{total}" }
                        p { class: "lexora-muted", style: "margin-top: 12px;", "Les bonnes réponses montent d'une boîte (prochain rappel dans {interval} jours ou plus) ; les erreurs repartent en boîte 1 pour être revues bientôt." }
                        div { class: "lexora-actions", a { class: "lexora-secondary", href: "#/", "Tableau de bord" } a { class: "lexora-primary", href: "#/stats", "Voir mes statistiques →" } }
                    }
                } else if let Some(q) = question {
                    div { class: "lexora-progressline", role: "progressbar", aria_valuemin: "0", aria_valuemax: "{total}", aria_valuenow: "{index()}", aria_label: "Progression de la révision", div { style: "width: {width}%" } }
                    QuestionView {
                        question: q.clone(), passage: bank::passage_of(&q).cloned(), number: index() + 1, selected: selected(), reveal: checked(), disabled: checked(),
                        on_select: move |k| selected.set(Some(k)),
                    }
                    if checked() { ReportButton { key: "{q.id}", question_id: q.id.clone(), part: q.part } }
                    div { class: "lexora-actions", style: "margin-top: 16px;", role: "status", aria_live: "polite",
                        a { class: "lexora-secondary", href: "#/", "Quitter" }
                        if checked() {
                            strong { if selected() == Some(bank::key_char(q.correct_key)) { "Bonne réponse !" } else { "Pas tout à fait : la bonne réponse est signalée en vert." } }
                            button { r#type: "button", class: "lexora-primary",
                                onclick: move |_| { index += 1; selected.set(None); checked.set(false); shown_at.set(bridge::perf_now()); },
                                if index() + 1 == total { "Terminer" } else { "Suivante" } " →"
                            }
                        } else {
                            button { r#type: "button", class: "lexora-primary", disabled: selected().is_none(),
                                onclick: {
                                    let q = q.clone();
                                    move |_| {
                                        let Some(key) = selected() else { return };
                                        let ok = key == bank::key_char(q.correct_key);
                                        ctx.data.write().record_answer(&q, key, bridge::perf_now() - shown_at(), AttemptMode::Review, true);
                                        if ok { correct_count += 1; }
                                        checked.set(true);
                                    }
                                },
                                "Valider ma réponse"
                            }
                        }
                    }
                }
            }
        }
    }
}
