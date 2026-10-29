//! Tests d'intégration de `/api/explain` : serveur réel sur un port local, faux DeepSeek,
//! faux backend. Ils vérifient surtout les garanties de sécurité (budget, quotas, origine, débit).

use async_trait::async_trait;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use lernoviq_ai::ExplainQuestion;
use lernoviq_server::backend::{
    AiUser, Backend, BackendResult, CachedExplanation, ReportEntry, ReportResult, Reservation,
    ReserveRequest, SaveEntry,
};
use lernoviq_server::{router, AppState, Config};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

// --- Faux DeepSeek ---

#[derive(Default)]
struct DsState {
    script: VecDeque<(u16, String)>,
    auth_seen: Vec<String>,
}

async fn ds_handler(
    State(s): State<Arc<Mutex<DsState>>>,
    headers: axum::http::HeaderMap,
) -> (StatusCode, String) {
    let mut s = s.lock().unwrap();
    s.auth_seen.push(
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string(),
    );
    let (status, body) = s.script.pop_front().expect("réponse DeepSeek prévue");
    (StatusCode::from_u16(status).unwrap(), body)
}

const GOOD: &str = r#"{"diagnostic":"d","resolution":"r","tip":"t","lesson":{"title":"T","rule":"R","exercise":"X","answer":"A"}}"#;

fn ds_ok(content: &str) -> (u16, String) {
    (200, json!({"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 1000, "completion_tokens": 200}}).to_string())
}

// --- Faux backend ---

struct MockBackend {
    quota: bool,
    reserve: Mutex<Result<Reservation, String>>,
    users: Vec<(String, String)>,
    cached: Option<CachedExplanation>,
    calls: Mutex<Vec<String>>,
}

impl MockBackend {
    fn new(quota: bool) -> Self {
        Self {
            quota,
            reserve: Mutex::new(Ok(Reservation {
                ok: true,
                reason: None,
                event_id: Some("evt-1".into()),
            })),
            users: vec![],
            cached: None,
            calls: Mutex::new(vec![]),
        }
    }
    fn log(&self, entry: impl Into<String>) {
        self.calls.lock().unwrap().push(entry.into());
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl Backend for MockBackend {
    fn quota_enabled(&self) -> bool {
        self.quota
    }
    fn reports_enabled(&self) -> bool {
        true
    }
    async fn save_report(&self, e: ReportEntry) -> BackendResult<ReportResult> {
        self.log(format!(
            "report:{}:{}:{}",
            e.question_id,
            e.reason,
            e.reporter_hash.len()
        ));
        Ok(if e.comment == "doublon" {
            ReportResult::Duplicate
        } else {
            ReportResult::Created
        })
    }
    async fn verify_user(&self, token: &str) -> Option<AiUser> {
        self.users
            .iter()
            .find(|(t, _)| t == token)
            .map(|(_, id)| AiUser { id: id.clone() })
    }
    async fn find_question(&self, id: &str) -> BackendResult<Option<ExplainQuestion>> {
        self.log(format!("find:{id}"));
        Ok(None)
    }
    async fn cached(&self, _: &str, _: char, _: &str, _: &str) -> Option<CachedExplanation> {
        self.cached.clone()
    }
    async fn touch(&self, id: &str) {
        self.log(format!("touch:{id}"));
    }
    async fn save(&self, e: SaveEntry) {
        self.log(format!("save:{}:{}", e.question_id, e.selected_key));
    }
    async fn reserve(&self, r: ReserveRequest) -> BackendResult<Reservation> {
        self.log(format!(
            "reserve:{}:daily{}:min{}",
            r.actor, r.daily_limit, r.per_minute
        ));
        self.reserve.lock().unwrap().clone()
    }
    async fn finalize(&self, id: &str, usd: f64) {
        self.log(format!("finalize:{id}:{usd}"));
    }
    async fn release(&self, id: &str) {
        self.log(format!("release:{id}"));
    }
}

struct Harness {
    url: String,
    ds: Arc<Mutex<DsState>>,
    backend: Arc<MockBackend>,
    http: reqwest::Client,
}

async fn start(mut config: Config, backend: MockBackend, script: Vec<(u16, String)>) -> Harness {
    let ds = Arc::new(Mutex::new(DsState {
        script: script.into(),
        auth_seen: vec![],
    }));
    let ds_app = axum::Router::new()
        .route("/chat/completions", post(ds_handler))
        .with_state(ds.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    config.deepseek_base_url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, ds_app).await.unwrap() });

    let backend = Arc::new(backend);
    let app = router(Arc::new(AppState::new(config, backend.clone())));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap()
    });
    Harness {
        url: format!("http://{addr}"),
        ds,
        backend,
        http: reqwest::Client::new(),
    }
}

fn config() -> Config {
    Config {
        deepseek_api_key: Some("sk-service-key-000000".into()),
        ..Config::default()
    }
}

impl Harness {
    async fn explain(&self, body: Value) -> reqwest::Response {
        self.http
            .post(format!("{}/api/explain", self.url))
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    fn req(&self) -> reqwest::RequestBuilder {
        self.http.post(format!("{}/api/explain", self.url))
    }
    fn ds_calls(&self) -> usize {
        self.ds.lock().unwrap().auth_seen.len()
    }
}

fn ok_body() -> Value {
    json!({"questionId": "q5-01", "selectedKey": "B"})
}

#[tokio::test]
async fn sante_et_en_tetes_de_securite() {
    let h = start(config(), MockBackend::new(false), vec![]).await;
    let res = h
        .http
        .get(format!("{}/api/health", h.url))
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.headers()["cache-control"], "no-store");
    assert_eq!(
        res.json::<Value>().await.unwrap(),
        json!({"hasDeepSeekKey": true})
    );
    let res = h
        .http
        .get(format!("{}/api/explain", h.url))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 405);
}

