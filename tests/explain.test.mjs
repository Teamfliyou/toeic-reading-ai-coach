import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleExplain } from "../server/explain.mjs";
import { resetRateLimit } from "../server/rate-limit.mjs";
import { makeReq, makeRes, makeStreamReq, parseBody } from "./helpers.mjs";

const dataset = JSON.parse(
  readFileSync(new URL("../data/questions.json", import.meta.url), "utf8")
);
const sample = dataset.questions[0];

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

/** Stub de fetch simulant une réponse DeepSeek réussie (aucun appel réseau réel). */
function okFetch(explanation = { diagnostic: "d", resolution: "r", tip: "t" }) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(explanation) } }],
    }),
  });
}

function body(extra = {}) {
  return JSON.stringify({ questionId: sample.id, selectedKey: "A", ...extra });
}

beforeEach(() => {
  resetRateLimit();
  process.env.DEEPSEEK_API_KEY = "sk-test-key-000000000000";
  delete process.env.ALLOW_SERVER_KEY_FALLBACK;
  delete process.env.EXPLAIN_RATE_LIMIT;
  delete process.env.EXPLAIN_RATE_WINDOW_MS;
  delete process.env.EXPLAIN_RESTRICT_ORIGIN;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

test("refuse les méthodes autres que POST", async () => {
  const res = makeRes();
  await handleExplain(makeReq({ method: "GET" }), res);
  assert.equal(res.statusCode, 405);
});

test("rejette un JSON invalide", async () => {
  const res = makeRes();
  await handleExplain(makeReq({ body: "{pas du json" }), res);
  assert.equal(res.statusCode, 400);
});

test("exige un questionId valide", async () => {
  const invalid = [
    {},
    { questionId: 123, selectedKey: "A" },
    { questionId: "", selectedKey: "A" },
    { questionId: "x".repeat(201), selectedKey: "A" },
  ];
  for (const payload of invalid) {
    const res = makeRes();
    await handleExplain(makeReq({ body: JSON.stringify(payload) }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test("rejette un selectedKey invalide", async () => {
  const res = makeRes();
  await handleExplain(makeReq({ body: body({ selectedKey: "Z" }) }), res);
  assert.equal(res.statusCode, 400);
});

test("refuse un corps trop volumineux (413)", async () => {
  const res = makeRes();
  await handleExplain(makeReq({ body: "x".repeat(20000) }), res);
  assert.equal(res.statusCode, 413);
});

test("refuse un corps trop volumineux reçu en flux (413)", async () => {
  const res = makeRes();
  await handleExplain(makeStreamReq({ chunks: ["x".repeat(20000)] }), res);
  assert.equal(res.statusCode, 413);
});

test("refuse une origine différente (403)", async () => {
  const res = makeRes();
  await handleExplain(
    makeReq({
      headers: { origin: "https://evil.example", host: "localhost:3000" },
      body: body(),
    }),
    res
  );
  assert.equal(res.statusCode, 403);
});

test("accepte l'origine correspondante", async () => {
  globalThis.fetch = okFetch();
  const res = makeRes();
  await handleExplain(
    makeReq({
      headers: { origin: "http://localhost:3000", host: "localhost:3000" },
      body: body(),
    }),
    res
  );
  assert.equal(res.statusCode, 200);
});

test("réponse nominale 200 avec explication", async () => {
  globalThis.fetch = okFetch();
  const res = makeRes();
  await handleExplain(makeReq({ body: body() }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(parseBody(res).explanation.diagnostic, "d");
});

test("B2 : gère une erreur DeepSeek sans ReferenceError et masque la clé", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => "DeepSeek failure Bearer sk-abcdefghijklmnop",
  });
  const res = makeRes();
  await handleExplain(makeReq({ body: body() }), res);

  assert.equal(res.statusCode, 500);
  const { error } = parseBody(res);
  assert.ok(!/body is not defined/i.test(error), "ne doit pas exposer de ReferenceError");
  assert.ok(!error.includes("sk-abcdefghijklmnop"), "la clé doit être masquée");
  assert.match(error, /500/);
});

test("S1 : limite l'usage de la clé serveur par IP (429)", async () => {
  process.env.EXPLAIN_RATE_LIMIT = "2";
  globalThis.fetch = okFetch();

  const send = async () => {
    const res = makeRes();
    await handleExplain(makeReq({ body: body() }), res);
    return res;
  };

  assert.equal((await send()).statusCode, 200);
  assert.equal((await send()).statusCode, 200);

  const blocked = await send();
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.getHeader("Retry-After")) >= 1);
});

test("S1 : une clé personnelle n'est pas soumise à la limite", async () => {
  process.env.EXPLAIN_RATE_LIMIT = "1";
  globalThis.fetch = okFetch();

  for (let i = 0; i < 5; i += 1) {
    const res = makeRes();
    await handleExplain(
      makeReq({
        headers: { "x-deepseek-api-key": "sk-user-key-0000000000" },
        body: body(),
      }),
      res
    );
    assert.equal(res.statusCode, 200, `requête ${i + 1}`);
  }
});

test("S1 : ALLOW_SERVER_KEY_FALLBACK=false exige une clé client (401)", async () => {
  process.env.ALLOW_SERVER_KEY_FALLBACK = "false";
  const res = makeRes();
  await handleExplain(makeReq({ body: body() }), res);
  assert.equal(res.statusCode, 401);
});
