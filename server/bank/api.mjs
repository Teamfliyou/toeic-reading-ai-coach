// Routage des actions « bank-* » de /api/admin (bibliothèque, importation, génération).
// L'authentification, la vérification d'origine et le journal d'audit sont ceux de admin.mjs ;
// ce module ajoute les rôles (admin / éditeur), la taille maximale des requêtes et le
// masquage des erreurs internes.

import { ZodError } from "zod";
import { recordAudit } from "../audit.mjs";
import { BankError, bankConfigured } from "./db.mjs";
import * as importing from "./import-service.mjs";
import * as library from "./library.mjs";
import * as generation from "./generation.mjs";
import * as listening from "./listening.mjs";

const MB = 1024 * 1024;

/**
 * Actions : `role` minimal ("editor" = éditeur ou administrateur), `limit` = taille maximale du
 * corps en caractères (les blocs d'importation sont plus volumineux que les autres requêtes).
 */
const ACTIONS = {
  "bank-import-analyze": { limit: 1 * MB, run: (b) => importing.analyzeImport(b) },
  "bank-import-start": { limit: 64_000, run: (b, u) => importing.startImport(b, u.username) },
  "bank-import-chunk": { limit: 3 * MB, run: async (b, u, ctx) => {
    const out = await importing.importChunk(b, u.username);
    if (out.batch?.status === "completed" && !out.alreadyDone) {
      await recordAudit({ actor: u, action: "bank.import", target: out.batch.filename, details: { accepted: out.batch.accepted, rejected: out.batch.rejected, duplicates: out.batch.duplicates }, req: ctx.req });
    }
    return out;
  } },
  "bank-import-status": { limit: 8_000, run: (b) => importing.importStatus(b) },
  "bank-import-issues": { limit: 8_000, run: (b) => importing.importIssues(b) },
  "bank-import-list": { limit: 8_000, run: () => importing.listImports() },
  "bank-import-cancel": { limit: 8_000, run: (b) => importing.cancelImport(b) },

  "bank-list": { limit: 16_000, run: (b) => library.listQuestions(b) },
  "bank-get": { limit: 8_000, run: (b) => library.getQuestion(b) },
  "bank-update": { limit: 64_000, run: async (b, u, ctx) => {
    const out = await library.updateQuestion(b, u.username);
    await recordAudit({ actor: u, action: "bank.update", target: out.question?.slug, details: { version: out.question?.version }, req: ctx.req });
    return out;
  } },
  "bank-update-passage": { limit: 128_000, run: (b, u) => library.updatePassage(b, u.username) },
  "bank-status": { limit: 64_000, run: async (b, u, ctx) => {
    const out = await library.setStatus(b, u.username);
    await recordAudit({ actor: u, action: "bank.status", target: b.status, details: { changed: out.changed, skipped: out.skipped?.length ?? 0 }, req: ctx.req });
    return out;
  } },
  "bank-delete": { role: "admin", limit: 64_000, run: async (b, u, ctx) => {
    const out = await library.deleteQuestions(b, u.username);
    await recordAudit({ actor: u, action: "bank.delete", details: { deleted: out.deleted, skipped: out.skipped?.length ?? 0 }, req: ctx.req });
    return out;
  } },
  "bank-stats": { limit: 4_000, run: () => library.stats() },
  "bank-duplicates": { limit: 8_000, run: (b) => library.duplicates(b) },

  "bank-gen-create": { limit: 16_000, run: async (b, u, ctx) => {
    const out = await generation.createJob(b, u);
    await recordAudit({ actor: u, action: "generation.create", target: out.job.id, details: { part: out.plan.part, total: out.plan.total, batches: out.plan.batches, estimatedUsd: out.plan.estimatedUsd }, req: ctx.req });
    return out;
  } },
  "bank-listening-import": { limit: 2 * MB, run: async (b, u, ctx) => {
    const out = await listening.importListening(b, u.username);
    await recordAudit({ actor: u, action: "bank.import", target: "listening", details: { accepted: out.inserted, rejected: out.rejected, duplicates: out.duplicates }, req: ctx.req });
    return out;
  } },
  "bank-listening-list": { limit: 8_000, run: (b) => listening.listListening(b) },
  "bank-listening-status": { limit: 64_000, run: async (b, u, ctx) => {
    const out = await listening.setListeningStatus(b, u.username);
    await recordAudit({ actor: u, action: "bank.status", target: `listening:${b.status}`, details: { changed: out.changed }, req: ctx.req });
    return out;
  } },
  "bank-gen-plan": { limit: 16_000, run: (b) => ({ plan: generation.planJob(b), limits: generation.limits() }) },
  "bank-gen-list": { limit: 4_000, run: () => generation.listJobs() },
  "bank-gen-get": { limit: 8_000, run: (b) => generation.jobReport(b) },
  "bank-gen-tick": { limit: 8_000, owner: true, run: async (b, u) => {
    const budget = Number(process.env.GEN_TICK_BUDGET_MS) || 50_000;
    const result = await generation.processNext({ jobId: b.jobId, worker: `ui:${u.username}`, deadline: Date.now() + budget });
    const report = await generation.jobReport(b);
    return { result, report };
  } },
  "bank-gen-cancel": { limit: 8_000, owner: true, run: async (b, u, ctx) => {
    const out = await generation.cancelJob(b, u);
    await recordAudit({ actor: u, action: "generation.control", target: b.jobId, details: { operation: "cancel" }, req: ctx.req });
    return out;
  } },
  "bank-gen-pause": { limit: 8_000, owner: true, run: async (b, u, ctx) => {
    const out = await generation.pauseJob(b);
    await recordAudit({ actor: u, action: "generation.control", target: b.jobId, details: { operation: "pause" }, req: ctx.req });
    return out;
  } },
  "bank-gen-resume": { limit: 8_000, owner: true, run: async (b, u, ctx) => {
    const out = await generation.resumeJob(b);
    await recordAudit({ actor: u, action: "generation.control", target: b.jobId, details: { operation: "resume" }, req: ctx.req });
    return out;
  } },
};

