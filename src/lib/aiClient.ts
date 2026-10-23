import { getAccessToken } from "./supabaseAuth";

/** En-têtes d'un appel au coach IA : clé personnelle éventuelle et jeton de connexion. */
export async function aiHeaders(apiKey: string | null): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-DeepSeek-Api-Key"] = apiKey;
  const token = await getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
