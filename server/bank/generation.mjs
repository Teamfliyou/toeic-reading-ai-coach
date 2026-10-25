// Génération massive de questions avec DeepSeek : file persistante en base, lots de 20
// questions maximum, traitée un lot à la fois par des requêtes courtes (compatible avec les
// limites d'exécution de Vercel). Aucune boucle longue dans une requête HTTP :
//   - le navigateur d'administration appelle `processNext` (un lot par requête) tant que le
//     job est actif ; et/ou
//   - une tâche planifiée (api/cron.mjs, facultative) appelle `runDue` avec un budget de temps.
//
// Garanties :
//   - un lot n'est jamais traité deux fois en parallèle (bail + jeton en base, une seule
//     réservation de budget en vol par job) ; un résultat d'une exécution périmée est refusé ;
//   - chaque lot réserve du budget avant l'appel et enregistre le coût réel (même si la
//     réponse est inutilisable) ; budget épuisé → le job est mis en pause, rien n'est perdu ;
//   - rien n'est publié automatiquement : les questions sans alerte passent « en validation »,
//     les questions suspectes restent en « brouillon » (needs_review).

import { z } from "zod";
import { BankError, rpc } from "./db.mjs";
import { flagSimilarExisting } from "./import-service.mjs";
import {
  OPTION_KEYS, answerBalance, categoriesForPart, checkPassageGroup, checkQuestion, outcomeFor, passageWordCount, rebalanceAnswers,
} from "./quality.mjs";
import { lshBands, passageHash, passageText, questionHash, similarWithin, similarityText } from "./text.mjs";
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, addUsage, computeCost } from "../deepseek-config.mjs";
import { budgetLimits, currentMonth, finalize, quotaConfigured, release, reserve } from "../quota.mjs";

/** À incrémenter à chaque modification des prompts (traçabilité : « version de création »). */
export const GENERATION_VERSION = "gen-2026-10-25.1";

/** Questions par document (une partie 6 = 4 trous, une partie 7 = 3 questions par ensemble). */
export const QUESTIONS_PER_PASSAGE = { 5: 1, 6: 4, 7: 3 };
export const KINDS = {
  5: ["grammar", "vocabulary"],
  6: ["email", "memo", "article", "notice", "letter"],
  7: ["email", "memo", "article", "notice", "schedule", "letter", "message", "multi"],
};

const THEMES = [
  "human resources and recruitment", "office supplies and equipment orders", "business travel and hotel bookings", "customer complaints and refunds",
  "software rollout and IT support", "quarterly financial reporting", "marketing campaigns and product launches", "warehouse logistics and shipping",
  "restaurant and catering services", "real estate and office leases", "manufacturing and quality control", "banking and loan services",
  "training workshops and seminars", "conference planning", "employee benefits and payroll", "health and safety regulations",
  "supplier contracts and negotiations", "retail promotions and store openings", "environmental policy and recycling", "public transportation and commuting",
  "medical clinic appointments", "university partnerships and internships", "construction and renovation projects", "insurance claims",
  "newsletter and press releases", "customer loyalty programs", "remote work and scheduling", "inventory management",
  "legal services and compliance", "telecommunications and internet services", "airline and airport services", "museum and event ticketing",
  "agriculture and food distribution", "energy and utilities billing", "advertising and design agencies", "library and community services",
  "automotive sales and maintenance", "hotel management and tourism", "mergers and company announcements", "nonprofit fundraising",
];

export const limits = (env = process.env) => ({
  maxTotal: Number(env.GEN_MAX_QUESTIONS_PER_JOB) || 5000,
  editorMax: Number(env.GEN_EDITOR_MAX_QUESTIONS) || 100,
  defaultBatch: Number(env.GEN_BATCH_SIZE) || 10,
  jobsPerHour: Number(env.GEN_JOBS_PER_HOUR) || 5,
  perBatchUsd: Number(env.AI_ESTIMATED_GENERATION_USD) || 0.012,
  verifyUsd: Number(env.AI_ESTIMATED_VERIFY_USD) || 0.004,
  verify: String(env.GEN_AI_VERIFY ?? "true") !== "false",
});

