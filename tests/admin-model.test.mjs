import test from "node:test";
import assert from "node:assert/strict";
import { MODEL, generate } from "../server/admin.mjs";

test("B1 : utilise un identifiant de modèle DeepSeek valide", () => {
  assert.equal(MODEL, "deepseek-chat");
});

test("B1 : la génération envoie bien « deepseek-chat » à l'API", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-test-key-000000000000";

  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }),
    };
  };

  try {
    await assert.rejects(
      generate({ part: 5, quantity: 1, kind: "grammar", difficulty: 1, topic: "" }),
      /invalide|incomplet/i
    );
    assert.equal(captured.model, "deepseek-chat");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.DEEPSEEK_API_KEY = originalKey;
  }
});
