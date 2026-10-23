import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_ACTIONS, ipFingerprint, listAudit, recordAudit, sanitizeDetails, userChangeEvents,
} from "../server/audit.mjs";
import {
  base32Decode, base32Encode, generateSecret, otpauthUrl, totp, verifyTotp,
} from "../server/totp.mjs";
import { makeRouter, jsonResponse, textResponse, setSupabaseEnv, clearSupabaseEnv } from "./helpers.mjs";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
beforeEach(() => clearSupabaseEnv());
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSupabaseEnv();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const actor = { id: "11111111-1111-4111-8111-111111111111", username: "alice" };

test("sanitizeDetails : retire mots de passe, jetons et clés, borne les textes", () => {
  const clean = sanitizeDetails({
    role: "editor", password: "hunter2hunter2", newPasswordHash: "x", session_token: "t", api_key: "k",
    count: 3, ok: true, note: "x".repeat(500), nested: { a: 1 },
  });
  assert.deepEqual(Object.keys(clean).sort(), ["count", "note", "ok", "role"]);
  assert.equal(clean.note.length, 200);
});

test("userChangeEvents : un événement par changement sensible, sans valeur de mot de passe", () => {
  const events = userChangeEvents({ id: "u1", role: "admin", active: false, password: "SuperSecret1234" }, { username: "bob" });
  assert.deepEqual(events.map((e) => e.action).sort(), ["user.deactivate", "user.password_reset", "user.role"]);
  assert.ok(!JSON.stringify(events).includes("SuperSecret"));
  assert.equal(events.find((e) => e.action === "user.role").details.role, "admin");
  assert.deepEqual(userChangeEvents({ id: "u1", active: true }, { username: "bob" }).map((e) => e.action), ["user.activate"]);
  assert.deepEqual(userChangeEvents({ id: "u1" }, null), []);
});

test("recordAudit : écrit auteur, action, cible et empreinte d'IP (jamais l'IP ni un secret)", async () => {
  setSupabaseEnv();
  const router = makeRouter([{ match: "rest/v1/admin_audit_log", method: "POST", handler: () => jsonResponse(null, 201) }]);
  globalThis.fetch = router;
  const req = { headers: {}, socket: { remoteAddress: "198.51.100.23" } };
  const ok = await recordAudit({ actor, action: "user.create", target: "bob", details: { role: "editor", password: "nope" }, req });
  assert.equal(ok, true);
  const row = JSON.parse(router.calls[0].init.body)[0];
  assert.equal(row.actor_username, "alice");
  assert.equal(row.action, "user.create");
  assert.deepEqual(row.details, { role: "editor" });
  assert.equal(row.ip_hash, ipFingerprint(req));
  assert.ok(!JSON.stringify(row).includes("198.51.100.23"));
  assert.ok(!JSON.stringify(row).includes("nope"));
});

test("recordAudit : action inconnue ou base indisponible → faux, sans exception", async () => {
  setSupabaseEnv();
  const warn = console.warn;
  console.warn = () => {};
  try {
    globalThis.fetch = makeRouter([{ match: "admin_audit_log", handler: () => textResponse("boom", 503) }]);
    assert.equal(await recordAudit({ actor, action: "user.create" }), false);
    assert.equal(await recordAudit({ actor, action: "n-importe-quoi" }), false);
    clearSupabaseEnv();
    assert.equal(await recordAudit({ actor, action: "user.create" }), false);
  } finally {
    console.warn = warn;
  }
  assert.ok(AUDIT_ACTIONS.includes("question.publish"));
});

test("listAudit : filtre sur une action connue, taille bornée", async () => {
  setSupabaseEnv();
  const router = makeRouter([{ match: "admin_audit_log", handler: () => jsonResponse([{ id: "1" }]) }]);
  globalThis.fetch = router;
  await listAudit({ action: "user.role", limit: 9999 });
  assert.match(router.calls[0].url, /action=eq\.user\.role/);
  assert.match(router.calls[0].url, /limit=500/);
  await listAudit({ action: "x=1&y=2" });
  assert.doesNotMatch(router.calls[1].url, /x=1/);
});

// --- TOTP (vecteurs de test RFC 6238, SHA-1) -----------------------------------
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // « 12345678901234567890 »

test("TOTP : vecteurs officiels de la RFC 6238", () => {
  assert.equal(base32Encode(Buffer.from("12345678901234567890")), RFC_SECRET);
  assert.equal(totp(RFC_SECRET, { time: 59_000, digits: 8 }), "94287082");
  assert.equal(totp(RFC_SECRET, { time: 1_111_111_109_000, digits: 8 }), "07081804");
  assert.equal(totp(RFC_SECRET, { time: 1_234_567_890_000, digits: 8 }), "89005924");
  assert.equal(totp(RFC_SECRET, { time: 59_000 }), "287082");
});

test("TOTP : vérification avec tolérance d'un pas, refus au-delà et des formats invalides", () => {
  const now = 1_700_000_000_000;
  const code = totp(RFC_SECRET, { time: now });
  assert.equal(verifyTotp(RFC_SECRET, code, { time: now }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { time: now + 30_000 }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { time: now + 90_000 }), false);
  assert.equal(verifyTotp(RFC_SECRET, "12345", { time: now }), false);
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", { time: now }), false);
  assert.equal(verifyTotp(RFC_SECRET, undefined, { time: now }), false);
  assert.equal(verifyTotp(RFC_SECRET, ` ${code.slice(0, 3)} ${code.slice(3)} `, { time: now }), true);
});

test("TOTP : secret généré, décodable ; URL otpauth pour QR code", () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret).length, 20);
  assert.throws(() => base32Decode("pas-du-base32!"), /base32/);
  const url = otpauthUrl({ secret, account: "alice@example.com" });
  assert.match(url, /^otpauth:\/\/totp\/Lernoviq:alice%40example\.com\?secret=/);
  assert.match(url, /issuer=Lernoviq/);
});