const createSchema = z.object({
  part: z.union([z.literal(5), z.literal(6), z.literal(7)]),
  kind: z.string().max(20),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("mixed")]),
  total: z.number().int().min(1),
  batchSize: z.number().int().min(1).max(20).optional(),
  theme: z.string().trim().max(120).optional(),
  category: z.string().max(60).optional(),
  verify: z.boolean().optional(),
});

/** Plan d'un job : taille des lots alignée sur les documents, coût estimé. */
export function planJob(input, env = process.env) {
  const lim = limits(env);
  const params = createSchema.parse(input);
  if (!KINDS[params.part].includes(params.kind)) throw new BankError("Type de contenu invalide pour cette partie.", { status: 400, expose: true });
  if (params.category && !categoriesForPart(params.part).includes(params.category)) {
    throw new BankError("Catégorie invalide pour cette partie.", { status: 400, expose: true });
  }
  const qpp = QUESTIONS_PER_PASSAGE[params.part];
  const total = Math.ceil(params.total / qpp) * qpp;
  if (total > lim.maxTotal) throw new BankError(`Quantité limitée à ${lim.maxTotal} questions par génération.`, { status: 400, expose: true });
  let size = Math.min(params.batchSize ?? lim.defaultBatch, 20);
  size = Math.max(qpp, Math.floor(size / qpp) * qpp);
  if (size > 20) size = Math.floor(20 / qpp) * qpp;
  const batches = Math.ceil(total / size);
  const verify = params.verify ?? lim.verify;
  const estimatedUsd = Number((batches * (lim.perBatchUsd + (verify ? lim.verifyUsd : 0))).toFixed(4));
  return { ...params, total, batchSize: size, batches, verify, estimatedUsd, qpp };
}

// --- Prompt ---------------------------------------------------------------------------------

/** Sujets et catégorie d'un lot : rotation déterministe pour varier le contenu à grande échelle. */
export function batchFocus(job, batchIdx) {
  const categories = categoriesForPart(job.part);
  const theme = job.theme || THEMES[(batchIdx * 7 + job.part) % THEMES.length];
  const category = job.options?.category || categories[batchIdx % categories.length];
  const mixed = job.options?.mixed === true;
  const difficulty = mixed ? [1, 2, 3, 2][batchIdx % 4] : job.difficulty;
  return { theme, category, difficulty };
}

const QUESTION_SHAPE = '{"prompt": string, "options": [{"key":"A","text":string},{"key":"B","text":string},{"key":"C","text":string},{"key":"D","text":string}], "correctKey": "A"|"B"|"C"|"D", "difficulty": 1|2|3, "category": string, "theme": string, "explanation": string (French, 1-3 sentences), "optionRationales": {"<each WRONG key>": string (French, why this option is wrong)}}';

