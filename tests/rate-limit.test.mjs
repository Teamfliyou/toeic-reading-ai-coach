import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  resetRateLimit,
  clientIp,
} from "../server/rate-limit.mjs";

beforeEach(() => resetRateLimit());

test("autorise tant que le seuil n'est pas atteint, puis bloque", () => {
  const options = { limit: 3, windowMs: 1000, now: 0 };
  assert.equal(checkRateLimit("k", options).ok, true);
  assert.equal(checkRateLimit("k", options).ok, true);
  assert.equal(checkRateLimit("k", options).ok, true);

  const blocked = checkRateLimit("k", options);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test("réinitialise après expiration de la fenêtre", () => {
  assert.equal(checkRateLimit("k", { limit: 1, windowMs: 1000, now: 0 }).ok, true);
  assert.equal(checkRateLimit("k", { limit: 1, windowMs: 1000, now: 500 }).ok, false);
  assert.equal(checkRateLimit("k", { limit: 1, windowMs: 1000, now: 1500 }).ok, true);
});

test("isole les compteurs par clé", () => {
  assert.equal(checkRateLimit("a", { limit: 1, windowMs: 1000, now: 0 }).ok, true);
  assert.equal(checkRateLimit("b", { limit: 1, windowMs: 1000, now: 0 }).ok, true);
});

test("clientIp ignore x-forwarded-for si le proxy n'est pas de confiance", () => {
  delete process.env.TRUST_PROXY;
  delete process.env.VERCEL;
  assert.equal(
    clientIp({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "9.9.9.9" } }),
    "9.9.9.9"
  );
  assert.equal(clientIp({ headers: {}, socket: {} }), "unknown");
});

test("clientIp : TRUST_PROXY lit la dernière valeur de x-forwarded-for (ajoutée par le proxy)", () => {
  process.env.TRUST_PROXY = "true";
  try {
    assert.equal(
      clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, socket: {} }),
      "1.2.3.4"
    );
    assert.equal(
      clientIp({ headers: { "x-vercel-forwarded-for": "7.7.7.7", "x-forwarded-for": "6.6.6.6" }, socket: {} }),
      "7.7.7.7"
    );
  } finally {
    delete process.env.TRUST_PROXY;
  }
});
