// Importation massive : API serveur. Le fichier est lu par le navigateur, puis envoyé par
// blocs de 200 lignes maximum ; chaque bloc est validé puis écrit dans UNE transaction
// (fonction SQL `bank_import_commit`), de façon idempotente : un bloc rejoué après une
// coupure n'insère rien en double, et un import interrompu se reprend où il s'était arrêté.
// Aucune requête ne dure plus de quelques secondes : pas de dépassement de temps Vercel.

import { z } from "zod";
import { rpc } from "./db.mjs";
import {
  FIELDS, MAX_CELL_LENGTH, MAX_CHUNK_ROWS, MAX_FILE_ROWS, previewRows, processChunk, sanitizeMapping, suggestMapping, missingFields,
} from "./import.mjs";
import { categoriesForPart } from "./quality.mjs";
import { jaccard, SIMILAR_THRESHOLD, similarityText } from "./text.mjs";

const rowSchema = z.object({
  n: z.number().int().min(1).max(MAX_FILE_ROWS + 10),
  data: z.record(z.string().max(120), z.union([z.string().max(MAX_CELL_LENGTH * 2), z.number(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 80, "trop de colonnes"),
});

const optionsSchema = z.object({
  defaultPart: z.union([z.literal(5), z.literal(6), z.literal(7)]).nullish(),
  defaultDifficulty: z.number().int().min(1).max(3).default(2),
});

const mappingSchema = z.record(z.string().max(60), z.string().max(120)).default({});

const analyzeSchema = z.object({
  headers: z.array(z.string().max(120)).min(1).max(80),
  rows: z.array(z.record(z.string(), z.union([z.string().max(MAX_CELL_LENGTH * 2), z.number(), z.boolean(), z.null()]))).max(60),
  mapping: mappingSchema.optional(),
}).merge(optionsSchema);

/** Étape « analyse » : correspondance automatique, champs manquants, aperçu des premières lignes. */
export function analyzeImport(body) {
  const input = analyzeSchema.parse(body);
  const suggestion = suggestMapping(input.headers);
  const mapping = input.mapping ? sanitizeMapping(input.mapping, input.headers) : suggestion.mapping;
  const missing = missingFields(mapping);
  // La partie peut être imposée à l'importation lorsque le fichier n'a pas de colonne « partie ».
  const preview = previewRows(input.rows, mapping, { defaultPart: input.defaultPart ?? null, defaultDifficulty: input.defaultDifficulty });
  return {
    fields: FIELDS.map(({ id, label, required }) => ({ id, label, required })),
    mapping,
    unmapped: input.headers.filter((h) => !Object.values(mapping).includes(h)),
    missing,
    needsDefaultPart: !mapping.part,
    preview,
    categories: { 5: categoriesForPart(5), 6: categoriesForPart(6), 7: categoriesForPart(7) },
    limits: { maxRows: MAX_FILE_ROWS, chunkRows: MAX_CHUNK_ROWS },
  };
}

const startSchema = z.object({
  filename: z.string().min(1).max(200),
  format: z.enum(["csv", "xlsx", "json"]),
  fingerprint: z.string().regex(/^[a-f0-9]{16,64}$/).nullish(),
  totalRows: z.number().int().min(1).max(MAX_FILE_ROWS),
  chunkSize: z.number().int().min(1).max(MAX_CHUNK_ROWS),
  chunksTotal: z.number().int().min(1).max(MAX_FILE_ROWS),
  mapping: mappingSchema,
});

/** Démarre (ou reprend) un import : si le même fichier est déjà en cours, il est repris. */
export async function startImport(body, actor) {
  const input = startSchema.parse(body);
  const batch = await rpc("bank_import_start", {
    p_filename: [...input.filename].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join(""),
    p_format: input.format,
    p_fingerprint: input.fingerprint ?? null,
    p_total_rows: input.totalRows,
    p_chunk_size: input.chunkSize,
    p_chunks_total: input.chunksTotal,
    p_mapping: input.mapping,
    p_actor: actor,
  });
  return { batch };
}

const chunkSchema = z.object({
  batchId: z.string().uuid(),
  chunk: z.number().int().min(0).max(MAX_FILE_ROWS),
  rows: z.array(rowSchema).min(1).max(MAX_CHUNK_ROWS),
  mapping: mappingSchema,
}).merge(optionsSchema);

/** Ajoute les quasi-doublons de la base (candidats LSH puis Jaccard exact) aux alertes. */
export async function flagSimilarExisting(items, issues, stats) {
  const probes = items
    .map((item, i) => ({ i, part: item.part, lsh: item.question.lsh }))
    .filter((p) => p.lsh.length);
  if (!probes.length) return;
  const found = await rpc("bank_find_similar_many", { p_items: probes });
  for (const { i, candidates } of found ?? []) {
    const item = items[i];
    const mine = similarityText(item.part, item.question.prompt, item.question.options);
    for (const c of candidates ?? []) {
      const score = jaccard(mine, similarityText(item.part, c.prompt, c.options));
      if (score < SIMILAR_THRESHOLD) continue;
      const message = `Très proche d'une question existante (${c.slug}, similarité ${Math.round(score * 100)} %).`;
      if (!item.question.needs_review) stats.flagged += 1;
      item.question.needs_review = true;
      item.question.review_flags.push({ code: "similar_existing", message, severity: "warning" });
      issues.push({ ref: String(item.ref), severity: "warning", code: "similar_existing", message, payload: { slug: c.slug, score: Number(score.toFixed(2)) } });
      break;
    }
  }
}

/** Valide puis enregistre un bloc de lignes. Idempotent pour un même numéro de bloc. */
export async function importChunk(body, actor) {
  const input = chunkSchema.parse(body);
  const { items, issues, stats } = processChunk(input.rows, input.mapping, {
    defaultPart: input.defaultPart ?? null,
    defaultDifficulty: input.defaultDifficulty,
  });
  await flagSimilarExisting(items, issues, stats);
  const result = await rpc("bank_import_commit", {
    p_batch: input.batchId,
    p_chunk: input.chunk,
    p_items: items,
    p_issues: issues.map((i) => ({ ...i, payload: i.payload ?? null })),
    p_stats: stats,
    p_actor: actor,
  }, { timeoutMs: 40000 });
  return {
    alreadyDone: Boolean(result.already_done),
    inserted: result.inserted ?? 0,
    duplicates: result.duplicates ?? 0,
    rejected: stats.rejected,
    flagged: stats.flagged,
    batch: result.batch,
  };
}


const idSchema = z.object({ batchId: z.string().uuid() });

/** État d'un import et synthèse du rapport. */
export async function importStatus(body) {
  const { batchId } = idSchema.parse(body);
  const report = await rpc("bank_import_report", { p_batch: batchId });
  return report ? { batch: report.batch, issueCounts: report.issue_counts } : { batch: null };
}

const issuesSchema = z.object({
  batchId: z.string().uuid(),
  severity: z.enum(["error", "warning", "info"]).optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(200).default(50),
});

/** Lignes du rapport : rejetées (error), à corriger (warning). */
export async function importIssues(body) {
  const input = issuesSchema.parse(body);
  return rpc("bank_issues_list", { p_import: input.batchId, p_severity: input.severity ?? null, p_limit: input.limit, p_offset: input.offset });
}

export async function listImports() {
  return { batches: await rpc("bank_import_list") };
}

export async function cancelImport(body) {
  const { batchId } = idSchema.parse(body);
  await rpc("bank_import_cancel", { p_batch: batchId });
  return { ok: true };
}
