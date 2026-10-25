// Importation massive : correspondance des colonnes, validation, regroupement par document,
// puis importation de 10 000 questions de bout en bout (services serveur + SQL réel dans PGlite).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  chunkRows, normalizeRow, parseCorrect, parseDifficulty, parsePart, previewRows, processChunk, suggestMapping,
} from "../server/bank/import.mjs";
import { analyzeImport, cancelImport, importChunk, importIssues, importStatus, listImports, startImport } from "../server/bank/import-service.mjs";
import { mulberry32 } from "../server/bank/text.mjs";
import { createBankDb, fakeSupabase } from "./pg-helper.mjs";

const template = JSON.parse(readFileSync(new URL("../data/import-template.json", import.meta.url), "utf8"));
const numbered = (rows, from = 2) => rows.map((data, i) => ({ n: from + i, data }));

test("colonnes : association automatique en français et en anglais, champs manquants", () => {
  const fr = suggestMapping(["Partie", "Énoncé", "Réponse A", "Réponse B", "Réponse C", "Réponse D", "Bonne réponse", "Niveau", "Catégorie", "Explication", "Colonne inconnue"]);
  assert.deepEqual(fr.missing, []);
  assert.equal(fr.mapping.prompt, "Énoncé");
  assert.equal(fr.mapping.option_c, "Réponse C");
  assert.equal(fr.mapping.correct, "Bonne réponse");
  assert.equal(fr.mapping.difficulty, "Niveau");
  assert.deepEqual(fr.unmapped, ["Colonne inconnue"]);
  const en = suggestMapping(["question", "A", "B", "C", "D", "answer"]);
  assert.deepEqual(en.missing, []);
  assert.equal(en.mapping.option_a, "A");
  assert.equal(en.mapping.correct, "answer");
  const partial = suggestMapping(["question", "A", "B"]);
  assert.deepEqual(partial.missing, ["option_c", "option_d", "correct"]);
  // Le modèle officiel est reconnu intégralement, sans colonne orpheline.
  const own = suggestMapping(template.headers);
  assert.deepEqual([own.missing, own.unmapped], [[], []]);
});

test("valeurs : bonne réponse, difficulté et partie acceptent les formes courantes", () => {
  const options = [{ key: "A", text: "by" }, { key: "B", text: "until" }, { key: "C", text: "since" }, { key: "D", text: "during" }];
  for (const [raw, expected] of [["b", "B"], ["(C)", "C"], [" D. ", "D"], ["2", "B"], ["until", "B"]]) assert.equal(parseCorrect(raw, options).value, expected, raw);
  for (const raw of ["", "E", "A,B", "9", "unknown"]) assert.ok(parseCorrect(raw, options).error, raw);
  assert.equal(parseDifficulty("hard").value, 3);
  assert.equal(parseDifficulty("Facile").value, 1);
  assert.equal(parseDifficulty("").value, 2);
  assert.ok(parseDifficulty("9").error);
  assert.equal(parsePart("Partie 6").value, 6);
  assert.ok(parsePart("6 et 7").error, "formes ambiguës refusées");
  assert.equal(parsePart("6").value, 6);
  assert.equal(parsePart("", 7).value, 7);
  assert.ok(parsePart("8").error);
});

test("modèle téléchargeable : parties 5, 6 et 7 valides, importées sans erreur ni alerte", () => {
  const { mapping } = suggestMapping(template.headers);
  const result = processChunk(numbered(template.rows), mapping);
  assert.deepEqual(result.stats, { rows: 10, rejected: 0, flagged: 0 });
  assert.equal(result.items.length, 10);
  assert.equal(result.issues.length, 0);
  const parts = result.items.reduce((acc, i) => ({ ...acc, [i.part]: (acc[i.part] ?? 0) + 1 }), {});
  assert.deepEqual(parts, { 5: 3, 6: 4, 7: 3 });
  const p6 = result.items.filter((i) => i.part === 6);
  assert.equal(new Set(p6.map((i) => i.passage.key)).size, 1, "les 4 questions partagent un document");
  assert.deepEqual(p6.map((i) => i.question.order_index), [1, 2, 3, 4]);
  const p7 = result.items.filter((i) => i.part === 7);
  assert.equal(p7[0].passage.documents.length, 2, "deux documents pour l'ensemble de la partie 7");
  assert.ok(result.items.every((i) => i.question.lsh.length === 12));
  assert.ok(result.items.every((i) => i.question.needs_review === false));
});

