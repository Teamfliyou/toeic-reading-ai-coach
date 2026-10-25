// Journal d'audit des actions sensibles de l'administration.
//
// Table `admin_audit_log` (supabase/admin_audit.sql), accessible au seul
// service_role. On n'y écrit jamais de mot de passe, de jeton ni d'IP en clair :
// uniquement l'auteur, l'action, la cible et quelques détails non sensibles.
//
// Si le journal est indisponible (migration absente, Supabase en panne), l'action
// administrative n'est pas bloquée mais l'échec est signalé dans les logs serveur.

import { createHash } from "node:crypto";
import { clientIp } from "./rate-limit.mjs";

export const AUDIT_ACTIONS = [
  "login.success",
  "setup.first_admin",
  "user.create",
  "user.role",
  "user.activate",
  "user.deactivate",
  "user.password_reset",
  "question.publish",
  "questions.generate",
  "report.status",
  "bank.import",
  "bank.update",
  "bank.status",
  "bank.delete",
  "generation.create",
  "generation.control",
];

function config() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

async function rest(path, { method = "GET", body } = {}) {
  const cfg = config();
  if (!cfg) throw new Error("Supabase non configuré");
  const res = await fetch(new URL(`/rest/v1/${path}`, cfg.base), {
    method,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      ...(body === undefined ? {} : { Prefer: "return=minimal" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} sur ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

/** Retire toute valeur sensible d'un objet de détails (défense en profondeur). */
export function sanitizeDetails(details) {
  const blocked = /pass|secret|token|cookie|authorization|hash|salt|key/i;
  const out = {};
  for (const [name, value] of Object.entries(details ?? {})) {
    if (blocked.test(name)) continue;
    if (value === null || ["boolean", "number"].includes(typeof value)) out[name] = value;
    else if (typeof value === "string") out[name] = value.slice(0, 200);
  }
  return out;
}

/** Empreinte salée de l'IP : permet de recouper des actions sans conserver l'adresse. */
export function ipFingerprint(req) {
  const salt = process.env.ADMIN_SESSION_SECRET || "lernoviq";
  return createHash("sha256").update(`${salt}|${clientIp(req)}`).digest("hex").slice(0, 16);
}

/** Enregistre une action. Ne lève jamais d'exception. */
export async function recordAudit({ actor, action, target = null, details = {}, req }) {
  try {
    if (!AUDIT_ACTIONS.includes(action)) throw new Error(`Action d'audit inconnue : ${action}`);
    await rest("admin_audit_log", {
      method: "POST",
      body: [
        {
          actor_id: actor?.id ?? null,
          actor_username: actor?.username ?? null,
          action,
          target: target === null ? null : String(target).slice(0, 200),
          details: sanitizeDetails(details),
          ip_hash: req ? ipFingerprint(req) : null,
        },
      ],
    });
    return true;
  } catch {
    console.warn("Journal d'audit indisponible : action non enregistrée.");
    return false;
  }
}

/** Traduit une modification de compte en événements d'audit distincts. */
export function userChangeEvents(body, updated) {
  const target = updated?.username ?? body?.id ?? null;
  const events = [];
  if (body?.password !== undefined) events.push({ action: "user.password_reset", target, details: {} });
  if (body?.role !== undefined) events.push({ action: "user.role", target, details: { role: body.role } });
  if (typeof body?.active === "boolean") {
    events.push({ action: body.active ? "user.activate" : "user.deactivate", target, details: {} });
  }
  return events;
}

/** Dernières entrées du journal (espace admin). */
export async function listAudit({ action, limit = 200 } = {}) {
  const filter = AUDIT_ACTIONS.includes(action) ? `action=eq.${action}&` : "";
  const size = Math.min(Math.max(Number(limit) || 200, 1), 500);
  return rest(
    `admin_audit_log?${filter}select=id,at,actor_username,action,target,details,ip_hash&order=at.desc&limit=${size}`
  );
}
