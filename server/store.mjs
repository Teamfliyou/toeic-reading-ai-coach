// Persistance et cache partagé des explications IA dans Supabase.
//
// Accès direct à l'API REST Supabase (PostgREST) via `fetch`, sans dépendance
// npm supplémentaire — même approche que `server/explain.mjs` et `admin.mjs`.
//
// Toutes les fonctions sont SÛRES sans Supabase configuré : elles ne font
// aucun appel et renvoient `null`, afin que l'application continue de
// fonctionner en local (exigence : les exercices restent accessibles).

function config() {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

/** Vrai si la persistance Supabase (service_role) est configurée. */
export function storeConfigured() {
  return config() !== null;
}

async function rest(path, { method = "GET", body, prefer, timeoutMs = 6000 } = {}) {
  const cfg = config();
  if (!cfg) return null;

  const url = new URL(`/rest/v1/${path}`, cfg.base);
  const res = await fetch(url, {
    method,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`Supabase ${res.status} sur ${path}`);
  if (res.status === 204) return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

/**
 * Cherche une explication déjà enregistrée (clé : question + réponse choisie
 * + version de prompt + modèle). Renvoie `null` si absente.
 */
export async function getCachedExplanation({ questionId, selectedKey, promptVersion, model }) {
  const query =
    `ai_explanations?question_id=eq.${encodeURIComponent(questionId)}` +
    `&selected_key=eq.${encodeURIComponent(selectedKey)}` +
    `&prompt_version=eq.${encodeURIComponent(promptVersion)}` +
    `&model=eq.${encodeURIComponent(model)}` +
    `&select=id,payload,lesson&limit=1`;
  const rows = await rest(query);
  const row = rows?.[0];
  return row ? { id: row.id, payload: row.payload, lesson: row.lesson ?? null } : null;
}

/**
 * Enregistre (ou complète) une explication IA en base. L'`upsert` protège
 * contre les enregistrements concurrents pour la même clé de cache.
 */
export async function saveExplanation(entry) {
  const rows = await rest(
    "ai_explanations?on_conflict=question_id,selected_key,prompt_version,model",
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: [
        {
          question_id: entry.questionId,
          selected_key: entry.selectedKey,
          prompt_version: entry.promptVersion,
          model: entry.model,
          payload: entry.payload,
          lesson: entry.lesson ?? null,
          user_id: entry.userId ?? null,
          prompt_tokens: entry.usage?.inputTokens ?? null,
          completion_tokens: entry.usage?.outputTokens ?? null,
          cache_hit_tokens: entry.usage?.cacheHitTokens ?? null,
          cost_usd: entry.usage?.estimatedUsd ?? null,
        },
      ],
    }
  );
  return rows?.[0] ?? null;
}

/** Incrémente le compteur `hits` d'une explication servie depuis le cache. */
export async function touchExplanation(id) {
  if (!id) return;
  await rest("rpc/ai_touch_explanation", { method: "POST", body: { p_id: id } });
}
