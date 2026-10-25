// Contrôles de qualité des questions (import, génération IA, édition manuelle).
//
// Une question qui passe la validation du schéma n'est PAS pour autant pédagogiquement
// correcte. Ce module sépare donc :
//   - les ERREURS  : la question est inutilisable (schéma, anglais, doublons d'options,
//                    texte à trous sans trou…) → rejetée ;
//   - les ALERTES  : la question est peut-être défectueuse (réponses multiples possibles,
//                    explication douteuse, difficulté incohérente, document incohérent,
//                    quasi-doublon…) → conservée en brouillon, `needs_review = true`,
//                    jamais publiée sans relecture humaine.
// Ce sont des heuristiques : elles réduisent le risque, elles ne remplacent pas la relecture.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { looksFrench, looksEnglish } from "./language.mjs";
import { mulberry32, norm } from "./text.mjs";

const CATEGORIES = JSON.parse(readFileSync(new URL("../../data/categories.json", import.meta.url), "utf8"));

export const OPTION_KEYS = ["A", "B", "C", "D"];
export const DOCUMENT_KINDS = ["email", "memo", "article", "notice", "schedule", "letter", "message"];

/** Catégories (types de piège) autorisées pour une partie. */
export const categoriesForPart = (part) => CATEGORIES.filter((c) => c.parts.includes(part)).map((c) => c.id);

const optionSchema = z.object({ key: z.enum(OPTION_KEYS), text: z.string().trim().min(1, "proposition vide").max(400) });

export const QuestionSchema = z.object({
  part: z.union([z.literal(5), z.literal(6), z.literal(7)]),
  prompt: z.string().trim().min(10, "énoncé trop court (10 caractères minimum)").max(1500, "énoncé trop long"),
  options: z.array(optionSchema).length(4, "quatre propositions A, B, C, D sont requises")
    .refine((opts) => opts.every((o, i) => o.key === OPTION_KEYS[i]), "les propositions doivent être A, B, C, D dans l'ordre"),
  correctKey: z.enum(OPTION_KEYS),
  difficulty: z.number().int().min(1).max(3),
  category: z.string().max(60).nullable().optional(),
  theme: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  explanation: z.string().max(2000).nullable().optional(),
  optionRationales: z.record(z.enum(OPTION_KEYS), z.string().max(600)).nullable().optional(),
  orderIndex: z.number().int().min(0).max(1000).optional(),
  externalId: z.string().max(80).nullable().optional(),
});

const issue = (severity, code, message) => ({ severity, code, message });
const error = (code, message) => issue("error", code, message);
const warning = (code, message) => issue("warning", code, message);

const BLANK = /_{3,}/;
const NUMBERED_BLANK = /\((\d{1,2})\)\s*_{2,}/g;

/** Remplace tout trou (numéroté ou non) par un mot neutre, pour comparer des phrases. */
export const stripBlanks = (text) => String(text ?? "").replace(/(d{1,2})s*_{2,}/g, " blank ").replace(/_{2,}/g, " blank ");

/** Numéros de trous « (1)______ » d'un texte. */
export function blankNumbers(text) {
  return [...String(text ?? "").matchAll(NUMBERED_BLANK)].map((m) => Number(m[1]));
}

// --- Difficulté --------------------------------------------------------------------

const COMPLEX_MARKERS = /\b(although|whereas|unless|provided that|notwithstanding|nevertheless|hence|thereby|whereby|despite|in spite of|had it not|were it|not only|no sooner)\b/i;

/**
 * Estimation GROSSIÈRE de la difficulté (1 à 3) à partir de la longueur, du lexique et de
 * la structure. Elle ne sert qu'à repérer les écarts manifestes avec la difficulté annoncée.
 */
