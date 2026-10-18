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
