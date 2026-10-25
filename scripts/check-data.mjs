// Valide data/questions.json (schéma, cohérence des parties 5/6/7) et vérifie
// que supabase/seed.sql en est bien la copie à jour. Usage : npm run check:data
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSeedSql } from "./generate-seed-sql.mjs";
import { buildListeningSeedSql } from "./generate-listening-sql.mjs";
import { processChunk, suggestMapping } from "../server/bank/import.mjs";
import { looksFrench } from "../server/admin.mjs";

const CATEGORIES = JSON.parse(
  readFileSync(new URL("../data/categories.json", import.meta.url), "utf8")
);

const KEYS = ["A", "B", "C", "D"];
const KINDS = ["email", "memo", "article", "notice", "schedule", "letter", "message"];

/** Valide data/listening.json (Part 2 : trois réponses A, B, C). */
export function validateListening(data) {
  const errors = [];
  const err = (message) => errors.push(message);
  const items = data?.part2;
  if (!Array.isArray(items) || !items.length) return ["listening.json doit contenir un tableau « part2 »."];
  const ids = new Set();
  const counts = { A: 0, B: 0, C: 0 };
  for (const item of items) {
    const label = `Listening ${item?.id ?? "?"}`;
    if (!item?.id) { err("Listening sans id."); continue; }
    if (ids.has(item.id)) err(`${label} : id en double.`);
    ids.add(item.id);
    if (item.part !== 2) err(`${label} : partie 2 attendue.`);
    if (!item.prompt?.trim()) err(`${label} : énoncé vide.`);
    const opts = item.options;
    if (!Array.isArray(opts) || opts.length !== 3) err(`${label} : exactement 3 réponses requises.`);
    else {
      if (opts.some((o, i) => o?.key !== "ABC"[i])) err(`${label} : clés attendues A, B, C dans l'ordre.`);
      if (opts.some((o) => typeof o?.text !== "string" || !o.text.trim())) err(`${label} : réponse vide.`);
    }
    if (!["A", "B", "C"].includes(item.correctKey)) err(`${label} : correctKey « ${item.correctKey} » invalide.`);
    else counts[item.correctKey] += 1;
    const category = CATEGORIES.find((c) => c.id === item.category);
    if (!category || !category.parts.includes(2)) err(`${label} : catégorie « ${item.category} » invalide pour la partie 2.`);
    if (item.audio !== undefined && !/^(\/|https:\/\/)\S+\.(mp3|m4a|ogg|wav)$/i.test(item.audio)) err(`${label} : audio doit être un chemin ou une URL https vers un fichier audio.`);
    if ([item.prompt, ...(opts ?? []).map((o) => o?.text)].some(looksFrench)) err(`${label} : contenu apparemment en français.`);
  }
  if (items.length >= 9) {
    for (const [key, n] of Object.entries(counts)) {
      if (n / items.length > 0.5) err(`Listening : réponses déséquilibrées (${key} = ${n}/${items.length}).`);
    }
  }
  return errors;
}