export function buildPrompts(job, batch, focus) {
  const { part, kind } = job;
  const n = batch.quantity;
  const qpp = QUESTIONS_PER_PASSAGE[part];
  const cats = categoriesForPart(part).join(", ");
  const common = [
    `Difficulty ${focus.difficulty}/3 (1 = easy, 2 = intermediate, 3 = advanced TOEIC level).`,
    `Professional theme: ${focus.theme}.`,
    `Preferred skill/category for these items: ${focus.category} (valid categories for this part: ${cats}). Set "category" to exactly one valid category per question.`,
    "LANGUAGE RULE: question prompts, answer options, document titles and document bodies MUST be entirely in English. Only \"explanation\" and \"optionRationales\" are written in French.",
    "Content must be ORIGINAL TOEIC-style practice material: never copy or closely imitate any official or copyrighted test item.",
    "Each question has exactly ONE clearly correct option; the three distractors must be plausible but unambiguously wrong for a careful reader. Avoid options that could both be correct.",
    "Correct answers must be spread evenly across A, B, C and D. Options must not repeat each other and must not refer to each other (no \"all of the above\").",
    "\"explanation\" explains in French why the correct answer is right; \"optionRationales\" gives one French sentence for EACH wrong option explaining why it is wrong.",
  ];
  let task;
  if (part === 5) {
    task = [
      `Write EXACTLY ${n} independent Part 5 (incomplete sentence) questions of type "${kind}".`,
      "Each prompt is one business-English sentence with a single blank written ______ (six underscores).",
      `Reply ONLY with JSON: {"questions": [${QUESTION_SHAPE}]}`,
    ];
  } else if (part === 6) {
    task = [
      `Write EXACTLY ${n / qpp} Part 6 text-completion document(s) of type "${kind}", each with EXACTLY 4 numbered blanks and 4 questions (${n} questions in total).`,
      "In the document body write each blank as (1)______, (2)______, (3)______, (4)______ (number in parentheses, then six underscores).",
      "For each question, \"prompt\" must be the sentence of the document that contains the blank, copied VERBATIM (including the (n)______ marker). Question n is about blank (n).",
      `Reply ONLY with JSON: {"passages": [{"title": string, "documents": [{"kind": "${kind}", "title": string, "body": [string, ...]}], "questions": [${QUESTION_SHAPE}, ...4 questions...]}]}`,
    ];
  } else {
    const docs = kind === "multi" ? "2 or 3 related documents of different kinds (e.g. e-mail + schedule, notice + e-mail)" : `1 document of type "${kind}"`;
    task = [
      `Write EXACTLY ${n / qpp} Part 7 reading-comprehension set(s). Each set has ${docs} of 80-220 words in total and EXACTLY ${qpp} questions (${n} questions in total).`,
      "Questions must require reading the document(s): main purpose, specific details, inference, vocabulary in context, or (for multiple documents) information across documents. Never ask about information not in the documents.",
      `Document kinds allowed: email, memo, article, notice, schedule, letter, message. Bodies are arrays of paragraphs; questions have NO blank.`,
      `Reply ONLY with JSON: {"passages": [{"title": string, "documents": [{"kind": string, "title": string, "body": [string, ...]}], "questions": [${QUESTION_SHAPE}, ...${qpp} questions...]}]}`,
    ];
  }
  return {
    system: "You are an expert TOEIC Reading item writer and English teacher. You write original, grammatically flawless, unambiguous practice items as strict JSON. You never copy official test content.",
    user: [...task, ...common].join("\n"),
  };
}

// --- Appels DeepSeek -----------------------------------------------------------------------------

function parseJsonContent(content) {
  const text = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("JSON illisible");
  }
}

class DeepSeekError extends Error {
  constructor(message, { status = 0, usage = null, retry = true } = {}) {
    super(message);
    this.status = status;
    this.usage = usage;
    this.retry = retry;
  }
}

async function callDeepSeek({ system, user, maxTokens, timeoutMs, temperature }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new DeepSeekError("DEEPSEEK_API_KEY absente du serveur.", { retry: false });
  const payload = {
    model: DEEPSEEK_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  if (String(process.env.DEEPSEEK_THINKING_ENABLED ?? "false") !== "true") payload.thinking = { type: "disabled" };
  let res;
  try {
    res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(3000, timeoutMs)),
    });
  } catch (e) {
    throw new DeepSeekError(e?.name === "TimeoutError" ? "DeepSeek n'a pas répondu à temps." : "DeepSeek injoignable.");
  }
  if (!res.ok) {
    // 401/402/403 : clé refusée, solde insuffisant… → inutile de réessayer immédiatement.
    throw new DeepSeekError(`DeepSeek a répondu ${res.status}.`, { status: res.status, retry: ![401, 402, 403].includes(res.status) });
  }
  const data = await res.json().catch(() => null);
  const usage = computeCost(data?.usage);
  const choice = data?.choices?.[0];
  if (!choice) throw new DeepSeekError("Réponse DeepSeek vide.", { usage });
  if (choice.finish_reason === "length") throw new DeepSeekError("Réponse DeepSeek tronquée (lot trop gros).", { usage });
  try {
    return { json: parseJsonContent(choice.message?.content), usage };
  } catch {
    throw new DeepSeekError("DeepSeek n'a pas renvoyé un JSON valide.", { usage });
  }
}

// --- Évaluation d'un lot --------------------------------------------------------------------------