export const isBankAction = (action) => Object.hasOwn(ACTIONS, action);

/** Un éditeur ne contrôle que ses propres générations ; un administrateur contrôle tout. */
async function assertOwner(user, body) {
  if (user.role === "admin") return;
  const id = body?.jobId;
  if (typeof id !== "string") return; // la validation du schéma refusera la requête
  const report = await generation.jobReport({ jobId: id });
  if (!report?.job || report.job.created_by !== user.username) {
    throw new BankError("Cette génération a été lancée par un autre utilisateur.", { status: 403, expose: true });
  }
}

/** Message d'erreur à renvoyer au navigateur : jamais de détail interne. */
export function publicError(error) {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return { status: 400, message: `Requête invalide${first ? ` (${first.path.join(".") || "corps"} : ${first.message})` : ""}.` };
  }
  if (error instanceof BankError) {
    return error.expose ? { status: error.status, message: error.message } : { status: 500, message: "Erreur de base de données." };
  }
  if (error instanceof SyntaxError) return { status: 400, message: "JSON invalide." };
  if (/trop volumineuse/i.test(error?.message ?? "")) return { status: 413, message: "Requête trop volumineuse." };
  console.warn("Erreur d'administration inattendue :", String(error?.message ?? error).replace(/(sk-|eyJ)[A-Za-z0-9._-]+/g, "$1***").slice(0, 300));
  return { status: 500, message: "Erreur du serveur." };
}

/** Exécute une action « bank-* ». L'utilisateur est déjà authentifié par admin.mjs. */
export async function handleBankAction(action, { req, res, user, json, readBody }) {
  const spec = ACTIONS[action];
  try {
    if (spec.role === "admin" && user.role !== "admin") return json(res, 403, { error: "Réservé aux administrateurs" });
    if (!bankConfigured()) return json(res, 503, { error: "Supabase n'est pas configuré côté serveur." });
    const body = await readBody(req, spec.limit);
    if (spec.owner) await assertOwner(user, body);
    const out = await spec.run(body, user, { req });
    return json(res, 200, out ?? {});
  } catch (error) {
    const { status, message } = publicError(error);
    return json(res, status, { error: message });
  }
}
