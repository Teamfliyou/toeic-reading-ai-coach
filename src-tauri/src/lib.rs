//! Intégration Tauri 2 : base SQLite locale, appels au serveur Lernoviq, mises à jour signées.
//!
//! La logique métier est dans les crates `lernoviq-*` ; ce fichier ne fait que relier la
//! fenêtre à la base locale et au réseau, avec des permissions minimales.

use lernoviq_database::Db;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

/// Serveur de l'API IA (variable `LERNOVIQ_SERVER_URL` pour un autre déploiement).
const DEFAULT_SERVER_URL: &str = "https://toeic-reading-ai-coach.vercel.app";
const UI_EXTRA_KEY: &str = "ui_extra";
/// Nombre de sauvegardes de la base conservées.
const MAX_BACKUPS: usize = 5;

struct AppState {
    db: Db,
    http: reqwest::Client,
    server_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
}

/// Version actuellement installée.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Score Reading estimé (logique métier de `lernoviq-core`).
#[tauri::command]
fn estimate_score(correct: u32, total: u32) -> u32 {
    lernoviq_core::exam::estimate_reading_score(correct, total)
}

/// État complet de l'application : SQLite + éléments propres à l'interface (leçons, examen en cours…).
#[tauri::command]
async fn load_state(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let core = state.db.export_json().await.map_err(|e| e.to_string())?;
    let mut value: Value = serde_json::from_str(&core).map_err(|e| e.to_string())?;
    if let Some(extra) = state
        .db
        .get_setting(UI_EXTRA_KEY)
        .await
        .map_err(|e| e.to_string())?
    {
        if let (Some(target), Ok(Value::Object(extra))) =
            (value.as_object_mut(), serde_json::from_str::<Value>(&extra))
        {
            target.extend(extra);
        }
    }
    Ok(value.to_string())
}

/// Enregistre l'état. Les données d'apprentissage vont dans les tables SQLite (fusion : la version
/// la plus récente gagne) ; le reste est conservé en un bloc JSON.
#[tauri::command]
async fn save_state(state: State<'_, Arc<AppState>>, json: String) -> Result<(), String> {
    let value: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    state
        .db
        .import_legacy(&json)
        .await
        .map_err(|e| e.to_string())?;
    let extra: serde_json::Map<String, Value> = ["sessions", "lessons", "diagnostic", "exam"]
        .iter()
        .filter_map(|k| value.get(*k).map(|v| ((*k).to_string(), v.clone())))
        .collect();
    state
        .db
        .set_setting(UI_EXTRA_KEY, &Value::Object(extra).to_string())
        .await
        .map_err(|e| e.to_string())
}

/// POST JSON vers le serveur Lernoviq. Aucun en-tête `Origin` de navigateur : pas de CORS.
async fn post(
    state: &AppState,
    path: &str,
    body: Value,
    user_key: Option<String>,
) -> Result<Value, String> {
    let mut request = state
        .http
        .post(format!("{}{path}", state.server_url))
        .timeout(Duration::from_secs(30))
        .json(&body);
    if let Some(key) = user_key.filter(|k| !k.trim().is_empty()) {
        request = request.header("x-deepseek-api-key", key.trim());
    }
    let response = request.send().await.map_err(|_| {
        "Connexion impossible au coach IA. Vérifiez votre connexion internet et réessayez ; les exercices restent accessibles."
            .to_string()
    })?;
    let status = response.status();
    let data: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(data["error"]
            .as_str()
            .unwrap_or("Impossible d'obtenir une réponse pour le moment.")
            .to_string());
    }
    Ok(data)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn explain(
    state: State<'_, Arc<AppState>>,
    questionId: String,
    selectedKey: String,
    userKey: Option<String>,
) -> Result<Value, String> {
    post(
        &state,
        "/api/explain",
        json!({"questionId": questionId, "selectedKey": selectedKey}),
        userKey,
    )
    .await
}

#[tauri::command]
#[allow(non_snake_case)]
async fn follow_up(
    state: State<'_, Arc<AppState>>,
    questionId: String,
    selectedKey: String,
    message: String,
    userKey: Option<String>,
) -> Result<Value, String> {
    post(
        &state,
        "/api/coach",
        json!({"questionId": questionId, "selectedKey": selectedKey, "question": message, "history": []}),
        userKey,
    )
    .await
}

#[tauri::command]
#[allow(non_snake_case)]
async fn report(
    state: State<'_, Arc<AppState>>,
    questionId: String,
    part: u8,
    reason: String,
    comment: String,
) -> Result<Value, String> {
    post(
        &state,
        "/api/report",
        json!({"questionId": questionId, "part": part, "reason": reason, "comment": comment}),
        None,
    )
    .await
}

/// Recherche une mise à jour signée sur GitHub Releases (`None` si l'application est à jour).
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        current_version: u.current_version.clone(),
        version: u.version.clone(),
        notes: u.body.clone(),
    }))
}

/// Télécharge, vérifie la signature et installe la mise à jour ; l'application redémarre ensuite.
/// La signature est vérifiée par le plugin avec la clé publique de `tauri.conf.json` :
/// un fichier altéré est refusé avant toute installation. La base est sauvegardée au préalable.
#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if let Some(dir) = backups_dir(&app) {
        let _ = backup(&state.db, &dir, &format!("avant-{}", update.version)).await;
    }
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

fn backups_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("backups"))
}

/// Sauvegarde cohérente de la base ; ne conserve que les `MAX_BACKUPS` plus récentes.
async fn backup(db: &Db, dir: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    db.backup_to(&dir.join(format!("lernoviq-{label}-{stamp}.db")))
        .await
        .map_err(|e| e.to_string())?;
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
        .collect();
    files.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    while files.len() > MAX_BACKUPS {
        let _ = std::fs::remove_file(files.remove(0).path());
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = tauri::async_runtime::block_on(Db::open(&dir.join("lernoviq.db")))
                .map_err(|e| format!("Impossible d'ouvrir la base de données locale : {e}"))?;
            // Première ouverture après une mise à jour : sauvegarde de la base existante.
            let version = app.package_info().version.to_string();
            let previous = tauri::async_runtime::block_on(db.get_setting("app_version"))
                .ok()
                .flatten();
            if let Some(previous) = previous.filter(|p| *p != version) {
                let _ = tauri::async_runtime::block_on(backup(
                    &db,
                    &dir.join("backups"),
                    &format!("v{previous}"),
                ));
            }
            let _ = tauri::async_runtime::block_on(db.set_setting("app_version", &version));
            let server_url = std::env::var("LERNOVIQ_SERVER_URL")
                .unwrap_or_else(|_| DEFAULT_SERVER_URL.to_string());
            app.manage(Arc::new(AppState {
                db,
                http: reqwest::Client::new(),
                server_url: server_url.trim_end_matches('/').to_string(),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            estimate_score,
            load_state,
            save_state,
            explain,
            follow_up,
            report,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de Lernoviq");
}
