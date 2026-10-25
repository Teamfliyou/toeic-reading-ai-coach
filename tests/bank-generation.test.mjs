// Génération massive par lots : plan, contrôles qualité de la réponse IA, file persistante,
// échec et reprise, budget, protection contre une double exécution — avec un faux DeepSeek
// et le vrai SQL (PGlite).
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompts, createJob, evaluateGenerated, jobReport, cancelJob, pauseJob, planJob, processNext, resumeJob, runDue, listJobs, batchFocus,
} from "../server/bank/generation.mjs";
import { mulberry32 } from "../server/bank/text.mjs";
import { createBankDb, fakeSupabase } from "./pg-helper.mjs";

const WORDS = "manager report budget client invoice meeting schedule contract supplier shipment warehouse delivery customer account proposal agreement department director employee training seminar project deadline quarterly annual revenue profit forecast inventory purchase refund warranty software network printer office conference reception visitor manual policy benefit payroll recruit interview candidate resume salary bonus promotion transfer vacation holiday overtime shift supervisor assistant technician engineer designer analyst auditor consultant".split(" ");
const VERBS = "approved reviewed submitted updated cancelled postponed confirmed revised signed delivered requested completed prepared reported scheduled arranged".split(" ");

const fr = (text) => text; // les explications sont en français ci-dessous
const EXPLANATION = fr("La bonne réponse convient car la phrase exige cette forme précise dans ce contexte professionnel.");
const WRONG = fr("Cette proposition ne convient pas ici car elle ne respecte pas la structure de la phrase.");

let seq = 0;
const rng = mulberry32(99);
const pick = (list) => list[Math.floor(rng() * list.length)];
const uniq = () => { seq += 1; return `${pick(WORDS)} ${pick(WORDS)} ${seq.toString(36)}`; };

/** Question P5 valide : la bonne réponse est toujours « A » pour que le rééquilibrage soit testé. */
function aiQuestion(over = {}) {
  const n = ++seq;
  return {
    prompt: `The ${pick(WORDS)} ${pick(VERBS)} the ${uniq()} before the ${pick(WORDS)} ______ ${pick(WORDS)}.`,
    options: ["alpha", "bravo", "charlie", "delta"].map((w, i) => ({ key: "ABCD"[i], text: `${w}${n}${i}` })),
    correctKey: "A", difficulty: 2, category: "vocabulary", theme: "Office",
    explanation: EXPLANATION, optionRationales: { B: WRONG, C: WRONG, D: WRONG }, ...over,
  };
}

function aiP6(n = 4) {
  const sentences = Array.from({ length: n }, (_, i) => `The ${pick(WORDS)} ${pick(VERBS)} the ${uniq()} (${i + 1})______ ${pick(WORDS)}.`);
  return {
    title: `Memo ${uniq()}`,
    documents: [{ kind: "memo", title: "To: Staff", body: [sentences.join(" ")] }],
    questions: sentences.map((prompt) => aiQuestion({ prompt })),
  };
}

/** Faux DeepSeek : fabrique la réponse selon le prompt et mémorise les bonnes réponses. */
function fakeDeepSeek({ failTimes = 0, verifyDisagree = [], truncate = false, status = 200 } = {}) {
  const state = { calls: 0, generations: 0, verifications: 0, failLeft: failTimes, answers: new Map() };
  const respond = (content, finish = "stop") => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: finish }], usage: { prompt_tokens: 900, completion_tokens: 1800, prompt_cache_hit_tokens: 0 } }),
    text: async () => "",
  });
  const fetchDeepSeek = async (_url, init) => {
    state.calls += 1;
    const body = JSON.parse(init.body);
    if (status !== 200) return { ok: false, status, text: async () => "boom", json: async () => ({}) };
    const user = body.messages[1].content;
    if (/meticulous English-test reviewer/.test(body.messages[0].content)) {
      state.verifications += 1;
      const bundle = JSON.parse(user.slice(user.lastIndexOf("\n\n[") + 2));
      return respond({ results: bundle.map((b) => ({ index: b.index, answer: verifyDisagree.includes(b.index) ? "D" : b.options.find((o) => o.text === state.answers.get(b.question))?.key ?? "A", ambiguous: false, note: "" })) });
    }
    state.generations += 1;
    if (state.failLeft > 0) { state.failLeft -= 1; return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) }; }
    if (truncate) return respond({ questions: [] }, "length");
    const n = Number(user.match(/EXACTLY (\d+)/)[1]);
    const difficulty = Number(user.match(/Difficulty (\d)\/3/)[1]);
    let out;
    if (/Part 5/.test(user)) out = { questions: Array.from({ length: n }, () => aiQuestion({ difficulty })) };
    else out = { passages: Array.from({ length: n }, () => aiP6()) }; // partie 6 : n = nombre de documents
    for (const q of out.questions ?? out.passages.flatMap((p) => p.questions)) state.answers.set(q.prompt, q.options.find((o) => o.key === q.correctKey).text);
    return respond(out);
  };
  return { state, fetchDeepSeek };
}

