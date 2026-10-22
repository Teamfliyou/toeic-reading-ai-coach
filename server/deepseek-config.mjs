// Constantes DeepSeek centralisées : modèle, prix de référence et version de
// prompt. Une seule source de vérité évite les divergences entre modules.
//
// Sources officielles (vérifiées le 2026-10-18) :
//   - Modèles   : https://api-docs.deepseek.com/quick_start/pricing
//   - Historique: https://api-docs.deepseek.com/updates
//     (`deepseek-chat` et `deepseek-reasoner` retirés le 2026-07-24.)

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// Modèle par défaut. `deepseek-flash` est le modèle actuel (DeepSeek-V4.1-Flash).
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";

// Version du prompt. À incrémenter dès qu'un prompt change : les explications
// mises en cache sous une ancienne version ne sont alors plus servies. À
// incrémenter aussi quand le texte ou l'ordre des choix d'une question change.
export const PROMPT_VERSION = "2026-10-22.1";

// Prix « deepseek-flash » hors heures de pointe, en USD par million de tokens.
const PRICES = { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 };

/** Vrai pendant les heures de pointe DeepSeek (01–04 h et 06–10 h UTC, lun–ven). */
export function isPeakUTC(now = new Date()) {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return (
    day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
  );
}

/**
 * Coût réel d'un appel à partir de l'objet `usage` renvoyé par DeepSeek.
 * @returns {{inputTokens:number, outputTokens:number, cacheHitTokens:number,
 *            estimatedUsd:number, ratePeriod:string, model:string}}
 */
export function computeCost(usage, { now = new Date(), model = DEEPSEEK_MODEL } = {}) {
  const input = Number(usage?.prompt_tokens) || 0;
  const output = Number(usage?.completion_tokens) || 0;
  const hit = Math.min(input, Number(usage?.prompt_cache_hit_tokens) || 0);
  const miss = Math.max(0, input - hit);
  const rate = isPeakUTC(now) ? 2 : 1;
  const usd =
    (miss * PRICES.cacheMiss + hit * PRICES.cacheHit + output * PRICES.output) /
    1e6 *
    rate;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheHitTokens: hit,
    estimatedUsd: Number(usd.toFixed(6)),
    ratePeriod: rate === 2 ? "peak" : "off-peak",
    model,
  };
}

/**
 * Estimation a priori (réservation de budget) d'un appel d'explication.
 * Volontairement majorée pour qu'un dépassement de budget reste impossible.
 */
export function estimateCostUsd() {
  const value = Number(process.env.AI_ESTIMATED_CALL_USD);
  return Number.isFinite(value) && value > 0 ? value : 0.004;
}

/** Additionne deux relevés de coût (tentatives successives d'un même appel). */
export function addUsage(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    ...a,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    estimatedUsd: Number((a.estimatedUsd + b.estimatedUsd).toFixed(6)),
  };
}
