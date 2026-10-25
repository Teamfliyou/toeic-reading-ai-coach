// Chargement paginé côté élève, repli JSON, examen Reading complet de 100 questions
// (composition pure + de bout en bout sur la vraie base PGlite).
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { examCandidates, loadByIds, pickLocal, pickSet } from "../src/lib/bank/practice.ts";
import { EXAM_TARGET, buildReadingExam, reducedNotice } from "../src/lib/examBuilder.ts";
import { mulberry32 } from "../server/bank/text.mjs";
import { createBankDb, fakeSupabase } from "./pg-helper.mjs";

const local = JSON.parse(readFileSync(new URL("../data/questions.json", import.meta.url), "utf8"));
const rng = () => mulberry32(5);
const options = (id) => ["A", "B", "C", "D"].map((key) => ({ key, text: `${id}${key}` }));
const question = (id, part, passageId = null, difficulty = 2, orderIndex = 0) => ({ id, part, passageId, orderIndex, prompt: `Prompt ${id} ______`, options: options(id), correctKey: "A", difficulty, category: "vocabulary" });

/** Banque synthétique : n questions P5, d documents P6 (4 q) et sets P7 de taille donnée. */
function syntheticPool({ p5 = 120, p6 = 12, p7Sizes = Array.from({ length: 30 }, (_, i) => 2 + (i % 4)) } = {}) {
  const questions = [];
  const passages = [];
  for (let i = 0; i < p5; i += 1) questions.push(question(`p5-${i}`, 5, null, 1 + (i % 3)));
  for (let d = 0; d < p6; d += 1) {
    passages.push({ id: `P6-${d}`, part: 6, title: `P6 ${d}`, documents: [{ id: `d${d}`, kind: "memo", title: "t", body: ["x"] }] });
    for (let k = 0; k < 4; k += 1) questions.push(question(`p6-${d}-${k}`, 6, `P6-${d}`, 1 + ((d + k) % 3), k + 1));
  }
  p7Sizes.forEach((size, d) => {
    const docs = 1 + (d % 3 === 0 ? 1 : 0);
    passages.push({ id: `P7-${d}`, part: 7, title: `P7 ${d}`, documents: Array.from({ length: docs }, (_, n) => ({ id: `e${d}${n}`, kind: "email", title: "t", body: ["x"] })) });
    for (let k = 0; k < size; k += 1) questions.push(question(`p7-${d}-${k}`, 7, `P7-${d}`, 1 + ((d + k) % 3), k + 1));
  });
  return { questions, passages };
}
const toPool = (d) => ({
  p5: d.questions.filter((q) => q.part === 5),
  p6: { passages: d.passages.filter((p) => p.part === 6), questions: d.questions.filter((q) => q.part === 6) },
  p7: { passages: d.passages.filter((p) => p.part === 7), questions: d.questions.filter((q) => q.part === 7) },
});

test("jeu local : tirage limité, inédites d'abord, filtres, documents complets", () => {
  const five = pickLocal(local, 5, { limit: 5 }, rng());
  assert.equal(five.questions.length, 5);
  assert.ok(five.questions.every((q) => q.part === 5 && !q.passageId));
  const all5 = local.questions.filter((q) => q.part === 5).map((q) => q.id);
  const seen = all5.slice(0, 10);
  const fresh = pickLocal(local, 5, { limit: 5, exclude: seen }, rng());
  assert.ok(fresh.questions.every((q) => !seen.includes(q.id)), "les inédites passent d'abord");
  const topUp = pickLocal(local, 5, { limit: 15, exclude: all5 }, rng());
  assert.equal(topUp.questions.length, 15, "banque épuisée : on complète avec des questions déjà vues");
  const filtered = pickLocal(local, 5, { limit: 20, difficulty: 3 }, rng());
  assert.ok(filtered.questions.length > 0 && filtered.questions.every((q) => q.difficulty === 3));
  const p6 = pickLocal(local, 6, { limit: 1 }, rng());
  assert.equal(p6.passages.length, 1);
  assert.equal(p6.questions.length, 4, "le document est livré avec toutes ses questions");
  assert.ok(p6.questions.every((q) => q.passageId === p6.passages[0].id));
  assert.equal(pickLocal(local, 7, { limit: 10 }, rng()).passages.length, 3);
});

const okJson = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const rows = (n, part = 5) => Array.from({ length: n }, (_, i) => ({ id: `uuid-${i}`, slug: `bank-${i}`, part, passage_id: null, order_index: 0, prompt: `Bank question ${i} ______`, options: options(`b${i}`), correct_key: "B", difficulty: 2, category: "connectors", tags: [], theme: "Office", explanation: "Explication." }));