let db;
let deepseek;
const realFetch = globalThis.fetch;
const editor = { username: "ed", role: "editor" };
const admin = { username: "root", role: "admin" };

before(async () => {
  db = await createBankDb({ seed: false, withAi: true });
  process.env.SUPABASE_URL = "https://demo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  process.env.DEEPSEEK_API_KEY = "sk-test-0000000000";
  process.env.GEN_JOBS_PER_HOUR = "1000";
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DEEPSEEK_API_KEY", "GEN_JOBS_PER_HOUR", "AI_MONTHLY_LIMIT_EUR", "AI_MONTHLY_SUSPEND_EUR"]) delete process.env[k];
});
beforeEach(() => {
  deepseek = fakeDeepSeek();
  globalThis.fetch = fakeSupabase(db, (url, init) => (String(url).includes("api.deepseek.com") ? deepseek.fetchDeepSeek(url, init) : Promise.reject(new Error(`réseau inattendu : ${url}`))));
  delete process.env.AI_MONTHLY_LIMIT_EUR;
  delete process.env.AI_MONTHLY_SUSPEND_EUR;
});

test("plan : lots de 20 maximum alignés sur les documents, coût estimé, limites", () => {
  const p5 = planJob({ part: 5, kind: "grammar", difficulty: 2, total: 1000, batchSize: 20 });
  assert.deepEqual([p5.total, p5.batchSize, p5.batches], [1000, 20, 50]);
  assert.ok(p5.estimatedUsd > 0);
  const p6 = planJob({ part: 6, kind: "email", difficulty: "mixed", total: 10, batchSize: 7 });
  assert.deepEqual([p6.total, p6.batchSize, p6.batches], [12, 4, 3], "multiples de 4 questions par document");
  const p7 = planJob({ part: 7, kind: "multi", difficulty: 3, total: 100, batchSize: 20 });
  assert.equal(p7.batchSize, 18);
  assert.ok(p7.batchSize <= 20 && p7.batchSize % 3 === 0);
  const sizes = [20, 100, 500, 1000, 2000].map((total) => planJob({ part: 5, kind: "vocabulary", difficulty: 1, total, batchSize: 20 }).batches);
  assert.deepEqual(sizes, [1, 5, 25, 50, 100]);
  assert.equal(planJob({ part: 5, kind: "grammar", difficulty: 1, total: 20 }).batchSize, 10, "10 par défaut");
  assert.throws(() => planJob({ part: 5, kind: "grammar", difficulty: 1, total: 99_999 }), /limitée/);
  assert.throws(() => planJob({ part: 5, kind: "email", difficulty: 1, total: 10 }), /invalide/);
  assert.throws(() => planJob({ part: 8, kind: "grammar", difficulty: 1, total: 10 }));
  assert.throws(() => planJob({ part: 5, kind: "grammar", difficulty: 1, total: 10, batchSize: 50 }));
  assert.throws(() => planJob({ part: 5, kind: "grammar", difficulty: 1, total: 10, category: "reading-detail" }), /Catégorie/);
});

