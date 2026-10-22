import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleExplain, findQuestion, renderDocuments } from "../server/explain.mjs";
import { parseExplanation, extractJsonText } from "../server/explanation-schema.mjs";
import { registerAttempt, clearAttempt } from "../server/login-limiter.mjs";
import { resetRateLimit } from "../server/rate-limit.mjs";
import { resetAuthCache } from "../server/auth.mjs";
import {
  makeReq, makeRes, parseBody, makeRouter, jsonResponse, textResponse,
  deepseekOk, setSupabaseEnv, clearSupabaseEnv,
} from "./helpers.mjs";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const good = { diagnostic: "d", resolution: "r", tip: "t" };

beforeEach(() => {
  resetRateLimit();
  resetAuthCache();
  clearSupabaseEnv();
  process.env.DEEPSEEK_API_KEY = "sk-server-key-000000000000";
  delete process.env.AI_FREE_REQUIRES_AUTH;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSupabaseEnv();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const body = JSON.stringify({ questionId: "q5-01", selectedKey: "A" });
const reply = (content, finish = "stop", usage = { prompt_tokens: 800, completion_tokens: 300 }) =>
  jsonResponse({ choices: [{ message: { content }, finish_reason: finish }], usage });

// --- parsing -----------------------------------------------------------------
test("parseExplanation : retire balises markdown et texte autour", () => {
  const raw = "Voici :\n```json\n" + JSON.stringify(good) + "\n```\nBonne chance !";
  const result = parseExplanation(raw);
  assert.equal(result.ok, true);
  assert.equal(result.explanation.diagnostic, "d");
  assert.equal(result.lesson, null);
});

test("parseExplanation : accolades dans une chaîne ne cassent pas l'extraction", () => {
  const raw = JSON.stringify({ ...good, tip: 'use {braces} and "quotes"' });
  assert.equal(extractJsonText("x" + raw + "y"), raw);
  assert.equal(parseExplanation(raw).explanation.tip, 'use {braces} and "quotes"');
});

test("parseExplanation : JSON tronqué, vide, invalide ou hors schéma", () => {
  assert.equal(parseExplanation('{"diagnostic":"a","resolu').reason, "truncated");
  assert.equal(parseExplanation("").reason, "empty");
  assert.equal(parseExplanation("{diagnostic: oops}").reason, "json");
  assert.equal(parseExplanation('{"diagnostic":"a","resolution":"","tip":"t"}').reason, "schema");
  assert.equal(parseExplanation("[1,2]").reason, "truncated");
});

test("parseExplanation : une leçon invalide est ignorée sans rejeter l'explication", () => {
  const result = parseExplanation(JSON.stringify({ ...good, lesson: { title: "x" } }));
  assert.equal(result.ok, true);
  assert.equal(result.lesson, null);
  const full = parseExplanation(JSON.stringify({
    ...good,
    lesson: { title: "T", rule: "R", exercise: "E", answer: "A" },
  }));
  assert.equal(full.lesson.title, "T");
});

// --- contexte ----------------------------------------------------------------
test("findQuestion : le contexte contient de vrais sauts de ligne", async () => {
  const q = await findQuestion("q7-1-1");
  assert.ok(q.context.includes("\n"));
  assert.ok(!q.context.includes("\\n"));
  assert.equal(renderDocuments([{ title: "T", body: ["a", "b"] }]), "T\na\nb");
});

// --- retry, budget, erreurs --------------------------------------------------
test("réponse tronquée puis valide : une seule nouvelle tentative", async () => {
  let n = 0;
  globalThis.fetch = makeRouter([
    {
      match: "api.deepseek.com",
      handler: () => (++n === 1 ? reply('{"diagnostic":"a","res', "length") : reply(JSON.stringify(good))),
    },
  ]);
  const res = makeRes();
  await handleExplain(makeReq({ body }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(n, 2);
  assert.equal(parseBody(res).explanation.diagnostic, "d");
});

test("deux réponses illisibles : 502 lisible, budget finalisé au coût réel (pas libéré)", async () => {
  setSupabaseEnv();
  const router = makeRouter([
    { match: "rpc/ai_reserve_explain", handler: () => jsonResponse({ ok: true, event_id: "evt-9" }) },
    { match: "rpc/ai_finalize_explain", handler: () => jsonResponse(null, 204) },
    { match: "rpc/ai_release_explain", handler: () => jsonResponse(null, 204) },
    { match: "rest/v1/ai_explanations", handler: () => jsonResponse([]) },
    { match: "api.deepseek.com", handler: () => reply("```json {pas du json```") },
  ]);
  globalThis.fetch = router;
  const res = makeRes();
  await handleExplain(makeReq({ body }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(parseBody(res).code, "unparsable");
  assert.match(parseBody(res).error, /explication lisible/);
  const finalize = router.calls.find((c) => c.url.includes("ai_finalize_explain"));
  assert.ok(finalize, "finalize attendu");
  assert.ok(JSON.parse(finalize.init.body).p_actual_usd > 0);
  assert.ok(!router.calls.some((c) => c.url.includes("ai_release_explain")));
});

test("erreur DeepSeek 500 : la réservation est libérée", async () => {
  setSupabaseEnv();
  const router = makeRouter([
    { match: "rpc/ai_reserve_explain", handler: () => jsonResponse({ ok: true, event_id: "evt-2" }) },
    { match: "rpc/ai_release_explain", handler: () => jsonResponse(null, 204) },
    { match: "rest/v1/ai_explanations", handler: () => jsonResponse([]) },
    { match: "api.deepseek.com", handler: () => textResponse("boom", 500) },
  ]);
  globalThis.fetch = router;
  const res = makeRes();
  await handleExplain(makeReq({ body }), res);
  assert.equal(res.statusCode, 500);
  assert.ok(router.calls.some((c) => c.url.includes("ai_release_explain")));
  assert.ok(!router.calls.some((c) => c.url.includes("ai_finalize_explain")));
});

test("clé personnelle refusée (401 DeepSeek) : 401 key_invalid", async () => {
  globalThis.fetch = makeRouter([{ match: "api.deepseek.com", handler: () => textResponse("{}", 401) }]);
  const res = makeRes();
  await handleExplain(makeReq({ headers: { "x-deepseek-api-key": "sk-mauvaise-cle-0000" }, body }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(parseBody(res).code, "key_invalid");
});

test("anonyme : quota quotidien et débit appliqués à la réservation", async () => {
  setSupabaseEnv();
  const router = makeRouter([
    { match: "rpc/ai_reserve_explain", handler: () => jsonResponse({ ok: true, event_id: "evt-3" }) },
    { match: "rpc/ai_finalize_explain", handler: () => jsonResponse(null, 204) },
    { match: "rest/v1/ai_explanations", handler: () => jsonResponse([]) },
    { match: "api.deepseek.com", handler: () => deepseekOk() },
  ]);
  globalThis.fetch = router;
  await handleExplain(makeReq({ body }), makeRes());
  const sent = JSON.parse(router.calls.find((c) => c.url.includes("ai_reserve_explain")).init.body);
  assert.equal(sent.p_daily_limit, 5);
  assert.equal(sent.p_per_minute, 2);
  assert.match(sent.p_actor, /^ip:/);
});

// --- limiteur de connexion admin ---------------------------------------------
test("login-limiter : délègue à la base et renvoie attemptId / retry", async () => {
  setSupabaseEnv();
  const answers = [
    { ok: true, attempt_id: "att-1" },
    { ok: false, retry_after: 321 },
  ];
  const router = makeRouter([
    { match: "rpc/admin_login_attempt", handler: () => jsonResponse(answers.shift()) },
    { match: "rpc/admin_login_clear", handler: () => jsonResponse(null, 204) },
  ]);
  globalThis.fetch = router;
  const first = await registerAttempt("1.1.1.1", "Admin");
  assert.deepEqual(first, { ok: true, retryAfterSec: 0, attemptId: "att-1" });
  assert.equal(JSON.parse(router.calls[0].init.body).p_username, "admin");
  await clearAttempt("att-1");
  assert.ok(router.calls.some((c) => c.url.includes("admin_login_clear")));
  const second = await registerAttempt("1.1.1.1", "admin");
  assert.equal(second.ok, false);
  assert.equal(second.retryAfterSec, 321);
});

test("login-limiter : repli mémoire si la base est indisponible, par identifiant", async () => {
  setSupabaseEnv();
  process.env.ADMIN_LOGIN_MAX_PER_USER = "2";
  globalThis.fetch = makeRouter([{ match: "rpc/", handler: () => textResponse("x", 404) }]);
  assert.equal((await registerAttempt("2.2.2.2", "cible")).ok, true);
  assert.equal((await registerAttempt("3.3.3.3", "cible")).ok, true);
  const blocked = await registerAttempt("4.4.4.4", "cible"); // IP différente, même identifiant
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

// --- génération admin sous budget --------------------------------------------
import { withBudget } from "../server/admin.mjs";

test("withBudget : réserve, finalise au coût réel et libère en cas d'échec sans coût", async () => {
  setSupabaseEnv();
  const router = makeRouter([
    { match: "rpc/ai_reserve_explain", handler: () => jsonResponse({ ok: true, event_id: "evt-a" }) },
    { match: "rpc/ai_finalize_explain", handler: () => jsonResponse(null, 204) },
    { match: "rpc/ai_release_explain", handler: () => jsonResponse(null, 204) },
  ]);
  globalThis.fetch = router;
  await withBudget({ id: "u1" }, async () => ({ cost: { estimatedUsd: 0.005 } }));
  const reserve = JSON.parse(router.calls[0].init.body);
  assert.equal(reserve.p_actor, "admin:u1");
  assert.equal(reserve.p_per_minute, 10);
  assert.equal(reserve.p_window_seconds, 3600);
  assert.equal(JSON.parse(router.calls[1].init.body).p_actual_usd, 0.005);

  await assert.rejects(withBudget({ id: "u1" }, async () => { throw new Error("réseau"); }), /réseau/);
  assert.ok(router.calls.at(-1).url.includes("ai_release_explain"));

  await assert.rejects(
    withBudget({ id: "u1" }, async () => { throw Object.assign(new Error("json"), { usage: { estimatedUsd: 0.003 } }); }),
    /json/
  );
  assert.ok(router.calls.at(-1).url.includes("ai_finalize_explain"));
});

test("withBudget : refuse quand le budget est épuisé", async () => {
  setSupabaseEnv();
  globalThis.fetch = makeRouter([
    { match: "rpc/ai_reserve_explain", handler: () => jsonResponse({ ok: false, reason: "budget" }) },
  ]);
  await assert.rejects(withBudget({ id: "u1" }, async () => ({})), /Budget mensuel/);
});
