import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

// --- manifeste et icônes -------------------------------------------------------
const manifest = JSON.parse(read("public/manifest.webmanifest"));

test("manifeste : champs requis pour l'installation, en français", () => {
  assert.equal(manifest.lang, "fr");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.match(manifest.name, /Lernoviq/);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
});

test("manifeste : icônes 192 et 512 existantes, PNG de la bonne taille, une maskable", () => {
  const sizes = new Set(manifest.icons.map((i) => i.sizes));
  assert.ok(sizes.has("192x192") && sizes.has("512x512"));
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"));
  for (const icon of manifest.icons) {
    const path = `public${icon.src}`;
    assert.ok(existsSync(new URL(path, root)), path);
    const png = readFileSync(new URL(path, root));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.equal(png.readUInt32BE(16), w);
    assert.equal(png.readUInt32BE(20), h);
  }
});

test("index.html référence le manifeste, les icônes et la couleur de thème", () => {
  const html = read("index.html");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /name="theme-color" content="#26446b"/);
});

// --- service worker ------------------------------------------------------------
const sandbox = { module: { exports: {} }, self: undefined };
vm.runInNewContext(read("public/sw.js"), sandbox);
const { strategyFor } = sandbox.module.exports;
const origin = "https://app.example";
const decide = (url, method = "GET", mode = "same-origin") => strategyFor(new URL(url), origin, method, mode);

test("sw : navigation réseau d'abord, ressources statiques cache d'abord", () => {
  assert.equal(decide(`${origin}/`, "GET", "navigate"), "network-first-shell");
  assert.equal(decide(`${origin}/assets/index-abc123.js`), "cache-first");
  assert.equal(decide(`${origin}/icons/icon-192.png`), "cache-first");
});

test("sw : l'API, les écritures et les données personnelles ne sont jamais interceptées", () => {
  for (const path of ["/api/explain", "/api/coach", "/api/admin?action=login", "/api/report", "/api/health"]) {
    assert.equal(decide(`${origin}${path}`), null, path);
    assert.equal(decide(`${origin}${path}`, "GET", "navigate"), null, path);
  }
  assert.equal(decide(`${origin}/assets/x.js`, "POST"), null);
  const supa = "https://abc.supabase.co";
  for (const path of ["/auth/v1/token", "/auth/v1/user", "/rest/v1/user_attempts", "/rest/v1/user_vocab", "/rest/v1/user_review_cards", "/rest/v1/user_goals", "/rest/v1/rpc/ai_reserve_explain", "/rest/v1/question_reports"]) {
    assert.equal(decide(`${supa}${path}`), null, path);
  }
  assert.equal(decide("https://abc.supabase.co/rest/v1/questions", "POST"), null);
});

test("sw : questions et passages Supabase en lecture, réseau d'abord ; tiers ignorés", () => {
  assert.equal(decide("https://abc.supabase.co/rest/v1/questions?part=eq.5&select=*"), "network-first-data");
  assert.equal(decide("https://abc.supabase.co/rest/v1/passages?part=eq.7"), "network-first-data");
  assert.equal(decide("https://evil.example/rest/v1/questions"), null);
  assert.equal(decide("https://plausible.io/js/script.hash.js"), null);
  assert.equal(decide("http://abc.supabase.co/rest/v1/questions"), null); // jamais en clair
});

test("sw : caches versionnés, anciens caches supprimés à l'activation", () => {
  const code = read("public/sw.js");
  assert.match(code, /const VERSION = "v\d+"/);
  assert.match(code, /caches\.delete/);
  assert.equal(sandbox.module.exports.KNOWN_CACHES.length, 2);
});

test("l'indicateur hors ligne et le message IA hors ligne existent", () => {
  assert.match(read("src/components/OfflineBanner.tsx"), /Hors connexion/);
  assert.match(read("src/lib/online.ts"), /indisponibles hors connexion/);
});

test("vercel.json : sw.js jamais mis en cache durablement", () => {
  const config = JSON.parse(read("vercel.json"));
  const sw = config.headers.find((h) => h.source === "/sw.js");
  assert.ok(sw.headers.some((h) => h.key === "Cache-Control" && h.value === "no-cache"));
});

