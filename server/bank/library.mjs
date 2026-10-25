// Bibliothèque d'administration : liste paginée, édition, statuts, suppression contrôlée,
// doublons et statistiques. Toute écriture passe par une fonction SQL transactionnelle qui
// consigne l'auteur et conserve l'historique des révisions.

import { z } from "zod";
import { BankError, rpc, select } from "./db.mjs";
import { OPTION_KEYS, checkQuestion, outcomeFor } from "./quality.mjs";
import { lshBands, similarityText } from "./text.mjs";

const STATUSES = ["draft", "review", "published", "archived"];

const filtersSchema = z.object({
  part: z.number().int().min(5).max(7).optional(),
  difficulty: z.number().int().min(1).max(3).optional(),
  category: z.string().max(60).optional(),
  theme: z.string().max(80).optional(),
  status: z.enum(["draft", "review", "published", "archived"]).optional(),
  source: z.enum(["ai", "import", "manual"]).optional(),
  needs_review: z.boolean().optional(),
  passage_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  batch_id: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["newest", "oldest", "updated"]).optional(),
}).strict();

const listSchema = z.object({
  filters: filtersSchema.default({}),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(100000).default(0),
});

/** Nombre de signalements d'élèves ouverts par question (identifiant ou slug). */
async function openReportCounts(rows) {
  const keys = [...new Set(rows.flatMap((r) => [r.slug, r.id]).filter(Boolean))];
  if (!keys.length) return {};
  try {
    const list = keys.map((k) => `"${String(k).replace(/"/g, "")}"`).join(",");
    const reports = await select(`question_reports?status=eq.open&question_id=in.(${encodeURIComponent(list)})&select=question_id&limit=1000`);
    const counts = {};
    for (const { question_id: id } of reports) counts[id] = (counts[id] ?? 0) + 1;
    return counts;
  } catch {
    return {}; // table des signalements absente : la liste reste utilisable
  }
}

export async function listQuestions(body) {
  const input = listSchema.parse(body ?? {});
  const result = await rpc("bank_admin_list", { p_filters: input.filters, p_limit: input.limit, p_offset: input.offset });
  const counts = await openReportCounts(result.rows);
  for (const row of result.rows) row.open_reports = (counts[row.slug] ?? 0) + (counts[row.id] ?? 0);
  return result;
}

const idSchema = z.object({ id: z.string().uuid() });

export async function getQuestion(body) {
  const { id } = idSchema.parse(body);
  const detail = await rpc("bank_admin_get", { p_id: id });
  if (!detail) throw new BankError("Question introuvable.", { status: 404, expose: true });
  const counts = await openReportCounts([detail.question]);
  detail.question.open_reports = (counts[detail.question.slug] ?? 0) + (counts[detail.question.id] ?? 0);
  const reports = await reportsFor(detail.question);
  return { ...detail, reports };
}

async function reportsFor(question) {
  try {
    const ids = [question.slug, question.id].filter(Boolean).map((k) => `"${String(k).replace(/"/g, "")}"`).join(",");
    return await select(`question_reports?question_id=in.(${encodeURIComponent(ids)})&select=id,reason,comment,status,created_at&order=created_at.desc&limit=20`);
  } catch {
    return [];
  }
}

const patchSchema = z.object({
  prompt: z.string().trim().min(10).max(1500).optional(),
  options: z.array(z.object({ key: z.enum(OPTION_KEYS), text: z.string().trim().min(1).max(400) })).length(4).optional(),
  correct_key: z.enum(OPTION_KEYS).optional(),
  difficulty: z.number().int().min(1).max(3).optional(),
  category: z.string().max(60).nullable().optional(),
  theme: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  explanation: z.string().max(2000).nullable().optional(),
  option_rationales: z.record(z.enum(OPTION_KEYS), z.string().max(600)).nullable().optional(),
  ack_review: z.boolean().optional(),
}).strict();

const updateSchema = z.object({ id: z.string().uuid(), patch: patchSchema, expectedVersion: z.number().int().min(1).optional() });