test("rejets : champs manquants, réponse invalide, partie invalide, document absent", () => {
  const { mapping } = suggestMapping(template.headers);
  const base = template.rows[0];
  const rows = numbered([
    { ...base, prompt: "" },
    { ...base, correct: "Z" },
    { ...base, option_b: "" },
    { ...base, part: "9" },
    { ...template.rows[3], doc1_text: "" },
    { ...base, prompt: "The manager reviewed the budget ______ the deadline.", difficulty: "tres difficile" },
  ]);
  const { items, issues, stats } = processChunk(rows, mapping);
  assert.equal(items.length, 0);
  assert.equal(stats.rejected, 6);
  const byCode = issues.map((i) => i.code).sort();
  assert.deepEqual(byCode, ["invalid_answer", "invalid_difficulty", "invalid_part", "missing_field", "missing_field", "missing_passage"]);
  assert.ok(issues.every((i) => i.severity === "error" && /^\d+$/.test(i.ref)), "chaque rejet cite son numéro de ligne");
});

test("doublons : exact dans le fichier (ordre des choix indifférent) et quasi-doublons signalés", () => {
  const { mapping } = suggestMapping(template.headers);
  const a = template.rows[0];
  const shuffled = { ...a, option_a: a.option_d, option_d: a.option_a, correct: "D" };
  const near = { ...a, prompt: "All invoices must be submitted ______ the end of this month.", option_a: "by", external_id: "" };
  const { items, issues, stats } = processChunk(numbered([a, shuffled, near]), mapping);
  assert.equal(items.length, 2);
  assert.equal(stats.rejected, 1);
  assert.ok(issues.some((i) => i.code === "duplicate_in_file" && i.ref === "3"));
  const flagged = items.find((i) => i.ref === 4);
  assert.equal(flagged.question.needs_review, true);
  assert.ok(flagged.question.review_flags.some((f) => f.code === "similar_in_file"));
  assert.equal(stats.flagged, 1);
});

test("documents : un document dont une question est invalide n'est pas importé à moitié", () => {
  const { mapping } = suggestMapping(template.headers);
  const p6 = template.rows.filter((r) => r.part === 6).map((r) => ({ ...r }));
  p6[2].correct = "X"; // ligne invalide → rejetée à la normalisation
  const first = processChunk(numbered(p6), mapping);
  assert.equal(first.items.length, 0, "3 trous sur 4 : incohérent, tout le document est refusé");
  assert.ok(first.issues.some((i) => i.code === "passage_blank_mismatch"));
  const p6bis = template.rows.filter((r) => r.part === 6).map((r) => ({ ...r }));
  p6bis[1].option_a = p6bis[1].option_b; // propositions identiques → rejetée par le contrôle de qualité
  const second = processChunk(numbered(p6bis), mapping);
  assert.equal(second.items.length, 0);
  assert.ok(second.issues.some((i) => i.code === "passage_incomplete"));
  const inconsistent = template.rows.filter((r) => r.part === 7).map((r) => ({ ...r }));
  inconsistent[2].doc1_text = `${inconsistent[2].doc1_text} Extra sentence that changes this document.`;
  inconsistent[2].passage_ref = "P7-WORKSHOP";
  const third = processChunk(numbered(inconsistent), mapping);
  assert.ok(third.items.length <= 2);
});

test("découpage : un document n'est jamais séparé de ses questions", () => {
  const { mapping } = suggestMapping(template.headers);
  const copies = Array.from({ length: 7 }, (_, c) => template.rows.map((r) => ({ ...r, passage_ref: r.passage_ref && `${r.passage_ref}-${c}` })));
  const rows = numbered(copies.flat());
  const chunks = chunkRows(rows, mapping, 12);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 12);
  const refsPerChunk = chunks.map((c) => new Set(c.map((r) => r.data.passage_ref).filter(Boolean)));
  const all = refsPerChunk.flatMap((s) => [...s]);
  // Chaque référence de document n'apparaît que dans un seul bloc.
  for (const ref of new Set(all)) assert.equal(refsPerChunk.filter((s) => s.has(ref)).length, 1, ref);
  assert.equal(chunks.flat().length, rows.length);
});

