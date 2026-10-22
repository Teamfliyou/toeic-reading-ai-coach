# AUDIT — Lernoviq / Coach TOEIC

Phase 0 : audit en lecture seule (aucun fichier applicatif modifié). État de départ : `npm test` → 54/54 verts, `npm run build` OK. Jeu de données : 33 questions (P5 : 15, P6 : 8, P7 : 10), 5 passages.

Légende : 🔴 grave · 🟠 important · 🟡 moyen · ⚪ faible. Colonne « État » mise à jour après la phase 1 (✅ corrigé · 🟡 partiel).

## Synthèse

| # | Gravité | Sujet | Fichier | État |
|---|---|---|---|---|
| 1 | 🔴 | Anti-bruteforce admin en mémoire, par IP seule, IP falsifiable | `server/admin.mjs:7,19,109,116` | ✅ corrigé (migration SQL à exécuter) |
| 2 | 🔴 | Aucun quota quotidien pour les anonymes ; limite IP en mémoire et contournable | `server/explain.mjs:349-360,428-435`, `server/rate-limit.mjs:15-20` | ✅ corrigé (migration SQL ; défaut `AI_FREE_REQUIRES_AUTH` inchangé) |
| 3 | 🔴 | Réservation `pending` jamais expirée → acteur bloqué + budget gelé | `supabase/ai_explanations.sql:120-126`, `server/explain.mjs:487-489` | ✅ corrigé (migration SQL à exécuter) |
| 4 | 🟠 | Aucune CSP ni en-tête de sécurité ; clé DeepSeek et jetons Supabase dans `localStorage` | `index.html`, `server.mjs`, absence de `vercel.json` | 🟡 partiellement corrigé (CSP + clé non mémorisée par défaut ; jetons Supabase toujours en `localStorage`) |
| 5 | 🟠 | Réponse IA : pas de schéma, pas de retry, risque de troncature (1024 tokens) | `server/explain.mjs:100-125,241-247` | ✅ corrigé |
| 6 | 🟠 | Budget libéré (remboursé) alors que DeepSeek a facturé l'appel | `server/explain.mjs:245-247,497-500` | ✅ corrigé |
| 7 | 🟠 | Génération admin hors quota/budget (clé serveur, 8000 tokens) + code dupliqué | `server/admin.mjs:6,44-57` | 🟡 partiellement corrigé (budget + limite horaire en base ; `order_index`, messages d'erreur, course du setup restent) |
| 8 | 🟡 | `\\n` littéral dans le contexte envoyé à l'IA | `server/explain.mjs:132,167` | ✅ corrigé |
| 9 | 🟡 | Réponse tardive d'une ancienne question écrase l'état de la suivante | `src/components/PracticeClient.tsx:76-126` | ✅ corrigé |
| 10 | 🟡 | Quota quotidien non remboursé sur échec | `supabase/ai_explanations.sql:157-159,203-228` | ✅ corrigé (migration SQL à exécuter) |
| 11 | 🟡 | Clé personnelle bidon = aucune limite de débit ni de quota | `server/explain.mjs:332,424` | 🟡 partiellement corrigé (401 explicite ; pas de limite de débit pour les clés personnelles) |
| 12 | 🟡 | Répartition des bonnes réponses déséquilibrée (A 12, B 15, C 4, D 2) | `data/questions.json` | ✅ corrigé (garde-fou dans `check:data`) |
| 13 | 🟡 | Identifiants de questions différents Supabase / JSON → carnet d'erreurs orphelin | `scripts/generate-seed-sql.mjs`, `src/lib/progress.ts` | ✅ corrigé (migration `questions_slug.sql` + seed à relancer) |
| 14 | 🟡 | Accessibilité : menus inline P6 sans ARIA ni clavier, modales sans piège de focus | `src/components/InlineSelect.tsx`, `SettingsModal.tsx` | 🟡 partiellement corrigé (menus P6, modale Paramètres, choix, aurore figée ; `AuthModal`, contrastes → phase 4) |
| 15 | ⚪ | Taux USD→EUR fixe (0,93), prix DeepSeek en dur | `server/quota.mjs:51`, `server/deepseek-config.mjs:19` | 🟡 documenté + avertissement au démarrage (pas de mise à jour automatique) |
| 16 | ⚪ | Divers : vote 👍/👎 sans effet, tables `attempts`/`feedback_votes` inutilisées, seed non idempotent, pas de CI/lint | voir §Dette | 🟡 partiellement corrigé (seed idempotent ; vote, tables inutilisées, lint, CI restent) |

---

## 🔴 Graves

### 1. Anti-bruteforce admin inefficace (point 2 de la mission)
- `admin.mjs:7` : `const loginAttempts = new Map()` — état par instance serverless. Sur Vercel, chaque instance froide repart à zéro ; un attaquant dont les requêtes sont réparties sur N instances obtient N×5 essais / 15 min, et un redéploiement remet tout à zéro.
- `admin.mjs:109,116` : clé = `x-forwarded-for` (1er élément). Hors Vercel (Express direct, `server.mjs`) cet en-tête est fourni par le client : une IP aléatoire par essai contourne totalement la limite. Aucun `trust proxy`.
- Pas de compteur **par identifiant** : un botnet peut tester un mot de passe sur `admin` depuis des IP différentes sans jamais être bloqué.
- Effet inverse : tout essai (y compris réussi) compte ; 5 connexions légitimes en 15 min depuis une même IP NAT verrouillent aussi l'admin. `setup` partage le même compteur.
- Repro : `for i in 1..50: curl -X POST /api/admin?action=login -H "Origin: …" -H "X-Forwarded-For: 1.2.3.$i" -d '{"username":"admin","password":"x"}'` sur le serveur Express → 50 réponses 401, aucun 429.
- Correctif prévu : table Supabase `admin_login_attempts` + fonction SQL atomique (fenêtre glissante par IP **et** par identifiant, verrou, remise à zéro après succès) ; IP lue depuis `x-vercel-forwarded-for`/`x-real-ip`, et `x-forwarded-for` seulement si `TRUST_PROXY=true`.

### 2. Quotas des anonymes (point 3)
Comment un anonyme est identifié : uniquement par `ip:<clientIp(req)>` (`explain.mjs:429`). Pas de session, pas de cookie.
- `explain.mjs:430-431` : pour un anonyme, `dailyLimit: 0` et `perMinute: 0` → la fonction SQL **ignore** quota et débit (`if p_daily_limit > 0`). Le seul frein est donc : 1 appel en vol par IP + budget mensuel global + `checkRateLimit` en mémoire (60 / 10 min **par instance**).
- `clientIp` (`rate-limit.mjs:15-20`) fait confiance à `x-forwarded-for` : en Express direct, rotation d'IP = quota infini et plusieurs appels en parallèle. Un seul abuseur peut donc vider le budget mensuel de 10 € (déni de service pour les vrais utilisateurs).
- `AI_FREE_REQUIRES_AUTH` vaut `false` par défaut (code `explain.mjs:333` et `.env.example:48`).
- Correctif prévu : quota quotidien et débit **appliqués aussi aux anonymes** (valeurs dédiées `AI_ANON_DAILY_LIMIT`, `AI_ANON_PER_MINUTE`), IP fiable (cf. 1), limiteur en mémoire conservé comme premier filtre uniquement ; `AI_FREE_REQUIRES_AUTH=true` recommandé en production (documenté, valeur par défaut du `.env.example` de production à `true` ; le défaut du code reste `false` pour ne pas casser l'existant — décision à valider).

### 3. Réservations « pending » éternelles (point 8, course critique)
- `ai_reserve_explain` refuse tout nouvel appel tant qu'une ligne `pending` existe pour l'acteur (`ai_explanations.sql:120-126`) et ne l'expire jamais.
- Si la fonction serverless est tuée (timeout Vercel 10-60 s, coupure réseau, `release`/`finalize` qui échouent car `.catch(() => {})` à `explain.mjs:488`), la ligne reste `pending` : l'acteur est bloqué (« Une explication est déjà en cours ») **pour toujours**, et le montant réservé reste dans `ai_budget.spent_usd`. Pour une IP partagée (NAT d'école), c'est un déni de service involontaire.
- Pas de course d'atomicité au sens strict : le `select … for update` sur `ai_budget` sérialise bien les réservations (vérifié à la lecture), au prix d'un verrou global unique.
- Correctif prévu : nouvelle migration (`supabase/ai_hardening.sql`) — les `pending` plus vieux que N secondes (> timeout DeepSeek + marge) sont considérés expirés et libérés dans `ai_reserve_explain` (remboursement du budget), + index partiel.

## 🟠 Importants

### 4. Clé DeepSeek en `localStorage`, aucune CSP (point 1)
- Stockage : `SettingsContext.tsx:9,26,33` (`deepseek_user_api_key`). Les jetons Supabase (access + refresh) sont dans la même situation : `supabaseAuth.ts:11,57`.
- Journalisation côté serveur : **vérifié, absente**. Aucun `console.log` de requête dans `server/` ; l'en-tête `x-deepseek-api-key` n'est lu qu'en `explain.mjs:317-320` et transmis à DeepSeek ; les erreurs passent par `maskSecret` (`explain.mjs:23-27`, masque `sk-…` et `Bearer …`). Elle n'est **jamais renvoyée au client** (seul `/api/health` expose un booléen). Réserve : `maskSecret` ne masque pas une clé qui ne commencerait pas par `sk-` hors d'un `Bearer` ; et un reverse proxy/CDN utilisateur peut journaliser les en-têtes (hors périmètre).
- CSP : **aucune** (pas de `vercel.json`, pas de `<meta http-equiv>`, `server.mjs` sans helmet). Pas de `dangerouslySetInnerHTML` dans `src/` (React échappe), ce qui limite le risque XSS actuel, mais la défense en profondeur manque.
- Correctif prévu : CSP stricte + en-têtes (`X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`) dans `vercel.json` et dans `server.mjs` ; option « Ne pas mémoriser (cette session uniquement) » dans les Paramètres (stockage en mémoire / `sessionStorage`), cochée par défaut ; libellé de la modale mis à jour.

### 5. Parsing / validation des explications IA (point 5)
- `parseExplanation` (`explain.mjs:100-125`) : seuls les fences ```` ``` ```` en début/fin sont retirés ; texte avant/après le JSON → échec. Aucune validation de schéma (zod absent des dépendances), longueurs non bornées, types coercés avec `String()`.
- Troncature : le prompt demande 3 champs (≤ 50 mots) **plus** un cours de 80-130 mots, un exemple, un exercice, une réponse et un tip, avec `max_tokens=1024` (`explain.mjs:212`). Probable troncature régulière (à mesurer en conditions réelles) ; `finish_reason === "length"` n'est jamais examiné.
- Aucun retry ; l'échec renvoie « Réponse DeepSeek non parsable en JSON. » en HTTP 500 (`explain.mjs:246,516`), message technique affiché tel quel à l'élève.
- Correctif prévu : schéma zod (`diagnostic`/`resolution`/`tip` obligatoires, `lesson` optionnelle et dégradable), nettoyage des balises/préfixes, 1 retry contrôlé (budget réservé pour 2 appels max, `finish_reason=length` ⇒ prompt plus court), repli lisible côté client.

### 6. Budget remboursé alors que l'appel est facturé
- `explainMistake` lève après avoir reçu la réponse payante si le JSON est inutilisable (`explain.mjs:245-247`) ; le `catch` appelle alors `release` (`:497-500`) → le budget n'enregistre pas le coût réel des tokens consommés. Même chose après un timeout côté client alors que DeepSeek a continué. Un flux d'échecs de parsing = dépense invisible pour `ai_budget`.
- Correctif prévu : `finalize` avec le coût réel (ou la réservation) dès que DeepSeek a répondu 200, `release` seulement si aucune facturation n'a eu lieu (erreur réseau avant réponse, 4xx/5xx).

### 7. Génération admin hors budget
- `admin.mjs:50-67` appelle DeepSeek avec `DEEPSEEK_API_KEY`, `max_tokens: 8000`, sans `reserve/finalize` : la dépense n'est pas imputée à `ai_budget`, le plafond de 10 € ne la voit pas. Limite 10/h/utilisateur **en mémoire** (`buckets`), donc contournable comme en 1.
- Duplication : `PRICES`, `peakUTC`, `cost` redéfinis (`admin.mjs:6,40-49`) au lieu d'importer `deepseek-config.mjs` (risque de divergence de prix).
- Autres : `publish` génère `order_index` avec `Date.now() % 1e8 + i` (collisions possibles, ordre non garanti) ; les erreurs internes (« Base des utilisateurs indisponible (503) ») sont renvoyées telles quelles (`admin.mjs:164`) ; setup initial non atomique (deux requêtes simultanées avec le code correct peuvent créer deux admins, `admin-users.mjs:36-41`).

## 🟡 Moyens

### 8. `\\n` littéral dans le contexte envoyé à l'IA — **bug confirmé**
`explain.mjs:132` et `:167` : `` `${d.title}\\n${d.body.join("\\n")}` `` dans un gabarit produit les deux caractères `\` `n`, pas un saut de ligne. L'IA reçoit un document sur une seule ligne avec des `\n` visibles, et pour la Part 6 les paragraphes sont collés. Repro : appeler `findQuestion("q7-1-1")` et afficher `.context`. Impact : qualité des explications, tokens inutiles.

### 9. Course dans `PracticeClient.fetchExplanation` — **bug confirmé par lecture**
`PracticeClient.tsx:76-126` : aucune annulation (`AbortController`) ni vérification que la question affichée est toujours celle de la requête. Si l'élève clique « Question suivante » pendant le chargement, `resetForNext` remet l'état à zéro, puis la réponse tardive appelle `setExplanation`/`setLatencyMs` sur la **nouvelle** question, et son `finally` met `aiLoading=false` pendant qu'une 2ᵉ requête est peut-être en cours. Repro : se tromper, cliquer rapidement « Question suivante », se tromper à nouveau. `Part6Inline` protège mieux (`prev.questionId !== q.id`) mais n'annule pas la requête non plus. Aucun nettoyage au démontage.

### 10. Quota quotidien non remboursé
`ai_release_explain` rembourse le budget mais pas `ai_daily_usage.used` : un utilisateur connecté qui subit 3 erreurs DeepSeek perd 3 de ses 10 explications du jour.

### 11. Clé personnelle quelconque = contournement des limites
Tout en-tête `X-DeepSeek-Api-Key` non vide (même invalide) passe `hasUserKey` (`explain.mjs:319,332`) : ni limite de débit, ni quota, ni budget, et chaque appel déclenche un aller-retour DeepSeek. Pas de risque de coût pour le propriétaire (la clé de l'appelant est utilisée), mais l'endpoint devient un amplificateur gratuit de temps de calcul serverless. Une erreur 401 DeepSeek ressort en HTTP 500 sans message adapté. Le cache n'est pas protégé non plus : une explication produite avec une clé personnelle est enregistrée dans le cache partagé (acceptable, mais à documenter).

### 12. Données : biais de réponses
Répartition des bonnes réponses : A 12, B 15, C 4, D 2 sur 33 → « choisir A ou B » donne ~80 %. Nuit à la valeur d'entraînement. Correctif prévu : rééquilibrage (permutation d'options, mêmes textes) via script de migration contrôlé par `check:data`.

### 13. Identifiants incohérents Supabase / JSON
`generate-seed-sql.mjs:4-10` transforme `p5-1`… en UUID stables. Le client charge d'abord Supabase (`data.ts:31`) puis retombe sur le JSON : le carnet d'erreurs (`progress.ts`, clés `question.id`) enregistre des UUID ou des ids lisibles selon la source disponible, donc des erreurs « orphelines » en cas de bascule. Correctif prévu : table de correspondance ou stockage des deux identifiants (champ `legacyId`/`slug`).

### 14. Accessibilité de base (point 8, volet a11y)
- `InlineSelect.tsx` : menu = `div` de `button`s sans `aria-haspopup`/`aria-expanded`/`role="listbox"`, pas de gestion Échap/flèches, pas de retour du focus, fermeture à la souris seulement (`mousedown`). Le déclencheur « n°1 » n'a pas de nom accessible explicite.
- `SettingsModal.tsx` : `role="dialog"` OK mais pas de piège de focus, `label` non relié à l'`input` (pas de `htmlFor`/`id`), fermeture par clic sur le fond sans équivalent clavier hors Échap.
- `PracticeClient.tsx:236-274` : choix de réponse = boutons sans `aria-pressed`/groupe `radiogroup` ; résultat correct/incorrect transmis par la couleur et l'icône sans `aria-live`.
- `index.css:160` : `prefers-reduced-motion` ramène les durées à 0,01 ms mais l'aurore reste affichée avec des animations `infinite` (scintillement possible) ; contrastes des cartes « glass » non mesurés.

## ⚪ Faibles / dette technique

### 15. Taux de change et prix (point 4)
- `quota.mjs:51` : `Number(env.AI_USD_EUR_RATE) || 0.93` ; `.env.example:44` fixe 0,93 sans avertissement. La conversion est correcte (`10 € / 0,93 = 10,75 $`) mais le taux dérive avec le marché.
- Coût réel (`deepseek-config.mjs:30-48`) : cohérent avec les champs `usage` (`prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`) ; les tokens de raisonnement sont inclus dans `completion_tokens`. Le multiplicateur « heures de pointe » dépend de l'heure du calcul (≠ heure de facturation), négligeable. Prix codés en dur (vérifiés le 2026-10-18) : à relire si DeepSeek change ses tarifs. La réservation de 0,002 $ couvre le pire cas hors thinking (≈ 0,0015 $ en pointe) ; avec `DEEPSEEK_THINKING_ENABLED=true` la marge n'est plus garantie.
- Correctif prévu : avertissement dans `.env.example`/README, option `AI_USD_EUR_RATE_URL` facultative **non retenue** (complexité) → on documente et on logue au démarrage un avertissement si le taux est celui par défaut (décision la plus simple).

### 16. Dette technique et divers
- **Vote 👍/👎** : `PracticeClient.tsx:143-146` est un no-op ; `feedback_votes` et `attempts` (`schema.sql:30-45`) ne sont jamais écrites par le code. Ils sont sous RLS sans politique d'écriture → inutilisables en l'état.
- `seed.sql` : `insert` simples, non idempotent (relancer échoue sur les clés primaires) ; `schema.sql` : `create policy` non idempotent. **Synchronisation vérifiée** : régénérer `seed.sql` depuis `questions.json` produit un fichier identique (5 passages, 33 questions).
- `.env.example:51` `ADMIN_INITIAL_USERNAME` n'est lu nulle part ; la description d'`ADMIN_INITIAL_PASSWORD` laisse croire à un mot de passe alors que c'est un code de configuration (cf. README:273).
- `supabaseConfig.ts:3-4` : URL et clé *publishable* d'un projet réel codées en repli (publiques par conception, mais couplent le dépôt à ce projet).
- `/api/health` révèle si la clé serveur est configurée (⚪).
- Pas de lint, pas de CI (`.github/` absent), `zod` absent, `check:data` absent. Messages d'erreur client mentionnant `DEEPSEEK_API_KEY` à des élèves (`PracticeClient.tsx:117`, `Part6Inline.tsx`).
- Fichiers `admin.mjs`, `admin-users.mjs`, `Admin.tsx` écrits en une ligne dense, difficilement relisibles/testables.

---

## Point 6 — Cohérence des noms (recensement, aucun renommage)

| Nom | Où |
|---|---|
| **Lernoviq** | `index.html` (titre), README (titre), `AuthModal.tsx`, `supabaseAuth.ts` (`lernoviq_auth_session`), commentaires SQL |
| **Lexora** | table `public.lexora_admin_users` (`supabase/admin_users.sql`, `admin-users.mjs:3-5`), cookie `lexora_admin` (`admin-users.mjs:3,44`), classes CSS `lexora-*` et `src/pages/lexora.css`, pages (`Dashboard`, `Admin`, `Diagnostic`, `Lessons`, `Practice`) |
| **toeic-reading-ai-coach** | nom du dépôt GitHub, README/`ai_explanations.sql` (« TOEIC Reading AI Coach »), message de démarrage `server.mjs:20` |
| **toeic-ai-coach** | `package.json` (`name`) |
| clés `localStorage` | `deepseek_user_api_key`, `lernoviq_auth_session`, `toeic_practice_history_v1`, `toeic_mistakes_v1` (+ clés des leçons) |

Décision proposée : **ne pas renommer** `lexora_admin_users` ni le cookie (renommer la table casserait les comptes existants et invaliderait les sessions). Documenter le choix dans le README ; si un renommage est voulu, une migration rétrocompatible = créer la vue `lernoviq_admin_users` sur `lexora_admin_users`, basculer le code sur la vue, retirer l'ancien nom dans une version ultérieure. Les noms visibles (`package.json`, message de démarrage) peuvent être alignés sans risque.

## Ce qui est correct (vérifié)
- Aucun secret serveur exposé via `VITE_*` ; `SUPABASE_SERVICE_ROLE_KEY` n'est lue que dans `server/`.
- Tables IA : RLS activée, droits retirés à `anon`/`authenticated`, fonctions `security definer` avec `search_path` fixé et exécution révoquée.
- Comparaisons de secrets en temps constant (`timingSafeEqual`), hachage `scrypt` salé, cookie `HttpOnly; SameSite=Strict`, sessions invalidées par `session_version`.
- Clé de cache `(question_id, selected_key, prompt_version, model)` cohérente avec l'unicité SQL ; `upsert` sûr en concurrence. Réserve : `PROMPT_VERSION` est un littéral à penser à incrémenter à chaque modification du prompt (aucun test ne le garantit), et `DEEPSEEK_THINKING_ENABLED` ne fait pas partie de la clé.
- Les exercices restent utilisables sans IA/quota/budget (réponses 429/503 explicites côté serveur, JSON local en secours côté client).

## Plan de correction (Phase 1, ordre proposé)
1. Migration `supabase/ai_hardening.sql` : expiration des `pending`, remboursement du quota sur `release`, quotas anonymes, table `admin_login_attempts` + fonction.
2. Serveur : IP de confiance, limiteur distribué admin, quotas anonymes, `finalize` sur réponse payante.
3. IA : zod + nettoyage + retry + repli ; correction `\\n` ; messages d'erreur côté client.
4. Client : annulation des requêtes (`AbortController`), option « ne pas mémoriser » la clé, CSP/en-têtes.
5. Données : `scripts/check-data.mjs` (`npm run check:data`), rééquilibrage des réponses, correspondance des identifiants.
6. Taux USD→EUR documenté, a11y de base (menus P6, modales), tests pour chaque correctif.

Décisions à valider avant la phase 1 : (a) `AI_FREE_REQUIRES_AUTH` — recommandé `true` en production mais valeur par défaut du code conservée à `false` ; (b) pas de renommage de la table `lexora_admin_users` ; (c) ajout de la dépendance `zod`.


---

## Suivi phase 1 (correctifs)

Commits : durcissement serveur (`fix(serveur)`), client/CSP/a11y (`fix(client)`), données (`fix(données)`).
Tests ajoutés : `tests/hardening.test.mjs`, `tests/security-headers.test.mjs`, `tests/check-data.test.mjs`, `tests/rate-limit.test.mjs` (IP de confiance). Total : 77 tests verts.

Non traité en phase 1 (reporté ou volontairement laissé) :
- Jetons Supabase Auth en `localStorage` (inhérent au client REST léger actuel).
- Pas de limite de débit pour une clé DeepSeek personnelle (le coût est à la charge de son titulaire).
- `order_index` de la publication admin, messages d'erreur internes renvoyés par l'admin, course du `setup` initial.
- Vote 👍/👎 sans effet, tables `attempts` / `feedback_votes` inutilisées (reprises en phase 2/3 avec l'historique et le signalement).
- Lint et CI (phase 4), contrastes AA et `AuthModal` (phase 4).
- Les tests ne couvrent pas les fonctions SQL elles-mêmes (pas de Postgres local) : à valider une fois dans Supabase.
