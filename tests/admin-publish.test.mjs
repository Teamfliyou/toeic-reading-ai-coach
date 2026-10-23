import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { publishBatch, generate, categoriesForPart } from "../server/admin.mjs";
import { makeRouter, jsonResponse, textResponse, setSupabaseEnv, clearSupabaseEnv } from "./helpers.mjs";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  clearSupabaseEnv();
  process.env.DEEPSEEK_API_KEY = "sk-server-key-000000000000";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSupabaseEnv();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const question = (over = {}) => ({
  part: 5,
  prompt: "The manager asked all employees to submit their reports ______ Friday.",
  options: [
    { key: "A", text: "by" },
    { key: "B", text: "at" },
    { key: "C", text: "of" },
    { key: "D", text: "into" },
  ],
  correctKey: "A",
  explanation: "« by » indique une date limite.",
  category: "prepositions",
  ...over,
});

function supabaseStack({ questionStatuses = [201] } = {}) {
  const statuses = [...questionStatuses];
  return makeRouter([
    { match: "rest/v1/passages", method: "POST", handler: () => jsonResponse([{ id: "p-1" }], 201) },
    { match: "rest/v1/passages", method: "DELETE", handler: () => jsonResponse(null, 204) },
    {
      match: "rest/v1/questions",
      method: "POST",
      handler: () => {
        const status = statuses.shift() ?? 201;
        return status === 201 ? jsonResponse([{ id: "q-1" }], 201) : textResponse("column does not exist", status);
      },
    },
  ]);
}

test("catégories autorisées par partie (Reading uniquement pour 5-7)", () => {
  assert.ok(categoriesForPart(5).includes("prepositions"));
  assert.ok(!categoriesForPart(5).includes("reading-detail"));
  assert.ok(categoriesForPart(7).includes("reading-detail"));
});

test("publishBatch : enregistre la catégorie valide, ignore une catégorie inconnue", async () => {
  setSupabaseEnv();
  const router = supabaseStack();
  globalThis.fetch = router;
  const bad = question({ prompt: "The invoice must be paid ______ the end of the month, please.", category: "reading-detail" });
  await publishBatch({ part: 5, difficulty: 2, questions: [question(), bad], passage: null });
  const rows = JSON.parse(router.calls.find((c) => c.url.endsWith("/questions")).init.body);
  assert.equal(rows[0].category, "prepositions");
  assert.equal(rows[1].category, null); // catégorie d'une autre partie : refusée
  assert.deepEqual(rows[0].tags, []);
});

test("publishBatch : base non migrée (400) → nouvel essai sans category/tags", async () => {
  setSupabaseEnv();
  const router = supabaseStack({ questionStatuses: [400, 201] });
  globalThis.fetch = router;
  const result = await publishBatch({ part: 5, difficulty: 2, questions: [question()], passage: null });
  assert.equal(result.saved, 1);
  const posts = router.calls.filter((c) => c.url.endsWith("/questions"));
  assert.equal(posts.length, 2);
  assert.ok("category" in JSON.parse(posts[0].init.body)[0]);
  assert.ok(!("category" in JSON.parse(posts[1].init.body)[0]));
});

test("publishBatch : refuse du contenu en français, un lot invalide et l'absence de Supabase", async () => {
  await assert.rejects(publishBatch({ part: 5, questions: [question()], passage: null }), /Publication indisponible/);
  setSupabaseEnv();
  globalThis.fetch = supabaseStack();
  const french = question({ prompt: "Vous devez envoyer le rapport pour les clients dans une semaine avec votre équipe." });
  await assert.rejects(publishBatch({ part: 5, questions: [french], passage: null }), /français/);
  await assert.rejects(publishBatch({ part: 5, questions: [question({ correctKey: "E" })], passage: null }), /invalide/);
  await assert.rejects(publishBatch({ part: 5, questions: [], passage: null }), /invalide/);
});

test("generate : la catégorie proposée par l'IA est vérifiée, sinon vide", async () => {
  const items = [
    question({ category: "prepositions" }),
    question({ prompt: "Please send the signed contract ______ courier before Tuesday morning.", category: "n-importe-quoi" }),
  ];
  let sentPrompt = "";
  globalThis.fetch = makeRouter([
    {
      match: "api.deepseek.com",
      handler: (_url, init) => {
        sentPrompt = JSON.parse(init.body).messages[1].content;
        return jsonResponse({
          choices: [{ message: { content: JSON.stringify({ questions: items, passage: null }) } }],
          usage: { prompt_tokens: 500, completion_tokens: 900 },
        });
      },
    },
  ]);
  const batch = await generate({ part: 5, quantity: 2, difficulty: 2, kind: "grammar", topic: "Office" });
  assert.deepEqual(batch.questions.map((q) => q.category), ["prepositions", null]);
  assert.match(sentPrompt, /exactly one of: .*prepositions/);
  assert.ok(batch.cost.estimatedUsd > 0);
});
