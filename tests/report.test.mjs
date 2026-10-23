import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  handleReport, parseReport, reporterHash, listReports, setReportStatus, MAX_COMMENT,
} from "../server/report.mjs";
import { resetRateLimit } from "../server/rate-limit.mjs";
import { resetAuthCache } from "../server/auth.mjs";
import {
  makeReq, makeRes, parseBody, makeRouter, jsonResponse, setSupabaseEnv, clearSupabaseEnv,
} from "./helpers.mjs";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  resetRateLimit();
  resetAuthCache();
  clearSupabaseEnv();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSupabaseEnv();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const valid = { questionId: "q5-01", reason: "wrong_answer", comment: "La réponse B est aussi correcte." };
const post = (body, headers = {}) => makeReq({ headers, body: JSON.stringify(body) });

function stack({ recent = [], duplicate = [] } = {}) {
  return makeRouter([
    { match: "question_reports?reporter_hash=eq.", method: "GET", handler: (url) => jsonResponse(url.includes("question_id=eq.") ? duplicate : recent) },
    { match: "rest/v1/question_reports", method: "POST", handler: () => jsonResponse(null, 201) },
  ]);
}

test("parseReport : motif, commentaire borné, « autre » exige une description", () => {
  assert.equal(parseReport(valid).ok, true);
  assert.equal(parseReport({ ...valid, reason: "spam" }).ok, false);
  assert.equal(parseReport({ ...valid, questionId: "" }).ok, false);
  assert.equal(parseReport({ ...valid, comment: "x".repeat(MAX_COMMENT + 1) }).ok, false);
  assert.equal(parseReport({ ...valid, reason: "other", comment: "" }).ok, false);
  assert.equal(parseReport({ ...valid, reason: "typo", comment: "" }).ok, true);
  assert.equal(parseReport({ ...valid, part: 9 }).value.part, null);
});

test("reporterHash : empreinte stable, sans l'IP en clair", () => {
  const h = reporterHash("203.0.113.9");
  assert.equal(h, reporterHash("203.0.113.9"));
  assert.notEqual(h, reporterHash("203.0.113.10"));
  assert.ok(!h.includes("203"));
  assert.equal(h.length, 24);
});

test("sans Supabase : 503 explicite, pas de plantage", async () => {
  const res = makeRes();
  await handleReport(post(valid), res);
  assert.equal(res.statusCode, 503);
  assert.equal(parseBody(res).code, "unavailable");
});

test("signalement enregistré avec l'énoncé et l'empreinte (jamais l'IP)", async () => {
  setSupabaseEnv();
  const router = stack();
  globalThis.fetch = router;
  const req = post(valid);
  req.socket = { remoteAddress: "198.51.100.7" };
  const res = makeRes();
  await handleReport(req, res);
  assert.equal(res.statusCode, 201);
  const insert = router.calls.find((c) => c.method === "POST" && c.url.endsWith("/question_reports"));
  const row = JSON.parse(insert.init.body)[0];
  assert.equal(row.question_id, "q5-01");
  assert.match(row.question_prompt, /quarterly report/);
  assert.equal(row.reason, "wrong_answer");
  assert.equal(row.reporter_id, null);
  assert.ok(!JSON.stringify(row).includes("198.51.100.7"));
});

test("question Listening reconnue ; question inconnue : 404", async () => {
  setSupabaseEnv();
  const router = stack();
  globalThis.fetch = router;
  const ok = makeRes();
  await handleReport(post({ questionId: "l2-03", reason: "unclear_audio" }), ok);
  assert.equal(ok.statusCode, 201);
  assert.equal(JSON.parse(router.calls.at(-1).init.body)[0].part, 2);

  globalThis.fetch = stack();
  const unknown = makeRes();
  await handleReport(post({ questionId: "inexistante", reason: "typo" }), unknown);
  assert.equal(unknown.statusCode, 404);
});

test("limite : 10 signalements par heure (base) et doublon ignoré", async () => {
  setSupabaseEnv();
  globalThis.fetch = stack({ recent: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })) });
  const limited = makeRes();
  await handleReport(post(valid), limited);
  assert.equal(limited.statusCode, 429);

  const router = stack({ duplicate: [{ id: "x" }] });
  globalThis.fetch = router;
  const dup = makeRes();
  await handleReport(post(valid), dup);
  assert.equal(dup.statusCode, 200);
  assert.equal(parseBody(dup).duplicate, true);
  assert.ok(!router.calls.some((c) => c.method === "POST"));
});

test("limite mémoire par IP, origine étrangère et méthode refusées", async () => {
  setSupabaseEnv();
  globalThis.fetch = stack();
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = makeRes();
    await handleReport(post({ ...valid, reason: "typo" }), last);
  }
  assert.equal(last.statusCode, 429);

  const foreign = makeRes();
  await handleReport(post(valid, { origin: "https://evil.example", host: "app.example" }), foreign);
  assert.equal(foreign.statusCode, 403);
  const get = makeRes();
  await handleReport(makeReq({ method: "GET" }), get);
  assert.equal(get.statusCode, 405);
});

test("admin : liste filtrée et changement de statut tracé", async () => {
  setSupabaseEnv();
  const router = makeRouter([
    { match: "status=eq.open", handler: () => jsonResponse([{ id: "r1" }]) },
    { match: "question_reports?id=eq.", method: "PATCH", handler: () => jsonResponse([{ id: "11111111-1111-4111-8111-111111111111", status: "resolved" }]) },
  ]);
  globalThis.fetch = router;
  assert.deepEqual(await listReports("open"), [{ id: "r1" }]);
  const done = await setReportStatus("11111111-1111-4111-8111-111111111111", "resolved", "alice");
  assert.equal(done.status, "resolved");
  const patch = JSON.parse(router.calls.at(-1).init.body);
  assert.equal(patch.handled_by, "alice");
  await assert.rejects(setReportStatus("pas-un-uuid", "resolved", "a"), /invalide/);
  await assert.rejects(setReportStatus("11111111-1111-4111-8111-111111111111", "bizarre", "a"), /Statut/);
});