/** Renvoie la liste des erreurs de validation (vide si le jeu est valide). */
export function validateDataset(data, { seedSql } = {}) {
  const errors = [];
  const err = (message) => errors.push(message);
  if (!data || !Array.isArray(data.questions) || !Array.isArray(data.passages)) {
    return ["Le fichier doit contenir « passages » et « questions » (tableaux)."];
  }

  const passages = new Map();
  for (const p of data.passages) {
    if (!p?.id || typeof p.id !== "string") { err("Passage sans id."); continue; }
    if (passages.has(p.id)) err(`Passage ${p.id} : id en double.`);
    passages.set(p.id, p);
    if (![6, 7].includes(p.part)) err(`Passage ${p.id} : partie ${p.part} invalide (6 ou 7).`);
    if (!p.title?.trim()) err(`Passage ${p.id} : titre vide.`);
    if (!Array.isArray(p.documents) || !p.documents.length) err(`Passage ${p.id} : aucun document.`);
    const docIds = new Set();
    for (const doc of p.documents ?? []) {
      if (docIds.has(doc.id)) err(`Passage ${p.id} : document ${doc.id} en double.`);
      docIds.add(doc.id);
      if (!KINDS.includes(doc.kind)) err(`Document ${doc.id} : type « ${doc.kind} » inconnu.`);
      if (!doc.title?.trim()) err(`Document ${doc.id} : titre vide.`);
      if (!Array.isArray(doc.body) || !doc.body.length || doc.body.some((l) => typeof l !== "string" || !l.trim())) {
        err(`Document ${doc.id} : corps invalide.`);
      }
    }
  }

  const ids = new Set();
  const usedPassages = new Set();
  const blanks = new Map(); // passage -> numéros de blancs de la partie 6 déjà vus
  const counts = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const q of data.questions) {
    const label = `Question ${q?.id ?? "?"}`;
    if (!q?.id || typeof q.id !== "string") { err("Question sans id."); continue; }
    if (ids.has(q.id)) err(`${label} : id en double.`);
    ids.add(q.id);
    if (![5, 6, 7].includes(q.part)) err(`${label} : partie ${q.part} invalide.`);
    if (!q.prompt?.trim()) err(`${label} : énoncé vide.`);
    const category = CATEGORIES.find((c) => c.id === q.category);
    if (!category) err(`${label} : catégorie « ${q.category} » inconnue (data/categories.json).`);
    else if (!category.parts.includes(q.part)) err(`${label} : catégorie ${q.category} incompatible avec la partie ${q.part}.`);
    if (!Array.isArray(q.tags) || q.tags.some((t) => typeof t !== "string" || !t.trim())) err(`${label} : tags (tableau de textes) requis.`);
    if (!Number.isInteger(q.orderIndex)) err(`${label} : orderIndex entier requis.`);
    if (![1, 2, 3].includes(q.difficulty)) err(`${label} : difficulté 1 à 3 requise.`);

    const opts = q.options;
    if (!Array.isArray(opts) || opts.length !== 4) {
      err(`${label} : exactement 4 choix requis.`);
    } else {
      if (opts.some((o, i) => o?.key !== KEYS[i])) err(`${label} : clés des choix attendues A, B, C, D dans l'ordre.`);
      if (opts.some((o) => typeof o?.text !== "string" || !o.text.trim())) err(`${label} : texte de choix vide.`);
      if (new Set(opts.map((o) => o?.text?.trim().toLowerCase())).size !== 4) err(`${label} : choix en double.`);
    }
    if (!KEYS.includes(q.correctKey)) err(`${label} : correctKey « ${q.correctKey} » invalide.`);
    else counts[q.correctKey] += 1;

    if (q.part === 5) {
      if (q.passageId) err(`${label} : la partie 5 n'a pas de passage.`);
      if (!/_{3,}/.test(q.prompt ?? "")) err(`${label} : la partie 5 doit contenir un blanc (______).`);
    } else if (q.part === 6 || q.part === 7) {
      const passage = passages.get(q.passageId);
      if (!passage) err(`${label} : passage « ${q.passageId} » introuvable.`);
      else {
        usedPassages.add(passage.id);
        if (passage.part !== q.part) err(`${label} : partie ${q.part} ≠ partie du passage ${passage.id} (${passage.part}).`);
        if (q.part === 6) {
          const m = /\((\d+)\)\s*_{3,}/.exec(q.prompt ?? "");
          if (!m) err(`${label} : la partie 6 doit contenir un blanc numéroté « (n)______ ».`);
          else {
            const text = passage.documents.flatMap((d) => d.body).join("\n");
            if (!text.includes(m[0])) err(`${label} : le blanc ${m[0]} est absent du passage ${passage.id}.`);
            const seen = blanks.get(passage.id) ?? new Set();
            if (seen.has(m[1])) err(`${label} : blanc n°${m[1]} répété dans ${passage.id}.`);
            seen.add(m[1]);
            blanks.set(passage.id, seen);
          }
        }
      }
    }
  }
  for (const id of passages.keys()) if (!usedPassages.has(id)) err(`Passage ${id} : aucune question associée.`);

  const total = data.questions.length;
  if (total >= 20) {
    for (const key of KEYS) {
      if (counts[key] / total > 0.4) err(`Réponses déséquilibrées : ${key} = ${counts[key]}/${total} (> 40 %).`);
    }
  }

  const french = [];
  for (const q of data.questions) {
    if ([q.prompt, ...(q.options ?? []).map((o) => o.text)].some(looksFrench)) french.push(q.id);
  }
  for (const p of data.passages) {
    if (p.documents?.some((d) => d.body?.some(looksFrench) || looksFrench(d.title))) french.push(p.id);
  }
  if (french.length) err(`Contenu apparemment en français (doit être en anglais) : ${french.join(", ")}.`);

  if (seedSql !== undefined) {
    const normalize = (s) => s.replace(/\r\n/g, "\n");
    if (normalize(seedSql) !== normalize(buildSeedSql(data))) {
      err("supabase/seed.sql n'est pas synchronisé avec data/questions.json : lancez « npm run seed:generate ».");
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = JSON.parse(readFileSync(new URL("../data/questions.json", import.meta.url), "utf8"));
  const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  const listening = JSON.parse(readFileSync(new URL("../data/listening.json", import.meta.url), "utf8"));
  const errors = [...validateDataset(data, { seedSql }), ...validateListening(listening)];

  // Migration du Listening : le script SQL de départ doit refléter data/listening.json.
  const listeningSeed = readFileSync(new URL("../supabase/listening_seed.sql", import.meta.url), "utf8");
  if (listeningSeed.replace(/\r\n/g, "\n") !== buildListeningSeedSql(listening)) {
    errors.push("supabase/listening_seed.sql n'est pas synchronisé avec data/listening.json : lancez « npm run listening:generate ».");
  }

  // Modèle d'importation : ses exemples (parties 5, 6, 7) doivent s'importer sans erreur ni alerte.
  const template = JSON.parse(readFileSync(new URL("../data/import-template.json", import.meta.url), "utf8"));
  const { mapping, missing } = suggestMapping(template.headers);
  if (missing.length) errors.push(`Modèle d'import : champs obligatoires non reconnus (${missing.join(", ")}).`);
  const imported = processChunk(template.rows.map((row, i) => ({ n: i + 2, data: row })), mapping);
  for (const issue of imported.issues) errors.push(`Modèle d'import, ligne ${issue.ref} : ${issue.message}`);
  if (imported.items.length !== template.rows.length) errors.push("Modèle d'import : toutes les lignes d'exemple doivent être valides.");
  if (errors.length) {
    console.error(`check:data — ${errors.length} problème(s) :`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`check:data — OK (${data.questions.length} questions, ${data.passages.length} passages, ${listening.part2.length} items Listening, seeds synchronisés, modèle d'import valide).`);
}