#[tokio::test]
async fn origine_validation_et_taille() {
    let h = start(config(), MockBackend::new(false), vec![]).await;
    let res = h
        .req()
        .header("origin", "https://evil.example")
        .json(&ok_body())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    // L'application de bureau Tauri est une origine autorisée (ici : corps invalide → 400, pas 403).
    let res = h
        .req()
        .header("origin", "tauri://localhost")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    assert_eq!(
        h.explain(json!({"questionId": "x", "selectedKey": "Z"}))
            .await
            .status(),
        400
    );
    assert_eq!(
        h.explain(json!({"questionId": "", "selectedKey": "A"}))
            .await
            .status(),
        400
    );
    assert_eq!(
        h.req().body("pas du json").send().await.unwrap().status(),
        400
    );
    let big = json!({"questionId": "x".repeat(20_000), "selectedKey": "A"});
    assert_eq!(h.explain(big).await.status(), 413);
    assert_eq!(h.ds_calls(), 0);
}

#[tokio::test]
async fn succes_avec_reservation_puis_cout_reel() {
    let h = start(config(), MockBackend::new(true), vec![ds_ok(GOOD)]).await;
    let res = h.explain(ok_body()).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["explanation"]["diagnostic"], "d");
    assert_eq!(body["lesson"]["title"], "T");
    assert!(body["latencyMs"].is_number());
    assert_eq!(
        h.ds.lock().unwrap().auth_seen[0],
        "Bearer sk-service-key-000000"
    );
    let calls = h.backend.calls();
    assert!(
        calls[0].starts_with("reserve:ip:127.0.0.1:daily5:min2"),
        "{calls:?}"
    );
    assert!(calls[1].starts_with("finalize:evt-1:"), "{calls:?}");
    assert_eq!(calls[2], "save:q5-01:B");
}

