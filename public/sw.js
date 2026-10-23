/* Service worker de Lernoviq : fonctionnement hors ligne des exercices.
 *
 * - Coquille de l'application et ressources statiques : mises en cache (les
 *   questions locales de secours sont incluses dans le JavaScript de l'application).
 * - Questions et passages Supabase (lecture seule) : réseau d'abord, copie en cache
 *   en cas de coupure.
 * - JAMAIS mis en cache : /api/* (explications IA, signalements, administration),
 *   authentification Supabase et données personnelles (user_*).
 * Les explications IA restent donc indisponibles hors ligne (message dans l'interface).
 */

const VERSION = "v1";
const SHELL_CACHE = `lernoviq-shell-${VERSION}`;
const DATA_CACHE = `lernoviq-data-${VERSION}`;
const KNOWN_CACHES = [SHELL_CACHE, DATA_CACHE];
const PRECACHE = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

/**
 * Stratégie à appliquer à une requête GET :
 *   "network-first-shell" : page HTML (navigation)
 *   "cache-first"         : ressource statique de même origine
 *   "network-first-data"  : questions / passages Supabase
 *   null                  : ne pas intercepter
 */
function strategyFor(url, origin, method, mode) {
  if (method !== "GET") return null;
  if (url.origin === origin) {
    if (url.pathname.startsWith("/api/")) return null;
    if (mode === "navigate") return "network-first-shell";
    return "cache-first";
  }
  if (
    url.protocol === "https:" &&
    url.hostname.endsWith(".supabase.co") &&
    /^\/rest\/v1\/(questions|passages)$/.test(url.pathname)
  ) {
    return "network-first-data";
  }
  return null;
}

async function networkFirst(request, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(fallbackKey || request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(fallbackKey || request)) || (await cache.match(request));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

/** Précharge la page d'accueil et les fichiers /assets/ qu'elle référence. */
async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(PRECACHE.map((path) => cache.add(path).catch(() => {})));
  try {
    const html = await (await fetch("/", { cache: "no-cache" })).text();
    const assets = [...new Set(html.match(/\/assets\/[^"')\s]+/g) || [])];
    await Promise.all(assets.map((path) => cache.add(path).catch(() => {})));
  } catch {
    /* Hors ligne pendant l'installation : les ressources seront mises en cache à l'usage. */
  }
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("install", (event) => {
    event.waitUntil(precache().then(() => self.skipWaiting()));
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((names) => Promise.all(names.filter((n) => !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n))))
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener("fetch", (event) => {
    const { request } = event;
    const strategy = strategyFor(new URL(request.url), self.location.origin, request.method, request.mode);
    if (!strategy) return;
    if (strategy === "network-first-shell") event.respondWith(networkFirst(request, SHELL_CACHE, "/"));
    else if (strategy === "cache-first") event.respondWith(cacheFirst(request));
    else event.respondWith(networkFirst(request, DATA_CACHE));
  });
}

if (typeof module !== "undefined") module.exports = { strategyFor, KNOWN_CACHES };