test("banque : une série demandée au serveur (jamais toute la table), paramètres transmis", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return okJson({ questions: rows(20) }); };
  const set = await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl }, 5, { difficulty: 2, category: "connectors", exclude: ["a", "b"] });
  assert.equal(set.origin, "bank");
  assert.equal(set.questions.length, 20);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /rpc\/bank_pick_questions$/);
  assert.deepEqual(calls[0].body, { p_part: 5, p_limit: 20, p_difficulty: 2, p_category: "connectors", p_theme: null, p_exclude: ["a", "b"] });
  assert.equal(set.questions[0].id, "bank-0", "l'identifiant stable (slug) sert de clé d'historique");
  assert.equal(set.questions[0].explanation, "Explication.");
  const p7 = [];
  await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl: async (u) => { p7.push(String(u)); return okJson({ questions: [], passages: [] }); } }, 7, { limit: 3, relax: false });
  assert.match(p7[0], /bank_pick_passages$/);
});

test("filtres abandonnés un à un quand la banque en manque, et signalés", async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    seen.push(b);
    return okJson({ questions: b.p_difficulty || b.p_category ? rows(1) : rows(20) });
  };
  const set = await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl }, 5, { difficulty: 3, category: "connectors" });
  assert.equal(set.questions.length, 20);
  assert.deepEqual(set.relaxed, ["difficulty", "category"]);
  assert.equal(seen.length, 3);
  const strict = await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl }, 5, { difficulty: 3, category: "connectors", relax: false });
  assert.equal(strict.questions.length, 1);
});

test("Supabase inaccessible : repli sur le jeu JSON local, sans erreur", async () => {
  const down = async () => { throw new TypeError("fetch failed"); };
  const set = await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl: down }, 5, { limit: 10 });
  assert.equal(set.origin, "local");
  assert.equal(set.questions.length, 10);
  const timeout = async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); };
  assert.equal((await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl: timeout }, 6, {})).origin, "local");
  const serverError = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" });
  assert.equal((await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl: serverError }, 7, {})).origin, "local");
  const noConfig = await pickSet({ url: "", key: "", local }, 5, {});
  assert.equal(noConfig.origin, "local");
  const empty = await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl: async () => okJson({ questions: [] }) }, 5, {});
  assert.equal(empty.origin, "local", "banque vide : le jeu local évite une page blanche");
  assert.ok(empty.questions.length > 0);
});

test("base non migrée : lecture REST bornée à 200 lignes, tirage dans le navigateur", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    urls.push(href);
    if (href.includes("/rpc/")) return { ok: false, status: 404, json: async () => ({ code: "PGRST202" }), text: async () => "" };
    return okJson(rows(60));
  };
  const set = await pickSet({ url: "https://x.supabase.co", key: "k", local, fetchImpl }, 5, { limit: 12 });
  assert.equal(set.origin, "legacy");
  assert.equal(set.questions.length, 12);
  const rest = urls.find((u) => u.includes("/rest/v1/questions?"));
  assert.match(rest, /limit=200/);
  assert.match(rest, /part=eq\.5/);
});

test("historique : questions retrouvées par identifiant, banque puis jeu local", async () => {
  const fetchImpl = async (_url, init) => {
    const { p_ids: ids } = JSON.parse(init.body);
    return okJson({ questions: ids.filter((i) => i.startsWith("bank-")).map((slug) => ({ ...rows(1)[0], slug })), passages: [] });
  };
  const localId = local.questions[0].id;
  const res = await loadByIds({ url: "https://x.supabase.co", key: "k", local, fetchImpl }, ["bank-7", localId, "inconnu"]);
  assert.deepEqual(res.questions.map((q) => q.id).sort(), [localId, "bank-7"].sort());
  const offline = await loadByIds({ url: "https://x.supabase.co", key: "k", local, fetchImpl: async () => { throw new Error("réseau"); } }, [localId]);
  assert.equal(offline.questions.length, 1);
  // 450 identifiants : appels de 200 au plus.
  let sizes = [];
  await loadByIds({ url: "https://x.supabase.co", key: "k", local, fetchImpl: async (_u, init) => { sizes.push(JSON.parse(init.body).p_ids.length); return okJson({ questions: [], passages: [] }); } }, Array.from({ length: 450 }, (_, i) => `id-${i}`));
  assert.deepEqual(sizes, [200, 200, 50]);
});