test("aperçu : 20 premières lignes avec questions normalisées et problèmes", () => {
  const { mapping } = suggestMapping(template.headers);
  const preview = previewRows(template.rows, mapping);
  assert.equal(preview.length, 10);
  assert.ok(preview.every((p) => p.ok));
  const bad = previewRows([{ ...template.rows[0], correct: "?" }], mapping);
  assert.equal(bad[0].ok, false);
  assert.equal(bad[0].row, 2);
  assert.equal(normalizeRow({ ...template.rows[0], tags: "a; B ,c" }, mapping).question.tags.join(), "a,b,c");
});

// --- Importation de bout en bout ---------------------------------------------------------

const WORDS = "manager report budget client invoice meeting schedule contract supplier shipment warehouse delivery customer account proposal agreement department director employee training seminar project deadline quarterly annual revenue profit forecast inventory purchase refund warranty software network printer office conference reception visitor manual policy benefit payroll recruit interview candidate resume salary bonus promotion transfer vacation holiday overtime shift supervisor assistant technician engineer designer analyst auditor consultant".split(" ");
const VERBS = "approved reviewed submitted updated cancelled postponed confirmed revised signed delivered requested completed prepared reported scheduled arranged".split(" ");
const FILLERS = ["promptly", "carefully", "recently", "formally", "annually", "quickly", "regularly", "personally"];

function makeRows(count, seed = 7) {
  const rng = mulberry32(seed);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const rows = [];
  const unique = (i) => `${pick(WORDS)} ${pick(WORDS)} ${i.toString(36)}`;
  const opts = (i) => ["alpha", "bravo", "charlie", "delta"].map((w, k) => `${w}${i}x${k}`);
  const row = (extra) => ({ part: "", passage_ref: "", passage_title: "", doc1_kind: "", doc1_title: "", doc1_text: "", doc2_kind: "", doc2_title: "", doc2_text: "", question_number: "", prompt: "", option_a: "", option_b: "", option_c: "", option_d: "", correct: "", difficulty: "2", category: "vocabulary", theme: "Office", tags: "", explanation: "", ...extra });
  let i = 0;
  while (rows.length < count) {
    i += 1;
    const kind = i % 10;
    if (kind < 8 || count - rows.length < 4) {
      const o = opts(i);
      rows.push(row({
        part: "5", prompt: `The ${pick(WORDS)} ${pick(VERBS)} the ${pick(WORDS)} ${pick(FILLERS)} before the ${unique(i)} ______ ${pick(WORDS)}.`,
        option_a: o[0], option_b: o[1], option_c: o[2], option_d: o[3], correct: "ABCD"[i % 4], difficulty: String(1 + (i % 3)),
        category: ["prepositions", "vocabulary", "verb-tenses", "connectors"][i % 4],
      }));
    } else if (kind === 8) {
      const sentences = [1, 2, 3, 4].map((n) => `The ${pick(WORDS)} ${pick(VERBS)} the ${unique(i * 10 + n)} (${n})______ ${pick(FILLERS)}.`);
      sentences.forEach((s, n) => rows.push(row({
        part: "6", passage_ref: `P6-${i}`, passage_title: `Memo ${i}`, doc1_kind: "memo", doc1_text: sentences.join("\n"),
        question_number: String(n + 1), prompt: s, ...Object.fromEntries(opts(i * 10 + n).map((t, k) => [`option_${"abcd"[k]}`, t])), correct: "ABCD"[(i + n) % 4],
      })));
    } else {
      const text = Array.from({ length: 6 }, (_, n) => `The ${pick(WORDS)} ${pick(VERBS)} the ${unique(i * 7 + n)} and the ${pick(WORDS)} ${pick(VERBS)} ${pick(FILLERS)}.`).join(" ");
      for (let n = 0; n < 3; n += 1) rows.push(row({
        part: "7", passage_ref: `P7-${i}`, passage_title: `Notice ${i}`, doc1_kind: "notice", doc1_text: text,
        question_number: String(n + 1), prompt: `What did the ${pick(WORDS)} ${pick(VERBS)} ${unique(i * 3 + n)}?`,
        ...Object.fromEntries(opts(i * 10 + n).map((t, k) => [`option_${"abcd"[k]}`, t])), correct: "ABCD"[(i + 2 * n) % 4], category: "reading-detail",
      }));
    }
  }
  return rows.slice(0, count);
}