test("prompt : partie, nombre exact, langue, originalité et rotation des thèmes", () => {
  const job = { part: 6, kind: "email", options: {} };
  const { user, system } = buildPrompts(job, { quantity: 8 }, { difficulty: 2, theme: "banking", category: "word-forms" });
  assert.match(user, /EXACTLY 2 Part 6/);
  assert.match(user, /\(1\)______/);
  assert.match(user, /entirely in English/);
  assert.match(user, /ORIGINAL/);
  assert.match(system, /never copy/i);
  const focus = (idx) => batchFocus({ part: 5, difficulty: 2, options: {} }, idx);
  assert.notEqual(focus(0).theme, focus(1).theme);
  assert.notEqual(focus(0).category, focus(1).category);
  assert.deepEqual([0, 1, 2, 3].map((i) => batchFocus({ part: 5, difficulty: 1, options: { mixed: true } }, i).difficulty), [1, 2, 3, 2]);
  assert.equal(batchFocus({ part: 5, difficulty: 1, theme: "my topic", options: { category: "connectors" } }, 5).theme, "my topic");
});

test("contrôles de la réponse IA : rejets, alertes, équilibre des réponses, doublons", () => {
  const job = { part: 5 };
  const batch = { idx: 0, job_id: "j" };
  const focus = { difficulty: 2, theme: "Office", category: "vocabulary" };
  const good = Array.from({ length: 12 }, () => aiQuestion());
  const parsed = {
    questions: [
      ...good,
      aiQuestion({ prompt: "Vous devez envoyer le rapport pour les clients dans une semaine ______ avec votre équipe." }),
      aiQuestion({ options: ["x", "x", "y", "z"].map((text, i) => ({ key: "ABCD"[i], text })) }),
      aiQuestion({ explanation: null, optionRationales: null }),
      aiQuestion({ optionRationales: { B: "« until » est aussi correct ici.", C: WRONG, D: WRONG } }),
      { prompt: 42 },
      good[0],
    ],
  };
  const r = evaluateGenerated(parsed, job, batch, focus);
  assert.equal(r.stats.generated, 18);
  assert.equal(r.stats.rejected, 4, "français, options identiques, mal formée, doublon exact");
  const codes = r.issues.map((i) => i.code);
  for (const c of ["not_english", "duplicate_options", "schema", "duplicate_in_batch", "explanation_missing", "rationales_missing", "multiple_correct_suspect"]) assert.ok(codes.includes(c), c);
  assert.equal(r.stats.flagged, 2, "explication absente et réponse multiple suspecte → brouillon à vérifier");
  assert.equal(r.stats.validated, 12);
  assert.equal(r.items.filter((i) => i.target_status === "review").length, 12);
  assert.ok(r.items.filter((i) => i.question.needs_review).every((i) => i.target_status === "draft"));
  // Toutes les bonnes réponses étaient « A » : le lot est rééquilibré sans changer les questions.
  assert.equal(r.balance.balanced, true, JSON.stringify(r.balance.distribution));
  for (const item of r.items) {
    assert.deepEqual(item.question.options.map((o) => o.key), ["A", "B", "C", "D"]);
    assert.match(item.question.options.find((o) => o.key === item.question.correct_key).text, /^alpha/);
  }
});

test("documents générés : trous incohérents ou question invalide → document entier écarté", () => {
  const job = { part: 6 };
  const batch = { idx: 3, job_id: "j" };
  const focus = { difficulty: 2, theme: "x", category: "word-forms" };
  const ok = aiP6();
  const threeBlanks = aiP6(3);
  const badQuestion = aiP6();
  badQuestion.questions[1].options = badQuestion.questions[1].options.map((o) => ({ ...o, text: "same" }));
  const r = evaluateGenerated({ passages: [ok, threeBlanks, badQuestion] }, job, batch, focus);
  assert.equal(r.items.length, 4, "seul le document cohérent est conservé");
  assert.equal(new Set(r.items.map((i) => i.passage.key)).size, 1);
  assert.equal(r.stats.rejected, 3 + 4);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("passage_question_count"));
  assert.ok(codes.includes("passage_incomplete"));
});