// --- Examen Reading ----------------------------------------------------------------------------

test("examen complet : 30 + 16 + 54 = 100 questions, documents entiers, difficultés réparties", () => {
  const exam = buildReadingExam(toPool(syntheticPool()), [], mulberry32(1));
  assert.equal(exam.reduced, false);
  assert.deepEqual(exam.counts, { p5: 30, p6: 16, p7: 54 });
  assert.equal(exam.questions.length, 100);
  assert.equal(reducedNotice(exam), "");
  assert.deepEqual(exam.questions.map((q) => q.part).filter((p, i, a) => i === 0 || p !== a[i - 1]), [5, 6, 7], "parties 5, 6 puis 7");
  const ids = exam.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, 100, "aucune question en double");
  // Partie 6 : 4 documents cohérents de 4 questions consécutives.
  const p6 = exam.questions.filter((q) => q.part === 6);
  const byPassage = Object.groupBy(p6, (q) => q.passageId);
  assert.equal(Object.keys(byPassage).length, 4);
  assert.ok(Object.values(byPassage).every((qs) => qs.length === 4));
  // Aucun document n'est coupé : toutes les questions d'un document figurent dans l'examen.
  const pool = syntheticPool();
  for (const passageId of new Set(exam.questions.filter((q) => q.passageId).map((q) => q.passageId))) {
    const wanted = pool.questions.filter((q) => q.passageId === passageId).length;
    assert.equal(exam.questions.filter((q) => q.passageId === passageId).length, wanted, passageId);
  }
  assert.equal(exam.passages.length, new Set(exam.questions.filter((q) => q.passageId).map((q) => q.passageId)).size);
  // Questions d'un même document côte à côte et dans l'ordre.
  const p7 = exam.questions.filter((q) => q.part === 7);
  for (let i = 1; i < p7.length; i += 1) if (p7[i].passageId !== p7[i - 1].passageId) assert.equal(p7.filter((q) => q.passageId === p7[i - 1].passageId).length > 0, true);
  const groups7 = p7.map((q) => q.passageId).filter((p, i, a) => i === 0 || p !== a[i - 1]);
  assert.equal(new Set(groups7).size, groups7.length, "chaque document forme un bloc contigu");
  const p5 = exam.questions.filter((q) => q.part === 5);
  const levels = [1, 2, 3].map((d) => p5.filter((q) => q.difficulty === d).length);
  assert.deepEqual(levels, [9, 14, 7]);
  assert.ok(p7.some((q) => pool.passages.find((p) => p.id === q.passageId).documents.length > 1), "ensembles à plusieurs documents présents");
});

test("examen : variété (deux tirages différents) et questions déjà vues évitées", () => {
  const pool = toPool(syntheticPool({ p5: 120 }));
  const a = buildReadingExam(pool, [], mulberry32(1));
  const b = buildReadingExam(pool, [], mulberry32(2));
  assert.notDeepEqual(a.questions.map((q) => q.id), b.questions.map((q) => q.id));
  const seen = a.questions.map((q) => q.id);
  const next = buildReadingExam(pool, seen, mulberry32(3));
  assert.equal(next.counts.p5, 30);
  assert.equal(next.questions.filter((q) => q.part === 5 && seen.includes(q.id)).length, 0, "assez d'inédites en partie 5 : aucune répétition");
  assert.ok(next.repeated < 100);
  // Banque trop petite : les questions déjà vues sont réutilisées (et comptées).
  const tight = toPool(syntheticPool({ p5: 30 }));
  const again = buildReadingExam(tight, tight.p5.map((q) => q.id), mulberry32(4));
  assert.equal(again.counts.p5, 30);
  assert.ok(again.repeated >= 30);
});

