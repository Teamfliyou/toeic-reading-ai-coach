// Sécurité de l'administration et bibliothèque : authentification, rôles, taille des requêtes,
// masquage des erreurs, édition, publication, suppression contrôlée (SQL réel dans PGlite).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { handleAdmin } from "../server/admin.mjs";
import { handleBankAction, isBankAction, publicError } from "../server/bank/api.mjs";
import { BankError } from "../server/bank/db.mjs";
import { createJob } from "../server/bank/generation.mjs";
import { createBankDb, fakeSupabase } from "./pg-helper.mjs";
import { makeReq, makeRes, makeStreamReq, parseBody } from "./helpers.mjs";

const admin = { id: "u1", username: "root", role: "admin" };
const editor = { id: "u2", username: "ed", role: "editor" };

let db;
const realFetch = globalThis.fetch;
const json = (res, status, data) => { res.statusCode = status; res.body = JSON.stringify(data); };
const readBody = async (req) => req.body;

async function call(action, body, user = admin) {
  const res = makeRes();
  await handleBankAction(action, { req: makeReq({ body }), res, user, json, readBody });
  return { status: res.statusCode, body: parseBody(res) };
}

before(async () => {
  db = await createBankDb({ withAi: true });
  process.env.SUPABASE_URL = "https://demo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  process.env.DEEPSEEK_API_KEY = "sk-test-0000000000";
  process.env.ADMIN_SESSION_SECRET = "s".repeat(40);
  globalThis.fetch = fakeSupabase(db, async (url) => {
    if (String(url).includes("question_reports")) return { ok: true, status: 200, text: async () => "[]", json: async () => [] };
    throw new Error(`réseau inattendu : ${url}`);
  });
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DEEPSEEK_API_KEY", "ADMIN_SESSION_SECRET"]) delete process.env[k];
});

test("actions reconnues : toutes les actions de la banque passent par le routeur sécurisé", () => {
  for (const a of ["bank-list", "bank-import-chunk", "bank-gen-create", "bank-delete", "bank-status"]) assert.equal(isBankAction(a), true, a);
  for (const a of ["login", "constructor", "__proto__", "bank-unknown", "toString"]) assert.equal(isBankAction(a), false, a);
});

test("authentification : sans session, toutes les actions de la banque sont refusées (401)", async () => {
  for (const action of ["bank-list", "bank-import-chunk", "bank-gen-create", "bank-delete", "bank-status", "bank-update"]) {
    const res = makeRes();
    const req = makeReq({
      method: "POST", body: { ids: [] },
      headers: { origin: "http://localhost:3000", host: "localhost:3000", "content-type": "application/json" },
    });
    req.url = `/api/admin?action=${action}`;
    await handleAdmin(req, res);
    assert.equal(res.statusCode, 401, action);
    assert.match(parseBody(res).error, /Connexion requise/);
  }
});

test("origine et méthode : requête d'un autre site (CSRF) et GET refusés", async () => {
  const cross = makeReq({ method: "POST", body: {}, headers: { origin: "https://evil.example", host: "localhost:3000", "content-type": "application/json" } });
  cross.url = "/api/admin?action=bank-list";
  const res = makeRes();
  await handleAdmin(cross, res);
  assert.equal(res.statusCode, 403);
  const get = makeReq({ method: "GET", headers: { host: "localhost:3000" } });
  get.url = "/api/admin?action=bank-list";
  const res2 = makeRes();
  await handleAdmin(get, res2);
  assert.equal(res2.statusCode, 405);
});

test("rôles : un éditeur ne peut pas supprimer ; un administrateur le peut (questions jamais publiées)", async () => {
  const denied = await call("bank-delete", { ids: ["00000000-0000-4000-8000-000000000000"] }, editor);
  assert.equal(denied.status, 403);
  const allowed = await call("bank-delete", { ids: ["00000000-0000-4000-8000-000000000000"] }, admin);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.deleted, 0);
});

test("générations : un éditeur ne contrôle pas le job d'un autre ; volume limité", async () => {
  process.env.GEN_JOBS_PER_HOUR = "100";
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 20, batchSize: 10 }, admin);
  for (const action of ["bank-gen-cancel", "bank-gen-pause", "bank-gen-tick"]) {
    const r = await call(action, { jobId: job.id }, editor);
    assert.equal(r.status, 403, action);
  }
  const big = await call("bank-gen-create", { part: 5, kind: "grammar", difficulty: 2, total: 1000, batchSize: 20 }, editor);
  assert.equal(big.status, 403);
  assert.match(big.body.error, /administrateur/);
  const ok = await call("bank-gen-create", { part: 5, kind: "grammar", difficulty: 2, total: 40, batchSize: 20 }, editor);
  assert.equal(ok.status, 200);
  const own = await call("bank-gen-cancel", { jobId: ok.body.job.id }, editor);
  assert.equal(own.status, 200);
  assert.equal(own.body.job.status, "cancelled");
  assert.equal((await call("bank-gen-cancel", { jobId: job.id }, admin)).status, 200);
  delete process.env.GEN_JOBS_PER_HOUR;
});