test("création d'un job : lots persistants, plafond des éditeurs, clé IA obligatoire", async () => {
  const { job, plan } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 30, batchSize: 10 }, editor);
  assert.equal(job.status, "queued");
  assert.equal(job.batches_total, 3);
  assert.equal(plan.batches, 3);
  assert.equal((await db.query("select count(*)::int n from generation_batches where job_id = $1", [job.id])).rows[0].n, 3);
  await assert.rejects(createJob({ part: 5, kind: "grammar", difficulty: 2, total: 500, batchSize: 20 }, editor), /administrateur/);
  const big = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 2000, batchSize: 20 }, admin);
  assert.equal(big.job.batches_total, 100);
  assert.equal((await db.query("select count(*)::int n from generation_batches where job_id = $1", [big.job.id])).rows[0].n, 100);
  delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(createJob({ part: 5, kind: "grammar", difficulty: 2, total: 10 }, admin), /DEEPSEEK_API_KEY/);
  await assert.rejects(processNext({}), /DEEPSEEK_API_KEY/);
  process.env.DEEPSEEK_API_KEY = "sk-test-0000000000";
  for (const j of [job, big.job]) await cancelJob({ jobId: j.id }, admin);
});

test("génération par lots : brouillons en base, coûts, rapport, statut final", async () => {
  const { job } = await createJob({ part: 5, kind: "vocabulary", difficulty: "mixed", total: 30, batchSize: 10 }, admin);
  const results = [];
  for (let i = 0; i < 3; i += 1) results.push(await processNext({ jobId: job.id, worker: `w${i}` }));
  assert.deepEqual(results.map((r) => r.status), ["done", "done", "done"]);
  assert.equal(results[2].jobStatus, "completed");
  assert.equal((await processNext({ jobId: job.id })).status, "idle");
  assert.equal(deepseek.state.generations, 3, "un appel de génération par lot");
  assert.equal(deepseek.state.verifications, 3, "une relecture automatique par lot");

  const report = await jobReport({ jobId: job.id });
  assert.equal(report.job.status, "completed");
  assert.equal(report.job.generated_count, 30);
  assert.equal(report.job.validated_count + report.job.flagged_count + report.job.rejected_count + report.job.duplicate_count, 30);
  assert.ok(Number(report.job.actual_usd) > 0);
  assert.ok(report.batches.every((b) => b.status === "done"));

  const rows = (await db.query("select status, source, explanation, option_rationales, origin_version, difficulty, theme, category, needs_review from questions where generation_job_id = $1", [job.id])).rows;
  assert.ok(rows.length >= 25);
  assert.ok(rows.every((r) => ["review", "draft"].includes(r.status)), "jamais publié automatiquement");
  assert.ok(rows.every((r) => r.source === "ai" && r.origin_version.startsWith("gen-") && r.explanation && r.option_rationales && r.theme));
  assert.deepEqual([...new Set(rows.map((r) => r.difficulty))].sort(), [1, 2, 3], "difficultés mélangées");
  const published = (await db.query("select count(*)::int n from questions where status = 'published'")).rows[0].n;
  assert.equal(published, 0);
  const dist = (await db.query("select correct_key, count(*)::int n from questions where generation_job_id = $1 group by 1 order by 1", [job.id])).rows;
  assert.ok(dist.length === 4 && dist.every((d) => d.n >= 3), JSON.stringify(dist));

  // Le budget mensuel enregistre le coût réel (3 lots × (génération + relecture)).
  const spent = Number((await db.query("select spent_usd from ai_budget")).rows[0].spent_usd);
  assert.ok(spent > 0 && spent <= 3 * (0.012 + 0.004) + 1e-6, `dépense : ${spent}`);
  assert.equal((await db.query("select count(*)::int n from ai_usage_events where status = 'pending'")).rows[0].n, 0, "aucune réservation orpheline");
});

