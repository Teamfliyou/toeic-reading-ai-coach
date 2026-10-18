import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleExplain } from "../server/explain.mjs";
import { resetRateLimit } from "../server/rate-limit.mjs";
import { resetAuthCache } from "../server/auth.mjs";
import {
  makeReq,
  makeRes,
  parseBody,
  makeRouter,
  jsonResponse,
  textResponse,
  deepseekOk,
  setSupabaseEnv,
  clearSupabaseEnv,
} from "./helpers.mjs";

const dataset = JSON.parse(
  readFileSync(new URL("../data/questions.json", import.meta.url), "utf8")
);
const sample = dataset.questions[0];

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function payload(extra = {}) {
  return JSON.stringify({ questionId: sample.id, selectedKey: "A", ...extra });
}

/** Pile complète simulée : Supabase Auth, quotas, cache, DeepSeek. */
function stackRouter({
  auth = { id: "user-1", email: "eleve@example.com" },
  cache = [],
  reserve = { ok: true, event_id: "evt-1" },
  deepseek = deepseekOk(),
} = {}) {
  return makeRouter([
    { match: "/auth/v1/user", handler: () => (auth ? jsonResponse(auth) : jsonResponse({}, 401)) },
    { match: "rpc/ai_reserve_explain", method: "POST", handler: () => jsonResponse(reserve) },
    { match: "rpc/ai_finalize_explain", method: "POST", handler: () => jsonResponse(null, 204) },
    { match: "rpc/ai_release_explain", method: "POST", handler: () => jsonResponse(null, 204) },
    { match: "rpc/ai_touch_explanation", method: "POST", handler: () => jsonResponse(null, 204) },
    { match: "ai_explanations?on_conflict", method: "POST", handler: () => jsonResponse([{ id: "e1" }]) },
    { match: "rest/v1/ai_explanations", handler: () => jsonResponse(cache) },
    { match: "api.deepseek.com", handler: () => deepseek },
  ]);
}

const authReq = (extra = {}) =>
  makeReq({ headers: { authorization: "Bearer jeton-test" }, body: payload(extra) });

const called = (router, needle, method) =>
  router.calls.some((c) => c.url.includes(needle) && (!method || c.method === method));

