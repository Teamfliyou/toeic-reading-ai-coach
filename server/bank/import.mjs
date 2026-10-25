// Importation massive : association des colonnes, normalisation des lignes, validation,
// regroupement par document et détection des doublons d'un lot. Fonctions PURES (aucun
// accès réseau) : l'écriture en base est dans server/bank/service.mjs.

import {
  OPTION_KEYS, DOCUMENT_KINDS, categoriesForPart, checkQuestion, checkPassageGroup, outcomeFor, passageWordCount,
} from "./quality.mjs";
import { lshBands, norm, passageHash, passageText, questionHash, similarWithin, similarityText } from "./text.mjs";

export const MAX_FILE_ROWS = 20000;
export const MAX_CHUNK_ROWS = 250;
export const MAX_CELL_LENGTH = 6000;
export const MAX_GROUP_ROWS = 40;

/** Champs reconnus : identifiant interne, libellé, obligation et noms de colonnes acceptés. */
export const FIELDS = [
  { id: "part", label: "Partie (5, 6 ou 7)", required: false, aliases: ["part", "partie", "toeic part", "section"] },
  { id: "passage_ref", label: "Référence du document", required: false, aliases: ["passage ref", "passage id", "passage", "document id", "doc id", "group", "set", "passage key", "reference document"] },
  { id: "passage_title", label: "Titre du document", required: false, aliases: ["passage title", "document title", "titre du document", "titre passage", "title"] },
  { id: "doc1_kind", label: "Document 1 · type", required: false, aliases: ["doc1 kind", "document 1 kind", "passage kind", "kind", "type de document", "document type", "doc type"] },
  { id: "doc1_title", label: "Document 1 · titre", required: false, aliases: ["doc1 title", "document 1 title", "document 1 titre"] },
  { id: "doc1_text", label: "Document 1 · texte", required: false, aliases: ["doc1 text", "document 1 text", "passage text", "passage", "document", "texte", "text", "texte du document", "body", "doc1"] },
  { id: "doc2_kind", label: "Document 2 · type", required: false, aliases: ["doc2 kind", "document 2 kind"] },
  { id: "doc2_title", label: "Document 2 · titre", required: false, aliases: ["doc2 title", "document 2 title"] },
  { id: "doc2_text", label: "Document 2 · texte", required: false, aliases: ["doc2 text", "document 2 text", "doc2"] },
  { id: "doc3_kind", label: "Document 3 · type", required: false, aliases: ["doc3 kind", "document 3 kind"] },
  { id: "doc3_title", label: "Document 3 · titre", required: false, aliases: ["doc3 title", "document 3 title"] },
  { id: "doc3_text", label: "Document 3 · texte", required: false, aliases: ["doc3 text", "document 3 text", "doc3"] },
  { id: "question_number", label: "Rang dans le document", required: false, aliases: ["question number", "question no", "number", "no", "n", "order", "ordre", "rang", "order index", "position"] },
  { id: "prompt", label: "Énoncé de la question", required: true, aliases: ["prompt", "question", "enonce", "énoncé", "stem", "sentence", "phrase", "question text"] },
  { id: "option_a", label: "Proposition A", required: true, aliases: ["option a", "a", "choice a", "answer a", "reponse a", "proposition a", "option 1"] },
  { id: "option_b", label: "Proposition B", required: true, aliases: ["option b", "b", "choice b", "answer b", "reponse b", "proposition b", "option 2"] },
  { id: "option_c", label: "Proposition C", required: true, aliases: ["option c", "c", "choice c", "answer c", "reponse c", "proposition c", "option 3"] },
  { id: "option_d", label: "Proposition D", required: true, aliases: ["option d", "d", "choice d", "answer d", "reponse d", "proposition d", "option 4"] },
  { id: "correct", label: "Bonne réponse (A, B, C ou D)", required: true, aliases: ["correct", "correct answer", "correct key", "correctkey", "answer", "key", "bonne reponse", "bonne réponse", "reponse", "réponse", "solution"] },
  { id: "difficulty", label: "Difficulté (1 à 3)", required: false, aliases: ["difficulty", "difficulte", "difficulté", "level", "niveau"] },
  { id: "category", label: "Catégorie (type de piège)", required: false, aliases: ["category", "categorie", "catégorie", "skill", "competence", "compétence", "type"] },
  { id: "theme", label: "Thème professionnel", required: false, aliases: ["theme", "thème", "topic", "domain", "sujet"] },
  { id: "tags", label: "Étiquettes", required: false, aliases: ["tags", "tag", "etiquettes", "étiquettes", "labels"] },
  { id: "explanation", label: "Explication (français)", required: false, aliases: ["explanation", "explication", "rationale", "justification", "correction"] },
  { id: "rationale_a", label: "Justification A", required: false, aliases: ["rationale a", "explication a", "why a", "justification a"] },
  { id: "rationale_b", label: "Justification B", required: false, aliases: ["rationale b", "explication b", "why b", "justification b"] },
  { id: "rationale_c", label: "Justification C", required: false, aliases: ["rationale c", "explication c", "why c", "justification c"] },
  { id: "rationale_d", label: "Justification D", required: false, aliases: ["rationale d", "explication d", "why d", "justification d"] },
  { id: "external_id", label: "Identifiant d'origine", required: false, aliases: ["external id", "id", "uid", "identifiant", "slug", "question id", "ref"] },
];

