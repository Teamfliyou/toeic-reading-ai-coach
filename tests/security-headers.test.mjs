import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SECURITY_HEADERS, securityHeaders } from "../server/security-headers.mjs";
import { makeRes } from "./helpers.mjs";

test("vercel.json applique exactement les mêmes en-têtes que Express", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const fromVercel = Object.fromEntries(config.headers[0].headers.map((h) => [h.key, h.value]));
  assert.deepEqual(fromVercel, SECURITY_HEADERS);
});

test("la CSP interdit scripts inline, objets, cadres et connexions tierces", () => {
  const csp = SECURITY_HEADERS["Content-Security-Policy"];
  assert.match(csp, /script-src 'self' https:\/\/plausible\.io(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/\*\.supabase\.co https:\/\/plausible\.io(;|$)/);
});

test("le middleware pose tous les en-têtes puis poursuit", () => {
  const res = makeRes();
  let called = false;
  securityHeaders({}, res, () => { called = true; });
  assert.ok(called);
  assert.equal(res.getHeader("x-content-type-options"), "nosniff");
  assert.ok(res.getHeader("content-security-policy"));
});
