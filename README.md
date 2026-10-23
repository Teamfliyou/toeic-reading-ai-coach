# Lernoviq — Coach TOEIC

> Application d'entraînement au **nouveau format du TOEIC** (section *Reading*),
> avec un **coach IA DeepSeek** qui corrige vos erreurs et vous explique
> précisément pourquoi, comme un professeur particulier.

Interface **100 % en français**, au design moderne **liquid glass**
(glassmorphism), pensée pour une lisibilité optimale des textes.

---

## Table des matières

- [Présentation](#présentation)
- [Design & UI](#design--ui)
- [Stack technique](#stack-technique)
- [Fonctionnalités](#fonctionnalités)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Configuration de l'IA (DeepSeek)](#configuration-de-lia-deepseek)
- [Explications IA gratuites (quotas & budget)](#explications-ia-gratuites-quotas--budget)
- [Scripts disponibles](#scripts-disponibles)
- [Structure du projet](#structure-du-projet)
- [Base de données (optionnel — Supabase)](#base-de-données-optionnel--supabase)
- [Licence](#licence)

---

## Présentation

La section *Reading* du TOEIC pose souvent des difficultés liées à la gestion
du temps, à la complexité des textes et aux pièges grammaticaux. Cette
application propose un **entraînement ciblé par sous-partie** avec un système de
**correction intelligente** : en cas d'erreur, DeepSeek génère une explication
sur mesure, structurée et concise.

## Design & UI

- **Liquid glass (glassmorphism)** : cartes translucides avec `backdrop-blur`,
  dégradés subtils et bordures fines.
- **Fond « aurore » animé** : halos de couleur dérivant en arrière-plan pour un
  rendu soigné et immersif.
- **Lisibilité optimisée pour les 3 sous-parties** :
  - *Part 5* : une phrase, un trou, quatre choix, lecture sans distraction.
  - *Part 6* : **trous remplis inline** — des menus déroulants au fond sombre
    opaque et au texte blanc contrasté sont intégrés directement dans le texte.
  - *Part 7* : **split-screen** — documents à gauche, questions à droite.
- **Focus mode** : interface épurée, sans distraction, pour rester concentré.

## Stack technique

| Couche     | Technologie                                        |
| ---------- | -------------------------------------------------- |
| Frontend   | **React 18 + TypeScript + Vite**                   |
| Styles     | **Tailwind CSS** (design system liquid glass)      |
| Backend    | **Express** (proxy sécurisé vers l'API DeepSeek)   |
| IA         | **DeepSeek** (`deepseek-flash`)                    |
| Données    | JSON embarqué (`data/questions.json`) + Supabase (optionnel) |

> La clé API DeepSeek n'est **jamais exposée côté client** : toutes les
> requêtes IA transitent par le serveur Express / le middleware Vite.

## Fonctionnalités

### Part 5 — Phrases à trous

Entraînement à la grammaire et au vocabulaire : une phrase incomplète, quatre
choix de réponse (A, B, C, D), validation instantanée (vert / rouge).

### Part 6 — Textes à trous interactifs inline

E-mails, lettres et articles courts comportant quatre trous. Les réponses se
remplissent **directement dans le texte** via des menus déroulants intégrés,
pour un entraînement ultra-intuitif.

### Part 7 — Compréhension écrite en split-screen

Un ou plusieurs documents (e-mails, plannings, messages croisés) affichés en
regard d'une série de questions à choix multiples.

### Correcteur IA DeepSeek

En cas de mauvaise réponse, l'application déclenche automatiquement une requête
vers DeepSeek, qui répond en français, de manière concise, au format JSON :

1. **Diagnostic** — pourquoi la réponse choisie est fausse ;
2. **Résolution** — pourquoi la bonne réponse est correcte ;
3. **Tip TOEIC** — une astuce pour repérer ce piège récurrent à l'examen.

Chaque explication peut être évaluée avec un pouce 👍 / 👎, et la latence de
réponse est affichée (objectif : < 3 secondes).

### Système de questions embarqué (fallback JSON)

Les questions sont chargées depuis `data/questions.json` : **aucune
configuration n'est requise** pour tester l'application. Une intégration
Supabase est prévue (voir [Base de données](#base-de-données-optionnel--supabase)).

## Prérequis

- **Node.js** ≥ 22.18 (les tests importent directement des modules TypeScript)
- **npm** ≥ 9

## Installation

```bash
git clone https://github.com/<votre-utilisateur>/toeic-reading-ai-coach.git
cd toeic-reading-ai-coach
npm install
```

## Configuration de l'IA (DeepSeek)

Deux façons de fournir une clé API DeepSeek :

### 1. Depuis l'interface (recommandé)

Cliquez sur l'icône **Paramètres** (engrenage) dans le tableau de bord ou
l'en-tête d'une session. Saisissez votre clé (`sk-...`) et cliquez sur
**Enregistrer**. Par défaut la clé reste **en mémoire** et disparaît au
rechargement de la page. Cochez **Mémoriser sur cet appareil** pour la conserver
dans le `localStorage` (`deepseek_user_api_key`) : pratique, mais lisible par tout
script exécuté dans la page (à éviter sur un poste partagé). Elle est transmise
au serveur via l'en-tête `X-DeepSeek-Api-Key`, jamais journalisée ni renvoyée.

Le serveur applique une **CSP stricte** et des en-têtes de sécurité (`vercel.json`
sur Vercel, `server/security-headers.mjs` avec `npm start`), ce qui limite l'impact
d'une éventuelle faille XSS.

Un indicateur vous indique l'état :

- 🟢 **Clé personnelle active** — votre clé est utilisée.
- 🔵 **Clé du serveur par défaut** — la clé du fichier `.env` est utilisée.

### 2. Via le fichier `.env` (clé du serveur)

1. Obtenez une clé API sur [platform.deepseek.com](https://platform.deepseek.com/api_keys).
2. Créez un fichier `.env` à la racine (à partir de `.env.example`) :

   ```bash
   DEEPSEEK_API_KEY=sk-votre-cle-api
   ```

3. Lancez l'application :

   ```bash
   npm run dev
   ```

   Puis ouvrez [http://localhost:5173](http://localhost:5173).

> Sans clé, l'application fonctionne entièrement : seules les explications IA
> sont désactivées (les réponses sont tout de même corrigées).

## Explications IA gratuites (quotas & budget)

Lernoviq peut offrir les explications IA à ses utilisateurs **tout en
maîtrisant strictement le budget** : la clé DeepSeek reste sur le serveur et
chaque appel à la clé du serveur est encadré par un quota et un budget
atomiques.

### Fonctionnement

1. **Authentification Supabase Auth** (facultative au démarrage) : le
   navigateur envoie `Authorization: Bearer <jwt>`. Le serveur valide le jeton
   via `GET /auth/v1/user` (avec cache court). Un bouton **Se connecter** (et
   une modale e-mail + mot de passe) apparaît dans l'en-tête dès que
   `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY` sont définis ; le
   jeton est joint automatiquement aux requêtes d'explication.
2. **Cache partagé** (`public.ai_explanations`) : une explication identique
   (question + réponse choisie + version de prompt + modèle) est resservie
   **sans consommer de quota ni appeler DeepSeek**.
3. **Réservation atomique** (`public.ai_reserve_explain`) : quota quotidien,
   débit par minute, unicité en vol et budget mensuel sont vérifiés **dans une
   seule transaction Postgres** — aucune course possible en serverless.
4. **Appel DeepSeek** encadré : `deepseek-flash`, mode *thinking* désactivé par
   défaut, `max_tokens` borné, délai d'expiration, `user_id` d'isolation.
5. **Enregistrement + finalisation** : la réponse IA est **enregistrée en base**
   (historique + cache) puis la réservation est remplacée par le coût réel. En
   cas d'échec avant toute réponse de DeepSeek, la réservation est **libérée**
   (budget et quota remboursés) ; si DeepSeek a répondu mais que le résultat est
   illisible, le **coût réel reste imputé** au budget. Une réservation orpheline
   (fonction serverless interrompue) expire d'elle-même après 2 minutes.
5. Les réponses de DeepSeek sont validées (schéma `zod`), nettoyées des balises
   markdown, et relancées **une fois** si elles sont tronquées ou invalides ; sinon
   un message lisible est affiché.

### Migration Supabase

Exécutez, dans cet ordre, `supabase/ai_explanations.sql` puis
**`supabase/ai_hardening.sql`** (expiration des réservations bloquées, quota
remboursé sur échec, limitation de connexion admin ; idempotent). Les tables
sont accessibles uniquement au serveur (`service_role`), comme
`public.lexora_admin_users`.

### Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DEEPSEEK_MODEL` | `deepseek-flash` | Modèle (source unique : `server/deepseek-config.mjs`). |
| `DEEPSEEK_THINKING_ENABLED` | `false` | `true` réactive le mode *thinking* (coût des tokens de raisonnement). |
| `DEEPSEEK_MAX_TOKENS` | `1024` | Plafond de tokens en sortie. |
| `DEEPSEEK_TIMEOUT_MS` | `22000` | Délai maximal d'un appel DeepSeek. |
| `AI_DAILY_LIMIT` | `10` | Quota quotidien par utilisateur connecté. |
| `AI_ANON_DAILY_LIMIT` | `5` | Quota quotidien par IP pour les visiteurs non connectés. |
| `AI_ANON_PER_MINUTE` | `2` | Débit par minute et par IP pour les visiteurs non connectés. |
| `TRUST_PROXY` | — | `true` derrière un reverse proxy de confiance : l'IP client est lue dans `x-forwarded-for`. Détecté automatiquement sur Vercel. Sinon l'IP est celle de la socket (non falsifiable). |
| `AI_PER_MINUTE` | `3` | Débit par minute et par utilisateur connecté. |
| `AI_MONTHLY_LIMIT_EUR` | `10` | Budget mensuel (limite dure). |
| `AI_MONTHLY_SUSPEND_EUR` | `8` | Seuil de suspension des nouvelles générations. |
| `AI_USD_EUR_RATE` | `0.93` | Taux USD→EUR (DeepSeek facture en dollars). **Valeur fixe : à mettre à jour** quand le change évolue ; un avertissement s'affiche au démarrage tant qu'elle n'est pas définie. |
| `AI_ESTIMATED_CALL_USD` | `0.004` | Réservation a priori par appel (majorée ; couvre une nouvelle tentative). |
| `AI_ESTIMATED_GENERATION_USD` | `0.012` | Réservation a priori d'une génération de questions (admin). |
| `AI_ESTIMATED_FOLLOWUP_USD` | `0.002` | Réservation a priori d'une question de relance au coach. |
| `ADMIN_GENERATE_PER_HOUR` | `10` | Générations de questions par administrateur et par heure (comptées en base). |
| `AI_FREE_REQUIRES_AUTH` | `false` | `true` exige un compte pour l'explication gratuite. **Recommandé en production** : sans compte, seule l'IP limite l'usage. |
| `ADMIN_LOGIN_MAX_PER_IP` | `20` | Tentatives de connexion admin par IP et par fenêtre. |
| `ADMIN_LOGIN_MAX_PER_USER` | `8` | Tentatives par identifiant et par fenêtre (quelle que soit l'IP). |
| `ADMIN_LOGIN_WINDOW_SECONDS` | `900` | Fenêtre glissante de la limitation de connexion. |
| `SUPABASE_ANON_KEY` | — | Vérification des jetons Supabase Auth (serveur). |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Persistance, quotas et budget (serveur uniquement). |

### Disponibilité des exercices

Les exercices TOEIC **restent accessibles** même si le quota ou le budget IA est
épuisé : seul le panneau d'explication affiche un message (les corrections
locales continuent de fonctionner). Aucune clé DeepSeek n'est exposée au
navigateur.

## Entraînement avancé (phase 2)

| Page | Route | Description |
| --- | --- | --- |
| Examen blanc | `#/exam` | Parties 5, 6, 7 à la suite, minuteur de **75 minutes** (calculé depuis l'échéance : survit à un rechargement), navigation libre, marquage « à revoir », correction et **score Reading estimé sur 495**. La conversion est une table **approximative** (le barème officiel n'est pas publié) ; si le jeu de questions compte moins de 100 questions, le score est extrapolé et signalé comme tel. |
| Statistiques | `#/stats` | Réussite par partie et par type de piège (catégorie), temps moyen par question, courbe de progression, série de jours, répartition des boîtes de révision. |
| À réviser aujourd'hui | `#/review` | Répétition espacée **Leitner** : boîtes 1 à 5 (rappels après 1, 2, 4, 8 puis 16 jours). Une erreur renvoie en boîte 1 ; une bonne réponse sur une carte *due* la fait monter ; réussir en boîte 5 la marque « maîtrisée ». Une bonne réponse hors échéance ne fait pas monter la carte. Les anciennes erreurs (`toeic_mistakes_v1`) sont reprises automatiquement. |
| Listening · Partie 2 | `#/listening/part2` | Question-réponse : **une seule écoute**, réponses A–C affichées après validation, transcription ensuite. Voir `docs/listening-design.md`. |

**Historique.** Chaque réponse (question, réponse, juste/faux, temps, date, mode) est enregistrée dans le `localStorage` pour les visiteurs anonymes. Pour un utilisateur connecté, l'historique et les cartes de révision sont synchronisés avec Supabase (tables `user_attempts` et `user_review_cards`, **RLS par utilisateur**, lues et écrites directement par le navigateur avec son jeton). Les données anonymes locales sont rattachées au premier compte qui se connecte sur l'appareil. Hors ligne, tout reste en local et se synchronise plus tard.

**Catégories.** Chaque question porte une `category` (liste dans `data/categories.json`) et des `tags`. Pour de nouvelles questions, ajoutez-les dans `scripts/tag-questions.mjs` (ou renseignez-les directement dans le JSON) puis lancez `npm run check:data`. Les questions déjà publiées dans Supabase sans catégorie reçoivent celle du jeu local lorsque l'énoncé est identique.

**Listening.** Sans fichier audio, la Part 2 utilise la synthèse vocale du navigateur (qualité variable) ; un mode lecture est proposé si aucun son n'est disponible. Pour de vrais enregistrements, renseignez le champ `audio` d'un item de `data/listening.json` (chemin ou URL https `.mp3`).

### Migrations Supabase de la phase 2

Dans l'éditeur SQL, dans cet ordre (toutes idempotentes) :

1. `supabase/questions_category.sql` : colonnes `category` et `tags` des questions.
2. `supabase/seed.sql` (régénéré) : renseigne catégories et tags du jeu de départ.
3. `supabase/user_data.sql` : tables `user_attempts` et `user_review_cards` + politiques RLS.

Sans ces migrations l'application fonctionne : le suivi reste local et la synchronisation est simplement ignorée.

## Fonctionnalités complémentaires (phase 3)

| Fonctionnalité | Où | Description |
| --- | --- | --- |
| Carnet de vocabulaire | `#/vocab` | « Ajouter à mes mots » sous chaque explication (mot, sens, exemple pré-rempli). Révision en **flashcards** avec les mêmes boîtes Leitner que les erreurs. Synchronisé pour un utilisateur connecté. |
| Signalement d'une question | bouton « Signaler une erreur » après une réponse | Formulaire court (motif + commentaire), stocké dans `question_reports`. L'IP n'est jamais conservée (empreinte salée pour limiter les abus : 10 signalements par heure). Liste et traitement dans **Administration → Signalements**. |
| Génération de questions (admin) | Administration → Génération | Générer → **relire et modifier** (énoncé, choix, bonne réponse, catégorie, explication, document) → cocher la relecture → publier. Jamais de publication automatique ; mêmes quotas et même budget mensuel que les explications. |
| Objectif et plan d'étude | `#/goals` + carte sur le tableau de bord | Date d'examen, score visé, objectif quotidien, série de jours, plan indicatif (rythme quotidien selon l'écart au score visé, un examen blanc par semaine, pièges prioritaires). |
| Question de relance | sous l'explication du coach | Jusqu'à 3 questions complémentaires par question, historique limité à la question en cours, mêmes quotas/budget (`/api/coach`, réservation `AI_ESTIMATED_FOLLOWUP_USD`, 0,002 $ par défaut). |

### Migrations Supabase de la phase 3

À exécuter dans l'éditeur SQL (idempotentes) :

1. `supabase/user_vocab.sql` : carnet de vocabulaire (RLS par utilisateur).
2. `supabase/user_goals.sql` : objectifs (RLS par utilisateur).
3. `supabase/question_reports.sql` : signalements (service_role uniquement).

Sans elles, le vocabulaire et les objectifs restent en local et le signalement répond « indisponible » sans bloquer les exercices.

## Qualité, hors ligne et administration (phase 4)

### Application installable et hors ligne (PWA)
`public/manifest.webmanifest`, icônes générées par `node scripts/generate-icons.mjs` et service worker `public/sw.js` (enregistré en production uniquement). Après une première visite en ligne, l'application, ses assets et les questions locales fonctionnent hors connexion ; les questions Supabase lues sont mises en cache (réseau d'abord). Un bandeau « Hors connexion » s'affiche, et les explications / questions de relance du coach IA sont désactivées avec un message clair. **Jamais mis en cache** : `/api/*`, l'authentification et les données personnelles (`user_*`). En cas de mise à jour, la version du cache (`VERSION` dans `sw.js`) est à incrémenter si la stratégie change.

### Accessibilité
Navigation clavier complète, lien « Aller au contenu », titre de page et focus déplacés à chaque changement de page, boîtes de dialogue modales avec piège de focus (`useDialog`), menus déroulants de la partie 6 en `listbox` (flèches, Échap, Début/Fin), régions nommées pour le split-screen de la partie 7, résultats annoncés (`aria-live`), `prefers-reduced-motion` respecté (fond aurore figé). Les contrastes des textes secondaires sont vérifiés (AA, 4,5:1) par `tests/contrast.test.mjs` ; les autres contrôles restent manuels (lecteur d'écran, zoom 200 %).

### CI
`.github/workflows/ci.yml` : à chaque push et pull request, `npm ci`, `tsc`, `npm run lint` (ESLint), `npm test`, `npm run check:data`, `npm run build` (Node 24).

### Journal d'audit et MFA
Les actions sensibles (connexion, création de compte, rôle, activation/désactivation, réinitialisation de mot de passe, génération et publication de questions, traitement d'un signalement) sont tracées dans `admin_audit_log` (ajout seul, aucun mot de passe ni jeton, IP sous forme d'empreinte salée) et consultables dans **Administration → Journal** (administrateurs). La **MFA TOTP** est préparée (module `server/totp.mjs`, colonnes SQL) mais **non imposée** : voir `docs/admin-mfa.md` pour l'activer.

### Mesure d'audience (facultative)
Désactivée par défaut. Renseignez `VITE_PLAUSIBLE_DOMAIN` (variable publique, incluse au build) pour activer [Plausible](https://plausible.io) : sans cookie, sans donnée personnelle, « Do Not Track » respecté. La CSP autorise déjà `https://plausible.io` ; pour un Plausible auto-hébergé, définissez aussi `VITE_PLAUSIBLE_SRC` et ajoutez son domaine à la CSP (`server/security-headers.mjs` et `vercel.json`). Reconstruire l'application après modification.

### Migration Supabase de la phase 4
`supabase/admin_audit.sql` (journal d'audit + colonnes MFA, idempotent). Sans elle, le journal reste vide (un avertissement apparaît dans les logs serveur) et les actions d'administration continuent de fonctionner.

## Scripts disponibles

| Commande          | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `npm run dev`     | Lance le serveur de développement Vite (avec proxy API intégré).  |
| `npm run build`   | Typecheck (`tsc`) puis build de production dans `dist/`.          |
| `npm run preview` | Prévisualise le build de production.                              |
| `npm start`       | Sert le build + l'API (Express) sur `http://localhost:3000`.      |
| `npm test`        | Lance les tests (`node --test`).                                  |
| `npm run lint`    | ESLint (TypeScript, React hooks).                                 |
| `npm run check:data` | Valide `data/questions.json` et la synchronisation de `seed.sql`. |
| `node scripts/tag-questions.mjs` | Ajoute/rafraîchit `category` et `tags` dans `data/questions.json` (puis `npm run seed:generate`). |
| `npm run seed:generate` | Régénère `supabase/seed.sql` depuis `data/questions.json`.  |

## Structure du projet

```
index.html                # Point d'entrée HTML
src/
  main.tsx / App.tsx      # Bootstrap + routeur minimal (hash)
  pages/                  # Dashboard + Practice
  components/             # UI liquid glass + moteurs de quiz (Part 5/6/7)
  lib/                    # types, métadonnées des parties, accès aux données
server/
  explain.mjs             # Proxy DeepSeek (prompt + appel API + parsing JSON)
  deepseek-config.mjs     # Modèle, prix et version de prompt (source unique)
  store.mjs               # Persistance + cache des explications (Supabase)
  auth.mjs                # Vérification des jetons Supabase Auth
  quota.mjs               # Quotas + budget (réservations atomiques)
server.mjs                # Serveur de production (Express)
data/questions.json       # Jeu de données local (fallback)
supabase/                 # Schéma + seed SQL (optionnel)
```

## Base de données (optionnel — Supabase)

Par défaut, les données proviennent de `data/questions.json`. Pour brancher
Supabase :

1. Créez un projet sur [Supabase](https://supabase.com).
2. Exécutez `supabase/schema.sql` dans l'éditeur SQL.
3. Générez puis exécutez le seed :

   ```bash
   npm run seed:generate
   ```

   puis exécutez `supabase/seed.sql` (idempotent). Sur une base **déjà créée**,
   exécutez d'abord `supabase/questions_slug.sql` (ajoute la colonne `slug`, qui
   garde l'identifiant lisible `q5-01` pour que le carnet d'erreurs reste valable
   que les questions viennent de Supabase ou du JSON local). Après toute
   modification des questions, lancez `npm run check:data`.
4. Branchez l'API REST PostgREST dans `src/lib/data.ts`.

## Licence

Distribué sous licence **MIT**. Voir le fichier [LICENSE](./LICENSE).


## Administration multi-utilisateurs (Lernoviq)

L'espace admin se trouve à `/#/admin`. Les comptes sont stockés dans `public.lexora_admin_users` dans Supabase avec un mot de passe haché avec scrypt et un sel aléatoire unique.

1. Exécutez `supabase/admin_users.sql` dans le SQL Editor du projet Supabase.
2. Définissez côté serveur `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SESSION_SECRET` (au moins 32 caractères), `ADMIN_INITIAL_USERNAME=admin` et `ADMIN_INITIAL_PASSWORD` (12 caractères minimum, fort et unique). Ne jamais préfixer ces secrets par `VITE_`.
3. Redéployez. Lors de la première connexion, si la table est vide, le serveur crée automatiquement le compte `admin` avec le mot de passe fourni. Aucun mot de passe public par défaut n'est codé dans le dépôt.
4. Dans **Administration → Utilisateurs**, créez des comptes `admin` ou `editor`, changez leur rôle, désactivez-les ou réinitialisez leur mot de passe.

Un éditeur peut générer et publier des questions, mais ne peut pas gérer les autres comptes. Une modification de compte invalide immédiatement ses sessions. Pour des raisons de sécurité, la suppression définitive n'est pas proposée : désactivez un compte à la place. La configuration de `ADMIN_INITIAL_PASSWORD` reste requise par le serveur, mais modifier cette variable après le premier compte créé ne change pas son mot de passe ; utilisez l'interface pour cela.


## Initialisation sécurisée de l'administration (Vercel)

- Déployez le schéma `supabase/admin_users.sql` dans **la base Supabase du projet**.
- Dans Vercel (Production), définissez `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` et `ADMIN_SESSION_SECRET` (32 caractères minimum).
- Définissez `ADMIN_INITIAL_PASSWORD` comme **code de configuration privé** fort (16 caractères minimum). Ce code ne devient **pas** le mot de passe du compte créé.
- Ouvrez `/#/admin`. Si la table des utilisateurs est vide, l'assistant de configuration propose de créer le premier administrateur avec son identifiant, un mot de passe et sa confirmation.
- La création du premier compte exige le code privé. Dès qu'un compte existe, l'inscription publique est fermée. Les comptes supplémentaires sont créés exclusivement par un administrateur authentifié dans l'onglet Utilisateurs.
- Les comptes existants dans `lexora_admin_users` sont conservés : le nouveau processus ne les réinitialise pas, et n'affiche pas l'assistant si la base contient déjà un compte.

**Important :** n'ajoutez jamais `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_INITIAL_PASSWORD` ou `ADMIN_SESSION_SECRET` à des variables `VITE_*` ni au code client. Les sessions sont signées, en cookies HttpOnly/SameSite, valables 8 h. La limitation des tentatives de connexion est **distribuée** (table `admin_login_attempts`, par IP et par identifiant, fenêtre glissante) : exécutez `supabase/ai_hardening.sql`. Sans cette migration, un repli en mémoire (moins fiable sur Vercel Serverless) est utilisé. À terme, ajouter la MFA.

**Nommage.** Le produit s'appelle *Lernoviq*, mais la table `public.lexora_admin_users`, le cookie `lexora_admin` et les classes CSS `lexora-*` conservent l'ancien nom *Lexora* : les renommer invaliderait les comptes et sessions existants. Si un renommage est un jour souhaité : créer une vue `lernoviq_admin_users` sur la table, basculer le code sur la vue, puis retirer l'ancien nom dans une version ultérieure. `ADMIN_INITIAL_PASSWORD` est un **code de configuration privé** (pas le mot de passe du compte) ; `ADMIN_INITIAL_USERNAME` n'est pas utilisé par le serveur.