const aiQuestionSchema = z.object({
  prompt: z.string(),
  options: z.union([
    z.array(z.object({ key: z.string(), text: z.string() })),
    z.record(z.string(), z.string()),
  ]),
  correctKey: z.string().optional(),
  correct_key: z.string().optional(),
  correct: z.string().optional(),
  difficulty: z.union([z.number(), z.string()]).optional(),
  category: z.string().nullish(),
  theme: z.string().nullish(),
  explanation: z.string().nullish(),
  optionRationales: z.record(z.string(), z.string()).nullish(),
  option_rationales: z.record(z.string(), z.string()).nullish(),
}).passthrough();

/** Normalise une question brute de l'IA vers le format interne (clés et types stricts). */
export function normalizeAiQuestion(raw, { part, focus, index }) {
  const parsed = aiQuestionSchema.safeParse(raw);
  if (!parsed.success) return { candidate: null, problem: "Question mal formée." };
  const q = parsed.data;
  const options = Array.isArray(q.options)
    ? q.options.map((o, i) => ({ key: String(o.key || OPTION_KEYS[i]).trim().toUpperCase().slice(0, 1), text: String(o.text ?? "").trim() }))
    : OPTION_KEYS.map((key) => ({ key, text: String(q.options[key] ?? "").trim() }));
  const difficulty = Number(q.difficulty);
  return {
    candidate: {
      part,
      prompt: q.prompt.trim(),
      options,
      correctKey: String(q.correctKey ?? q.correct_key ?? q.correct ?? "").trim().toUpperCase().slice(0, 1),
      difficulty: [1, 2, 3].includes(difficulty) ? difficulty : focus.difficulty,
      category: q.category || null,
      theme: (q.theme || focus.theme || "").slice(0, 80) || null,
      explanation: q.explanation?.trim() || null,
      optionRationales: q.optionRationales ?? q.option_rationales ?? null,
      orderIndex: index,
    },
  };
}

const flag = (i) => ({ code: i.code, message: i.message, severity: i.severity });

/**
 * Applique tous les contrôles à la réponse de l'IA. Fonction pure (sans réseau) : renvoie les
 * éléments à écrire, les problèmes détectés et les statistiques du lot.
 */