export function estimateDifficulty(q, { passageWords = 0 } = {}) {
  const words = norm(q.prompt).split(" ").filter(Boolean);
  const optionTexts = q.options.map((o) => o.text);
  const avgWord = words.length ? words.reduce((n, w) => n + w.length, 0) / words.length : 0;
  const avgOption = optionTexts.reduce((n, t) => n + t.length, 0) / Math.max(optionTexts.length, 1);
  let score = 1;
  if (words.length >= 18 || avgWord >= 6) score += 0.6;
  if (COMPLEX_MARKERS.test(q.prompt)) score += 0.6;
  if (avgOption >= 14) score += 0.4;
  if (q.part === 7) {
    if (passageWords >= 180) score += 0.6;
    if (["reading-inference", "reading-cross"].includes(q.category)) score += 0.8;
  }
  if (q.part === 6 && passageWords >= 160) score += 0.3;
  return Math.max(1, Math.min(3, Math.round(score)));
}

// --- Contrôles d'une question ---------------------------------------------------------

const CONTRADICTING_RATIONALE = /\b(est (aussi |également )?(correct|possible|acceptable)|bonne réponse|convient (aussi|parfaitement)|aussi valable)\b/i;
const NEGATED = /\b(in|n'est pas|ne convient pas|pas (correct|possible|acceptable)|faux|incorrect)/i;
const MULTI_ANSWER = /(également|aussi|les deux|plusieurs|deux réponses)[^.]{0,40}(correct|possible|acceptable|valable)|(correct|possible|acceptable|valable)[^.]{0,20}(aussi|également)/i;

/**
 * Contrôle une question. `source` vaut « ai » (explication et justifications attendues),
 * « import » ou « manual ». Renvoie `{ errors, warnings, question }` (question normalisée).
 */
export function checkQuestion(input, { source = "import", passageWords = 0 } = {}) {
  const errors = [];
  const warnings = [];
  const parsed = QuestionSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push(error("schema", `${i.path.join(".") || "question"} : ${i.message}`));
    return { errors, warnings, question: null };
  }
  const q = { ...parsed.data, tags: parsed.data.tags ?? [] };

  // Catégorie : doit exister pour la partie, sinon elle est ignorée (alerte, pas d'échec).
  if (q.category && !categoriesForPart(q.part).includes(q.category)) {
    warnings.push(warning("unknown_category", `Catégorie « ${q.category} » inconnue pour la partie ${q.part} : ignorée.`));
    q.category = null;
  }

  const normalized = q.options.map((o) => norm(o.text));
  if (new Set(normalized).size < 4) errors.push(error("duplicate_options", "Deux propositions sont identiques."));
  if (q.part !== 7 && !BLANK.test(q.prompt)) {
    errors.push(error("blank_missing", "L'énoncé doit contenir un trou (______)."));
  }
  if (q.part === 6 && BLANK.test(q.prompt) && !blankNumbers(q.prompt).length) {
    warnings.push(warning("blank_unnumbered", "Le trou n'est pas numéroté « (1)______ » : le lien avec le document est incertain."));
  }
  if ([q.prompt, ...q.options.map((o) => o.text)].some(looksFrench)) {
    errors.push(error("not_english", "Le contenu de la question doit être entièrement en anglais."));
  }
  const odd = [...(q.prompt + q.options.map((o) => o.text).join(""))].filter((c) => {
    const code = c.codePointAt(0);
    return code > 0xff && !(code >= 0x2010 && code <= 0x2027) && code !== 0x20ac;
  });
  if (odd.length > 3) warnings.push(warning("unusual_characters", "Caractères inhabituels (encodage ?) dans l'énoncé ou les propositions."));

  // Réponses multiples potentiellement correctes.
  const correct = q.options.find((o) => o.key === q.correctKey);
  const promptNorm = ` ${norm(q.prompt)} `;
  const correctNorm = norm(correct.text);
  if (q.part === 5 && correctNorm.length >= 5 && promptNorm.includes(` ${correctNorm} `)) {
    warnings.push(warning("answer_in_prompt", "La bonne réponse apparaît déjà dans l'énoncé."));
  }
  const rationales = q.optionRationales ?? {};
  const wrongKeys = OPTION_KEYS.filter((k) => k !== q.correctKey);
  const suspectRationale = wrongKeys.some((k) => {
    const text = rationales[k];
    return text && CONTRADICTING_RATIONALE.test(text) && !NEGATED.test(text);
  });
  if (suspectRationale || (q.explanation && MULTI_ANSWER.test(q.explanation))) {
    warnings.push(warning("multiple_correct_suspect", "L'explication suggère qu'une autre proposition pourrait aussi être correcte."));
  }
  if (/\b(all of the above|none of the above|both [a-d] and [a-d]|\([a-d]\) and \([a-d]\))\b/i.test(q.options.map((o) => o.text).join(" "))) {
    warnings.push(warning("option_refers_to_options", "Une proposition renvoie à d'autres propositions (« all of the above »…) : format non-TOEIC."));
  }

  // Explications.
  if (source === "ai") {
    if (!q.explanation || q.explanation.length < 25) warnings.push(warning("explanation_missing", "Explication pédagogique absente ou trop courte."));
    const missing = wrongKeys.filter((k) => !rationales[k] || rationales[k].length < 8);
    if (missing.length) warnings.push(warning("rationales_missing", `Justification manquante pour : ${missing.join(", ")}.`));
  }
  if (q.explanation && looksEnglish(q.explanation)) {
    warnings.push(warning("explanation_language", "L'explication semble rédigée en anglais : elle doit être en français."));
  }
  if (q.explanation && Object.values(rationales).some((r) => looksEnglish(r))) {
    warnings.push(warning("explanation_language", "Une justification semble rédigée en anglais : elle doit être en français."));
  }

  // Difficulté.
  const estimated = estimateDifficulty(q, { passageWords });
  if (Math.abs(estimated - q.difficulty) >= 2) {
    warnings.push(warning("difficulty_mismatch", `Difficulté annoncée ${q.difficulty}/3, estimée ${estimated}/3.`));
  }

  return { errors, warnings, question: q };
}

