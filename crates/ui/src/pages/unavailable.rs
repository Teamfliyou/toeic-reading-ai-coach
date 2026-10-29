//! Écrans pas encore portés. Ils l'annoncent clairement plutôt que de simuler la fonctionnalité.

use crate::components::*;
use dioxus::prelude::*;

#[component]
pub fn Unavailable(title: &'static str, reason: &'static str) -> Element {
    rsx! {
        Page {
            main { class: "lexora-shell lexora-content",
                p { class: "lexora-eyebrow", "Pas encore disponible" }
                h1 { class: "lexora-heading", "{title}" }
                section { class: "lexora-card", role: "status",
                    p { class: "lexora-muted", "{reason}" }
                    a { class: "lexora-secondary", href: "#/", "Retour au tableau de bord" }
                }
            }
        }
    }
}