#[tokio::test]
async fn quota_refuse_aucun_appel_deepseek() {
    let b = MockBackend::new(true);
    *b.reserve.lock().unwrap() = Ok(Reservation {
        ok: false,
        reason: Some("quota".into()),
        event_id: None,
    });
    let h = start(config(), b, vec![]).await;
    let res = h.explain(ok_body()).await;
    assert_eq!(res.status(), 429);
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "quota");
    assert_eq!(h.ds_calls(), 0);
}

#[tokio::test]
async fn reservation_impossible_refuse_plutot_que_de_risquer_le_budget() {
    let b = MockBackend::new(true);
    *b.reserve.lock().unwrap() = Err("Supabase RPC ai_reserve_explain : 404".into());
    let h = start(config(), b, vec![]).await;
    let res = h.explain(ok_body()).await;
    assert_eq!(res.status(), 503);
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "unavailable");
    assert_eq!(h.ds_calls(), 0, "aucun appel facturé sans réservation");
}

#[tokio::test]
async fn cache_partage_sans_quota_ni_appel() {
    let mut b = MockBackend::new(true);
    b.cached = Some(CachedExplanation {
        id: "c1".into(),
        explanation: json!({"diagnostic": "cache"}),
        lesson: Value::Null,
    });
    let h = start(config(), b, vec![]).await;
    let body: Value = h.explain(ok_body()).await.json().await.unwrap();
    assert_eq!(
        (
            body["cached"].as_bool(),
            body["explanation"]["diagnostic"].as_str()
        ),
        (Some(true), Some("cache"))
    );
    assert_eq!(h.backend.calls(), ["touch:c1"]);
    assert_eq!(h.ds_calls(), 0);
}

#[tokio::test]
async fn cle_personnelle_sans_quota_et_cle_refusee() {
    let h = start(
        config(),
        MockBackend::new(true),
        vec![ds_ok(GOOD), (401, "bad sk-abcdefghijklmnop".into())],
    )
    .await;
    assert_eq!(
        h.req()
            .header("x-deepseek-api-key", " sk-user-key-999999 ")
            .json(&ok_body())
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        h.ds.lock().unwrap().auth_seen[0],
        "Bearer sk-user-key-999999"
    );
    assert!(
        h.backend
            .calls()
            .iter()
            .all(|c| !c.starts_with("reserve") && !c.starts_with("finalize")),
        "pas de budget du service"
    );
    let res = h
        .req()
        .header("x-deepseek-api-key", "sk-bad-key-1234567")
        .json(&ok_body())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["code"], "key_invalid");
    assert!(!body.to_string().contains("abcdefghijklmnop"));
}

#[tokio::test]
async fn solde_epuise_libere_la_reservation() {
    let h = start(
        config(),
        MockBackend::new(true),
        vec![(402, "insufficient".into())],
    )
    .await;
    let res = h.explain(ok_body()).await;
    assert_eq!(res.status(), 503);
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "budget");
    assert!(h.backend.calls().contains(&"release:evt-1".to_string()));
}

#[tokio::test]
async fn reponse_illisible_reste_facturee() {
    let h = start(
        config(),
        MockBackend::new(true),
        vec![ds_ok("rien"), ds_ok("encore rien")],
    )
    .await;
    let res = h.explain(ok_body()).await;
    assert_eq!(res.status(), 502);
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "unparsable");
    let calls = h.backend.calls();
    assert!(
        calls.iter().any(|c| c.starts_with("finalize:evt-1:")),
        "le coût des deux appels est imputé : {calls:?}"
    );
    assert!(!calls.iter().any(|c| c.starts_with("release")));
}