let db;
const originalFetch = globalThis.fetch;
before(async () => {
  db = await createBankDb({ seed: false });
  process.env.SUPABASE_URL = "https://demo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  globalThis.fetch = fakeSupabase(db);
});
after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test("analyse : correspondance suggérée, aperçu et besoin d'une partie par défaut", () => {
  const rows = template.rows.slice(0, 3);
  const res = analyzeImport({ headers: template.headers, rows });
  assert.deepEqual(res.missing, []);
  assert.equal(res.preview.length, 3);
  assert.ok(res.fields.find((f) => f.id === "prompt").required);
  const noPart = analyzeImport({ headers: ["question", "A", "B", "C", "D", "answer"], rows: [{ question: "The cat ______ on the mat today.", A: "sat", B: "sit", C: "sitting", D: "sits", answer: "A" }], defaultPart: 5 });
  assert.equal(noPart.needsDefaultPart, true);
  assert.equal(noPart.preview[0].ok, true);
  const corrected = analyzeImport({ headers: ["question", "A", "B", "C", "D", "answer"], rows: [], mapping: { prompt: "question", option_a: "A", fake: "x" } });
  assert.deepEqual(corrected.mapping, { prompt: "question", option_a: "A" });
  assert.ok(corrected.missing.includes("correct"));
  assert.throws(() => analyzeImport({ headers: [], rows: [] }));
});

test("importation de 10 000 questions : blocs, reprise après coupure, rapport, tout en brouillon", async () => {
  const rows = makeRows(10_000);
  assert.equal(rows.length, 10_000);
  const { mapping } = suggestMapping(template.headers);
  const chunks = chunkRows(numbered(rows), mapping, 250);
  assert.ok(chunks.length >= 40 && chunks.every((c) => c.length <= 250));

  const start = () => startImport({
    filename: "banque.xlsx", format: "xlsx", fingerprint: "a".repeat(32), totalRows: rows.length, chunkSize: 250, chunksTotal: chunks.length, mapping,
  }, "alice");
  const { batch } = await start();
  assert.equal(batch.resumed, false);

  const t0 = performance.now();
  let slowest = 0;
  // Première moitié ; puis « coupure » : l'élève recharge la page et reprend le même fichier.
  const half = Math.floor(chunks.length / 2);
  for (let i = 0; i < half; i += 1) {
    const t = performance.now();
    await importChunk({ batchId: batch.id, chunk: i, rows: chunks[i], mapping }, "alice");
    slowest = Math.max(slowest, performance.now() - t);
  }
  const { batch: resumed } = await start();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.id, batch.id);
  assert.equal(resumed.chunks_done.length, half);
  // Un bloc rejoué (réponse perdue) ne crée aucun doublon.
  const replay = await importChunk({ batchId: batch.id, chunk: 0, rows: chunks[0], mapping }, "alice");
  assert.equal(replay.alreadyDone, true);
  for (let i = half; i < chunks.length; i += 1) {
    const t = performance.now();
    await importChunk({ batchId: batch.id, chunk: i, rows: chunks[i], mapping }, "alice");
    slowest = Math.max(slowest, performance.now() - t);
  }
  const totalMs = performance.now() - t0;

  const status = await importStatus({ batchId: batch.id });
  assert.equal(status.batch.status, "completed");
  assert.equal(status.batch.rows_done, 10_000);
  assert.equal(status.batch.accepted + status.batch.rejected + status.batch.duplicates, 10_000);
  assert.ok(status.batch.accepted >= 9_900, `acceptées : ${status.batch.accepted}`);

  const counts = (await db.query("select status, count(*)::int n from questions group by status")).rows;
  assert.deepEqual(counts.map((c) => c.status), ["draft"], "tout est importé en brouillon");
  assert.equal(counts[0].n, status.batch.accepted);
  const p6 = (await db.query("select passage_id, count(*)::int n from questions where part = 6 group by passage_id")).rows;
  assert.ok(p6.length > 100 && p6.every((r) => r.passage_id && r.n === 4), "chaque document partie 6 garde ses 4 questions");
  const orphans = (await db.query("select count(*)::int n from questions where part in (6, 7) and passage_id is null")).rows[0].n;
  assert.equal(orphans, 0);

  // Aucun bloc ne dure assez longtemps pour poser problème à une fonction serverless.
  assert.ok(slowest < 8000, `bloc le plus lent : ${slowest.toFixed(0)} ms`);
  console.log(`   10 000 lignes : ${(totalMs / 1000).toFixed(1)} s au total, bloc le plus lent ${slowest.toFixed(0)} ms, ${status.batch.accepted} acceptées, ${status.batch.rejected} rejetées, ${status.batch.flagged} à vérifier`);

  const list = await listImports();
  assert.equal(list.batches[0].id, batch.id);
  const issues = await importIssues({ batchId: batch.id, limit: 5 });
  assert.ok(issues.total >= 0 && issues.issues.length <= 5);
});