export function evaluateGenerated(parsed, job, batch, focus) {
  const part = job.part;
  const issues = [];
  const note = (ref, severity, code, message) => issues.push({ ref, severity, code, message, payload: null });
  const stats = { generated: 0, validated: 0, flagged: 0, rejected: 0 };
  let groups;
  if (part === 5) {
    groups = [{ passage: null, raws: Array.isArray(parsed?.questions) ? parsed.questions : [] }];
  } else {
    const passages = Array.isArray(parsed?.passages) ? parsed.passages : [];
    groups = passages.map((p) => ({ passage: p, raws: Array.isArray(p?.questions) ? p.questions : [] }));
  }

  const entries = [];
  let counter = 0;
  groups.forEach((group, g) => {
    const members = [];
    group.raws.forEach((raw, i) => {
      counter += 1;
      stats.generated += 1;
      const ref = `b${batch.idx}-${counter}`;
      const { candidate, problem } = normalizeAiQuestion(raw, { part, focus, index: i + 1 });
      if (!candidate) {
        stats.rejected += 1;
        note(ref, "error", "schema", problem);
        members.push({ ref, rejected: true });
        return;
      }
      const words = group.passage ? passageWordCount({ documents: (group.passage.documents ?? []).map((d) => ({ body: Array.isArray(d?.body) ? d.body : [String(d?.body ?? "")] })) }) : 0;
      const checked = checkQuestion(candidate, { source: "ai", passageWords: words });
      members.push({ ref, candidate, checked, group: g });
    });

    // Cohérence du document (parties 6 et 7) : une seule question invalide écarte le document.
    if (group.passage) {
      const valid = members.filter((m) => !m.rejected && !m.checked.errors.length);
      const result = checkPassageGroup(part, group.passage, valid.map((m) => m.checked.question), { expectedQuestions: part === 6 ? 4 : null });
      const anyBad = members.some((m) => m.rejected || m.checked.errors.length);
      group.passageChecked = result;
      if (result.errors.length || anyBad || !result.passage) {
        for (const m of members) {
          if (m.rejected) continue;
          const errors = [...m.checked.errors, ...(anyBad ? [{ severity: "error", code: "passage_incomplete", message: "Une autre question du même document est invalide : document écarté." }] : result.errors)];
          stats.rejected += 1;
          for (const e of errors) note(m.ref, "error", e.code, e.message);
          m.rejected = true;
        }
      } else {
        valid.forEach((m, i) => {
          m.checked.warnings.push(...result.warnings.filter((w) => w.index === undefined || w.index === i));
        });
      }
    } else {
      for (const m of members) {
        if (m.rejected) continue;
        if (m.checked.errors.length) {
          stats.rejected += 1;
          for (const e of m.checked.errors) note(m.ref, "error", e.code, e.message);
          m.rejected = true;
        }
      }
    }
    entries.push({ group, members, g });
  });

  // Équilibre des bonnes réponses sur le lot.
  const live = entries.flatMap((e) => e.members.filter((m) => !m.rejected));
  if (live.length >= 4) {
    const rebalanced = rebalanceAnswers(live.map((m) => m.checked.question), batch.idx + 1);
    live.forEach((m, i) => { m.checked.question = rebalanced[i]; });
  }

  // Doublons exacts et quasi-doublons dans le lot.
  const hashOf = (m, group) => questionHash(part, m.checked.question.prompt, m.checked.question.options,
    group.passage ? passageHash(part, group.passage.title, group.passage.documents) : null);
  const seen = new Map();
  for (const { group, members } of entries) {
    for (const m of members) {
      if (m.rejected) continue;
      const h = hashOf(m, group);
      if (seen.has(h)) {
        m.rejected = true;
        stats.rejected += 1;
        note(m.ref, "error", "duplicate_in_batch", `Doublon exact de ${seen.get(h)}.`);
      } else seen.set(h, m.ref);
    }
  }
  const alive = entries.flatMap((e) => e.members.filter((m) => !m.rejected));
  const sims = similarWithin(alive.map((m) => similarityText(part, m.checked.question.prompt, m.checked.question.options)));
  alive.forEach((m, i) => {
    for (const s of sims[i]) {
      m.checked.warnings.push({ severity: "warning", code: "similar_in_batch", message: `Très proche de ${alive[s.index].ref} (similarité ${Math.round(s.score * 100)} %).` });
      break;
    }
  });

  // Éléments à écrire.
  const items = [];
  for (const { group, members, g } of entries) {
    for (const m of members) {
      if (m.rejected) continue;
      const q = m.checked.question;
      const outcome = outcomeFor({ errors: [], warnings: m.checked.warnings }, { clean: "review" });
      for (const w of m.checked.warnings) note(m.ref, "warning", w.code, w.message);
      if (outcome.needsReview) stats.flagged += 1;
      else stats.validated += 1;
      const passage = group.passage && group.passageChecked?.passage
        ? { key: `${batch.job_id}-${batch.idx}-${g}`, title: group.passageChecked.passage.title, documents: group.passageChecked.passage.documents, theme: q.theme, lsh: lshBands(passageText(group.passageChecked.passage.title, group.passageChecked.passage.documents)) }
        : null;
      items.push({
        ref: m.ref,
        part,
        target_status: outcome.status,
        passage,
        question: {
          prompt: q.prompt, options: q.options, correct_key: q.correctKey, difficulty: q.difficulty,
          category: q.category ?? focus.category, theme: q.theme, tags: [], explanation: q.explanation,
          option_rationales: q.optionRationales, order_index: q.orderIndex ?? 0,
          lsh: lshBands(similarityText(part, q.prompt, q.options)),
          needs_review: outcome.needsReview, review_flags: m.checked.warnings.map(flag),
        },
      });
    }
  }
  return { items, issues, stats, balance: answerBalance(items.map((i) => ({ correctKey: i.question.correct_key }))) };
}

/**
 * Seconde passe : l'IA résout chaque question SANS voir la réponse attendue. Un désaccord ou une
 * ambiguïté déclarée garde la question en brouillon pour vérification humaine.
 */