#[tokio::test]
async fn connexion_requise_et_quota_par_utilisateur() {
    let mut b = MockBackend::new(true);
    b.users = vec![("jwt-ok".into(), "user-42".into())];
    let h = start(
        Config {
            free_requires_auth: true,
            ..config()
        },
        b,
        vec![ds_ok(GOOD)],
    )
    .await;
    let res = h.explain(ok_body()).await;
    assert_eq!(res.status(), 401);
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "auth_required");
    let res = h
        .req()
        .bearer_auth("jwt-bad")
        .json(&ok_body())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401, "jeton invalide = anonyme");
    let res = h
        .req()
        .bearer_auth("jwt-ok")
        .json(&ok_body())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(
        h.backend.calls()[0].starts_with("reserve:user:user-42:daily10:min3"),
        "{:?}",
        h.backend.calls()
    );
}

#[tokio::test]
async fn limite_de_debit_par_ip() {
    let h = start(
        Config {
            explain_rate_limit: 2,
            ..config()
        },
        MockBackend::new(false),
        vec![ds_ok(GOOD), ds_ok(GOOD)],
    )
    .await;
    assert_eq!(h.explain(ok_body()).await.status(), 200);
    assert_eq!(h.explain(ok_body()).await.status(), 200);
    let res = h.explain(ok_body()).await;
    assert_eq!(res.status(), 429);
    assert!(res.headers().contains_key("retry-after"));
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "rate");
}

#[tokio::test]
async fn en_tetes_de_proxy_falsifies_ignores_sans_proxy_de_confiance() {
    let h = start(
        Config {
            explain_rate_limit: 1,
            ..config()
        },
        MockBackend::new(false),
        vec![ds_ok(GOOD)],
    )
    .await;
    let first = h
        .req()
        .header("x-forwarded-for", "1.1.1.1")
        .json(&ok_body())
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let second = h
        .req()
        .header("x-forwarded-for", "2.2.2.2")
        .json(&ok_body())
        .send()
        .await
        .unwrap();
    assert_eq!(
        second.status(),
        429,
        "changer d'IP déclarée ne contourne pas la limite"
    );
}

#[tokio::test]
async fn question_inconnue_et_cle_absente() {
    let h = start(config(), MockBackend::new(true), vec![]).await;
    let res = h
        .explain(json!({"questionId": "nope", "selectedKey": "A"}))
        .await;
    assert_eq!(res.status(), 404);
    assert!(h.backend.calls().contains(&"release:evt-1".to_string()));
    assert_eq!(h.ds_calls(), 0);

    let h = start(
        Config {
            deepseek_api_key: None,
            ..Config::default()
        },
        MockBackend::new(false),
        vec![],
    )
    .await;
    let res = h.explain(ok_body()).await;
    assert_eq!(res.status(), 500);
    assert!(res.json::<Value>().await.unwrap()["error"]
        .as_str()
        .unwrap()
        .contains("Aucune clé API DeepSeek"));
}

// --- /api/coach ---

impl Harness {
    async fn post(&self, path: &str, body: Value) -> reqwest::Response {
        self.http
            .post(format!("{}{path}", self.url))
            .json(&body)
            .send()
            .await
            .unwrap()
    }
}

fn follow(question: &str, history: Value) -> Value {
    json!({"questionId": "q5-01", "selectedKey": "B", "question": question, "history": history})
}

#[tokio::test]
async fn relance_reussie_avec_reservation_plus_faible() {
    let h = start(
        config(),
        MockBackend::new(true),
        vec![ds_ok("Parce que « by » marque une échéance.")],
    )
    .await;
    let res = h
        .post(
            "/api/coach",
            follow(
                "Pourquoi pas until ?",
                json!([{"q": "Et since ?", "a": "Point de départ."}]),
            ),
        )
        .await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["answer"], "Parce que « by » marque une échéance.");
    let calls = h.backend.calls();
    assert!(calls[0].starts_with("reserve:ip:127.0.0.1"), "{calls:?}");
    assert!(calls[1].starts_with("finalize:evt-1:"), "{calls:?}");
}

