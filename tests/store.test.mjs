import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  storeConfigured,
  getCachedExplanation,
  saveExplanation,
  touchExplanation,
} from "../server/store.mjs";
import { makeRouter, jsonResponse, setSupabaseEnv, clearSupabaseEnv } from "./helpers.mjs";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearSupabaseEnv();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSupabaseEnv();
});

test("storeConfigured : faux sans variables Supabase", () => {
  assert.equal(storeConfigured(), false);
});

test("sans Supabase : aucune lecture ni écriture (null, pas d'appel)", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse([]);
  };
  assert.equal(await getCachedExplanation({ questionId: "q", selectedKey: "A", promptVersion: "v", model: "m" }), null);
  assert.equal(await saveExplanation({ questionId: "q", selectedKey: "A", promptVersion: "v", model: "m", payload: {} }), null);
  await touchExplanation("id");
  assert.equal(called, false, "aucun appel réseau sans configuration");
});

test("storeConfigured : vrai avec URL + service_role", () => {
  setSupabaseEnv();
  assert.equal(storeConfigured(), true);
});

test("getCachedExplanation : renvoie la ligne mise en cache", async () => {
  setSupabaseEnv();
  globalThis.fetch = makeRouter([
    {
      match: "rest/v1/ai_explanations",
      handler: () =>
        jsonResponse([{ id: "e1", payload: { diagnostic: "cache" }, lesson: { title: "t" } }]),
    },
  ]);
  const cached = await getCachedExplanation({
    questionId: "q1",
    selectedKey: "A",
    promptVersion: "2026-10-18.1",
    model: "deepseek-flash",
  });
  assert.equal(cached.id, "e1");
  assert.equal(cached.payload.diagnostic, "cache");
  assert.equal(cached.lesson.title, "t");
});

test("saveExplanation : enregistre payload, tokens et coût (upsert)", async () => {
  setSupabaseEnv();
  let captured = null;
  globalThis.fetch = makeRouter([
    {
      match: "ai_explanations?on_conflict",
      method: "POST",
      handler: (_url, init) => {
        captured = JSON.parse(init.body);
        return jsonResponse([{ id: "e1" }]);
      },
    },
  ]);

  const row = await saveExplanation({
    questionId: "q1",
    selectedKey: "B",
    promptVersion: "2026-10-18.1",
    model: "deepseek-flash",
    payload: { diagnostic: "d", resolution: "r", tip: "t" },
    lesson: null,
    userId: "user-1",
    usage: { inputTokens: 800, outputTokens: 200, cacheHitTokens: 0, estimatedUsd: 0.00024 },
  });

  assert.equal(row.id, "e1");
  const entry = captured[0];
  assert.equal(entry.question_id, "q1");
  assert.equal(entry.selected_key, "B");
  assert.equal(entry.model, "deepseek-flash");
  assert.equal(entry.payload.diagnostic, "d");
  assert.equal(entry.user_id, "user-1");
  assert.equal(entry.prompt_tokens, 800);
  assert.equal(entry.completion_tokens, 200);
  assert.equal(entry.cost_usd, 0.00024);
});

test("touchExplanation : incrémente le compteur via RPC", async () => {
  setSupabaseEnv();
  let rpcCalled = false;
  globalThis.fetch = makeRouter([
    {
      match: "rpc/ai_touch_explanation",
      method: "POST",
      handler: () => {
        rpcCalled = true;
        return jsonResponse(null, 204);
      },
    },
  ]);
  await touchExplanation("e1");
  assert.equal(rpcCalled, true);
});
