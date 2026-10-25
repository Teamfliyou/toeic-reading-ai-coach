// Accès à la base Supabase pour la banque d'exercices (clé service_role, serveur uniquement).
// Toutes les écritures passent par des fonctions SQL (RPC) transactionnelles.

function config() {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

/** Vrai si la banque peut être administrée (Supabase + clé service_role côté serveur). */
export const bankConfigured = () => config() !== null;

/** Erreur de base de données. `expose` : le message est destiné à l'administrateur. */
export class BankError extends Error {
  constructor(message, { code = null, status = 500, expose = false } = {}) {
    super(message);
    this.name = "BankError";
    this.code = code;
    this.status = status;
    this.expose = expose;
  }
}

// Erreurs levées volontairement par nos fonctions SQL (`raise exception`) : sûres à afficher.
const RAISE_EXCEPTION = "P0001";

/**
 * Appelle une fonction SQL (`/rest/v1/rpc/<nom>`) avec des paramètres nommés.
 * @returns {Promise<any>} le résultat JSON de la fonction
 */
export async function rpc(name, args = {}, { timeoutMs = 25000 } = {}) {
  const cfg = config();
  if (!cfg) throw new BankError("Supabase n'est pas configuré côté serveur.", { status: 503, expose: true });
  let res;
  try {
    res = await fetch(new URL(`/rest/v1/rpc/${name}`, cfg.base), {
      method: "POST",
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new BankError("Base de données injoignable.", { status: 503, expose: true });
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* corps non JSON */ }
  if (!res.ok) {
    const code = body?.code ?? null;
    const message = String(body?.message ?? `Erreur ${res.status}`);
    if (code === RAISE_EXCEPTION) throw new BankError(message, { code: message, status: 409, expose: true });
    if (res.status === 404 && /Could not find the function|schema cache/i.test(message)) {
      throw new BankError("Migration manquante : exécutez supabase/question_bank.sql dans Supabase.", { status: 503, expose: true });
    }
    console.warn(`Supabase RPC ${name} : ${res.status} ${code ?? ""} ${message.slice(0, 200)}`);
    throw new BankError("Erreur de base de données.", { code, status: 500 });
  }
  return body;
}

/** Lecture simple d'une table via PostgREST (requêtes courtes, filtres déjà encodés). */
export async function select(path, { timeoutMs = 10000 } = {}) {
  const cfg = config();
  if (!cfg) throw new BankError("Supabase n'est pas configuré côté serveur.", { status: 503, expose: true });
  const res = await fetch(new URL(`/rest/v1/${path}`, cfg.base), {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new BankError("Erreur de base de données.", { status: 500 });
  return res.json();
}