/**
 * Modifie une question. Les mêmes contrôles qu'à l'import s'appliquent au résultat : une
 * modification qui rend la question invalide est refusée ; les alertes sont renvoyées.
 */
export async function updateQuestion(body, actor) {
  const input = updateSchema.parse(body);
  const detail = await rpc("bank_admin_get", { p_id: input.id });
  if (!detail) throw new BankError("Question introuvable.", { status: 404, expose: true });
  const cur = detail.question;
  const merged = {
    part: cur.part,
    prompt: input.patch.prompt ?? cur.prompt,
    options: input.patch.options ?? cur.options,
    correctKey: input.patch.correct_key ?? cur.correct_key,
    difficulty: input.patch.difficulty ?? cur.difficulty,
    category: input.patch.category !== undefined ? input.patch.category : cur.category,
    theme: input.patch.theme !== undefined ? input.patch.theme : cur.theme,
    tags: input.patch.tags ?? cur.tags,
    explanation: input.patch.explanation !== undefined ? input.patch.explanation : cur.explanation,
    optionRationales: input.patch.option_rationales !== undefined ? input.patch.option_rationales : cur.option_rationales,
  };
  const checked = checkQuestion(merged, { source: cur.source });
  if (checked.errors.length) {
    throw new BankError(checked.errors.map((e) => e.message).join(" "), { status: 400, expose: true });
  }
  const patch = { ...input.patch };
  if (patch.category !== undefined) patch.category = checked.question.category;
  if ("prompt" in patch || "options" in patch) patch.lsh = lshBands(similarityText(cur.part, merged.prompt, merged.options));
  try {
    const row = await rpc("bank_update_question", { p_id: input.id, p_patch: patch, p_expected_version: input.expectedVersion ?? null, p_actor: actor });
    return { question: row, warnings: checked.warnings, outcome: outcomeFor(checked) };
  } catch (e) {
    if (e instanceof BankError && e.code === "version_conflict") {
      throw new BankError("Cette question a été modifiée par quelqu'un d'autre : rechargez-la avant d'enregistrer.", { status: 409, expose: true });
    }
    if (e instanceof BankError && e.code === "duplicate_content") {
      throw new BankError("Une autre question avec le même contenu existe déjà.", { status: 409, expose: true });
    }
    throw e;
  }
}

const passageSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(250),
  documents: z.array(z.object({
    kind: z.enum(["email", "memo", "article", "notice", "schedule", "letter", "message"]),
    title: z.string().trim().max(250),
    body: z.array(z.string().trim().min(1).max(4000)).min(1).max(40),
  })).min(1).max(4),
});

export async function updatePassage(body, actor) {
  const input = passageSchema.parse(body);
  const passage = await rpc("bank_update_passage", { p_id: input.id, p_title: input.title, p_documents: input.documents, p_actor: actor });
  return { passage };
}

const statusSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  status: z.enum(["draft", "review", "published", "archived"]),
  ack: z.boolean().default(false),
});

/** Statut individuel ou en masse. Publier une question à vérifier exige `ack` (relecture humaine). */
export async function setStatus(body, actor) {
  const input = statusSchema.parse(body);
  return rpc("bank_set_status", { p_ids: input.ids, p_status: input.status, p_actor: actor, p_ack: input.ack });
}

const deleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

/** Suppression : uniquement des questions jamais publiées. Les autres doivent être archivées. */
export async function deleteQuestions(body, actor) {
  const input = deleteSchema.parse(body);
  return rpc("bank_delete_questions", { p_ids: input.ids, p_actor: actor });
}

export const stats = async () => rpc("bank_admin_stats");

const dupSchema = z.object({ limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0) });
export async function duplicates(body) {
  const input = dupSchema.parse(body ?? {});
  return rpc("bank_duplicate_groups", { p_limit: input.limit, p_offset: input.offset });
}

export const STATUS_LIST = STATUSES;