test("erreurs : jamais de détail interne ni de secret renvoyé au navigateur", async () => {
  const internal = publicError(new BankError("relation \"secret_table\" does not exist (SUPABASE_SERVICE_ROLE_KEY=abc)"));
  assert.deepEqual(internal, { status: 500, message: "Erreur de base de données." });
  assert.equal(publicError(new Error("boom: sk-live-123")).message, "Erreur du serveur.");
  assert.equal(publicError(new SyntaxError("Unexpected token")).status, 400);
  assert.equal(publicError(new Error("Requête trop volumineuse")).status, 413);
  assert.equal(publicError(new BankError("Migration manquante.", { status: 503, expose: true })).status, 503);
  const invalid = await call("bank-list", { filters: { part: 9 } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Requête invalide/);
  const unknownFilter = await call("bank-list", { filters: { "1=1; drop table questions": true } });
  assert.equal(unknownFilter.status, 400, "filtres inconnus refusés (aucune injection possible)");
  assert.equal((await call("bank-get", { id: "not-a-uuid" })).status, 400);
  assert.equal((await call("bank-status", { ids: [], status: "published" })).status, 400);
  assert.equal((await call("bank-status", { ids: ["00000000-0000-4000-8000-000000000000"], status: "deleted" })).status, 400);
});

test("taille des requêtes : un corps trop gros est refusé avant analyse", async () => {
  const res = makeRes();
  const big = "x".repeat(70_000);
  const req = makeStreamReq({ method: "POST", headers: {}, chunks: [`{"a":"${big}"}`] });
  req[Symbol.asyncIterator] = async function* () { yield `{"a":"${big}"}`; };
  const streamRead = async (r, limit) => {
    let body = "";
    for await (const chunk of r) { body += chunk; if (body.length > limit) throw new Error("Requête trop volumineuse"); }
    return JSON.parse(body || "{}");
  };
  await handleBankAction("bank-import-start", { req, res, user: admin, json, readBody: streamRead });
  assert.equal(res.statusCode, 413);
});

test("sans Supabase : la banque répond 503 sans exposer de détail", async () => {
  const url = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const r = await call("bank-list", {});
  assert.equal(r.status, 503);
  process.env.SUPABASE_URL = url;
});

test("bibliothèque : pagination, filtres, recherche et statistiques du catalogue", async () => {
  const stats = await call("bank-stats", {});
  assert.equal(stats.body.by_status.published, 33);
  assert.equal(stats.body.by_part_status["5:published"], 15);
  assert.equal(stats.body.by_part_status["6:published"], 8);
  const page = await call("bank-list", { filters: { part: 5, status: "published" }, limit: 10, offset: 10 });
  assert.equal(page.body.total, 15);
  assert.equal(page.body.rows.length, 5);
  const byCategory = await call("bank-list", { filters: { category: "prepositions" } });
  assert.ok(byCategory.body.rows.length > 0 && byCategory.body.rows.every((r) => r.category === "prepositions"));
  const search = await call("bank-list", { filters: { q: "quarterly report" } });
  assert.ok(search.body.rows.some((r) => /quarterly report/i.test(r.prompt)));
  assert.equal((await call("bank-list", { limit: 500 })).status, 400, "taille de page bornée");
  const row = page.body.rows[0];
  assert.ok(!("lsh" in row) && !("search_vec" in row) && "open_reports" in row);
});

test("édition : contrôles qualité à l'enregistrement, historique, conflit de version", async () => {
  const list = await call("bank-list", { filters: { part: 5 }, limit: 1 });
  const q = list.body.rows[0];
  const edited = await call("bank-update", { id: q.id, expectedVersion: q.version, patch: { explanation: "« must be » exprime une obligation à la voix passive.", difficulty: 3 } }, editor);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.question.version, q.version + 1);
  assert.equal(edited.body.question.updated_by, "ed");
  const stale = await call("bank-update", { id: q.id, expectedVersion: q.version, patch: { difficulty: 1 } });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /modifiée par quelqu'un d'autre/);
  const badAnswer = await call("bank-update", { id: q.id, patch: { correct_key: "E" } });
  assert.equal(badAnswer.status, 400);
  const dupOptions = await call("bank-update", { id: q.id, patch: { options: q.options.map((o) => ({ ...o, text: "same" })) } });
  assert.equal(dupOptions.status, 400);
  assert.match(dupOptions.body.error, /identiques/);
  const french = await call("bank-update", { id: q.id, patch: { prompt: "Vous devez envoyer les factures pour les clients dans une semaine ______ ici." } });
  assert.equal(french.status, 400);
  const detail = await call("bank-get", { id: q.id });
  assert.equal(detail.body.revisions.length, 1);
  assert.equal(detail.body.revisions[0].snapshot.difficulty, q.difficulty);
  assert.equal(detail.body.question.difficulty, 3);
});

