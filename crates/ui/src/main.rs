//! Interface Lernoviq en Rust (Dioxus/WASM). La logique métier vient de `lernoviq-core`.

mod ai;
mod bank;
mod bridge;
mod components;
mod pages;
mod parts;
mod route;
mod state;

use components::{OfflineBanner, SettingsModal};
use dioxus::prelude::*;
use pages::unavailable::Unavailable;
use route::Route;

const APP_CSS: Asset = asset!("/assets/app.css");
const ADMIN_CSS: Asset = asset!("/assets/admin.css");

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    let _ctx = state::provide_state();
    let mut route = use_signal(|| route::parse(&bridge::hash()));

    // Changement de page : écoute de `hashchange`.
    use_hook(move || {
        use wasm_bindgen::prelude::*;
        let handler = Closure::<dyn FnMut()>::new(move || route.set(route::parse(&bridge::hash())));
        if let Some(w) = web_sys::window() {
            let _ =
                w.add_event_listener_with_callback("hashchange", handler.as_ref().unchecked_ref());
        }
        handler.forget();
    });

    use_effect(move || {
        let title = route::title(&route.read());
        bridge::set_title(&if title.is_empty() {
            "Lernoviq — Coach TOEIC".to_string()
        } else {
            format!("{title} — Lernoviq")
        });
    });

    let content = match route() {
        Route::Dashboard => rsx! { pages::dashboard::Dashboard {} },
        Route::Practice { part, search } => {
            rsx! { pages::practice::PracticePage { key: "{part}{search}", part, search } }
        }
        Route::Review => rsx! { pages::review::Review {} },
        Route::ReviewPart(part) => {
            rsx! { pages::practice::PracticePage { key: "review{part}", part, review_mode: true } }
        }
        Route::Adaptive => rsx! { pages::adaptive::Adaptive {} },
        Route::Exam => rsx! { pages::exam::Exam {} },
        Route::Stats => rsx! { pages::stats::Stats {} },
        Route::Vocab => rsx! { pages::vocab::Vocab {} },
        Route::Goals => rsx! { pages::goals::GoalsPage {} },
        Route::Lessons => rsx! { pages::lessons::Lessons {} },
        Route::Diagnostic => rsx! { pages::diagnostic::Diagnostic {} },
        Route::Listening => rsx! {
            Unavailable { title: "Listening · Partie 2", reason: "Les enregistrements audio proviennent de la banque en ligne, pas encore branchée à la version Rust de Lernoviq." }
        },
        Route::Admin => rsx! {
            Unavailable { title: "Administration", reason: "L'espace d'administration (banque, import, génération, utilisateurs) repose sur des routes serveur protégées qui ne sont pas encore portées en Rust. Il reste accessible dans l'ancienne version web." }
        },
    };

    rsx! {
        document::Stylesheet { href: APP_CSS }
        document::Stylesheet { href: ADMIN_CSS }
        a { href: "#contenu", class: "lexora-skip", "Aller au contenu" }
        {content}
        OfflineBanner {}
        SettingsModal {}
    }
}