const FIELD_IDS = new Set(FIELDS.map((f) => f.id));
const HEADER_NORM = (h) => String(h ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Association automatique colonnes → champs. Un nom exact (ou un alias) l'emporte ; chaque
 * colonne n'est utilisée qu'une fois ; les alias ambigus d'une lettre ne servent qu'en dernier.
 */
export function suggestMapping(headers) {
  const normalized = headers.map(HEADER_NORM);
  const used = new Set();
  const mapping = {};
  // 1) identifiant exact du champ (modèle officiel), 2) alias dans l'ordre de déclaration.
  const passes = [
    (field, h) => HEADER_NORM(field.id) === h,
    (field, h) => field.aliases.some((alias) => HEADER_NORM(alias) === h),
  ];
  for (const pass of passes) {
    for (const field of FIELDS) {
      if (mapping[field.id] !== undefined) continue;
      const index = normalized.findIndex((h, i) => !used.has(i) && h && pass(field, h));
      if (index >= 0) {
        mapping[field.id] = headers[index];
        used.add(index);
      }
    }
  }
  const unmapped = headers.filter((_, i) => !used.has(i) && normalized[i]);
  return { mapping, unmapped, missing: missingFields(mapping) };
}

/** Champs obligatoires non associés. */
export function missingFields(mapping) {
  return FIELDS.filter((f) => f.required && !mapping?.[f.id]).map((f) => f.id);
}

/** Nettoie un mapping fourni par le client (champs et colonnes connus uniquement). */
export function sanitizeMapping(mapping, headers) {
  const out = {};
  const known = new Set(headers);
  for (const [field, header] of Object.entries(mapping ?? {})) {
    if (FIELD_IDS.has(field) && typeof header === "string" && known.has(header)) out[field] = header;
  }
  return out;
}

const cell = (row, mapping, field) => {
  const header = mapping[field];
  if (!header) return "";
  const value = row[header];
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u0000/g, "").trim().slice(0, MAX_CELL_LENGTH);
};

// --- Normalisation des valeurs ----------------------------------------------------------

const DIFFICULTY_WORDS = { easy: 1, facile: 1, low: 1, medium: 2, moyen: 2, intermediate: 2, intermediaire: 2, hard: 3, difficile: 3, high: 3, advanced: 3, avance: 3 };

export function parseDifficulty(raw, fallback = 2) {
  if (raw === "" || raw === undefined) return { value: fallback };
  const key = HEADER_NORM(raw);
  if (key in DIFFICULTY_WORDS) return { value: DIFFICULTY_WORDS[key] };
  const n = Number(String(raw).replace(",", "."));
  if (Number.isInteger(n) && n >= 1 && n <= 3) return { value: n };
  return { error: `Difficulté « ${raw} » invalide (1, 2 ou 3).` };
}

export function parsePart(raw, fallback) {
  const match = String(raw ?? "").match(/[567]/);
  if (match && /^(part(ie)?\s*)?[567]\.?$/i.test(String(raw).trim())) return { value: Number(match[0]) };
  if (raw === "" && fallback) return { value: fallback };
  return { error: raw === "" ? "Partie manquante (5, 6 ou 7)." : `Partie « ${raw} » invalide (5, 6 ou 7).` };
}