// --- Simulation complète du service worker (caches et réseau factices) -----------
function makeWorker({ online = true, responses = {} } = {}) {
  const stores = new Map();
  const listeners = {};
  const state = { online, fetched: [] };
  const mkCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async (key) => store.get(typeof key === "string" ? new URL(key, origin).href : key.url),
      put: async (key, response) => store.set(typeof key === "string" ? new URL(key, origin).href : key.url, response),
      add: async (path) => {
        const response = await fakeFetch(path);
        if (!response.ok) throw new Error("échec");
        store.set(new URL(path, origin).href, response);
      },
    };
  };
  const fakeFetch = async (input) => {
    const href = new URL(typeof input === "string" ? input : input.url, origin).href;
    state.fetched.push(href);
    if (!state.online) throw new TypeError("hors ligne");
    const body = responses[href] ?? "ok";
    const response = { ok: true, status: 200, url: href, text: async () => body, clone() { return this; } };
    return response;
  };
  const sandboxed = {
    module: { exports: {} },
    URL,
    fetch: fakeFetch,
    caches: {
      open: async (name) => mkCache(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
    },
    self: {
      location: { origin },
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (type, handler) => (listeners[type] = handler),
    },
  };
  vm.runInNewContext(read("public/sw.js"), sandboxed);
  const dispatch = async (type, extra = {}) => {
    let promise;
    await listeners[type]({ waitUntil: (p) => (promise = p), respondWith: (p) => (promise = p), ...extra });
    return promise;
  };
  const fetchEvent = (url, mode = "same-origin", method = "GET") => {
    let answer;
    listeners.fetch({ request: { url, method, mode }, respondWith: (p) => (answer = p) });
    return answer;
  };
  return { state, stores, dispatch, fetchEvent };
}

test("sw simulé : installation → coquille et assets en cache, puis navigation hors ligne servie depuis le cache", async () => {
  const w = makeWorker({ responses: { [`${origin}/`]: '<script src="/assets/index-abc.js"></script><link href="/assets/index-abc.css">' } });
  await w.dispatch("install");
  const cached = [...w.stores.get("lernoviq-shell-v1").keys()];
  assert.ok(cached.includes(`${origin}/assets/index-abc.js`));
  assert.ok(cached.includes(`${origin}/assets/index-abc.css`));
  assert.ok(cached.includes(`${origin}/manifest.webmanifest`));

  w.state.online = false;
  const page = await w.fetchEvent(`${origin}/`, "navigate");
  assert.equal(await page.text(), '<script src="/assets/index-abc.js"></script><link href="/assets/index-abc.css">');
  const asset = await w.fetchEvent(`${origin}/assets/index-abc.js`);
  assert.equal(asset.ok, true);
});

test("sw simulé : une route de l'application hors ligne retombe sur la page d'accueil mise en cache", async () => {
  const w = makeWorker();
  await w.dispatch("install");
  w.state.online = false;
  const page = await w.fetchEvent(`${origin}/#/exam`, "navigate");
  assert.equal(page.ok, true);
});

test("sw simulé : l'API n'est jamais interceptée et échoue franchement hors ligne", async () => {
  const w = makeWorker();
  await w.dispatch("install");
  assert.equal(w.fetchEvent(`${origin}/api/explain`, "same-origin", "POST"), undefined);
  assert.equal(w.fetchEvent(`${origin}/api/coach`), undefined);
  assert.equal(w.fetchEvent("https://abc.supabase.co/auth/v1/user"), undefined);
});

test("sw simulé : questions Supabase servies depuis le cache hors ligne, jamais les données personnelles", async () => {
  const w = makeWorker();
  const url = "https://abc.supabase.co/rest/v1/questions?part=eq.5&select=*";
  await w.fetchEvent(url); // en ligne : réponse mise en cache
  w.state.online = false;
  const offline = await w.fetchEvent(url);
  assert.equal(offline.ok, true);
  const dataCache = [...w.stores.get("lernoviq-data-v1").keys()];
  assert.deepEqual(dataCache, [url]);
  // Une page jamais visitée hors ligne : l'erreur réseau remonte (pas de réponse inventée).
  await assert.rejects(w.fetchEvent("https://abc.supabase.co/rest/v1/passages?part=eq.7"), /hors ligne/);
});

test("sw simulé : l'activation supprime les anciens caches", async () => {
  const w = makeWorker();
  await w.dispatch("install");
  w.stores.set("lernoviq-shell-v0", new Map());
  await w.dispatch("activate");
  assert.ok(!w.stores.has("lernoviq-shell-v0"));
  assert.ok(w.stores.has("lernoviq-shell-v1"));
});