export async function verifyItems(items, job, timeoutMs) {
  if (!items.length) return { usage: null, flagged: 0, ran: true };
  const bundle = items.map((item, i) => ({
    index: i,
    document: item.passage ? `${item.passage.title}\n${item.passage.documents.map((d) => `[${d.kind}] ${d.title}\n${d.body.join("\n")}`).join("\n\n")}` : null,
    question: item.question.prompt,
    options: item.question.options,
  }));
  const { json, usage } = await callDeepSeek({
    system: "You are a meticulous English-test reviewer. Solve each TOEIC question independently, as a careful test taker would.",
    user: `For each item below choose the single best option. If more than one option is defensible, or none is, set "ambiguous" to true.\nReply ONLY with JSON: {"results":[{"index":number,"answer":"A"|"B"|"C"|"D","ambiguous":boolean,"note":string (max 20 words)}]}\n\n${JSON.stringify(bundle)}`,
    maxTokens: 2500, timeoutMs, temperature: 0,
  });
  const results = new Map((Array.isArray(json?.results) ? json.results : []).map((r) => [Number(r?.index), r]));
  let flagged = 0;
  items.forEach((item, i) => {
    const r = results.get(i);
    if (!r) return;
    const messages = [];
    if (String(r.answer ?? "").toUpperCase() !== item.question.correct_key) messages.push({ code: "verification_disagrees", message: `La relecture automatique choisit ${String(r.answer).toUpperCase()} au lieu de ${item.question.correct_key}.` });
    if (r.ambiguous === true) messages.push({ code: "verification_ambiguous", message: `La relecture automatique juge la question ambiguë${r.note ? ` : ${String(r.note).slice(0, 120)}` : ""}.` });
    for (const m of messages) item.question.review_flags.push({ ...m, severity: "warning" });
    if (messages.length) {
      if (!item.question.needs_review) flagged += 1;
      item.question.needs_review = true;
      item.target_status = "draft";
    }
  });
  return { usage, flagged, ran: true };
}

// --- Traitement d'un lot -----------------------------------------------------------------------------

const DEADLINE_SAFETY_MS = 6000;

/**
 * Traite UN lot : bail → budget → DeepSeek → contrôles → écriture atomique.
 * @param {{jobId?:string, worker?:string, deadline?:number}} opts  `deadline` : instant (ms) à ne pas dépasser
 */