/** Lettre de bonne réponse : A–D, (B), « B. », 1–4, ou texte exact d'une proposition. */
export function parseCorrect(raw, options) {
  const value = String(raw ?? "").trim();
  if (!value) return { error: "Bonne réponse manquante." };
  const letter = value.match(/^[(\[]?\s*([A-Da-d])\s*[)\].:]?$/);
  if (letter) return { value: letter[1].toUpperCase() };
  const digit = value.match(/^[(\[]?\s*([1-4])\s*[)\].:]?$/);
  if (digit) return { value: OPTION_KEYS[Number(digit[1]) - 1] };
  const matches = options.filter((o) => norm(o.text) === norm(value));
  if (matches.length === 1) return { value: matches[0].key };
  return { error: `Bonne réponse « ${value.slice(0, 40)} » invalide : attendu A, B, C ou D.` };
}

const KIND_WORDS = { mail: "email", courriel: "email", "e mail": "email", note: "memo", memorandum: "memo", annonce: "notice", planning: "schedule", agenda: "schedule", lettre: "letter", sms: "message", chat: "message", text: "message", "text message": "message", "online chat": "message", advertisement: "notice", ad: "notice", form: "notice", invoice: "notice", review: "article", report: "article" };
function parseKind(raw, fallback) {
  const key = HEADER_NORM(raw);
  if (!key) return fallback;
  if (DOCUMENT_KINDS.includes(key)) return key;
  return KIND_WORDS[key] ?? null;
}

