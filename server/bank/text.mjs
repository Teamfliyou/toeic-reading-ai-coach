// Normalisation, empreintes et similarité des questions.
//
// Les empreintes (`questionHash`, `passageHash`) reproduisent EXACTEMENT les fonctions SQL
// `bank_question_hash` / `bank_passage_hash` (supabase/question_bank.sql) : tests/bank-text.test.mjs
// vérifie la parité sur une vraie base. La similarité repose sur des « bandes » MinHash
// (LSH) stockées dans une colonne int[] indexée en GIN : on retrouve les candidats proches
// d'une question en une requête, sans comparer les 100 000 questions une à une.

import { createHash } from "node:crypto";

/** Même règle que `bank_norm` en SQL : minuscules, tout caractère hors [a-z0-9] devient un espace. */
export const norm = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const bodyText = (body) => (Array.isArray(body) ? body.map(String).join(" ") : String(body ?? ""));

/** Empreinte d'un document (titre + documents), insensible à la casse et à la ponctuation. */
export function passageHash(part, title, documents) {
  const docs = (Array.isArray(documents) ? documents : [])
    .map((d) => `${norm(d?.title)}~${norm(bodyText(d?.body))}`)
    .join("|");
  return sha256(`${part}|${norm(title)}|${docs}`);
}

/** Empreinte d'une question : l'ordre des propositions n'a pas d'importance. */
export function questionHash(part, prompt, options, passageHashValue = null) {
  const texts = (Array.isArray(options) ? options : []).map((o) => norm(o?.text));
  texts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(`${part}|${norm(prompt)}|${texts.join("|")}|${passageHashValue ?? ""}`);
}

// --- Similarité -----------------------------------------------------------------

/** Ensemble de « shingles » (mots et paires de mots) d'un texte. */
export function shingles(text) {
  const words = norm(text).split(" ").filter(Boolean);
  const set = new Set(words);
  for (let i = 0; i + 1 < words.length; i += 1) set.add(`${words[i]} ${words[i + 1]}`);
  return set;
}

/** Similarité de Jaccard exacte entre deux textes (0 à 1). */
export function jaccard(textA, textB) {
  const a = shingles(textA);
  const b = shingles(textB);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common += 1;
  return common / (a.size + b.size - common);
}

function fnv1a(text, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export const LSH_ROWS = 4;
export const LSH_BANDS = 12;

/**
 * Bandes LSH d'un texte : 12 entiers signés (compatibles int[] PostgreSQL). Deux textes
 * qui partagent au moins une bande sont des candidats ; `jaccard` tranche ensuite.
 * Un texte trop court (moins de 3 shingles) n'a pas de bandes : aucune détection approchée.
 */
export function lshBands(text) {
  const set = shingles(text);
  if (set.size < 3) return [];
  const hashes = [...set].map((s) => [fnv1a(s), fnv1a(s, 0x9e3779b1) | 1]);
  const mins = [];
  for (let i = 0; i < LSH_ROWS * LSH_BANDS; i += 1) {
    let min = 0xffffffff;
    for (const [h1, h2] of hashes) {
      const value = (h1 + Math.imul(i + 1, h2)) >>> 0;
      if (value < min) min = value;
    }
    mins.push(min);
  }
  const bands = [];
  for (let b = 0; b < LSH_BANDS; b += 1) {
    let h = 2166136261 ^ b;
    for (let r = 0; r < LSH_ROWS; r += 1) h = Math.imul(h ^ mins[b * LSH_ROWS + r], 16777619);
    bands.push(h | 0);
  }
  return bands;
}

/** Texte comparé pour la similarité : la phrase seule en partie 5, énoncé + choix ensuite. */
export function similarityText(part, prompt, options) {
  if (part === 5) return String(prompt ?? "");
  return [prompt, ...(Array.isArray(options) ? options.map((o) => o?.text) : [])].join(" ");
}

/** Texte d'un document pour la similarité (titre + corps de tous les documents). */
export function passageText(title, documents) {
  return [title, ...(Array.isArray(documents) ? documents.map((d) => `${d?.title ?? ""} ${bodyText(d?.body)}`) : [])].join(" ");
}

/** Seuil à partir duquel deux questions sont signalées comme « trop proches ». */
export const SIMILAR_THRESHOLD = 0.7;

/** Compare deux bandes de listes : vrai si au moins une bande est identique. */
export const shareBand = (a, b) => {
  if (!a?.length || !b?.length) return false;
  const set = new Set(a);
  return b.some((x) => set.has(x));
};

/**
 * Détecte les similarités à l'intérieur d'un lot : renvoie, pour chaque indice, la liste
 * des indices plus anciens qui lui ressemblent (Jaccard >= seuil).
 */
export function similarWithin(texts, threshold = SIMILAR_THRESHOLD) {
  const bandsOf = texts.map((t) => lshBands(t));
  const index = new Map(); // bande -> indices déjà vus
  const result = texts.map(() => []);
  texts.forEach((text, i) => {
    const candidates = new Set();
    for (const band of bandsOf[i]) for (const j of index.get(band) ?? []) candidates.add(j);
    for (const j of candidates) {
      const score = jaccard(text, texts[j]);
      if (score >= threshold) result[i].push({ index: j, score });
    }
    for (const band of bandsOf[i]) {
      if (!index.has(band)) index.set(band, []);
      index.get(band).push(i);
    }
  });
  return result;
}

/** Générateur pseudo-aléatoire déterministe (tests reproductibles). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
