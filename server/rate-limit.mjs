// Limiteur de débit à fenêtre glissante, en mémoire, sans dépendance.
//
// Objectif : freiner l'abus de l'endpoint /api/explain (consommation de la clé
// DeepSeek du serveur) sans gêner les utilisateurs légitimes.
//
// Limite connue : la fenêtre est stockée par instance de processus. Sur un
// déploiement serverless multi-instances, la limite effective est donc plus
// permissive. Pour une garantie forte à grande échelle, brancher un stockage
// partagé (Redis/KV) ou un WAF en amont.

const buckets = new Map();
const MAX_BUCKETS = 5000;

/** Vrai si les en-têtes de proxy (x-forwarded-for…) sont fiables ici. */
function trustsProxy() {
  return process.env.TRUST_PROXY === "true" || Boolean(process.env.VERCEL);
}

/**
 * Adresse IP du client. Les en-têtes de proxy ne sont lus que s'ils sont
 * fiables (Vercel, ou `TRUST_PROXY=true` derrière un reverse proxy) : sinon un
 * client pourrait les falsifier pour changer d'IP à chaque requête. Dans
 * `x-forwarded-for`, on prend la dernière valeur, ajoutée par le proxy de
 * confiance, et non la première, qui est fournie par le client.
 */
export function clientIp(req) {
  const first = (value) => (Array.isArray(value) ? value[0] : value);
  if (trustsProxy()) {
    const headers = req?.headers ?? {};
    for (const name of ["x-vercel-forwarded-for", "x-real-ip"]) {
      const value = first(headers[name]);
      if (typeof value === "string" && value.trim()) return value.split(",")[0].trim();
    }
    const forwarded = first(headers["x-forwarded-for"]);
    if (typeof forwarded === "string" && forwarded.trim()) {
      const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || "unknown";
}

/**
 * Enregistre une requête pour `key` et indique si elle est autorisée.
 *
 * @param {string} key       Clé de regroupement (ex. `explain:<ip>`).
 * @param {object} [options]
 * @param {number} [options.limit]     Nombre maximum de requêtes par fenêtre.
 * @param {number} [options.windowMs]  Durée de la fenêtre en millisecondes.
 * @param {number} [options.now]       Horodatage courant (injectable en test).
 * @returns {{ok: boolean, remaining: number, retryAfterSec: number}}
 */
export function checkRateLimit(key, options = {}) {
  const max = Number(options.limit) > 0 ? Number(options.limit) : 60;
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : 600000;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();

  const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);

  if (recent.length >= max) {
    buckets.set(key, recent);
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowMs - (now - recent[0])) / 1000)
    );
    return { ok: false, remaining: 0, retryAfterSec };
  }

  recent.push(now);
  buckets.set(key, recent);

  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, timestamps] of buckets) {
      if (!timestamps.some((t) => now - t < windowMs)) buckets.delete(bucketKey);
    }
  }

  return { ok: true, remaining: max - recent.length, retryAfterSec: 0 };
}

/** Réinitialise l'état (utilisé par les tests). */
export function resetRateLimit() {
  buckets.clear();
}
