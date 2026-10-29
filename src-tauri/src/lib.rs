//! Intégration Tauri 2 : commandes natives et mises à jour signées.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

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
/// un fichier altéré est refusé avant toute installation.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            estimate_score,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de Lernoviq");
}
