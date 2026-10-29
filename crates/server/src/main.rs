use lernoviq_server::{router, AppState, Backend, Config, NoBackend, SupabaseBackend};
use std::net::SocketAddr;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let config = Config::from_env();
    if std::env::var("AI_USD_EUR_RATE").is_err() {
        tracing::warn!(
            "AI_USD_EUR_RATE non défini : taux USD→EUR fixe de 0,93 utilisé pour le budget."
        );
    }
    let backend: Arc<dyn Backend> = match SupabaseBackend::from_config(&config) {
        Some(b) => Arc::new(b),
        None => {
            tracing::warn!("Supabase non configuré : ni quotas, ni cache, ni comptes.");
            Arc::new(NoBackend)
        }
    };
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let app = router(Arc::new(AppState::new(config, backend)));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("port indisponible");
    tracing::info!("Lernoviq server : http://{addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("erreur serveur");
}