// --- Contrôles d'un document et de ses questions ----------------------------------------

export const PassageSchema = z.object({
  title: z.string().trim().min(1, "titre du document manquant").max(250),
  documents: z.array(z.object({
    kind: z.enum(DOCUMENT_KINDS),
    title: z.string().trim().max(250).default(""),
    body: z.array(z.string().trim().min(1)).min(1, "texte du document vide"),
  })).min(1, "au moins un document").max(4),
});

export const passageWordCount = (passage) =>
  (passage?.documents ?? []).reduce((n, d) => n + norm(d.body.join(" ")).split(" ").filter(Boolean).length, 0);

/**
 * Contrôle la cohérence d'un document (parties 6 et 7) et de ses questions.
 * `questions` : questions normalisées par `checkQuestion` (même document).
 */
export function checkPassageGroup(part, passageInput, questions, { expectedQuestions = null } = {}) {
  const errors = [];
  const warnings = [];
  const parsed = PassageSchema.safeParse(passageInput);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push(error("passage_schema", `document ${i.path.join(".")} : ${i.message}`));
    return { errors, warnings, passage: null };
  }
  const passage = parsed.data;
  const texts = [passage.title, ...passage.documents.flatMap((d) => [d.title, ...d.body])];
  if (texts.some(looksFrench)) errors.push(error("passage_not_english", "Le document doit être entièrement en anglais."));
  const words = passageWordCount(passage);
  if (expectedQuestions && questions.length !== expectedQuestions) {
    errors.push(error("passage_question_count", `${questions.length} question(s) pour ce document au lieu de ${expectedQuestions}.`));
  }

  if (part === 6) {
    const blanks = blankNumbers(passage.documents.flatMap((d) => d.body).join(" "));
    const sorted = [...blanks].sort((a, b) => a - b);
    if (!blanks.length) errors.push(error("passage_blanks_missing", "Le texte à trous ne contient aucun trou numéroté « (1)______ »."));
    else if (new Set(blanks).size !== blanks.length || sorted.some((n, i) => n !== i + 1)) {
      errors.push(error("passage_blanks_invalid", `Numérotation des trous incohérente (${blanks.join(", ")}).`));
    }
    if (blanks.length && questions.length !== blanks.length) {
      errors.push(error("passage_blank_mismatch", `Le document contient ${blanks.length} trou(s) mais ${questions.length} question(s) y sont rattachées.`));
    }
    const text = ` ${norm(stripBlanks(passage.documents.flatMap((d) => d.body).join(" ")))} `;
    const seen = new Set();
    for (const [index, q] of questions.entries()) {
      const n = blankNumbers(q.prompt)[0];
      if (n !== undefined) {
        if (blanks.length && !blanks.includes(n)) errors.push(error("question_blank_unknown", `La question renvoie au trou (${n}), absent du document.`));
        if (seen.has(n)) errors.push(error("question_blank_duplicate", `Deux questions portent sur le trou (${n}).`));
        seen.add(n);
      }
      const sentence = norm(stripBlanks(q.prompt));
      if (sentence.length > 20 && !text.includes(` ${sentence} `)) {
        warnings.push({ ...warning("prompt_not_in_passage", `L'énoncé du trou ${n ?? "?"} ne figure pas tel quel dans le document.`), index });
      }
    }
  } else {
    if (words < 40) warnings.push(warning("passage_too_short", `Document très court (${words} mots).`));
    if (questions.length < 2 || questions.length > 5) {
      warnings.push(warning("question_count", `${questions.length} question(s) pour ce document : 2 à 5 sont attendues.`));
    }
  }
  return { errors, warnings, passage, words };
}

