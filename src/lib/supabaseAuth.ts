// Authentification Supabase (client léger, sans dépendance npm).
//
// On utilise l'API REST d'authentification de Supabase directement, comme
// `src/lib/data.ts` le fait pour PostgREST. La session est conservée dans le
// `localStorage` et le jeton d'accès est rafraîchi automatiquement avant
// expiration. Seul le jeton de l'utilisateur est manipulé côté navigateur :
// jamais la clé DeepSeek.

import { supabaseUrl, supabasePublishableKey } from "./supabaseConfig";

export const SESSION_STORAGE_KEY = "lernoviq_auth_session";
const REFRESH_MARGIN_MS = 60_000;

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Horodatage (ms) d'expiration du jeton d'accès. */
  expiresAt: number;
  user: AuthUser;
}

/** Vrai si Supabase Auth est configuré (URL + clé publishable). */
export const authEnabled = Boolean(supabaseUrl && supabasePublishableKey);

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id?: string; email?: string | null } | null;
  error_description?: string;
  msg?: string;
  message?: string;
}

let current: AuthSession | null = readStored();
const listeners = new Set<(session: AuthSession | null) => void>();

function readStored(): AuthSession | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    return parsed?.accessToken && parsed?.user?.id ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(session: AuthSession | null) {
  if (typeof localStorage === "undefined") return;
  if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_STORAGE_KEY);
}

function emit() {
  for (const listener of listeners) listener(current);
}

/** S'abonne aux changements de session ; renvoie la fonction de désabonnement. */
export function onAuthChange(listener: (session: AuthSession | null) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Session courante (ou `null`). */
export function getSession(): AuthSession | null {
  return current;
}

function setSession(session: AuthSession | null) {
  current = session;
  writeStored(session);
  emit();
}

/** Vrai si le jeton d'accès doit être rafraîchi. */
export function isExpiring(expiresAt: number, now = Date.now()): boolean {
  return !Number.isFinite(expiresAt) || expiresAt - now <= REFRESH_MARGIN_MS;
}

/** Transforme une réponse Supabase en session exploitable (ou `null`). */
export function toSession(payload: TokenResponse | null): AuthSession | null {
  if (!payload) return null;
  const { access_token: access, refresh_token: refresh, user } = payload;
  if (typeof access !== "string" || typeof refresh !== "string" || !user?.id) {
    return null;
  }
  const expiresIn = Number(payload.expires_in) || 3600;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    user: { id: String(user.id), email: user.email ?? null },
  };
}

async function request(path: string, init: RequestInit = {}): Promise<TokenResponse> {
  const response = await fetch(new URL(path, supabaseUrl), {
    ...init,
    headers: {
      apikey: supabasePublishableKey,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = (text ? JSON.parse(text) : null) as TokenResponse | null;
  if (!response.ok) {
    throw new Error(
      data?.error_description ||
        data?.msg ||
        data?.message ||
        "Échec de l'authentification."
    );
  }
  return data ?? {};
}

let refreshInFlight: Promise<AuthSession | null> | null = null;

async function refreshSession(): Promise<AuthSession | null> {
  const refreshToken = current?.refreshToken;
  if (!refreshToken) return null;
  try {
    const data = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const session = toSession(data);
    setSession(session);
    return session;
  } catch {
    setSession(null);
    return null;
  }
}

/** Connexion par e-mail + mot de passe. */
export async function signIn(email: string, password: string): Promise<AuthSession> {
  const data = await request("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const session = toSession(data);
  if (!session) throw new Error("Réponse d'authentification invalide.");
  setSession(session);
  return session;
}

/**
 * Création de compte. Si la confirmation par e-mail est activée côté Supabase,
 * aucune session n'est renvoyée : `needsConfirmation` vaut alors `true`.
 */
export async function signUp(
  email: string,
  password: string
): Promise<{ needsConfirmation: boolean }> {
  const data = await request("/auth/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const session = toSession(data);
  if (session) {
    setSession(session);
    return { needsConfirmation: false };
  }
  return { needsConfirmation: true };
}

/** Déconnexion (la session locale est effacée même si l'appel échoue). */
export async function signOut(): Promise<void> {
  const token = current?.accessToken;
  setSession(null);
  if (!token) return;
  try {
    await request("/auth/v1/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* La session locale est déjà supprimée. */
  }
}

/**
 * Jeton d'accès courant, rafraîchi si nécessaire. Renvoie `null` si aucun
 * utilisateur n'est connecté ou si Supabase Auth n'est pas configuré.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!authEnabled) return null;
  const session = current;
  if (!session) return null;
  if (!isExpiring(session.expiresAt)) return session.accessToken;

  if (!refreshInFlight) {
    refreshInFlight = refreshSession().finally(() => {
      refreshInFlight = null;
    });
  }
  const refreshed = await refreshInFlight;
  return refreshed?.accessToken ?? null;
}
