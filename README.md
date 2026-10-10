# TOEIC Reading AI Coach

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

- **Node.js** ≥ 18
- **npm** ≥ 9

## Installation

```bash
git clone https://github.com/<votre-utilisateur>/toeic-reading-ai-coach.git
cd toeic-reading-ai-coach
npm install
```

## Configuration de l'IA (DeepSeek)

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

## Scripts disponibles

| Commande          | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `npm run dev`     | Lance le serveur de développement Vite (avec proxy API intégré).  |
| `npm run build`   | Typecheck (`tsc`) puis build de production dans `dist/`.          |
| `npm run preview` | Prévisualise le build de production.                              |
| `npm start`       | Sert le build + l'API (Express) sur `http://localhost:3000`.      |

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
   node scripts/generate-seed-sql.mjs
   ```

   puis exécutez `supabase/seed.sql`.
4. Branchez l'API REST PostgREST dans `src/lib/data.ts`.

## Licence

Distribué sous licence **MIT**. Voir le fichier [LICENSE](./LICENSE).