// --- Lot : équilibre des réponses ----------------------------------------------------------

/** Répartition des bonnes réponses d'un lot et verdict (déséquilibre si une lettre dépasse 40 %). */
export function answerBalance(questions) {
  const distribution = { A: 0, B: 0, C: 0, D: 0 };
  for (const q of questions) if (q.correctKey in distribution) distribution[q.correctKey] += 1;
  const total = questions.length;
  const max = Math.max(...Object.values(distribution));
  return { distribution, total, balanced: total < 8 || max / total <= 0.4 };
}

const POSITION_DEPENDENT = /\b(all of the above|none of the above|both|neither|either of)\b|\b(options?|choices?|answers?)\s+[A-D]\b|\([A-D]\)/i;

/** Une question dont les propositions renvoient les unes aux autres ne peut pas être permutée. */
export const canShuffle = (q) => !q.options.some((o) => POSITION_DEPENDENT.test(o.text));

/**
 * Rééquilibre les bonnes réponses d'un lot en échangeant deux propositions (le contenu
 * de la question ne change pas ; les justifications suivent leur proposition).
 */
export function rebalanceAnswers(questions, seed = 1) {
  const rng = mulberry32(seed);
  const target = questions.length / 4;
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const q of questions) counts[q.correctKey] += 1;
  return questions.map((q) => {
    if (!canShuffle(q)) return q;
    const surplus = counts[q.correctKey] - target;
    if (surplus <= 0.5) return q;
    // Lettre la plus en déficit (tirage au sort à égalité).
    const options = OPTION_KEYS.filter((k) => k !== q.correctKey);
    const deficit = options.map((k) => target - counts[k] + rng() * 0.01);
    const best = options[deficit.indexOf(Math.max(...deficit))];
    if (counts[best] >= target) return q;
    const swapped = q.options.map((o) => ({ ...o }));
    const from = q.correctKey.charCodeAt(0) - 65;
    const to = best.charCodeAt(0) - 65;
    [swapped[from], swapped[to]] = [swapped[to], swapped[from]];
    const texts = swapped.map((o) => o.text);
    const options2 = texts.map((text, i) => ({ key: OPTION_KEYS[i], text }));
    let rationales = q.optionRationales ?? null;
    if (rationales) {
      const next = { ...rationales };
      next[best] = rationales[q.correctKey];
      next[q.correctKey] = rationales[best];
      rationales = next;
    }
    counts[q.correctKey] -= 1;
    counts[best] += 1;
    return { ...q, options: options2, correctKey: best, optionRationales: rationales };
  });
}

/**
 * Décide du sort d'une question à partir de ses contrôles.
 * - erreurs → rejetée ; alertes → brouillon à vérifier ; sinon « en validation » (génération)
 *   ou brouillon (import : jamais plus loin sans action humaine).
 */
export function outcomeFor({ errors, warnings }, { clean = "draft" } = {}) {
  if (errors.length) return { outcome: "rejected", status: null, needsReview: false };
  if (warnings.length) return { outcome: "flagged", status: "draft", needsReview: true };
  return { outcome: "accepted", status: clean, needsReview: false };
}