export async function processNext({ jobId = null, worker = "web", deadline = Date.now() + 50_000 } = {}) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new BankError("DEEPSEEK_API_KEY n'est pas configurée côté serveur : génération impossible.", { status: 503, expose: true });
  }
  const claim = await rpc("gen_claim_batch", { p_job: jobId, p_lease_seconds: 150, p_worker: worker });
  if (!claim) return { status: "idle" };
  const { batch, token, job } = claim;
  const lim = limits();
  const verify = job.options?.verify !== false && lim.verify;
  const focus = batchFocus(job, batch.idx);
  const estimate = lim.perBatchUsd * Math.max(1, Math.ceil(batch.quantity / 20)) + (verify ? lim.verifyUsd : 0);

  // 1) Budget : même plafond mensuel que les explications. Une réservation à la fois par job.
  let eventId = null;
  if (quotaConfigured()) {
    const { limitUsd, suspendUsd } = budgetLimits();
    const r = await reserve({ actor: `gen:${job.id}`, dailyLimit: 0, perMinute: 0, windowSeconds: 60, estimatedUsd: estimate, limitUsd, suspendUsd, month: currentMonth() });
    if (!r.ok) {
      await rpc("gen_release_batch", { p_batch: batch.id, p_token: token });
      if (r.reason === "in_flight") return { status: "busy", jobId: job.id };
      if (r.reason === "budget") {
        await rpc("gen_pause_job", { p_job: job.id, p_pause: true }).catch(() => {});
        return { status: "budget", jobId: job.id, message: "Budget mensuel d'IA atteint : le job est en pause." };
      }
      return { status: "unavailable", jobId: job.id, message: "Quotas indisponibles : réessayez plus tard." };
    }
    eventId = r.eventId;
  }

  let usage = null;
  const settle = async (billedUsd) => {
    if (!eventId) return;
    if (billedUsd > 0) await finalize(eventId, billedUsd).catch(() => {});
    else await release(eventId).catch(() => {});
  };

  try {
    const remaining = () => deadline - Date.now() - DEADLINE_SAFETY_MS;
    const prompts = buildPrompts(job, batch, focus);
    const generated = await callDeepSeek({ ...prompts, maxTokens: 8000, timeoutMs: Math.min(remaining(), 45_000), temperature: 0.8 });
    usage = addUsage(usage, generated.usage);

    const evaluated = evaluateGenerated(generated.json, job, batch, focus);
    await flagSimilarExisting(evaluated.items, evaluated.issues, evaluated.stats);
    // Les questions signalées par la base passent en brouillon.
    for (const item of evaluated.items) if (item.question.needs_review) item.target_status = "draft";
    evaluated.stats.validated = evaluated.items.filter((i) => !i.question.needs_review).length;

    let verification = "skipped";
    if (verify && evaluated.items.length && remaining() > 8000) {
      try {
        const v = await verifyItems(evaluated.items.filter((i) => i.target_status === "review"), job, Math.min(remaining(), 20_000));
        usage = addUsage(usage, v.usage);
        verification = "done";
        evaluated.stats.validated = evaluated.items.filter((i) => !i.question.needs_review).length;
        evaluated.stats.flagged = evaluated.items.length - evaluated.stats.validated;
        for (const item of evaluated.items) {
          for (const f of item.question.review_flags.filter((x) => x.code.startsWith("verification_"))) {
            evaluated.issues.push({ ref: item.ref, severity: "warning", code: f.code, message: f.message, payload: null });
          }
        }
      } catch (e) {
        usage = addUsage(usage, e?.usage ?? null);
        verification = "failed";
        evaluated.issues.push({ ref: `b${batch.idx}`, severity: "info", code: "verification_unavailable", message: "Relecture automatique indisponible : validation humaine requise." , payload: null });
      }
    } else if (verify) {
      evaluated.issues.push({ ref: `b${batch.idx}`, severity: "info", code: "verification_skipped", message: "Relecture automatique ignorée (temps d'exécution insuffisant).", payload: null });
    }

    const cost = usage?.estimatedUsd ?? 0;
    const result = await rpc("gen_commit_batch", {
      p_batch: batch.id, p_token: token, p_items: evaluated.items,
      p_issues: evaluated.issues,
      p_stats: { ...evaluated.stats, cost_usd: cost, origin_version: GENERATION_VERSION },
    }, { timeoutMs: 30000 });
    await settle(cost);
    return {
      status: "done", jobId: job.id, batch: batch.idx, jobStatus: result.job_status,
      inserted: result.inserted ?? 0, duplicates: result.duplicates ?? 0, stats: evaluated.stats, costUsd: cost, verification,
    };
  } catch (error) {
    const billed = (error?.usage ?? usage)?.estimatedUsd ?? 0;
    await settle(billed);
    if (error instanceof BankError && error.code === "lease_lost") {
      return { status: "lost", jobId: job.id, message: "Ce lot a été repris par une autre exécution." };
    }
    const retry = error instanceof DeepSeekError ? error.retry : true;
    const message = error instanceof DeepSeekError || error instanceof BankError ? error.message : "Erreur inattendue pendant la génération.";
    if (!(error instanceof DeepSeekError || error instanceof BankError)) console.warn("Génération : erreur inattendue", error);
    if (error instanceof DeepSeekError && [401, 402, 403].includes(error.status)) {
      // Clé refusée ou solde épuisé : on rend le lot et on met le job en pause.
      await rpc("gen_release_batch", { p_batch: batch.id, p_token: token }).catch(() => {});
      await rpc("gen_pause_job", { p_job: job.id, p_pause: true }).catch(() => {});
      return { status: "paused", jobId: job.id, message: `${message} Job mis en pause.` };
    }
    const failed = await rpc("gen_fail_batch", { p_batch: batch.id, p_token: token, p_error: message, p_cost: billed, p_retry: retry }).catch(() => null);
    return { status: "failed", jobId: job.id, batch: batch.idx, message, final: failed?.final ?? false, costUsd: billed };
  }
}

