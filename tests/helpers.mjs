// Utilitaires de test : simulent les objets req/res de Node sans ouvrir de port.

export function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    end(chunk) {
      this.body = chunk;
    },
  };
}

export function makeReq({ method = "POST", headers = {}, body = "" } = {}) {
  return { method, headers, body, socket: {}, connection: {} };
}

/** Simule une requête à flux (pas de `req.body` pré-analysé). */
export function makeStreamReq({ method = "POST", headers = {}, chunks = [] } = {}) {
  const listeners = {};
  const req = {
    method,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    on(event, callback) {
      (listeners[event] ||= []).push(callback);
      return req;
    },
    destroy() {},
  };
  // Émet les données après un tick, le temps que le gestionnaire s'abonne.
  queueMicrotask(() => {
    for (const chunk of chunks) {
      for (const cb of listeners.data || []) cb(chunk);
    }
    for (const cb of listeners.end || []) cb();
  });
  return req;
}

export function parseBody(res) {
  return res.body ? JSON.parse(res.body) : null;
}

/** Réponse simulée de type `fetch`. */
export function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (data === undefined ? "" : JSON.stringify(data)),
  };
}

/** Réponse simulée en texte brut (ex. erreur DeepSeek). */
export function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text || "{}"),
    text: async () => text,
  };
}

/**
 * Construit un `fetch` simulé qui route selon l'URL (et la méthode).
 *
 * @param {Array<{match: string|RegExp, method?: string, handler: Function}>} routes
 * @param {Function} [fallback] Appelé si aucune route ne correspond.
 * @returns {Function} `fetch` simulé, exposant `calls` (historique).
 */
export function makeRouter(routes, fallback) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = typeof url === "string" ? url : url.toString();
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url: href, method, init });
    for (const route of routes) {
      const matches = typeof route.match === "string"
        ? href.includes(route.match)
        : route.match.test(href);
      const methodOk = !route.method || route.method.toUpperCase() === method;
      if (matches && methodOk) return route.handler(href, init, calls);
    }
    if (fallback) return fallback(href, init, calls);
    throw new Error(`Aucune route simulée pour ${method} ${href}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Réponse DeepSeek réussie, avec un bloc `usage` réaliste. */
export function deepseekOk(
  payload = { diagnostic: "d", resolution: "r", tip: "t" },
  usage = { prompt_tokens: 800, completion_tokens: 200, prompt_cache_hit_tokens: 0 }
) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage,
  });
}

/** Configure l'environnement Supabase simulé (URL + clés factices). */
export function setSupabaseEnv() {
  process.env.SUPABASE_URL = "https://demo.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
}

/** Retire les variables d'environnement Supabase. */
export function clearSupabaseEnv() {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
}

