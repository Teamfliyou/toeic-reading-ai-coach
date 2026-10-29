//! Interface Lernoviq en Rust (Dioxus/WASM). La logique métier vient de `lernoviq-core`.

use dioxus::prelude::*;
use lernoviq_core::exam::estimate_reading_score;

const STYLE: Asset = asset!("/assets/main.css");

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    let mut correct = use_signal(|| 60u32);
    let score = estimate_reading_score(correct(), 100);
    rsx! {
        document::Stylesheet { href: STYLE }
        main { class: "glass",
            h1 { "Lernoviq — Coach TOEIC" }
            p { "Score Reading estimé (indicatif) pour un examen de 100 questions." }
            label { r#for: "correct", "Bonnes réponses : {correct}" }
            input {
                id: "correct",
                r#type: "range",
                min: "0",
                max: "100",
                value: "{correct}",
                oninput: move |e| correct.set(e.value().parse().unwrap_or(0)),
            }
            p { class: "score", "{score} / 495" }
        }
    }
}