test("examen réduit : annoncé explicitement, jamais présenté comme complet", () => {
  const exam = buildReadingExam(toPool(local), [], mulberry32(1));
  assert.equal(exam.reduced, true);
  assert.deepEqual(exam.counts, { p5: 15, p6: 8, p7: 10 });
  assert.deepEqual(exam.shortfall, { p5: 15, p6: 8, p7: 44 });
  const notice = reducedNotice(exam);
  assert.match(notice, /RÉDUIT/);
  assert.match(notice, /33 questions au lieu de 100/);
  assert.match(notice, /partie 5 : 15\/30/);
  // Cas limite : 54 inatteignable avec des ensembles de 5 questions → le plus grand total possible.
  const fives = toPool(syntheticPool({ p7Sizes: Array(12).fill(5) }));
  const e2 = buildReadingExam(fives, [], mulberry32(1));
  assert.equal(e2.counts.p7, 50);
  assert.equal(e2.reduced, true);
  // Partie 6 incomplète (documents de 3 trous) : écartés.
  const bad = syntheticPool({ p6: 0 });
  bad.passages.push({ id: "X", part: 6, title: "x", documents: [{ id: "d", kind: "memo", title: "t", body: ["x"] }] });
  for (let k = 0; k < 3; k += 1) bad.questions.push(question(`x${k}`, 6, "X", 2, k + 1));
  assert.equal(buildReadingExam(toPool(bad), [], mulberry32(1)).counts.p6, 0);
  assert.equal(EXAM_TARGET.p5 + EXAM_TARGET.p6 + EXAM_TARGET.p7, 100);
});

// --- De bout en bout sur la vraie base ------------------------------------------------------------

let db;
const items = [];
before(async () => {
  db = await createBankDb({ seed: false });
  // 150 questions P5, 20 documents P6 (4 q), 30 ensembles P7 (2 à 5 q) — publiés via les fonctions SQL.
  const syn = syntheticPool({ p5: 150, p6: 20, p7Sizes: Array.from({ length: 30 }, (_, i) => 2 + (i % 4)) });
  const wordy = (id) => `${id} the manager ${id.length % 2 ? "approved" : "reviewed"} request ${id} before the quarterly meeting on ${id}`;
  for (const q of syn.questions) {
    const passage = syn.passages.find((p) => p.id === q.passageId);
    items.push({
      ref: q.id, part: q.part,
      passage: passage ? { key: passage.id, title: passage.title, documents: [{ kind: "memo", title: passage.title, body: [`Body for ${passage.id} with (1)______ text and more words to make it unique ${passage.id}`] }] } : null,
      question: { prompt: `${wordy(q.id)} ______`, options: q.options, correct_key: "A", difficulty: q.difficulty, category: "vocabulary", order_index: q.orderIndex },
    });
  }
  for (let i = 0; i < items.length; i += 200) {
    const res = (await db.query("select public.bank_insert_items($1::jsonb, $2::jsonb) as r", [JSON.stringify(items.slice(i, i + 200)), JSON.stringify({ status: "draft", source: "import", actor: "seed" })])).rows[0].r;
    assert.equal(res.duplicates, 0);
  }
  await db.exec("update questions set status = 'published' where status = 'draft'; update passages set status = 'published'");
});

test("bout en bout : tirage SQL paginé, exclusion des vues, examen complet de 100 questions", async () => {
  const src = { url: "https://demo.supabase.co", key: "anon", local, fetchImpl: fakeSupabase(db), rng: mulberry32(9) };
  const first = await pickSet(src, 5, { limit: 20 });
  assert.equal(first.origin, "bank");
  assert.equal(first.questions.length, 20);
  const seen = first.questions.map((q) => q.id);
  const second = await pickSet(src, 5, { limit: 20, exclude: seen });
  assert.equal(second.questions.filter((q) => seen.includes(q.id)).length, 0);
  const p6 = await pickSet(src, 6, { limit: 3 });
  assert.equal(p6.passages.length, 3);
  assert.ok(p6.passages.every((p) => p6.questions.filter((q) => q.passageId === p.id).length === 4));
  const hard = await pickSet(src, 5, { limit: 10, difficulty: 3, category: "vocabulary" });
  assert.ok(hard.questions.length >= 5 && hard.questions.every((q) => q.difficulty === 3));

  const pool = await examCandidates(src, seen);
  assert.equal(pool.origin, "bank");
  assert.equal(pool.p5.length, 90);
  const exam = buildReadingExam(pool, seen, mulberry32(3));
  assert.equal(exam.reduced, false, reducedNotice(exam));
  assert.deepEqual(exam.counts, { p5: 30, p6: 16, p7: 54 });
  assert.equal(new Set(exam.questions.map((q) => q.id)).size, 100);
  assert.ok(exam.questions.filter((q) => q.part === 5).every((q) => !seen.includes(q.id)), "inédites d'abord");
  for (const pid of new Set(exam.questions.filter((q) => q.passageId).map((q) => q.passageId))) {
    assert.ok(exam.passages.some((p) => p.id === pid), "chaque question a son document");
  }
  // Brouillons et questions en validation ne sont jamais servis aux élèves.
  await db.exec("update questions set status = 'review' where part = 5 and id in (select id from questions where part = 5 limit 100)");
  const afterReview = await pickSet(src, 5, { limit: 200 });
  assert.ok(afterReview.questions.length <= 50);
});

