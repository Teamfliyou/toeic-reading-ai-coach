// Quotas et budget IA : réservations atomiques via des fonctions Postgres.
//
// Toute la logique de quota / débit / budget vit en base, dans une seule
// transaction (voir supabase/ai_explanations.sql). C'est indispensable en
// serverless : l'état mémoire n'est pas partagé entre instances.
//
// Sans Supabase configuré, les fonctions sont inertes (`{ok:true, skipped:true}`)
// et l'application conserve son comportement d'origine.

import { storeConfigured } from "./store.mjs";

function config() {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

/** Vrai si les quotas/budget sont actifs (Supabase service_role). */
export function quotaConfigured() {
  return storeConfigured();
}

async function rpc(name, body) {
  const cfg = config();
  if (!cfg) return null;
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

/** Mois courant au format `YYYY-MM` (UTC), clé du budget mensuel. */
export function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

/**
 * Budget mensuel exprimé en USD (DeepSeek facture en dollars) à partir des
 * variables en euros, via un taux de conversion configurable.
 */
export function budgetLimits(env = process.env) {
  const rate = Number(env.AI_USD_EUR_RATE) || 0.93; // 1 USD ≈ 0,93 €
  const limitEur = Number(env.AI_MONTHLY_LIMIT_EUR) || 10;
  const suspendEur = Number(env.AI_MONTHLY_SUSPEND_EUR) || 8;
  const toUsd = (eur) => Number((eur / rate).toFixed(4));
  return {
    limitUsd: Number(env.AI_MONTHLY_LIMIT_USD) || toUsd(limitEur),
    suspendUsd: Number(env.AI_MONTHLY_SUSPEND_USD) || toUsd(suspendEur),
  };
}

/**
 * Réserve atomiquement une explication : vérifie le quota quotidien, le débit
 * par minute, l'unicité en vol et le budget mensuel, puis enregistre la
 * réservation. Renvoie `{ ok:true, eventId }` ou `{ ok:false, reason }`.
 */
export async function reserve({
  actor,
  dailyLimit,
  perMinute,
  windowSeconds,
  estimatedUsd,
  limitUsd,
  suspendUsd,
  month,
}) {
  if (!quotaConfigured()) return { ok: true, eventId: null, skipped: true };
  const result = await rpc("ai_reserve_explain", {
    p_actor: actor,
    p_daily_limit: dailyLimit,
    p_per_minute: perMinute,
    p_window_seconds: windowSeconds,
    p_estimated_usd: estimatedUsd,
    p_month: month,
    p_limit_usd: limitUsd,
    p_suspend_usd: suspendUsd,
  });
  if (!result) return { ok: false, reason: "unavailable" };
  // La fonction Postgres renvoie `event_id` : on normalise en `eventId`.
  return { ...result, eventId: result.event_id ?? result.eventId ?? null };
}

/** Remplace la réservation par le coût réel après un appel réussi. */
export async function finalize(eventId, actualUsd) {
  if (!eventId || !quotaConfigured()) return;
  await rpc("ai_finalize_explain", { p_event: eventId, p_actual_usd: actualUsd });
}

/** Rembourse la réservation lorsqu'aucune explication n'a été produite. */
export async function release(eventId) {
  if (!eventId || !quotaConfigured()) return;
  await rpc("ai_release_explain", { p_event: eventId });
}