/** Tâche planifiée : traite des lots jusqu'à épuisement du budget de temps. */
export async function runDue({ budgetMs = 45_000, worker = "cron" } = {}) {
  const deadline = Date.now() + budgetMs;
  const outcomes = [];
  while (deadline - Date.now() > 20_000) {
    const r = await processNext({ worker, deadline });
    outcomes.push(r.status);
    if (["idle", "budget", "paused", "unavailable"].includes(r.status)) break;
  }
  return { processed: outcomes.filter((s) => s === "done").length, outcomes };
}

// --- Gestion des jobs ----------------------------------------------------------------------------------

/** Budget restant ce mois-ci (null si les tables de budget n'existent pas encore). */
async function remainingBudgetUsd() {
  try {
    const { limitUsd } = budgetLimits();
    const spent = await rpc("gen_budget_spent", { p_month: currentMonth() });
    return spent === null ? null : limitUsd - Number(spent);
  } catch {
    return null;
  }
}

/** Crée un job et ses lots (transaction unique). Les éditeurs sont limités en volume. */
export async function createJob(input, user) {
  const lim = limits();
  const plan = planJob(input);
  if (user.role !== "admin" && plan.total > lim.editorMax) {
    throw new BankError(`Les éditeurs peuvent générer ${lim.editorMax} questions au plus ; demandez à un administrateur.`, { status: 403, expose: true });
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new BankError("DEEPSEEK_API_KEY n'est pas configurée côté serveur.", { status: 503, expose: true });
  }
  if (quotaConfigured()) {
    const remaining = await remainingBudgetUsd();
    const open = Number(await rpc("gen_open_estimate"));
    if (remaining !== null && plan.estimatedUsd + open > remaining) {
      throw new BankError(`Coût estimé (${plan.estimatedUsd.toFixed(2)} $) supérieur au budget disponible (${Math.max(0, remaining - open).toFixed(2)} $).`, { status: 402, expose: true });
    }
  }
  const job = await rpc("gen_create_job", {
    p_params: {
      part: plan.part, kind: plan.kind, difficulty: plan.difficulty === "mixed" ? 2 : plan.difficulty, theme: plan.theme ?? null,
      total: plan.total, batch_size: plan.batchSize, estimated_usd: plan.estimatedUsd,
      options: { mixed: plan.difficulty === "mixed", category: plan.category ?? null, verify: plan.verify },
    },
    p_actor: user.username,
    p_max_per_hour: lim.jobsPerHour,
  }).catch((e) => {
    if (e instanceof BankError && e.code === "rate_limit") throw new BankError("Trop de générations lancées cette heure.", { status: 429, expose: true });
    throw e;
  });
  return { job, plan };
}

const idSchema = z.object({ jobId: z.string().uuid() });
export const jobReport = async (body) => rpc("gen_job_report", { p_job: idSchema.parse(body).jobId });
export const listJobs = async () => ({ jobs: await rpc("gen_job_list") });
export const cancelJob = async (body, user) => ({ job: await rpc("gen_cancel_job", { p_job: idSchema.parse(body).jobId, p_actor: user.username }) });
export const pauseJob = async (body) => ({ job: await rpc("gen_pause_job", { p_job: idSchema.parse(body).jobId, p_pause: true }) });
export const resumeJob = async (body) => {
  const { jobId } = idSchema.parse(body);
  const report = await rpc("gen_job_report", { p_job: jobId });
  // « Reprendre » couvre la pause comme les lots en échec.
  if (report?.job?.status === "paused") {
    const hasFailed = report.batches.some((b) => b.status === "failed");
    if (hasFailed) await rpc("gen_resume_job", { p_job: jobId });
    else await rpc("gen_pause_job", { p_job: jobId, p_pause: false });
  } else await rpc("gen_resume_job", { p_job: jobId });
  return { job: (await rpc("gen_job_report", { p_job: jobId })).job };
};
