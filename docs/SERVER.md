# Serveur Lernoviq (Rust / axum)

`crates/server` remplace `server.mjs` pour l'API IA. Il garde côté serveur la clé DeepSeek du service et la clé `service_role` Supabase : elles ne sont jamais dans l'application de bureau.

## Lancer
```bash
cargo run -p lernoviq-server        # PORT=3000 par défaut
```

## Variables d'environnement (mêmes noms que le serveur Node)
| Variable | Rôle | Défaut |
|---|---|---|
| `DEEPSEEK_API_KEY` | clé du service (secret) | absente |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | quotas, budget, cache, comptes | absentes : pas de quota |
| `AI_FREE_REQUIRES_AUTH` | exiger une connexion pour l'explication gratuite | `false` (recommandé `true` en production) |
| `ALLOW_SERVER_KEY_FALLBACK` | autoriser la clé du service sans clé personnelle | `true` |
| `AI_DAILY_LIMIT` / `AI_PER_MINUTE` | quotas utilisateur connecté | 10 / 3 |
| `AI_ANON_DAILY_LIMIT` / `AI_ANON_PER_MINUTE` | quotas anonymes | 5 / 2 |
| `AI_MONTHLY_LIMIT_EUR`, `AI_MONTHLY_SUSPEND_EUR`, `AI_USD_EUR_RATE` | budget mensuel | 10 / 8 / 0,93 |
| `TRUST_PROXY` | lire l'IP réelle derrière un reverse proxy | `false` |
| `EXPLAIN_RESTRICT_ORIGIN`, `ALLOWED_ORIGINS` | origines autorisées (l'application Tauri l'est d'office) | `true` |

## Garanties vérifiées par les tests (`crates/server/tests/explain.rs`)
- Aucun appel facturé avec la clé du service sans réservation de budget réussie ; réservation impossible → 503.
- Réponse illisible : le coût des deux appels reste imputé au budget ; erreur avant facturation : réservation rendue.
- Clé personnelle : jamais de budget du service ; clé refusée → 401 sans fuite de la clé.
- Quotas anonymes appliqués ; en-têtes `X-Forwarded-For` ignorés sans proxy de confiance.

## Routes
`GET /api/health`, `POST /api/explain`, `POST /api/coach` (relance, 3 échanges maximum, 400 tokens), `POST /api/report` (10 signalements par heure et par empreinte salée de l'IP, doublons refusés).

## Pas encore porté
`/api/admin` (utilisateurs, audit, génération, import, MFA), `/api/cron` et la limite de connexion admin en base. Les briques de sécurité (scrypt, sessions, TOTP) sont dans `crates/security` ; le Node `server.mjs` reste la référence pour ces routes.
