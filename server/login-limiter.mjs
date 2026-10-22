// Limitation de la connexion admin, distribuée via Supabase.
//
// Le compteur vit en base (fonctions `admin_login_attempt` / `admin_login_clear`,
// voir supabase/ai_hardening.sql) : il est donc partagé entre toutes les
// instances serverless, par IP et par identifiant, sur une fenêtre glissante.
// Si la migration n'est pas appliquée, on retombe sur un compteur mémoire
// (moins fiable) plutôt que de verrouiller l'administration.

import { checkRateLimit } from "./rate-limit.mjs";

function config() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

async function rpc(name, body) {
  const cfg = config();
  const res = await fetch(new URL(`/rest/v1/rpc/${name}`, cfg.base), {
    method: "POST",
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Supabase RPC ${name} : ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function limits() {
  return {
    maxIp: Number(process.env.ADMIN_LOGIN_MAX_PER_IP) || 20,
    maxUser: Number(process.env.ADMIN_LOGIN_MAX_PER_USER) || 8,
    windowSeconds: Number(process.env.ADMIN_LOGIN_WINDOW_SECONDS) || 900,
  };
}

/**
 * Enregistre une tentative. Renvoie `{ ok, retryAfterSec, attemptId }`.
 * `attemptId` doit être passé à `clearAttempt` après une connexion réussie.
 */
export async function registerAttempt(ip, username) {
  const { maxIp, maxUser, windowSeconds } = limits();
  const name = String(username || "").toLowerCase().slice(0, 64);
  const address = String(ip || "unknown").slice(0, 64);
  if (config()) {
    try {
      const result = await rpc("admin_login_attempt", {
        p_ip: address,
        p_username: name,
        p_max_ip: maxIp,
        p_max_user: maxUser,
        p_window_seconds: windowSeconds,
      });
      if (result && typeof result.ok === "boolean") {
        return {
          ok: result.ok,
          retryAfterSec: result.retry_after ?? 0,
          attemptId: result.attempt_id ?? null,
        };
      }
    } catch {
      /* migration absente ou base indisponible : repli mémoire ci-dessous */
    }
  }
  const windowMs = windowSeconds * 1000;
  const byIp = checkRateLimit(`admin-ip:${address}`, { limit: maxIp, windowMs });
  const byUser = checkRateLimit(`admin-user:${name}`, { limit: maxUser, windowMs });
  const ok = byIp.ok && byUser.ok;
  return {
    ok,
    retryAfterSec: ok ? 0 : Math.max(byIp.retryAfterSec, byUser.retryAfterSec),
    attemptId: null,
  };
}

/** Efface une tentative réussie : seuls les échecs comptent. */
export async function clearAttempt(attemptId) {
  if (!attemptId || !config()) return;
  await rpc("admin_login_clear", { p_attempt: attemptId }).catch(() => {});
}