test("réimportation du même fichier : tout est détecté comme doublon exact, rien n'est inséré", async () => {
  const rows = makeRows(300, 11);
  const { mapping } = suggestMapping(template.headers);
  const run = async (fingerprint) => {
    const chunks = chunkRows(numbered(rows), mapping, 100);
    const { batch } = await startImport({ filename: "second.csv", format: "csv", fingerprint, totalRows: rows.length, chunkSize: 100, chunksTotal: chunks.length, mapping }, "bob");
    for (let i = 0; i < chunks.length; i += 1) await importChunk({ batchId: batch.id, chunk: i, rows: chunks[i], mapping }, "bob");
    return importStatus({ batchId: batch.id });
  };
  const first = await run("b".repeat(32));
  assert.ok(first.batch.accepted > 250);
  const before = (await db.query("select count(*)::int n from questions")).rows[0].n;
  const again = await run("c".repeat(32));
  const after = (await db.query("select count(*)::int n from questions")).rows[0].n;
  assert.equal(after, before, "aucune question dupliquée");
  assert.equal(again.batch.accepted, 0);
  assert.equal(again.batch.duplicates, first.batch.accepted);
  assert.ok(again.issueCounts["error:duplicate_exact"] >= first.batch.accepted);
});

test("quasi-doublon d'une question déjà en base : alerte « à corriger », importée en brouillon", async () => {
  const { mapping } = suggestMapping(template.headers);
  const base = { ...template.rows[0] };
  const variant = { ...base, prompt: "All invoices must be submitted ______ the end of next month.", option_a: "by", external_id: "NEAR-1" };
  const { batch } = await startImport({ filename: "near.csv", format: "csv", fingerprint: "d".repeat(32), totalRows: 2, chunkSize: 50, chunksTotal: 1, mapping }, "alice");
  const res = await importChunk({ batchId: batch.id, chunk: 0, rows: numbered([base, variant]), mapping }, "alice");
  assert.equal(res.inserted, 2);
  const again = await startImport({ filename: "near2.csv", format: "csv", fingerprint: "e".repeat(32), totalRows: 1, chunkSize: 50, chunksTotal: 1, mapping }, "alice");
  const variant2 = { ...base, prompt: "All invoices must be submitted ______ the end of last month.", external_id: "NEAR-2" };
  const res2 = await importChunk({ batchId: again.batch.id, chunk: 0, rows: numbered([variant2]), mapping }, "alice");
  assert.equal(res2.flagged, 1);
  const row = (await db.query("select needs_review, status, review_flags from questions where external_id = 'NEAR-2'")).rows[0];
  assert.equal(row.needs_review, true);
  assert.equal(row.status, "draft");
  assert.ok(row.review_flags.some((f) => f.code === "similar_existing"));
});

test("sécurité de l'import : tailles, types et identifiants refusés avant toute écriture", async () => {
  const { mapping } = suggestMapping(template.headers);
  const ok = { filename: "x.csv", format: "csv", totalRows: 1, chunkSize: 10, chunksTotal: 1, mapping };
  await assert.rejects(startImport({ ...ok, totalRows: 50_000 }, "a"));
  await assert.rejects(startImport({ ...ok, chunkSize: 5000 }, "a"));
  await assert.rejects(startImport({ ...ok, format: "exe" }, "a"));
  await assert.rejects(importChunk({ batchId: "not-a-uuid", chunk: 0, rows: [{ n: 2, data: {} }], mapping }, "a"));
  const { batch } = await startImport({ ...ok, fingerprint: "f".repeat(32) }, "a");
  const big = Array.from({ length: 300 }, (_, i) => ({ n: i + 2, data: { prompt: "x" } }));
  await assert.rejects(importChunk({ batchId: batch.id, chunk: 0, rows: big, mapping }, "a"), "blocs limités à 250 lignes");
  await assert.rejects(importChunk({ batchId: batch.id, chunk: 0, rows: [{ n: 2, data: { prompt: "y".repeat(20_000) } }], mapping }, "a"));
  await cancelImport({ batchId: batch.id });
  await assert.rejects(importChunk({ batchId: batch.id, chunk: 0, rows: [{ n: 2, data: { ...template.rows[0] } }], mapping }, "a"), /annulé/);
});
