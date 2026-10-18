// Vérification des jetons Supabase Auth (authentification gratuite).
//
// Aucune dépendance externe : on interroge `GET /auth/v1/user`, Supabase
// valide lui-même la signature du JWT puis renvoie l'utilisateur. Un cache
// mémoire à durée courte évite un appel réseau à chaque requête.

const cache = new Map(); // empreinte du jeton -> { user, expiresAt }
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

function config() {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return base && key ? { base, key } : null;
}

/** Vrai si la vérification des jetons Supabase est possible. */
export function authConfigured() {
  return config() !== null;
}

/** Empreinte non cryptographique, suffisante comme clé de cache mémoire. */
function fingerprint(token) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer <token>`. */
export function bearerToken(req) {
  const raw = req?.headers?.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Réinitialise le cache (tests, rotation de configuration). */
export function resetAuthCache() {
  cache.clear();
}

/**
 * Valide un jeton Supabase et renvoie `{ id, email }` (ou `null`).
 */
export async function verifyToken(token) {
  const cfg = config();
  if (!cfg || !token) return null;

  const key = fingerprint(token);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.user;

  let response;
  try {
    response = await fetch(new URL("/auth/v1/user", cfg.base), {
      headers: { apikey: cfg.key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const user = await response.json().catch(() => null);
  if (!user?.id) return null;

  const safe = { id: String(user.id), email: user.email ?? null };
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { user: safe, expiresAt: now + TTL_MS });
  return safe;
}

/** Utilisateur Supabase courant d'une requête, ou `null` si anonyme. */
export async function currentAiUser(req) {
  return verifyToken(bearerToken(req));
}