const splitParagraphs = (text) => text.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
const splitTags = (text) => text.split(/[;,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10);

/** Documents (1 à 3) d'une ligne. */
function readDocuments(row, mapping, issues) {
  const documents = [];
  for (const n of [1, 2, 3]) {
    const text = cell(row, mapping, `doc${n}_text`);
    if (!text) continue;
    const kind = parseKind(cell(row, mapping, `doc${n}_kind`), n === 1 ? "email" : "message");
    if (kind === null) {
      issues.push({ severity: "warning", code: "unknown_document_kind", message: `Type de document « ${cell(row, mapping, `doc${n}_kind`)} » inconnu : « email » utilisé.` });
    }
    documents.push({ kind: kind ?? "email", title: cell(row, mapping, `doc${n}_title`).slice(0, 250), body: splitParagraphs(text) });
  }
  return documents;
}

/**
 * Transforme une ligne brute en question + document candidats.
 * @returns {{question:object|null, passage:object|null, passageRef:string|null, issues:object[]}}
 */
export function normalizeRow(row, mapping, { defaultPart = null, defaultDifficulty = 2 } = {}) {
  const issues = [];
  const err = (code, message) => issues.push({ severity: "error", code, message });

  const partResult = parsePart(cell(row, mapping, "part"), defaultPart);
  if (partResult.error) err("invalid_part", partResult.error);
  const part = partResult.value;

  const prompt = cell(row, mapping, "prompt");
  if (!prompt) err("missing_field", "Énoncé manquant.");
  const options = OPTION_KEYS.map((key) => ({ key, text: cell(row, mapping, `option_${key.toLowerCase()}`) }));
  options.forEach((o) => { if (!o.text) err("missing_field", `Proposition ${o.key} manquante.`); });

  const correct = parseCorrect(cell(row, mapping, "correct"), options);
  if (correct.error) err("invalid_answer", correct.error);

  const difficulty = parseDifficulty(cell(row, mapping, "difficulty"), defaultDifficulty);
  if (difficulty.error) err("invalid_difficulty", difficulty.error);

  const rationales = {};
  for (const key of OPTION_KEYS) {
    const text = cell(row, mapping, `rationale_${key.toLowerCase()}`);
    if (text) rationales[key] = text;
  }
  const order = Number.parseInt(cell(row, mapping, "question_number"), 10);

  let passage = null;
  let passageRef = null;
  if (part === 6 || part === 7) {
    const documents = readDocuments(row, mapping, issues);
    passageRef = cell(row, mapping, "passage_ref") || null;
    if (!documents.length) {
      err("missing_passage", `La partie ${part} exige le texte d'un document (colonne « document 1 · texte »).`);
    } else {
      const title = cell(row, mapping, "passage_title") || documents[0].title || prompt.slice(0, 60);
      passage = { title: title.slice(0, 250), documents };
    }
  } else if (part === 5 && (cell(row, mapping, "doc1_text") || cell(row, mapping, "passage_ref"))) {
    issues.push({ severity: "warning", code: "passage_ignored", message: "Un document est fourni pour une question de partie 5 : il est ignoré." });
  }

  if (issues.some((i) => i.severity === "error")) return { question: null, passage: null, passageRef: null, issues };
  return {
    question: {
      part,
      prompt,
      options,
      correctKey: correct.value,
      difficulty: difficulty.value,
      category: cell(row, mapping, "category").toLowerCase() || null,
      theme: cell(row, mapping, "theme") || null,
      tags: splitTags(cell(row, mapping, "tags")),
      explanation: cell(row, mapping, "explanation") || null,
      optionRationales: Object.keys(rationales).length ? rationales : null,
      orderIndex: Number.isInteger(order) && order >= 0 ? order : undefined,
      externalId: cell(row, mapping, "external_id").slice(0, 80) || null,
    },
    passage,
    passageRef,
    issues,
  };
}

/** Aperçu des premières lignes (utilisé par l'écran de correspondance des colonnes). */
export function previewRows(rows, mapping, options = {}) {
  return rows.slice(0, 20).map((row, i) => {
    const r = normalizeRow(row, mapping, options);
    const checked = r.question ? checkQuestion(r.question, { source: "import" }) : null;
    return {
      row: i + 2,
      ok: Boolean(r.question) && !checked?.errors.length,
      question: r.question,
      passage: r.passage,
      issues: [...r.issues, ...(checked ? [...checked.errors, ...checked.warnings] : [])],
    };
  });
}

// --- Traitement d'un bloc de lignes ---------------------------------------------------------

const flag = (i) => ({ code: i.code, message: i.message, severity: i.severity });

/**
 * Valide un bloc de lignes. Les lignes d'un même document doivent arriver ensemble (le client
 * les regroupe avant le découpage).
 *
 * @param {{n:number,data:object}[]} rows  lignes numérotées (numéro de ligne du fichier)
 * @returns {{items:object[], issues:object[], stats:{rows:number,rejected:number,flagged:number}, similarProbe:object[]}}
 */
export function processChunk(rows, mapping, { defaultPart = null, defaultDifficulty = 2 } = {}) {
  const issues = [];
  const stats = { rows: rows.length, rejected: 0, flagged: 0 };
  const push = (n, list, extra = {}) => {
    for (const i of list) issues.push({ ref: String(n), severity: i.severity, code: i.code, message: i.message, payload: extra.payload ?? null });
  };

  // 1) Normalisation + contrôles de chaque ligne.
  const entries = [];
  for (const { n, data } of rows) {
    const r = normalizeRow(data, mapping, { defaultPart, defaultDifficulty });
    if (!r.question) {
      push(n, r.issues);
      stats.rejected += 1;
      continue;
    }
    entries.push({ n, ...r, warnings: r.issues });
  }

  // 2) Regroupement par document (parties 6 et 7).
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.passage) continue;
    const key = `${entry.question.part}|${entry.passageRef ?? passageHash(entry.question.part, entry.passage.title, entry.passage.documents)}`;
    entry.groupKey = key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const rejected = new Set();
  const reject = (entry, list) => {
    if (rejected.has(entry)) return;
    rejected.add(entry);
    push(entry.n, list);
    stats.rejected += 1;
  };

  // 3) Contrôles question par question puis document par document.
  for (const entry of entries) {
    const words = entry.passage ? passageWordCount({ documents: entry.passage.documents }) : 0;
    const checked = checkQuestion(entry.question, { source: "import", passageWords: words });
    entry.checked = checked;
    if (checked.errors.length) reject(entry, [...checked.errors, ...checked.warnings]);
    else entry.question = checked.question;
  }
  for (const [, group] of groups) {
    const live = group.filter((e) => !rejected.has(e));
    const invalidMembers = group.length - live.length;
    if (group.length > MAX_GROUP_ROWS) {
      for (const e of group) reject(e, [{ severity: "error", code: "group_too_large", message: `Document partagé par plus de ${MAX_GROUP_ROWS} lignes.` }]);
      continue;
    }
    // Un document dont une question est invalide n'est pas importé à moitié : cohérence avant tout.
    const first = group[0];
    const documents = first.passage.documents;
    const same = group.every((e) => passageHash(first.question.part, e.passage.title, e.passage.documents) === passageHash(first.question.part, first.passage.title, documents));
    if (!same) {
      for (const e of group) reject(e, [{ severity: "error", code: "passage_inconsistent", message: "Les lignes d'un même document contiennent des textes différents." }]);
      continue;
    }
    if (invalidMembers > 0) {
      const list = [{ severity: "error", code: "passage_incomplete", message: "Une autre question du même document est invalide : document non importé." }];
      for (const e of live) reject(e, list);
      continue;
    }
    const result = checkPassageGroup(first.question.part, first.passage, live.map((e) => e.question));
    if (result.errors.length) {
      for (const e of live) reject(e, result.errors);
      continue;
    }
    live.forEach((e, i) => { e.groupWarnings = result.warnings.filter((w) => w.index === undefined || w.index === i); });
    group.forEach((e, i) => { e.position = i + 1; });
  }

  // 4) Doublons exacts et quasi-doublons dans le bloc.
  const live = entries.filter((e) => !rejected.has(e));
  const seen = new Map();
  for (const entry of live) {
    const q = entry.question;
    const pHash = entry.passage ? passageHash(q.part, entry.passage.title, entry.passage.documents) : null;
    entry.hash = questionHash(q.part, q.prompt, q.options, pHash);
    if (seen.has(entry.hash)) {
      reject(entry, [{ severity: "error", code: "duplicate_in_file", message: `Doublon de la ligne ${seen.get(entry.hash)} du fichier.` }]);
    } else seen.set(entry.hash, entry.n);
  }
  const alive = live.filter((e) => !rejected.has(e));
  const similarity = similarWithin(alive.map((e) => similarityText(e.question.part, e.question.prompt, e.question.options)));
  alive.forEach((entry, i) => {
    entry.similar = similarity[i].map((s) => ({ row: alive[s.index].n, score: Number(s.score.toFixed(2)) }));
  });

  // 5) Items à écrire.
  const items = [];
  for (const entry of alive) {
    const { question: q } = entry;
    const warnings = [...entry.warnings, ...entry.checked.warnings, ...(entry.groupWarnings ?? [])];
    for (const s of entry.similar ?? []) {
      warnings.push({ severity: "warning", code: "similar_in_file", message: `Très proche de la ligne ${s.row} du fichier (similarité ${Math.round(s.score * 100)} %).` });
    }
    const outcome = outcomeFor({ errors: [], warnings });
    push(entry.n, warnings);
    if (outcome.needsReview) stats.flagged += 1;
    const lsh = lshBands(similarityText(q.part, q.prompt, q.options));
    items.push({
      ref: entry.n,
      part: q.part,
      passage: entry.passage ? {
        key: entry.groupKey,
        title: entry.passage.title,
        documents: entry.passage.documents,
        theme: q.theme,
        lsh: lshBands(passageText(entry.passage.title, entry.passage.documents)),
      } : null,
      question: {
        prompt: q.prompt,
        options: q.options,
        correct_key: q.correctKey,
        difficulty: q.difficulty,
        category: q.category,
        theme: q.theme,
        tags: q.tags,
        explanation: q.explanation,
        option_rationales: q.optionRationales,
        order_index: q.orderIndex ?? entry.position ?? 0,
        external_id: q.externalId,
        lsh,
        needs_review: outcome.needsReview,
        review_flags: warnings.map(flag),
      },
    });
  }
  return { items, issues, stats };
}

/**
 * Découpe des lignes en blocs sans séparer un document de ses questions.
 * @returns {{n:number,data:object}[][]}
 */
export function chunkRows(numberedRows, mapping, size = 200) {
  const limit = Math.min(Math.max(size, 1), MAX_CHUNK_ROWS);
  const groupColumn = mapping.passage_ref || mapping.doc1_text;
  const refKey = (r) => (groupColumn ? String(r.data[groupColumn] ?? "").trim() : "");
  // Les lignes partageant une référence de document restent ensemble (premier passage de la référence).
  const order = [];
  const byRef = new Map();
  for (const row of numberedRows) {
    const ref = refKey(row);
    if (!ref) { order.push([row]); continue; }
    if (!byRef.has(ref)) { const group = []; byRef.set(ref, group); order.push(group); }
    byRef.get(ref).push(row);
  }
  const chunks = [];
  let current = [];
  for (const group of order) {
    if (current.length && current.length + group.length > limit) { chunks.push(current); current = []; }
    current.push(...group);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export const categoriesHint = (part) => categoriesForPart(part);