#[tokio::test]
async fn relance_validation_et_limite_de_trois_echanges() {
    let h = start(config(), MockBackend::new(true), vec![]).await;
    assert_eq!(
        h.post("/api/coach", follow("ab", json!([]))).await.status(),
        400
    );
    assert_eq!(
        h.post("/api/coach", follow(&"x".repeat(301), json!([])))
            .await
            .status(),
        400
    );
    let three = json!([{"q": "a", "a": "b"}, {"q": "a", "a": "b"}, {"q": "a", "a": "b"}]);
    let res = h.post("/api/coach", follow("Une quatrième ?", three)).await;
    assert_eq!(res.status(), 400);
    assert!(res.json::<Value>().await.unwrap()["error"]
        .as_str()
        .unwrap()
        .contains("Limite de 3"));
    assert_eq!(
        h.post(
            "/api/coach",
            follow("Valide ?", json!([{"q": 1, "a": "b"}]))
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        h.post(
            "/api/coach",
            json!({"questionId": "q5-01", "selectedKey": "Z", "question": "Valide ?"})
        )
        .await
        .status(),
        400
    );
    assert_eq!(h.ds_calls(), 0);
    assert!(
        h.backend.calls().is_empty(),
        "aucune réservation pour une requête invalide"
    );
}

#[tokio::test]
async fn relance_vide_reste_facturee() {
    let h = start(config(), MockBackend::new(true), vec![ds_ok("   ")]).await;
    let res = h.post("/api/coach", follow("Pourquoi ?", json!([]))).await;
    assert_eq!(res.status(), 502);
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "unparsable");
    assert!(h
        .backend
        .calls()
        .iter()
        .any(|c| c.starts_with("finalize:evt-1:")));
}

// --- /api/report ---

fn report_body(reason: &str, comment: &str) -> Value {
    json!({"questionId": "q5-01", "reason": reason, "comment": comment, "part": 5})
}

#[tokio::test]
async fn signalement_cree_doublon_et_validation() {
    let h = start(config(), MockBackend::new(false), vec![]).await;
    let res = h
        .post(
            "/api/report",
            report_body("wrong_answer", "  la   réponse  "),
        )
        .await;
    assert_eq!(res.status(), 201);
    assert!(
        h.backend.calls()[0].starts_with("report:q5-01:wrong_answer:24"),
        "{:?}",
        h.backend.calls()
    );
    let res = h.post("/api/report", report_body("typo", "doublon")).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.json::<Value>().await.unwrap()["duplicate"], true);
    assert_eq!(
        h.post("/api/report", report_body("bad", "")).await.status(),
        400
    );
    assert_eq!(
        h.post("/api/report", report_body("other", "court"))
            .await
            .status(),
        201,
        "5 caractères suffisent"
    );
    assert_eq!(
        h.post("/api/report", report_body("other", "abc"))
            .await
            .status(),
        400
    );
    assert_eq!(
        h.post("/api/report", report_body("typo", &"x".repeat(501)))
            .await
            .status(),
        400
    );
    assert_eq!(
        h.post(
            "/api/report",
            json!({"questionId": "nope", "reason": "typo"})
        )
        .await
        .status(),
        404
    );
    // Les énoncés du Listening sont signalables.
    assert_eq!(
        h.post(
            "/api/report",
            json!({"questionId": "l2-01", "reason": "unclear_audio"})
        )
        .await
        .status(),
        201
    );
}

#[tokio::test]
async fn signalement_limite_par_ip_et_origine() {
    let h = start(config(), MockBackend::new(false), vec![]).await;
    for _ in 0..10 {
        assert_eq!(
            h.post("/api/report", report_body("typo", ""))
                .await
                .status(),
            201
        );
    }
    let res = h.post("/api/report", report_body("typo", "")).await;
    assert_eq!(res.status(), 429);
    assert!(res.headers().contains_key("retry-after"));
    let res = h
        .http
        .post(format!("{}/api/report", h.url))
        .header("origin", "https://evil.example")
        .json(&report_body("typo", ""))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
}
