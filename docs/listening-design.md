# Conception du Listening (Parties 1 à 4)

Statut : **Part 2 implémentée** (premier lot). Parties 1, 3 et 4 : conception uniquement.

## 1. Objectifs et limites

- Entraîner la compréhension orale TOEIC avec les mêmes principes que le Reading : suivi des réponses, statistiques par type de question, révision espacée.
- Respect des conditions d'examen : **une seule écoute**, pas de retour en arrière sur l'audio, réponses non affichées pendant l'écoute.
- Contenu **original uniquement** (pas de reprise de questions d'examens officiels).
- Les exercices restent utilisables sans IA, sans quota et hors connexion (voir §7).
- Hors périmètre de ce lot : examen Listening complet de 100 questions, notation estimée du Listening.

## 2. Structure de l'examen visée

| Partie | Format | Support | Réponses |
| --- | --- | --- | --- |
| 1 · Photographs | 1 photo, 4 phrases entendues | image + audio | A–D (non affichées) |
| 2 · Question-Response | 1 énoncé entendu | audio | A–C (non affichées) |
| 3 · Conversations | dialogue de 2–3 voix, 3 questions | audio (+ visuel parfois) | A–D (affichées) |
| 4 · Talks | monologue, 3 questions | audio (+ visuel parfois) | A–D (affichées) |

Particularité des parties 3 et 4 : plusieurs questions partagent **un même audio** (un « set »), comme les passages du Reading.

## 3. Modèle de données

### 3.1 Aujourd'hui (Part 2) — fichier `data/listening.json`

```jsonc
{ "part2": [{
  "id": "l2-01", "part": 2, "category": "listening-wh",
  "prompt": "When does the new accountant start working here?",   // phrase prononcée
  "options": [{ "key": "A", "text": "…" }, { "key": "B", "text": "…" }, { "key": "C", "text": "…" }],
  "correctKey": "B",
  "audio": "/audio/part2/l2-01.mp3"                                  // optionnel
}] }
```

- La **transcription** = `prompt` + `options[].text` ; elle est affichée **après** la réponse.
- Les catégories (`listening-wh`, `-yes-no`, `-choice`, `-request`, `-statement`) vivent dans `data/categories.json` avec celles du Reading, et alimentent les mêmes statistiques.
- `npm run check:data` valide ce fichier (3 réponses, catégories, audio, équilibre des clés, contenu anglais).
- Les tentatives passent par `recordAnswer({ mode: "listening", spaced: false })` : même historique et même synchronisation Supabase que le Reading (`part = 2`). La répétition espacée n'est pas activée pour le Listening dans ce lot (les cartes ne savent pas encore retrouver une question audio).

### 3.2 Cible (Parties 1 à 4) — tables Supabase

```sql
-- Non appliqué : esquisse pour la suite.
create table listening_sets (          -- un audio et ses questions
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,           -- identifiant lisible, comme questions.slug
  part int not null check (part in (1,2,3,4)),
  title text,
  audio_path text,                     -- chemin dans le bucket de stockage
  image_path text,                     -- partie 1 (photo) ou visuel des parties 3-4
  image_alt text,                      -- description pour l'accessibilité
  transcript jsonb not null,           -- [{ speaker, text }]
  duration_ms int,
  created_at timestamptz not null default now()
);
create table listening_questions (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  set_id uuid not null references listening_sets(id) on delete cascade,
  order_index int not null,
  prompt text,                         -- parties 3-4 : question écrite ; partie 2 : vide (énoncé audio)
  options jsonb not null,              -- A-C (partie 2) ou A-D
  correct_key char(1) not null,
  category text,
  tags text[] not null default '{}'
);
```

Lecture publique (RLS `select using (true)`), écriture réservée au service_role / à l'espace admin, comme `questions`.

## 4. Stockage des fichiers audio

- **Bucket Supabase Storage `listening-audio`**, lecture publique, écriture par l'admin uniquement (service_role). Chemins : `part2/l2-01.mp3`, `part3/set-014.mp3`. Les URL sont référencées dans `audio_path` ; la CSP autorise déjà `media-src 'self' https://*.supabase.co`.
- Format : MP3 mono 64–96 kbit/s (voix), < 300 Ko par item de partie 2, < 2 Mo par set de partie 3/4.
- **Source des enregistrements** (à décider) : voix humaines (qualité d'examen, droits à clarifier) ou synthèse vocale de qualité produite hors ligne puis importée. Aucune reprise d'enregistrements officiels.
- **Repli actuel** : sans fichier audio, le navigateur lit le texte via la synthèse vocale (Web Speech API, `src/lib/speech.ts`). Qualité et voix dépendent de l'appareil ; suffisant pour valider le parcours, pas pour la préparation finale. Si ni fichier ni synthèse ne sont disponibles, un **mode lecture** affiche l'énoncé (signalé comme moins formateur).
- Phase 4 (PWA) : le service worker mettra en cache les audios déjà joués avec gestion des requêtes `Range`.

## 5. Composant audio (`AudioPlayer`)

- Props : `item`, `onHeard`, `onUnavailable`. États : `ready → playing → done` (ou `error`).
- **Écoute unique** : le bouton se désactive dès le démarrage ; pas de barre de progression, ni pause, ni retour (conforme à l'examen).
- Source : `item.audio` (élément `<audio>`) sinon synthèse vocale ; la séquence lue pour la partie 2 est « énoncé, pause, A., B., C. ».
- Les boutons de réponse restent inactifs tant que l'audio n'est pas terminé ; leurs textes ne sont affichés qu'**après la validation** (ou en mode lecture).
- Accessibilité : états annoncés via `role="status"`, transcription accessible après réponse ; pour les personnes sourdes ou malentendantes, un mode lecture explicite est proposé (une évolution possible est d'afficher directement la transcription sur demande, hors score).

## 6. Plan par partie

1. **Part 2 (fait)** : 12 items originaux, 5 catégories, transcription après réponse.
2. **Part 1** : composant image + 4 phrases audio ; `image_alt` obligatoire ; réponses A–D non affichées.
3. **Parts 3 et 4** : modèle « set » (1 audio, 3 questions A–D affichées pendant l'écoute), transcription par locuteur, éventuel visuel (graphique, planning).
4. **Examen Listening** : 100 questions en 45 minutes avec audio continu, estimation de score séparée (même avertissement « estimation » que pour le Reading).
5. **Répétition espacée** : les cartes référenceront `listening_questions.slug` ; la révision rejouera l'audio (une écoute).
6. **Outils admin** : import audio + transcription, relecture avant publication, mêmes garde-fous que la génération de questions Reading (jamais de publication automatique).

## 7. Disponibilité et sécurité

- Aucune clé ni appel IA dans ce flux : fonctionne hors quotas et budget.
- Contenu statique servi par l'application (`data/listening.json`) ; les audios externes passent par la CSP (`media-src`).
- Pas de donnée personnelle dans les fichiers audio ; les tentatives sont soumises à la même RLS que le Reading (`user_attempts.part` accepte 2).

## 8. Points ouverts

- Choix de la source des voix et vérification des droits.
- Seuil de qualité acceptable pour la synthèse vocale du navigateur (varie selon l'appareil et le système).
- Faut-il rendre l'écoute unique optionnelle (mode « entraînement » avec rejeu) pour les débutants ?