test("édition d'un document (partie 6) : l'empreinte des questions suit", async () => {
  const list = await call("bank-list", { filters: { part: 6 }, limit: 1 });
  const detail = await call("bank-get", { id: list.body.rows[0].id });
  assert.ok(detail.body.passage && detail.body.siblings.length === 4, "le document et ses 4 questions sont chargés ensemble");
  const docs = detail.body.passage.documents.map((d) => ({ ...d, body: [...d.body] }));
  docs[0].body[0] += " (revised)";
  const upd = await call("bank-update-passage", { id: detail.body.passage.id, title: detail.body.passage.title, documents: docs });
  assert.equal(upd.status, 200);
  assert.equal((await call("bank-update-passage", { id: detail.body.passage.id, title: "", documents: docs })).status, 400);
});

test("publication : individuelle, multiple, confirmation des questions à vérifier, archivage", async () => {
  // Un lot importé en brouillon, dont une question est à vérifier.
  const { startImport, importChunk } = await import("../server/bank/import-service.mjs");
  const { suggestMapping } = await import("../server/bank/import.mjs");
  const { readFileSync } = await import("node:fs");
  const template = JSON.parse(readFileSync(new URL("../data/import-template.json", import.meta.url), "utf8"));
  const { mapping } = suggestMapping(template.headers);
  const { batch } = await startImport({ filename: "t.json", format: "json", fingerprint: "9".repeat(32), totalRows: 10, chunkSize: 50, chunksTotal: 1, mapping }, "ed");
  const rows = template.rows.map((data, i) => ({ n: i + 2, data }));
  const out = await importChunk({ batchId: batch.id, chunk: 0, rows, mapping }, "ed");
  assert.equal(out.inserted, 10);

  const drafts = await call("bank-list", { filters: { batch_id: batch.id, status: "draft" }, limit: 100 });
  assert.equal(drafts.body.total, 10);
  const ids = drafts.body.rows.map((r) => r.id);
  const published = await call("bank-status", { ids, status: "published" }, editor);
  assert.equal(published.status, 200);
  assert.equal(published.body.changed, 10);
  // Visible par les élèves, passages compris.
  const pick = await db.query("select public.bank_pick_passages(7, 5) as r");
  assert.ok(pick.rows[0].r.passages.some((p) => /Workshop/.test(p.title)));
  assert.equal((await call("bank-status", { ids: [ids[0]], status: "archived" })).body.changed, 1);
  assert.equal((await call("bank-status", { ids: [ids[0]], status: "archived" })).body.changed, 0, "idempotent");

  // Suppression : impossible pour une question déjà publiée.
  const del = await call("bank-delete", { ids: [ids[1]] }, admin);
  assert.deepEqual(del.body.skipped.map((s) => s.reason), ["was_published"]);
});

test("doublons : le catalogue n'en contient aucun une fois l'index unique en place", async () => {
  const dup = await call("bank-duplicates", {});
  assert.equal(dup.status, 200);
  assert.equal(dup.body.total, 0);
});

test("sans IA : bibliothèque, import, édition et publication fonctionnent sans clé DeepSeek", async () => {
  const key = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.equal((await call("bank-stats", {})).status, 200);
    assert.equal((await call("bank-list", { limit: 5 })).status, 200);
    const list = await call("bank-list", { filters: { status: "published", part: 5 }, limit: 1 });
    const q = list.body.rows[0];
    const edit = await call("bank-update", { id: q.id, expectedVersion: q.version, patch: { theme: "Offline" } }, editor);
    assert.equal(edit.status, 200);
    // La génération, elle, est refusée avec un message clair — sans rien débiter.
    const gen = await call("bank-gen-create", { part: 5, kind: "grammar", difficulty: 2, total: 20 }, admin);
    assert.equal(gen.status, 503);
    assert.match(gen.body.error, /DEEPSEEK_API_KEY/);
    const tick = await call("bank-gen-tick", { jobId: "00000000-0000-4000-8000-000000000000" }, admin);
    assert.equal(tick.status, 503);
  } finally {
    process.env.DEEPSEEK_API_KEY = key;
  }
});