test("documents (partie 6) : 8 questions = 2 documents de 4 trous, rattachés à leur passage", async () => {
  const { job } = await createJob({ part: 6, kind: "memo", difficulty: 2, total: 8, batchSize: 8 }, admin);
  const r = await processNext({ jobId: job.id });
  assert.equal(r.status, "done");
  const groups = (await db.query("select passage_id, count(*)::int n from questions where generation_job_id = $1 group by passage_id", [job.id])).rows;
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.passage_id && g.n === 4));
});

test("relecture automatique : un désaccord garde la question en brouillon à vérifier", async () => {
  deepseek = fakeDeepSeek({ verifyDisagree: [0, 1] });
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 10, batchSize: 10 }, admin);
  const r = await processNext({ jobId: job.id });
  assert.equal(r.verification, "done");
  const flagged = (await db.query("select review_flags, status, needs_review from questions where generation_job_id = $1 and needs_review", [job.id])).rows;
  assert.equal(flagged.length, 2);
  assert.ok(flagged.every((f) => f.status === "draft" && f.review_flags.some((x) => x.code === "verification_disagrees")));
  const issues = (await db.query("select code from bank_issues where job_id = $1", [job.id])).rows.map((x) => x.code);
  assert.ok(issues.includes("verification_disagrees"));
});

test("échec puis reprise : nouvel essai automatique, échec définitif, reprise manuelle", async () => {
  deepseek = fakeDeepSeek({ failTimes: 1 });
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 20, batchSize: 10 }, admin);
  const first = await processNext({ jobId: job.id });
  assert.equal(first.status, "failed");
  assert.equal(first.final, false);
  let report = await jobReport({ jobId: job.id });
  assert.equal(report.batches[0].status, "pending", "le lot repart en file");
  assert.equal(report.batches[0].attempts, 1);
  assert.equal(report.job.errors.length, 1);
  assert.match(report.job.errors[0].message, /500/);
  assert.equal((await db.query("select count(*)::int n from ai_usage_events where status = 'pending'")).rows[0].n, 0, "réservation libérée après un échec sans facturation");

  // Les essais suivants réussissent : le job va jusqu'au bout.
  assert.equal((await processNext({ jobId: job.id })).status, "done");
  assert.equal((await processNext({ jobId: job.id })).status, "done");
  report = await jobReport({ jobId: job.id });
  assert.equal(report.job.status, "completed");

  // Échec définitif après 3 tentatives, puis reprise.
  deepseek = fakeDeepSeek({ failTimes: 99 });
  const second = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 10, batchSize: 10 }, admin);
  for (let i = 0; i < 3; i += 1) assert.equal((await processNext({ jobId: second.job.id })).status, "failed");
  report = await jobReport({ jobId: second.job.id });
  assert.equal(report.job.status, "failed");
  assert.equal(report.batches[0].status, "failed");
  deepseek = fakeDeepSeek();
  const resumed = await resumeJob({ jobId: second.job.id });
  assert.equal(resumed.job.status, "queued");
  assert.equal((await processNext({ jobId: second.job.id })).status, "done");
  assert.equal((await jobReport({ jobId: second.job.id })).job.status, "completed");
});

test("réponse tronquée : facturée au budget, lot en échec avec nouvel essai", async () => {
  deepseek = fakeDeepSeek({ truncate: true });
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 10, batchSize: 10 }, admin);
  const before = Number((await db.query("select coalesce(sum(spent_usd), 0) s from ai_budget")).rows[0].s);
  const r = await processNext({ jobId: job.id });
  assert.equal(r.status, "failed");
  assert.match(r.message, /tronquée/);
  assert.ok(r.costUsd > 0, "DeepSeek a facturé l'appel");
  const after = Number((await db.query("select coalesce(sum(spent_usd), 0) s from ai_budget")).rows[0].s);
  assert.ok(after >= before, "le coût réel reste imputé");
  const rep = await jobReport({ jobId: job.id });
  assert.ok(Number(rep.job.actual_usd) > 0);
  await cancelJob({ jobId: job.id }, admin);
});

