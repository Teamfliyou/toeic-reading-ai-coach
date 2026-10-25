# Banque d'exercices évolutive (100 000+ questions)

Ce document décrit l'architecture de la bibliothèque, l'importation massive et la génération
massive par DeepSeek, ainsi que les opérations de déploiement. Tout ce qui est décrit ici est couvert
par des tests (`tests/bank-*.test.mjs`) exécutés sur un vrai PostgreSQL (PGlite) : voir « Tests ».

## 1. Principes

| Besoin | Réponse |
| --- | --- |
| Ne jamais charger 100 000 questions dans le navigateur | L'élève demande une **série** (20 questions de partie 5, 3 documents en parties 6/7) : fonctions SQL `bank_pick_questions` / `bank_pick_passages`. Plafond de 200 lignes par appel. |
| Sélection aléatoire performante | Colonne `rand_key` indexée : le tirage parcourt l'index (aucun `ORDER BY random()`), avec retour au début de l'index si besoin. Mesuré : < 400 ms à 20 000 lignes dans PGlite (WASM), coût constant ensuite. |
| Pagination serveur | `bank_admin_list` (25 à 100 lignes, filtres, recherche plein texte, total) ; élèves : séries bornées. |
| Index SQL | `(part, rand_key)`, `(part, difficulty, rand_key)`, `(part, category, rand_key)` partiels sur `status = 'published'` ; GIN sur `search_vec` (texte) et `lsh` (quasi-doublons) ; `(created_at desc, id)` pour la liste. |
| Identification stable | `slug` unique (`q5-<12 hex de l'empreinte>` ou identifiant d'origine). Les historiques d'élèves (`user_attempts.question_id`) utilisent le slug : une question n'est **jamais** supprimée une fois publiée. |
| Doublons | Empreinte SHA-256 du contenu normalisé (ordre des propositions ignoré, passage inclus) + **index unique** partiel (hors archives) ; quasi-doublons par MinHash/LSH + similarité de Jaccard ≥ 0,7. |
| Historique des modifications | Table `question_revisions` alimentée par trigger (contenu, statut, suppression) ; version incrémentée à chaque modification ; édition avec contrôle de version (conflit 409). |
| Statuts | `draft` (brouillon), `review` (en validation), `published`, `archived`. Les élèves ne lisent que `published` (et `archived`, pour retrouver leur historique) — RLS. |
| Passages (parties 6 et 7) | Table `passages` ; un document n'est proposé que si **toutes** ses questions sont publiées ; un passage identique est réutilisé à l'import ; l'édition d'un passage met à jour l'empreinte de ses questions. |

## 2. Migrations SQL (ordre)

À exécuter dans l'éditeur SQL Supabase. Toutes sont **idempotentes et non destructives**.

1. `schema.sql`, `questions_slug.sql`, `questions_category.sql`, `seed.sql` (déjà en place).
2. `ai_explanations.sql` puis `ai_hardening.sql` (déjà en place — le budget IA est réutilisé).
3. **`question_bank.sql`** — banque : colonnes, statuts, empreintes, historique, import, file de génération, fonctions publiques et d'administration, RLS.
4. **`listening_bank.sql`** puis `listening_seed.sql` — Listening centralisé (facultatif, voir §8).

Ce que fait `question_bank.sql` sur une base existante :

- ajoute des colonnes (`status` **par défaut `published`** : les 33 questions actuelles restent visibles) ;
- calcule l'empreinte des questions existantes ; crée l'index unique anti-doublons seulement si aucun doublon n'existe (sinon un simple index et un avertissement : traitez-les dans Bibliothèque → Statistiques et doublons) ;
- remplace la lecture publique (`using (true)`) par « publié ou archivé » ;
- ne supprime ni ne réécrit aucune donnée.

Migration contrôlée recommandée : exécuter d'abord sur une **branche Supabase** ou une copie, lancer `npm run demo:bank` pour valider les écrans, puis exécuter sur la production en dehors des heures de pointe. Retour arrière : la migration n'efface rien ; remettre l'ancienne politique de lecture (`create policy … using (true)`) suffit à restaurer l'accès aux brouillons (déconseillé).

## 3. Importation massive (Bibliothèque → Importer des exercices)

1. **Fichier** : CSV, XLSX ou JSON (y compris le format actuel `data/questions.json`). 25 Mo et 20 000 lignes maximum. Modèle Excel téléchargeable (`data/import-template.json` : exemples valides des parties 5, 6 et 7, instructions, catégories).
2. **Colonnes** : association automatique (noms français ou anglais), correction manuelle, champs manquants signalés, partie et difficulté par défaut, aperçu des 20 premières lignes.
3. **Importation** : le navigateur envoie des blocs de **200 lignes** (un document n'est jamais séparé de ses questions). Chaque bloc est validé puis écrit dans **une transaction** (`bank_import_commit`), idempotent par numéro de bloc. Aucune requête ne dure plus de quelques secondes (mesuré : 10 000 lignes en environ une minute au total dans PGlite (WASM), bloc le plus lent ≈ 2,5 s) : pas de dépassement de temps Vercel.
4. **Reprise** : le même fichier (empreinte SHA-256) relance l'import là où il s'est arrêté ; un bloc rejoué ne crée aucun doublon.
5. **Rapport** : acceptées / rejetées / à corriger / doublons, ligne par ligne, exportable en CSV ; tout est enregistré en **brouillon**.

Contrôles à l'import : champs obligatoires, réponse A/B/C/D (ou 1–4, ou texte exact), partie, difficulté, document requis (parties 6/7), anglais, trou dans l'énoncé, propositions identiques, cohérence document ↔ questions (parties 6 : trous numérotés = questions), doublons exacts (fichier et base), quasi-doublons (fichier et base).

Sécurité : formats refusés (`.xls`, `.xlsm`, exécutables), faux `.xlsx`, macros (`vbaProject.bin`), **bombes ZIP** (taille décompressée plafonnée avant toute décompression), formules jamais évaluées, XML lu sans résolution d'entités, cellules tronquées à 6 000 caractères, objets sans prototype (pas de pollution), blocs de 250 lignes / 3 Mo maximum côté serveur, authentification + origine vérifiées, rôles admin/éditeur.

## 4. Génération massive (Génération massive)

Quantités : 20, 100, 500, 1 000, 2 000 ou personnalisée (jusqu'à `GEN_MAX_QUESTIONS_PER_JOB`, 5 000 par défaut ; un éditeur est limité à `GEN_EDITOR_MAX_QUESTIONS`, 100 par défaut).

- **File persistante** : un *job* (`generation_jobs`) découpé en *lots* (`generation_batches`) de 20 questions maximum (10 par défaut ; multiples de 4 pour la partie 6, de 3 pour la partie 7).
- **Traitement compatible Vercel** : un lot par requête courte (`bank-gen-tick`, ≤ 50 s). La page d'administration enchaîne les requêtes tant qu'elle est ouverte ; une tâche planifiée **facultative** (`api/cron.mjs`) fait avancer les jobs sans navigateur. Aucune boucle longue dans une requête.
- **Protection contre la double exécution** : `gen_claim_batch` (`for update skip locked`) + bail de 150 s + **jeton** vérifié à l'écriture (`lease_lost`) + une seule réservation de budget en vol par job. Un résultat d'une exécution périmée est refusé.
- **Suivi** : identifiant, statut, quantité demandée, générées / validées / à vérifier / rejetées / doublons, coût estimé et **réel** (tokens facturés), historique des erreurs, état de chaque lot.
- **Échec et reprise** : 3 essais automatiques par lot ; ensuite « Reprendre les lots en échec ». Une réponse inutilisable mais facturée reste imputée au budget.
- **Pause, annulation** : les lots non traités sont annulés ; les questions déjà générées sont conservées.
- **Budget** : même plafond mensuel et mêmes réservations atomiques que les explications (`ai_reserve_explain`) ; au plafond, le job se met **en pause** (rien n'est perdu) ; création refusée si le coût estimé dépasse le budget restant ; limite de jobs par heure.
- **Qualité pédagogique** : voir §5. Rien n'est publié automatiquement.

Estimation du coût : ≈ 0,012 $ par lot de 20 questions (plafond de réservation, `AI_ESTIMATED_GENERATION_USD`) + 0,004 $ de relecture automatique. À 0,6 $/M tokens en sortie, 1 000 questions coûtent en pratique de l'ordre de 0,1 à 0,3 $ ; le coût réel est affiché au job.

## 5. Qualité des questions

Chaque question IA enregistre : partie, difficulté, catégorie, thème professionnel, énoncé, 4 propositions, bonne réponse, **explication en français**, **justification de chaque mauvaise réponse**, identifiant du passage, origine (`ai`/`import`/`manual`), date et **version de création** (`origin_version`, ex. `gen-2026-10-25.1`).

Contrôles (`server/bank/quality.mjs`) : schéma (zod) · anglais · trou · propositions identiques · réponses multiples potentiellement correctes (justifications contradictoires, explication ambiguë, propositions « all of the above ») · fuite de la réponse dans l'énoncé · explication/justifications en français · **équilibre des bonnes réponses** (rééquilibrage par permutation, justifications suivant leur proposition) · difficulté (estimation grossière : n'alerte que sur 2 niveaux d'écart) · cohérence document ↔ questions (trous, énoncé présent dans le texte, nombre de questions) · quasi-doublons · **relecture automatique** (seconde passe IA qui résout chaque question sans voir la réponse : désaccord ou ambiguïté → brouillon à vérifier).

Issue : erreur → rejetée (non enregistrée, motif au rapport) ; alerte → **brouillon à vérifier** (`needs_review`, publication seulement avec confirmation explicite) ; sinon → « en validation ». **Limite assumée** : ces contrôles réduisent le risque, ils ne remplacent pas la relecture humaine ; l'estimation de difficulté est heuristique.

## 6. Examens et entraînement

- **Examen Reading** : 30 (partie 5, 9 faciles / 14 intermédiaires / 7 avancées) + 16 (partie 6 : 4 documents de 4 trous) + 54 (partie 7 : ensembles de 2 à 5 questions choisis par un sac à dos pour totaliser exactement 54, ensembles multi-documents favorisés) = 100 questions, 75 minutes. Questions déjà vues évitées autant que possible ; progression, retour arrière, « à revoir », correction, historique et estimation de score (jamais un score officiel ETS) conservés. Si la banque ne suffit pas : bandeau **« Examen réduit »** (accueil et résultats), durée proportionnelle, score extrapolé.
- **Séries d'entraînement** : tirage dans la banque, questions inédites d'abord, filtres par catégorie/difficulté (`#/practice/part5?category=prepositions&difficulty=1&limit=10`), filtres abandonnés un à un (et signalés) si la banque en manque, jeu JSON local en secours.
- **Adaptatif** (`#/adaptive`) : compétences pondérées par l'ancienneté (demi-vie 14 j), vitesse, tendance, erreurs répétées, objectifs ; révisions espacées, exercices ciblés, séance mixte, questions jamais vues, difficulté progressive.

## 7. Tests

| Fichier | Couvre |
| --- | --- |
| `bank-sql.test.mjs` | migration (idempotente), RLS, doublons, historique, statuts, suppression contrôlée, import reprenable, file de génération (bail, jeton, reprise), tirage, volume 20 000 lignes. |
| `bank-text.test.mjs` | parité des empreintes JavaScript ↔ SQL, LSH. |
| `bank-quality.test.mjs` | contrôles pédagogiques. |
| `bank-import.test.mjs` | colonnes, validation, **import de 10 000 questions** de bout en bout, reprise, rapport, quasi-doublons. |
| `bank-generation.test.mjs` | génération par lots, **échec et reprise**, budget, double exécution, annulation, pause, relecture IA. |
| `bank-api.test.mjs` | **sécurité de l'administration** (401, CSRF, rôles, taille, erreurs masquées), bibliothèque, **fonctionnement sans IA**. |
| `bank-client.test.mjs` | CSV/XLSX/JSON, modèle, fichiers malveillants. |
| `bank-practice.test.mjs` | **pagination**, **fallback JSON**, **examen de 100 questions**, historique et progression. |
| `adaptive.test.mjs`, `bank-listening.test.mjs`, `bank-a11y.test.mjs` | adaptatif, Listening, accessibilité. |

PGlite exécute le **vrai SQL** de `supabase/*.sql`. Limites : pas de PostgREST ni de Supabase Auth dans les tests (les appels sont simulés par `fakeSupabase`), les performances en WASM sont plus lentes qu'un Postgres réel.

## 8. Listening centralisé

`listening_bank.sql` crée `listening_items` (énoncé, transcription, choix A–C, réponse, difficulté, catégorie, thème, statut, version) et `listening_tracks` (URL audio, durée, locuteur, transcription, fournisseur). `listening_seed.sql` (généré par `npm run listening:generate`, vérifié par `check:data`) reprend les 12 exercices du JSON. L'application lit la bibliothèque quand elle contient des exercices publiés, **sinon `data/listening.json`** (comportement actuel conservé). Import en masse : action `bank-listening-import` (lignes tabulaires, 250 par appel, rejouable). **Aucun fichier audio n'est fabriqué** : une piste n'existe que si une URL d'enregistrement ou de synthèse (produite hors de l'application) est fournie ; sinon la synthèse vocale du navigateur reste utilisée.

## 9. Démonstration locale

```bash
DEMO_BULK=1 npm run demo:bank      # http://localhost:4173/#/admin (rôle admin, base en mémoire)
```

Compile l'application dans `dist-demo/`, charge la vraie migration dans PGlite et simule DeepSeek. **Contourne l'authentification : ne jamais l'exposer.**

## 10. Déploiement

Voir la section « Banque d'exercices » du README (variables, ordre des migrations, vérifications, tâche planifiée facultative).