test("historique et progression : l'examen complet est corrigé, noté (estimation) et consigné", async () => {
  const { gradeExam, estimateReadingScore, newExamState, setAnswer, EXAM_DURATION_MS } = await import("../src/lib/exam.ts");
  const exam = buildReadingExam(toPool(syntheticPool()), [], mulberry32(8));
  assert.equal(exam.questions.length, 100);
  const refs = exam.questions.map((q) => ({ id: q.id, part: q.part, orderIndex: q.orderIndex, correctKey: q.correctKey }));
  let state = newExamState(exam.questions.map((q) => q.id), 0);
  assert.equal(state.deadline - state.startedAt, EXAM_DURATION_MS, "75 minutes");
  // Retour en arrière : une réponse peut être modifiée avant la fin.
  state = setAnswer(state, exam.questions[0].id, "B");
  state = setAnswer(state, exam.questions[0].id, "A");
  for (const q of exam.questions.slice(1, 80)) state = setAnswer(state, q.id, "A");
  for (const q of exam.questions.slice(80, 90)) state = setAnswer(state, q.id, "B");
  const result = gradeExam(state, refs);
  assert.equal(result.total, 100);
  assert.equal(result.reduced, false);
  assert.equal(result.correct, 80);
  assert.equal(result.unanswered.length, 10);
  assert.equal(result.wrong.length, 10);
  assert.equal(result.score, estimateReadingScore(80, 100));
  assert.deepEqual(Object.keys(result.byPart).map(Number), [5, 6, 7]);
  assert.deepEqual(Object.values(result.byPart).map((p) => p.total), [30, 16, 54]);
  assert.ok(result.score >= 5 && result.score <= 495 && result.score % 5 === 0, "estimation par pas de 5, jamais un score officiel");
  // Examen réduit : détecté par la correction.
  const small = buildReadingExam(toPool(local), [], mulberry32(1));
  const smallState = newExamState(small.questions.map((q) => q.id), 0);
  assert.equal(gradeExam(smallState, small.questions.map((q) => ({ id: q.id, part: q.part, orderIndex: q.orderIndex, correctKey: q.correctKey }))).reduced, true);
});

test("base non migrée : l'examen et la révision continuent d'utiliser les questions de Supabase", async () => {
  const urls = [];
  const bankRows = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`.slice(-36), slug: null, part: 5, passage_id: null, order_index: i, prompt: `Legacy P5 ${i} ______`, options: options(`l${i}`), correct_key: "A", difficulty: 1 + (i % 3), category: "vocabulary", tags: [] })),
  ];
  const fetchImpl = async (url) => {
    const href = String(url);
    urls.push(href);
    if (href.includes("/rpc/")) return { ok: false, status: 404, json: async () => ({ code: "PGRST202" }), text: async () => "" };
    if (href.includes("questions?part=eq.5")) return okJson(bankRows);
    if (href.includes("questions?part=eq.")) return okJson([]);
    if (href.includes("questions?slug=in.(old-1,old-2)")) return okJson(bankRows.slice(0, 2).map((r, i) => ({ ...r, slug: `old-${i + 1}` })));
    if (href.includes("questions?id=in.(")) return okJson(bankRows.slice(2, 3));
    return okJson([]);
  };
  const src = { url: "https://x.supabase.co", key: "k", local, fetchImpl, rng: mulberry32(2) };
  const pool = await examCandidates(src, []);
  assert.equal(pool.origin, "legacy");
  assert.equal(pool.p5.length, 40, "les questions de Supabase (et non les 15 du jeu local) alimentent l'examen");
  assert.ok(urls.filter((u) => u.includes("limit=200")).length >= 1, "lecture bornée");
  const ids = await loadByIds(src, ["old-1", "old-2", bankRows[2].id]);
  assert.deepEqual(ids.questions.map((q) => q.id).sort(), ["old-1", "old-2", bankRows[2].id].sort());
  assert.ok(urls.some((u) => u.includes("slug=in.(old-1,old-2)")));
  // Tout échoue (réseau coupé) : le jeu local prend le relais.
  const offline = await examCandidates({ url: "https://x.supabase.co", key: "k", local, fetchImpl: async () => { throw new Error("hors ligne"); } }, []);
  assert.equal(offline.origin, "local");
});
