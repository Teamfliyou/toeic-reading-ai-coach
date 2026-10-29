# Migration Lernoviq → Rust + Tauri 2

Branche : `migration/rust-tauri` (rien n'est poussé sur `main`). L'application React/Express reste intacte et fonctionnelle tant qu'un remplaçant n'a pas été testé.

## 1. Inventaire (Phase 0, audit du dépôt au commit `8a4e853`)

Environ 15 000 lignes de code applicatif (hors tests et SQL) : `src/` (React/TS), `server/` (+`server/bank/`) en `.mjs`, `api/` (fonctions Vercel), `supabase/` (SQL), `scripts/`, `tests/` (35 fichiers, `node --test`).

### Écrans (routes par hash, `src/App.tsx`)
Tableau de bord, Entraînement `#/practice/part5|6|7`, Révision (`#/review`, `#/review/partN`), Adaptatif, Examen blanc (75 min, 100 questions), Statistiques, Mes mots (vocabulaire), Mon objectif, Leçons, Diagnostic, Listening Partie 2, Administration (bibliothèque, import, génération, rapports, audit), modales Paramètres et Connexion, bandeau hors-ligne.

### API serveur (`server.mjs` / `api/*.mjs`)
| Route | Rôle | Fichiers |
|---|---|---|
| `POST /api/explain` | Explication IA d'une erreur (quota, budget, cache, schéma zod, retry) | `server/explain.mjs`, `explanation-schema.mjs`, `quota.mjs`, `deepseek-config.mjs` |
| `POST /api/coach` | Relances conversationnelles / leçons personnalisées | `server/coach.mjs` |
| `POST /api/report` | Signalement d'une question | `server/report.mjs` |
| `ALL /api/admin?action=` | session, setup, login, logout, users, create-user, update-user, audit, reports, report-status, publish, generate(-stream), actions banque | `server/admin.mjs`, `admin-users.mjs`, `login-limiter.mjs`, `totp.mjs`, `audit.mjs`, `bank/*` |
| `ALL /api/cron` | Génération planifiée (Bearer `CRON_SECRET`) | `api/cron.mjs`, `bank/generation.mjs` |
| `GET /api/health` | Présence de la clé serveur | `explain.mjs` |

### Données et services externes
- Supabase (Postgres) : `schema.sql`, `question_bank.sql` (1273 lignes), `ai_explanations.sql`, `ai_hardening.sql`, `listening_bank.sql`, `user_data.sql`, `user_vocab.sql`, `user_goals.sql`, `admin_users.sql`, `admin_audit.sql`, `question_reports.sql`, etc.
- DeepSeek (API chat) ; Plausible (analytics, CSP) ; Web Speech API (`speech.ts`) ; PWA/service worker.
- Jeu local : `data/questions.json` (33 questions), `categories.json`, `listening.json`, `import-template.json`.
- `localStorage` : `deepseek_user_api_key`, `lernoviq_auth_session`, `toeic_practice_history_v1`, `toeic_mistakes_v1`, clés leçons/objectifs/vocabulaire.

### Logique métier pure (migrable en priorité, déjà testée côté JS)
`exam.ts`, `srs.ts`, `stats.ts`, `goals.ts`, `adaptive.ts`, `examBuilder.ts`, `vocab.ts`, `tracker.ts`, `analytics.ts`, `lib/bank/{parse,csv,xlsx,practice,listeningPick}.ts`, `server/bank/{quality,text,import,library,listening}.mjs`.

### Sécurité à préserver (cf. `AUDIT.md`)
Anti-bruteforce admin par IP et identifiant (SQL atomique), quotas IA y compris anonymes, réservation/finalisation/remboursement du budget, expiration des `pending`, hachage scrypt + comparaison à temps constant, cookie `HttpOnly`/`SameSite=Strict`, `session_version`, TOTP (MFA admin), journal d'audit, RLS Supabase, CSP et en-têtes.

## 2. Décision d'architecture : ce qui peut être local ou doit rester distant

| Domaine | Cible | Raison |
|---|---|---|
| Exercices P5/6/7, examen, SRS, stats, objectifs, vocabulaire, adaptatif | **100 % local** (Rust + SQLite) | Aucune donnée sensible, hors-ligne requis |
| Banque de questions embarquée + import XLSX/CSV/JSON (côté élève) | Local | Parsing pur |
| Coach IA, explications | **Backend distant en Rust** (axum) qui détient la clé DeepSeek, les quotas et le budget ; clé personnelle optionnelle stockée localement (Credential Manager Windows) | Une clé DeepSeek du service ne doit jamais être dans le binaire |
| Administration (publication, génération, utilisateurs, audit, MFA) | **Backend distant en Rust**, autorisations serveur ; le client Tauri n'est qu'un client | Une opération admin ne devient jamais une commande locale |
| Comptes et synchronisation | Supabase (Auth + tables existantes), conflits résolus par `updatedAt` (cf. `merge_cards`) | Aucune donnée existante n'est supprimée ni migrée sans stratégie validée |

## 3. Architecture Rust cible

```
Cargo.toml (workspace)
crates/models    modèles serde + validation          ← créé
crates/core      règles TOEIC pures (exam, srs, …)   ← créé (exam, srs)
crates/database  SQLite (sqlx) + migrations versionnées
crates/progress  stats, objectifs, vocabulaire, adaptatif
crates/exams     sessions d'examen
crates/bank      banque, import, qualité, génération
crates/ai        client DeepSeek, schéma de réponse, prompts
crates/security  sessions, TOTP, scrypt, limites de débit
crates/server    (nouveau) backend axum : /api/explain, /coach, /report, /admin
crates/ui        Dioxus (WASM)
src-tauri        Tauri 2 + updater + NSIS
```

### Risque technique majeur : Dioxus + Tauri 2
Dioxus a son propre renderer desktop (wry/tao), distinct de Tauri. Le montage retenu à valider par un prototype **avant** de migrer les écrans : Dioxus compilé en WASM (`dx build --platform web`) servi comme `frontendDist` de Tauri, appels natifs via `invoke` (liaison `wasm-bindgen`/`tauri-sys`). Cela impose un minimum de JS de colle généré par `wasm-bindgen`, conforme à la tolérance du cahier des charges. Alternative documentée si cela échoue : Leptos ou Yew en WASM sous Tauri.

## 4. Risques de migration

1. **Volume** : environ 15 000 lignes + 1 273 lignes de SQL de banque. Compter plusieurs semaines pour une parité fonctionnelle complète ; livrer par tranches testables.
2. **Parité UI** : liquid glass (Tailwind + `lexora.css`, `bank.css`, `phase2.css`) à reprendre en CSS inchangé ; réécrire 14 pages et ~30 composants en RSX.
3. **Secrets** : tout appel DeepSeek « service » ou Supabase `service_role` reste serveur. Le client n'embarque que l'URL et la clé *publishable* Supabase.
4. **Données existantes** : les clés `localStorage` des utilisateurs web ne migrent pas d'elles-mêmes vers SQLite ; prévoir un export JSON côté web et un import côté Rust (format camelCase conservé exprès).
5. **Environnement local** : toolchain par défaut `stable-x86_64-pc-windows-gnu`. Tauri exige la cible MSVC pour l'installateur NSIS ; la CI utilisera `windows-latest` + `stable-x86_64-pc-windows-msvc`.
6. **Signature et mise à jour** : il faut générer une paire `tauri signer generate`, stocker la clé privée dans les secrets GitHub (`TAURI_SIGNING_PRIVATE_KEY`) ; l'action est à faire par le propriétaire du dépôt. L'installateur n'est pas signé Authenticode (SmartScreen avertira) tant qu'aucun certificat n'est fourni.
7. **Mise à jour réelle** : le critère « transition entre deux versions réelles » ne peut être validé qu'après publication de deux tags.

## 5. Matrice de correspondance

Statuts : ⬜ non commencée · 🟨 en cours · 🟦 implémentée · 🟩 testée · ✅ validée

| Fonctionnalité (source JS/TS) | Cible Rust | Statut |
|---|---|---|
| `exam.ts` (score, chrono, correction) | `crates/core/src/exam.rs` | 🟩 testée (6 tests unitaires) |
| `srs.ts` (Leitner, fusion) | `crates/core/src/srs.rs` | 🟩 testée (4 tests unitaires) |
| `stats.ts`, `goals.ts` | `crates/core/src/{stats,goals}.rs` | 🟩 testée (10 tests) |
| `adaptive.ts`, `vocab.ts` | `crates/core/src/{adaptive,vocab}.rs` | 🟩 testée (13 tests) |
| `examBuilder.ts`, `attempts.ts` | `crates/core/src/{exam_builder,attempts}.rs` | 🟩 testée (9 tests) |
| `bank/csv.ts`, `server/bank/{text,language,quality}.mjs` | `crates/bank/src/{csv,text,language,quality}.rs` | 🟩 testée (20 tests ; empreintes SHA-256, bandes LSH et mulberry32 vérifiés contre les valeurs du JS) |
| `tracker.ts`, `analytics.ts`, `parts.ts`, `lessons.ts` | `core` / `progress` | ⬜ |
| Types `types.ts`, `bank/types.ts` | `models` | 🟨 (`ExamQuestionRef`, `Attempt`, `Question`, `Passage`) |
| `bank/{parse,csv,xlsx,practice,listeningPick}.ts` | `bank` | ⬜ |
| `server/bank/*` (qualité, import, génération, bibliothèque, listening) | `bank` | ⬜ |
| `deepseek-config.mjs`, `explanation-schema.mjs`, prompts et client de `explain.mjs` | `crates/ai` | 🟩 testée (18 tests, client testé contre un faux serveur HTTP) |
| `quota.mjs`, `rate-limit.mjs`, route `/api/explain` (quotas, budget, cache Supabase) | `security` + `server` | ⬜ |
| `server/coach.mjs`, `report.mjs`, `audit.mjs` | `ai` / `server` | ⬜ |
| `server/admin*.mjs`, `login-limiter.mjs`, `totp.mjs`, `auth.mjs` | `security` + `server` | ⬜ |
| `supabase/*.sql` | inchangé (serveur) ; SQLite pour le local | ⬜ |
| Stockage local (tentatives, cartes, vocabulaire, objectifs, examens, paramètres, import de l'export web, sauvegarde) | `crates/database` (SQLx + SQLite, migrations versionnées) | 🟩 testée (7 tests dont persistance fichier) |
| `sync.ts`, `supabaseAuth.ts`, `AuthContext`, `SettingsContext` | `security` + `ui` | ⬜ |
| 14 pages + ~30 composants React | `crates/ui` (Dioxus) | ⬜ |
| Service worker / PWA | remplacé par Tauri | ⬜ |
| NSIS, updater, CI, release | `src-tauri`, `.github/workflows` | ⬜ |

## 6. Prochaines étapes

1. Prototype Dioxus-WASM sous Tauri 2 (fenêtre vide + une commande `invoke`) et build local MSVC.
2. Porter `stats`, `goals`, `adaptive`, `vocab`, `tracker` avec leurs tests JS comme référence.
3. Crate `database` (SQLite + migrations) et import des données `localStorage` exportées.
4. Backend `crates/server` (axum) pour IA et administration, avec tests reprenant `tests/*.test.mjs`.
5. Écrans Dioxus, puis `src-tauri`, puis workflows CI et release.

## 7. Écarts volontaires avec le JavaScript

- `strip_blanks` (qualité de la banque) : l'expression régulière JS `(d{1,2})s*_{2,}` avait perdu ses antislashs (bug). Le Rust applique l'intention : `\(\d{1,2}\)\s*_{2,}`. À corriger aussi côté JS tant qu'il existe.
- Tirage aléatoire de l'examen : le générateur est injectable, la séquence diffère de `Math.random`.