beforeEach(() => {
  resetRateLimit();
  resetAuthCache();
  clearSupabaseEnv();
  process.env.DEEPSEEK_API_KEY = "sk-server-key-000000000000";
  delete process.env.ALLOW_SERVER_KEY_FALLBACK;
  delete process.env.AI_FREE_REQUIRES_AUTH;
  delete process.env.AI_PER_MINUTE;
  delete process.env.AI_DAILY_LIMIT;
  delete process.env.EXPLAIN_RATE_LIMIT;
  delete process.env.EXPLAIN_RATE_WINDOW_MS;
  delete process.env.AI_MONTHLY_LIMIT_USD;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRateLimit();
  resetAuthCache();
  clearSupabaseEnv();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

test("utilisateur légitime : réservation, appel DeepSeek, puis enregistrement en base", async () => {
  setSupabaseEnv();
  const router = stackRouter();
  globalThis.fetch = router;

  const res = makeRes();
  await handleExplain(authReq(), res);

  assert.equal(res.statusCode, 200);
  const body = parseBody(res);
  assert.equal(body.explanation.diagnostic, "d");

  // Réservation puis finalisation atomique du budget.
  assert.ok(called(router, "rpc/ai_reserve_explain", "POST"), "réservation attendue");
  assert.ok(called(router, "rpc/ai_finalize_explain", "POST"), "finalisation attendue");

  // La réponse IA est enregistrée dans Supabase (exigence « enregistrer la réponse »).
  const saveCall = router.calls.find((c) => c.url.includes("on_conflict"));
  assert.ok(saveCall, "enregistrement de l'explication attendu");
  const entry = JSON.parse(saveCall.init.body)[0];
  assert.equal(entry.question_id, sample.id);
  assert.equal(entry.selected_key, "A");
  assert.equal(entry.payload.diagnostic, "d");
  assert.equal(entry.model, "deepseek-flash");
});

test("cache : une explication identique est resservie sans appeler DeepSeek", async () => {
  setSupabaseEnv();
  const router = stackRouter({
    cache: [{ id: "e9", payload: { diagnostic: "cache", resolution: "r", tip: "t" }, lesson: null }],
  });
  globalThis.fetch = router;

  const res = makeRes();
  await handleExplain(authReq(), res);

  assert.equal(res.statusCode, 200);
  const body = parseBody(res);
  assert.equal(body.cached, true);
  assert.equal(body.explanation.diagnostic, "cache");
  assert.ok(!called(router, "api.deepseek.com"), "aucun appel DeepSeek sur un cache hit");
  assert.ok(!called(router, "rpc/ai_reserve_explain"), "aucun quota consommé sur un cache hit");
  assert.ok(called(router, "rpc/ai_touch_explanation", "POST"), "compteur de cache incrémenté");
});

test("quota quotidien épuisé → 429 code quota, sans appel DeepSeek", async () => {
  setSupabaseEnv();
  const router = stackRouter({ reserve: { ok: false, reason: "quota" } });
  globalThis.fetch = router;

  const res = makeRes();
  await handleExplain(authReq(), res);

  assert.equal(res.statusCode, 429);
  assert.equal(parseBody(res).code, "quota");
  assert.ok(!called(router, "api.deepseek.com"));
});

test("budget mensuel épuisé → 429 code budget", async () => {
  setSupabaseEnv();
  const router = stackRouter({ reserve: { ok: false, reason: "budget" } });
  globalThis.fetch = router;

  const res = makeRes();
  await handleExplain(authReq(), res);

  assert.equal(res.statusCode, 429);
  assert.equal(parseBody(res).code, "budget");
});

test("échec DeepSeek → réservation libérée, 500, aucun secret exposé", async () => {
  setSupabaseEnv();
  const router = stackRouter({
    deepseek: textResponse("panne Bearer sk-secret123456789", 500),
  });
  globalThis.fetch = router;

  const res = makeRes();
  await handleExplain(authReq(), res);

  assert.equal(res.statusCode, 500);
  assert.ok(called(router, "rpc/ai_release_explain", "POST"), "réservation libérée");
  assert.ok(!called(router, "rpc/ai_finalize_explain"), "pas de facturation sur échec");
  assert.ok(!parseBody(res).error.includes("sk-secret123456789"), "secret masqué");
});

test("solde DeepSeek épuisé (402) → 503 code budget", async () => {
  setSupabaseEnv();
  const router = stackRouter({ deepseek: textResponse("Insufficient Balance", 402) });
  globalThis.fetch = router;

  const res = makeRes();
  await handleExplain(authReq(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(parseBody(res).code, "budget");
  assert.ok(called(router, "rpc/ai_release_explain", "POST"));
});

test("accès anonyme refusé quand l'explication gratuite exige un compte (401)", async () => {
  setSupabaseEnv();
  process.env.AI_FREE_REQUIRES_AUTH = "true";
  const router = stackRouter();
  globalThis.fetch = router;

  const res = makeRes();
  await handleExplain(makeReq({ body: payload() }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(parseBody(res).code, "auth_required");
  assert.ok(!called(router, "api.deepseek.com"));
});

test("limite de 3 requêtes par minute et par utilisateur (429 code rate)", async () => {
  setSupabaseEnv();
  process.env.AI_PER_MINUTE = "3";
  globalThis.fetch = stackRouter();

  const send = async () => {
    const res = makeRes();
    await handleExplain(authReq(), res);
    return res.statusCode;
  };

  assert.equal(await send(), 200);
  assert.equal(await send(), 200);
  assert.equal(await send(), 200);
  assert.equal(await send(), 429, "la 4e requête de la minute est refusée");
});

test("utilisateur anonyme : la clé serveur reste limitée par IP", async () => {
  setSupabaseEnv();
  process.env.EXPLAIN_RATE_LIMIT = "1";
  globalThis.fetch = stackRouter({ auth: null });

  const send = async () => {
    const res = makeRes();
    await handleExplain(makeReq({ body: payload() }), res);
    return res.statusCode;
  };

  assert.equal(await send(), 200);
  assert.equal(await send(), 429, "la limite IP s'applique aux appels anonymes");
});

test("sans Supabase configuré : comportement d'origine conservé (200)", async () => {
  globalThis.fetch = stackRouter();
  const res = makeRes();
  await handleExplain(makeReq({ body: payload() }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(parseBody(res).explanation.diagnostic, "d");
});
