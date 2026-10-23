// Signalement d'une question erronée (anonyme ou connecté).
//
// Écriture avec la clé service_role uniquement (table sans accès public). L'IP
// n'est jamais stockée : seule une empreinte salée sert à limiter les abus.

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkRateLimit, clientIp } from "./rate-limit.mjs";
import { authConfigured, currentAiUser } from "./auth.mjs";
import { findQuestion } from "./explain.mjs";
import { storeConfigured } from "./store.mjs";

const listening = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../data/listening.json"), "utf8")
);

/** Question à signaler : Reading (jeu local ou Supabase) ou Listening Part 2. */
async function findReportable(questionId) {
  const audio = listening.part2.find((item) => item.id === questionId);
  if (audio) return { part: 2, prompt: audio.prompt };
  return findQuestion(questionId).catch(() => null);
}

export const REPORT_REASONS = ["wrong_answer", "typo", "ambiguous", "unclear_audio", "other"];
export const MAX_COMMENT = 500;
const MAX_BODY_BYTES = 4 * 1024;

function config() {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const cfg = config();
  const res = await fetch(new URL(`/rest/v1/${path}`, cfg.base), {
    method,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} sur ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

/** Empreinte salée d'une IP : permet de limiter les abus sans conserver l'adresse. */
export function reporterHash(ip) {
  const salt = process.env.ADMIN_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "lernoviq";
  return createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 24);
}

export function parseReport(body) {
  const { questionId, reason, comment, part } = body ?? {};
  if (typeof questionId !== "string" || !questionId.trim() || questionId.length > 200) {
    return { ok: false, error: "Question à signaler invalide." };
  }
  if (!REPORT_REASONS.includes(reason)) return { ok: false, error: "Motif invalide." };
  const text = typeof comment === "string" ? comment.replace(/\s+/g, " ").trim() : "";
  if (text.length > MAX_COMMENT) return { ok: false, error: `Commentaire trop long (${MAX_COMMENT} caractères maximum).` };
  if (reason === "other" && text.length < 5) return { ok: false, error: "Décrivez brièvement le problème." };
  const partNumber = [2, 5, 6, 7].includes(part) ? part : null;
  return { ok: true, value: { questionId: questionId.trim(), reason, comment: text, part: partNumber } };
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function sameOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers["x-forwarded-host"] || req.headers.host);
  } catch {
    return false;
  }
}

async function readJson(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== "function") {
    const text = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error("trop volumineux"), { statusCode: 413 });
    return JSON.parse(text || "{}");
  }
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > MAX_BODY_BYTES) throw Object.assign(new Error("trop volumineux"), { statusCode: 413 });
  }
  return JSON.parse(data || "{}");
}

export async function handleReport(req, res) {
  if (req.method && req.method !== "POST") return send(res, 405, { error: "Méthode non autorisée." });
  if (!sameOrigin(req)) return send(res, 403, { error: "Origine non autorisée." });
  if (!storeConfigured()) {
    return send(res, 503, { error: "Le signalement n'est pas disponible pour le moment.", code: "unavailable" });
  }

  const ip = clientIp(req);
  const gate = checkRateLimit(`report:${ip}`, { limit: 10, windowMs: 3_600_000 });
  if (!gate.ok) {
    res.setHeader("Retry-After", String(gate.retryAfterSec));
    return send(res, 429, { error: "Trop de signalements. Merci de réessayer plus tard.", code: "rate" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    if (error?.statusCode === 413) return send(res, 413, { error: "Requête trop volumineuse." });
    return send(res, 400, { error: "JSON invalide." });
  }
  const parsed = parseReport(body);
  if (!parsed.ok) return send(res, 400, { error: parsed.error });
  const { questionId, reason, comment, part } = parsed.value;

  try {
    const user = authConfigured() ? await currentAiUser(req).catch(() => null) : null;
    const hash = reporterHash(ip);

    // Limite distribuée : au plus 10 signalements par heure et par empreinte.
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const recent = await rest(
      `question_reports?reporter_hash=eq.${hash}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=11`
    );
    if (recent.length >= 10) {
      return send(res, 429, { error: "Trop de signalements. Merci de réessayer plus tard.", code: "rate" });
    }

    // Capture de l'énoncé au moment du signalement (la question peut être modifiée ensuite).
    const question = await findReportable(questionId);
    if (!question) return send(res, 404, { error: "Question introuvable." });

    // Un même lecteur ne signale pas deux fois la même question pour le même motif.
    const duplicate = await rest(
      `question_reports?reporter_hash=eq.${hash}&question_id=eq.${encodeURIComponent(questionId)}&reason=eq.${reason}&status=eq.open&select=id&limit=1`
    );
    if (duplicate.length) return send(res, 200, { ok: true, duplicate: true });

    await rest("question_reports", {
      method: "POST",
      prefer: "return=minimal",
      body: [
        {
          question_id: questionId,
          part: part ?? question.part ?? null,
          question_prompt: String(question.prompt ?? "").slice(0, 600),
          reason,
          comment,
          reporter_id: user?.id ?? null,
          reporter_hash: hash,
        },
      ],
    });
    return send(res, 201, { ok: true });
  } catch {
    return send(res, 503, { error: "Le signalement n'a pas pu être enregistré. Réessayez plus tard.", code: "unavailable" });
  }
}

export const REPORT_STATUSES = ["open", "resolved", "rejected"];

/** Liste des signalements (espace admin), les plus récents d'abord. */
export async function listReports(status = "open") {
  if (!config()) throw new Error("Supabase n'est pas configuré côté serveur.");
  const filter = REPORT_STATUSES.includes(status) ? `status=eq.${status}&` : "";
  return rest(
    `question_reports?${filter}select=id,question_id,part,question_prompt,reason,comment,status,handled_by,handled_at,created_at&order=created_at.desc&limit=200`
  );
}

export async function setReportStatus(id, status, handledBy) {
  if (!config()) throw new Error("Supabase n'est pas configuré côté serveur.");
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Identifiant de signalement invalide.");
  if (!REPORT_STATUSES.includes(status)) throw new Error("Statut invalide.");
  const rows = await rest(`question_reports?id=eq.${id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status,
      handled_by: status === "open" ? null : String(handledBy).slice(0, 64),
      handled_at: status === "open" ? null : new Date().toISOString(),
    },
  });
  if (!rows.length) throw new Error("Signalement introuvable.");
  return rows[0];
}
