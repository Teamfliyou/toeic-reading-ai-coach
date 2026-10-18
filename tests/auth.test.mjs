import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  authConfigured,
  bearerToken,
  verifyToken,
  currentAiUser,
  resetAuthCache,
} from "../server/auth.mjs";
import { makeRouter, jsonResponse, setSupabaseEnv, clearSupabaseEnv } from "./helpers.mjs";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearSupabaseEnv();
  resetAuthCache();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSupabaseEnv();
  resetAuthCache();
});

test("bearerToken : extrait le jeton d'un en-tête Authorization", () => {
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc.def.ghi" } }), "abc.def.ghi");
  assert.equal(bearerToken({ headers: { authorization: "bearer   xyz  " } }), "xyz");
  assert.equal(bearerToken({ headers: { authorization: ["Bearer one", "Bearer two"] } }), "one");
});

test("bearerToken : null si absent ou mal formé", () => {
  assert.equal(bearerToken({ headers: {} }), null);
  assert.equal(bearerToken({ headers: { authorization: "Basic xyz" } }), null);
  assert.equal(bearerToken(undefined), null);
});

test("authConfigured : faux sans configuration", () => {
  assert.equal(authConfigured(), false);
});

test("verifyToken : null sans jeton ou sans configuration", async () => {
  assert.equal(await verifyToken(""), null);
  assert.equal(await verifyToken("abc"), null);
});

test("verifyToken : renvoie l'utilisateur via /auth/v1/user", async () => {
  setSupabaseEnv();
  let calls = 0;
  globalThis.fetch = makeRouter([
    {
      match: "/auth/v1/user",
      handler: () => {
        calls += 1;
        return jsonResponse({ id: "user-1", email: "eleve@example.com" });
      },
    },
  ]);
  const user = await verifyToken("jeton-valide");
  assert.equal(user.id, "user-1");
  assert.equal(user.email, "eleve@example.com");
  assert.equal(calls, 1);
});

test("verifyToken : met en cache (un seul appel réseau)", async () => {
  setSupabaseEnv();
  let calls = 0;
  globalThis.fetch = makeRouter([
    {
      match: "/auth/v1/user",
      handler: () => {
        calls += 1;
        return jsonResponse({ id: "user-1" });
      },
    },
  ]);
  await verifyToken("jeton-1");
  await verifyToken("jeton-1");
  assert.equal(calls, 1);
});

test("verifyToken : rejette un jeton invalide (401 Supabase)", async () => {
  setSupabaseEnv();
  globalThis.fetch = makeRouter([
    { match: "/auth/v1/user", handler: () => jsonResponse({ message: "invalid" }, 401) },
  ]);
  assert.equal(await verifyToken("mauvais"), null);
});

test("currentAiUser : chaîne complète requête → utilisateur", async () => {
  setSupabaseEnv();
  globalThis.fetch = makeRouter([
    { match: "/auth/v1/user", handler: () => jsonResponse({ id: "u9" }) },
  ]);
  const user = await currentAiUser({ headers: { authorization: "Bearer t" } });
  assert.equal(user.id, "u9");
});
