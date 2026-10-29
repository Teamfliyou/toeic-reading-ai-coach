//! Pont avec le navigateur et Tauri : horloge, hasard, stockage, appels natifs et HTTP.
//! Le JavaScript se limite à `invoke` de Tauri (déclaré en ligne, requis par la WebView).

use chrono::{DateTime, FixedOffset, Utc};
use serde::de::DeserializeOwned;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
export function tauri_present() { return !!(window.__TAURI__ && window.__TAURI__.core); }
export function tauri_invoke(cmd, args) { return window.__TAURI__.core.invoke(cmd, args); }
export function random_uuid() { return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now(); }
export function is_online() { return navigator.onLine !== false; }
"#)]
extern "C" {
    fn tauri_present() -> bool;
    #[wasm_bindgen(catch)]
    async fn tauri_invoke(cmd: &str, args: JsValue) -> Result<JsValue, JsValue>;
    fn random_uuid() -> String;
    fn is_online() -> bool;
}

pub fn online() -> bool {
    is_online()
}

pub fn uuid() -> String {
    random_uuid()
}

/// Instant présent (horloge du navigateur).
pub fn now() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(js_sys::Date::now() as i64).unwrap_or(DateTime::UNIX_EPOCH)
}

/// Fuseau local (décalage actuel) pour les « jours » des statistiques.
pub fn local_tz() -> FixedOffset {
    let minutes = js_sys::Date::new_0().get_timezone_offset() as i32;
    FixedOffset::west_opt(minutes * 60).unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC"))
}

pub fn today() -> chrono::NaiveDate {
    now().with_timezone(&local_tz()).date_naive()
}

pub fn random() -> f64 {
    js_sys::Math::random()
}

pub fn perf_now() -> f64 {
    web_sys::window()
        .and_then(|w| w.performance())
        .map_or(0.0, |p| p.now())
}

pub fn set_title(title: &str) {
    if let Some(doc) = web_sys::window().and_then(|w| w.document()) {
        doc.set_title(title);
    }
}

pub fn hash() -> String {
    web_sys::window()
        .and_then(|w| w.location().hash().ok())
        .unwrap_or_default()
}

fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok()?
}

pub fn local_get(key: &str) -> Option<String> {
    storage()?.get_item(key).ok()?
}

pub fn local_set(key: &str, value: &str) {
    if let Some(s) = storage() {
        let _ = s.set_item(key, value);
    }
}

pub fn in_tauri() -> bool {
    tauri_present()
}

const STATE_KEY: &str = "lernoviq_state_v1";

/// Charge l'état : SQLite via Tauri, sinon `localStorage` (mode navigateur).
pub async fn load_state() -> Option<String> {
    if tauri_present() {
        let v = tauri_invoke("load_state", JsValue::NULL).await.ok()?;
        return v.as_string();
    }
    local_get(STATE_KEY)
}

/// Enregistre l'état : SQLite via Tauri, sinon `localStorage`.
pub async fn save_state(json: String) {
    if tauri_present() {
        let args = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&args, &"json".into(), &JsValue::from_str(&json));
        let _ = tauri_invoke("save_state", args.into()).await;
    } else {
        local_set(STATE_KEY, &json);
    }
}

/// Appel natif Tauri avec arguments sérialisables.
pub async fn invoke<A: Serialize, R: DeserializeOwned>(cmd: &str, args: &A) -> Result<R, String> {
    if !tauri_present() {
        return Err("Disponible uniquement dans l'application de bureau.".into());
    }
    let js = serde_json::to_string(args).map_err(|e| e.to_string())?;
    let value = js_sys::JSON::parse(&js).map_err(|e| format!("{e:?}"))?;
    let out = tauri_invoke(cmd, value)
        .await
        .map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")))?;
    let text = js_sys::JSON::stringify(&out)
        .map_err(|e| format!("{e:?}"))?
        .as_string()
        .unwrap_or_default();
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