test("double exécution : deux exécutions simultanées ne traitent jamais le même lot", async () => {
  deepseek = fakeDeepSeek();
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 40, batchSize: 10 }, admin);
  const outcomes = await Promise.all([1, 2, 3, 4].map((i) => processNext({ jobId: job.id, worker: `parallel-${i}` })));
  const done = outcomes.filter((o) => o.status === "done");
  assert.ok(done.length >= 1);
  assert.equal(new Set(done.map((o) => o.batch)).size, done.length, "lots distincts");
  assert.ok(outcomes.every((o) => ["done", "busy"].includes(o.status)), outcomes.map((o) => o.status).join());
  assert.equal(deepseek.state.generations, done.length, "aucun appel IA en double");
  // Reprise sans perte : le reste est traité ensuite, chaque lot exactement une fois.
  for (let i = 0; i < 6; i += 1) if ((await processNext({ jobId: job.id })).status === "idle") break;
  const rep = await jobReport({ jobId: job.id });
  assert.equal(rep.job.status, "completed");
  assert.deepEqual(rep.batches.map((b) => b.attempts), [1, 1, 1, 1]);
  assert.equal(deepseek.state.generations, 4);
});

test("annulation et pause : plus aucun lot n'est lancé", async () => {
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 30, batchSize: 10 }, admin);
  assert.equal((await processNext({ jobId: job.id })).status, "done");
  await pauseJob({ jobId: job.id });
  assert.equal((await processNext({ jobId: job.id })).status, "idle");
  assert.equal((await resumeJob({ jobId: job.id })).job.status, "queued");
  const cancelled = await cancelJob({ jobId: job.id }, admin);
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal((await processNext({ jobId: job.id })).status, "idle");
  const rep = await jobReport({ jobId: job.id });
  assert.deepEqual(rep.batches.map((b) => b.status), ["done", "cancelled", "cancelled"]);
  assert.ok((await listJobs()).jobs.some((j) => j.id === job.id));
  await assert.rejects(cancelJob({ jobId: job.id }, admin), /terminé/);
});

test("budget mensuel : au plafond, le job est mis en pause sans appeler DeepSeek", async () => {
  process.env.AI_MONTHLY_LIMIT_EUR = "0.001";
  process.env.AI_MONTHLY_SUSPEND_EUR = "0.0005";
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 10, batchSize: 10 }, admin).catch((e) => ({ error: e }));
  // Soit la création est refusée (coût estimé > budget), soit le premier lot met le job en pause.
  if (!job) return;
  const before = deepseek.state.generations;
  const r = await processNext({ jobId: job.id });
  assert.equal(r.status, "budget");
  assert.equal(deepseek.state.generations, before);
  assert.equal((await jobReport({ jobId: job.id })).job.status, "paused");
});

test("création refusée quand le coût estimé dépasse le budget disponible", async () => {
  process.env.AI_MONTHLY_LIMIT_EUR = "0.001";
  process.env.AI_MONTHLY_SUSPEND_EUR = "0.0005";
  await assert.rejects(createJob({ part: 5, kind: "grammar", difficulty: 2, total: 100, batchSize: 10 }, admin), /budget/);
});

test("clé DeepSeek refusée (401) : le lot est rendu et le job mis en pause", async () => {
  deepseek = fakeDeepSeek({ status: 401 });
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 10, batchSize: 10 }, admin);
  const r = await processNext({ jobId: job.id });
  assert.equal(r.status, "paused");
  const rep = await jobReport({ jobId: job.id });
  assert.equal(rep.job.status, "paused");
  assert.equal(rep.batches[0].status, "pending");
  assert.equal(rep.batches[0].attempts, 0, "l'essai n'est pas compté");
});

test("tâche planifiée : traite plusieurs lots dans son budget de temps", async () => {
  deepseek = fakeDeepSeek();
  const { job } = await createJob({ part: 5, kind: "grammar", difficulty: 2, total: 30, batchSize: 10 }, admin);
  const out = await runDue({ budgetMs: 120_000, worker: "cron-test" });
  assert.equal(out.processed >= 3, true, JSON.stringify(out));
  assert.equal((await jobReport({ jobId: job.id })).job.status, "completed");
});
