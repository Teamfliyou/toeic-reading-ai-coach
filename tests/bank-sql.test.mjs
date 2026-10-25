// Tests de la migration SQL de la banque sur un vrai Postgres (PGlite) :
// statuts, RLS, doublons, historique, importation reprenable, file de génération,
// tirage aléatoire paginé, publication et suppression contrôlée.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createBankDb, runMigration, asRole } from "./pg-helper.mjs";

let db;
before(async () => { db = await createBankDb(); });

const j = (v) => JSON.stringify(v);
const rpc = async (sql, ...params) => (await db.query(`select ${sql} as r`, params)).rows[0].r;
const opts = (texts) => texts.map((text, i) => ({ key: "ABCD"[i], text }));
const p5 = (n, extra = {}) => ({
  ref: n, part: 5, passage: null,
  question: {
    prompt: `Item ${n}: the manager reviewed the proposal number ${n} before the ______ meeting.`,
    options: opts([`alpha${n}`, `beta${n}`, `gamma${n}`, `delta${n}`]), correct_key: "A", difficulty: 2,
    category: "vocabulary", ...extra,
  },
});
const passageItem = (key, n, qs = 4, part = 6) => ({
  key, title: `Memo ${key}`,
  qs: Array.from({ length: qs }, (_, i) => ({
    ref: n * 10 + i, part,
    passage: { key, title: `Memo ${key}`, documents: [{ kind: "memo", title: `Doc ${key}`, body: [`Body of ${key} with (1)______ blank.`] }] },
    question: { prompt: `Blank ${i + 1} of ${key}`, options: opts(["w", "x", "y", "z"].map((c) => `${c}${key}${i}`)), correct_key: "B", difficulty: 2, order_index: i + 1 },
  })),
});
const insert = (items, ctx = {}) => rpc("public.bank_insert_items($1::jsonb, $2::jsonb)", j(items), j({ status: "draft", source: "import", actor: "tester", ...ctx }));

test("migration : idempotente, données existantes conservées et publiées", async () => {
  await runMigration(db); // deuxième exécution
  const r = (await db.query("select count(*)::int n, count(*) filter (where status='published')::int p, count(content_hash)::int h, count(published_at)::int d from questions")).rows[0];
  assert.deepEqual(r, { n: 33, p: 33, h: 33, d: 33 });
  const q = (await db.query("select slug, version, source from questions where slug = 'q5-01'")).rows[0];
  assert.deepEqual(q, { slug: "q5-01", version: 1, source: "manual" });
});

test("RLS : un élève ne voit ni les brouillons ni les questions en validation", async () => {
  const res = await insert([p5(1)]);
  assert.equal(res.inserted, 1);
  const anon = await asRole(db, "anon", async () => (await db.query("select count(*)::int n from questions where status in ('draft','review')")).rows[0].n);
  assert.equal(anon, 0);
  const total = await asRole(db, "anon", async () => (await db.query("select count(*)::int n from questions")).rows[0].n);
  assert.equal(total, 33);
  const direct = await asRole(db, "anon", async () => db.query("insert into questions (part, prompt, options, correct_key) values (5, 'x', '[]', 'A')").then(() => "ok", (e) => e.message));
  assert.match(direct, /row-level security|permission denied/);
  const admin = await asRole(db, "anon", async () => db.query("select count(*) from import_batches").then(() => "ok", (e) => e.message));
  assert.match(admin, /permission denied/);
});

test("insertion : identifiant stable, empreinte, doublon exact refusé (ordre des choix indifférent)", async () => {
  const first = (await db.query("select slug, content_hash, status, source, created_by from questions where prompt like 'Item 1:%'")).rows[0];
  assert.match(first.slug, /^q5-[0-9a-f]{12}$/);
  assert.equal(first.content_hash.length, 64);
  assert.deepEqual([first.status, first.source, first.created_by], ["draft", "import", "tester"]);
  const shuffled = p5(1);
  shuffled.question.options = [...shuffled.question.options].reverse();
  const again = await insert([shuffled, p5(2)]);
  assert.equal(again.duplicates, 1);
  assert.equal(again.inserted, 1);
  assert.equal(again.results[0].outcome, "duplicate");
  assert.equal(again.results[0].existing_slug, first.slug);
});

test("passages : un document et ses 4 questions restent liés, un passage identique est réutilisé", async () => {
  const a = passageItem("alpha", 1);
  const res = await insert(a.qs);
  assert.equal(res.inserted, 4);
  const rows = (await db.query("select distinct passage_id from questions where prompt like 'Blank % of alpha'")).rows;
  assert.equal(rows.length, 1);
  const second = await insert(passageItem("alpha", 2).qs); // même document, mêmes questions
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 4);
  assert.equal((await db.query("select count(*)::int n from passages where title = 'Memo alpha'")).rows[0].n, 1);
});

test("historique : chaque modification crée une révision et incrémente la version", async () => {
  const id = (await db.query("select id from questions where prompt like 'Item 2:%'")).rows[0].id;
  const upd = await rpc("public.bank_update_question($1::uuid, $2::jsonb, 1, 'alice')", id, j({ explanation: "Parce que.", difficulty: 3 }));
  assert.equal(upd.version, 2);
  assert.equal(upd.updated_by, "alice");
  const revs = (await db.query("select version, change_type, changed_by, snapshot->>'difficulty' d from question_revisions where question_id = $1", [id])).rows;
  assert.deepEqual(revs, [{ version: 1, change_type: "edit", changed_by: "alice", d: "2" }]);
  await assert.rejects(rpc("public.bank_update_question($1::uuid, $2::jsonb, 1, 'bob')", id, j({ difficulty: 1 })), /version_conflict/);
  await assert.rejects(rpc("public.bank_update_question($1::uuid, $2::jsonb, null, 'bob')", id, j({ options: [] })), /Quatre propositions/);
  // Éditer vers le contenu d'une autre question est refusé.
  const other = (await db.query("select prompt, options from questions where prompt like 'Item 1:%'")).rows[0];
  await assert.rejects(rpc("public.bank_update_question($1::uuid, $2::jsonb, null, 'bob')", id, j({ prompt: other.prompt, options: other.options })), /duplicate_content/);
});

test("statuts : publication individuelle/multiple, confirmation des questions à vérifier, archivage", async () => {
  const flagged = await insert([p5(3, { needs_review: true, review_flags: [{ code: "suspect" }] })]);
  const id = flagged.results[0].id;
  let r = await rpc("public.bank_set_status(array[$1::uuid], 'published', 'alice', false)", id);
  assert.equal(r.changed, 0);
  assert.equal(r.skipped[0].reason, "needs_review");
  r = await rpc("public.bank_set_status(array[$1::uuid], 'published', 'alice', true)", id);
  assert.equal(r.changed, 1);
  const row = (await db.query("select status, needs_review, published_at from questions where id = $1", [id])).rows[0];
  assert.equal(row.status, "published");
  assert.equal(row.needs_review, false);
  assert.ok(row.published_at);
  // Une question publiée ne repasse pas en brouillon : on l'archive.
  r = await rpc("public.bank_set_status(array[$1::uuid], 'draft', 'alice', false)", id);
  assert.equal(r.skipped[0].reason, "archive_first");
  r = await rpc("public.bank_set_status(array[$1::uuid], 'archived', 'alice', false)", id);
  assert.equal(r.changed, 1);
  // Archivée mais toujours lisible (historique d'élève conservé).
  const visible = await asRole(db, "anon", async () => (await db.query("select count(*)::int n from questions where id = $1", [id])).rows[0].n);
  assert.equal(visible, 1);
  await assert.rejects(rpc("public.bank_set_status(array[$1::uuid], 'oops', 'a', false)", id), /Statut invalide/);
});

test("publication d'un passage : le document devient visible avec ses questions", async () => {
  const ids = (await db.query("select id from questions where prompt like 'Blank % of alpha'")).rows.map((x) => x.id);
  const before = await asRole(db, "anon", async () => (await db.query("select count(*)::int n from passages where title = 'Memo alpha'")).rows[0].n);
  assert.equal(before, 0);
  const r = await rpc("public.bank_set_status($1::uuid[], 'published', 'alice', false)", ids);
  assert.equal(r.changed, 4);
  const after = await asRole(db, "anon", async () => (await db.query("select count(*)::int n from passages where title = 'Memo alpha'")).rows[0].n);
  assert.equal(after, 1);
});

test("suppression contrôlée : jamais les questions déjà publiées ou archivées", async () => {
  const draft = (await db.query("select id from questions where prompt like 'Item 1:%'")).rows[0].id;
  const published = (await db.query("select id from questions where slug = 'q5-01'")).rows[0].id;
  const r = await rpc("public.bank_delete_questions(array[$1::uuid, $2::uuid], 'alice')", draft, published);
  assert.equal(r.deleted, 1);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["was_published"]);
  assert.equal((await db.query("select count(*)::int n from questions where id = $1", [published])).rows[0].n, 1);
  const rev = (await db.query("select change_type from question_revisions where question_id = $1", [draft])).rows.map((x) => x.change_type);
  assert.ok(rev.includes("delete"), "la suppression est conservée dans l'historique");
});

test("importation : reprise du même fichier, bloc rejoué sans doublon, annulation", async () => {
  const start = (fp) => rpc("public.bank_import_start('q.csv', 'csv', $1, 400, 200, 2, '{}'::jsonb, 'alice')", fp);
  const b = await start("fp-1");
  assert.equal(b.resumed, false);
  const items = [p5(100), p5(101)];
  const c1 = await rpc("public.bank_import_commit($1::uuid, 0, $2::jsonb, $3::jsonb, $4::jsonb, 'alice')", b.id, j(items), j([{ ref: "7", severity: "error", code: "missing_field", message: "Énoncé manquant" }]), j({ rows: 3, rejected: 1, flagged: 0 }));
  assert.equal(c1.inserted, 2);
  assert.equal(c1.batch.status, "processing");
  // Le bloc 0 rejoué (coupure réseau) n'insère rien de plus.
  const replay = await rpc("public.bank_import_commit($1::uuid, 0, $2::jsonb, '[]'::jsonb, $3::jsonb, 'alice')", b.id, j(items), j({ rows: 3 }));
  assert.equal(replay.already_done, true);
  const resumed = await start("fp-1");
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.id, b.id);
  assert.deepEqual(resumed.chunks_done, [0]);
  const c2 = await rpc("public.bank_import_commit($1::uuid, 1, $2::jsonb, '[]'::jsonb, $3::jsonb, 'alice')", b.id, j([p5(102), p5(100)]), j({ rows: 2 }));
  assert.equal(c2.batch.status, "completed");
  assert.equal(c2.batch.accepted, 3);
  assert.equal(c2.batch.duplicates, 1);
  assert.equal(c2.batch.rejected, 1);
  const issues = (await db.query("select code, severity from bank_issues where import_batch_id = $1 order by id", [b.id])).rows.map((x) => x.code);
  assert.deepEqual(issues.sort(), ["duplicate_exact", "missing_field"]);
  const c = await start("fp-2");
  await rpc("public.bank_import_cancel($1::uuid)", c.id);
  await assert.rejects(rpc("public.bank_import_commit($1::uuid, 0, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'a')", c.id), /annulé/);
});

test("tirage aléatoire : paginé, filtré, sans doublon, questions vues en dernier recours", async () => {
  await db.exec(`insert into questions (part, prompt, options, correct_key, difficulty, category, status)
    select 5, 'Bulk question ' || g || ' with unique wording ' || md5(g::text), jsonb_build_array(
      jsonb_build_object('key','A','text','a' || g), jsonb_build_object('key','B','text','b' || g),
      jsonb_build_object('key','C','text','c' || g), jsonb_build_object('key','D','text','d' || g)),
      'A', 1 + g % 3, case when g % 2 = 0 then 'prepositions' else 'connectors' end, 'published'
    from generate_series(1, 600) g`);
  const pick = (...a) => rpc("public.bank_pick_questions($1, $2, $3, $4, null, $5::text[], $6)", ...a);
  const res = await pick(5, 20, null, null, "{}", 0.5);
  assert.equal(res.questions.length, 20);
  assert.equal(new Set(res.questions.map((q) => q.id)).size, 20);
  assert.ok(res.questions.every((q) => q.part === 5 && q.passage_id === null));
  const wrap = await pick(5, 20, null, null, "{}", 0.99999); // en fin d'index : retour au début
  assert.equal(wrap.questions.length, 20);
  const hard = await pick(5, 30, 3, "prepositions", "{}", 0.2);
  assert.ok(hard.questions.length > 0 && hard.questions.every((q) => q.difficulty === 3 && q.category === "prepositions"));
  const seen = res.questions.map((q) => q.slug);
  const next = await pick(5, 20, null, null, `{${seen.join(",")}}`, 0.5);
  assert.equal(next.questions.filter((q) => seen.includes(q.slug)).length, 0, "les questions inédites passent d'abord");
  // Banque épuisée : on complète avec des questions déjà vues plutôt que de renvoyer moins.
  const all = (await db.query("select slug from questions where status='published' and part=5 and passage_id is null")).rows.map((x) => x.slug);
  const exhausted = await pick(5, 10, null, null, `{${all.join(",")}}`, 0.3);
  assert.equal(exhausted.questions.length, 10);
  const p = await rpc("public.bank_pick_questions(5, 100000)");
  assert.equal(p.questions.length, 200, "plafonné à 200 par appel");
});

test("tirage de passages : seuls les documents entièrement publiés, avec toutes leurs questions", async () => {
  const partial = passageItem("partial", 9);
  const res = await insert(partial.qs);
  const ids = res.results.map((x) => x.id);
  await rpc("public.bank_set_status($1::uuid[], 'published', 'a', false)", ids.slice(0, 3)); // 3 sur 4 seulement
  let r = await rpc("public.bank_pick_passages(6, 50)");
  assert.ok(!r.passages.some((p) => p.title === "Memo partial"), "passage incomplet exclu");
  await rpc("public.bank_set_status($1::uuid[], 'published', 'a', false)", ids.slice(3));
  r = await rpc("public.bank_pick_passages(6, 50)");
  const found = r.passages.find((p) => p.title === "Memo partial");
  assert.ok(found);
  assert.equal(r.questions.filter((q) => q.passage_id === found.id).length, 4);
  r = await rpc("public.bank_pick_passages(6, 50, null, null, null, '{}', null, 5, 5)");
  assert.equal(r.passages.length, 0, "filtre sur le nombre de questions par document");
  const cand = await rpc("public.bank_exam_candidates('{}', 0.4)");
  assert.ok(Array.isArray(cand.p5) && cand.p5.length === 90);
  assert.ok(cand.p6.passages.length >= 2);
});

test("liste d'administration : pagination, filtres, recherche texte, statistiques", async () => {
  const list = (f, l = 25, o = 0) => rpc("public.bank_admin_list($1::jsonb, $2, $3)", j(f), l, o);
  const page1 = await list({ part: 5, status: "published" }, 25, 0);
  assert.ok(page1.total > 600);
  assert.equal(page1.rows.length, 25);
  const page2 = await list({ part: 5, status: "published" }, 25, 25);
  assert.equal(page2.rows.length, 25);
  assert.ok(!page1.rows.some((r) => page2.rows.some((s) => s.id === r.id)), "pages disjointes");
  assert.ok(!("lsh" in page1.rows[0]) && !("search_vec" in page1.rows[0]));
  const cat = await list({ category: "prepositions", difficulty: 2, status: "published" }, 100);
  assert.ok(cat.rows.every((r) => r.category === "prepositions" && r.difficulty === 2));
  const text = await list({ q: "proposal" }, 50);
  assert.ok(text.rows.length >= 1 && text.rows.every((r) => /proposal/i.test(r.prompt)));
  const bySlug = await list({ q: "q5-01" });
  assert.ok(bySlug.rows.some((r) => r.slug === "q5-01"));
  assert.equal((await list({}, 1000)).rows.length, 100, "page plafonnée à 100");
  const stats = await rpc("public.bank_admin_stats()");
  assert.ok(stats.total > 600 && stats.by_status.published > 600);
  assert.ok(stats.by_part_status["5:published"] > 600);
});

test("doublons et similarités : candidats LSH, groupes de doublons actifs", async () => {
  const lsh = Array.from({ length: 12 }, (_, i) => 1000 + i);
  await insert([p5(500, { lsh })]);
  const sim = await rpc("public.bank_find_similar_many($1::jsonb)", j([{ i: 0, part: 5, lsh: [5, 1003, 99] }, { i: 1, part: 5, lsh: [-1] }]));
  assert.equal(sim[0].candidates.length, 1);
  assert.match(sim[0].candidates[0].prompt, /Item 500/);
  assert.equal(sim[1].candidates.length, 0);
  const groups = await rpc("public.bank_duplicate_groups(10, 0)");
  assert.equal(groups.total, 0); // l'index unique empêche tout doublon actif
});

test("file de génération : lots, bail exclusif, jeton, reprise, annulation", async () => {
  const create = (total, actor = "alice", max = 5) => rpc("public.gen_create_job($1::jsonb, $2, $3)", j({ part: 5, kind: "grammar", difficulty: 2, theme: "Office", total, batch_size: 20, estimated_usd: 0.5 }), actor, max);
  const job = await create(50);
  assert.equal(job.batches_total, 3);
  const batches = (await db.query("select idx, quantity from generation_batches where job_id = $1 order by idx", [job.id])).rows;
  assert.deepEqual(batches.map((b) => b.quantity), [20, 20, 10]);

  const c1 = await rpc("public.gen_claim_batch($1::uuid, 120, 'w1')", job.id);
  const c2 = await rpc("public.gen_claim_batch($1::uuid, 120, 'w2')", job.id);
  assert.notEqual(c1.batch.id, c2.batch.id, "deux exécutions ne prennent jamais le même lot");
  assert.equal(c1.batch.idx, 0);
  assert.equal(c1.job.status, "running");
  assert.ok(!("lease_token" in c1.batch), "le jeton n'est pas dans la ligne du lot");

  // Commit : jeton incorrect refusé ; bon jeton accepté ; second commit idempotent.
  const items = [{ ...p5(900), target_status: "review" }, { ...p5(901), target_status: "draft", question: { ...p5(901).question, needs_review: true } }];
  const stats = { generated: 3, validated: 1, flagged: 1, rejected: 1, cost_usd: 0.004 };
  await assert.rejects(rpc("public.gen_commit_batch($1::uuid, gen_random_uuid(), $2::jsonb, '[]'::jsonb, $3::jsonb)", c1.batch.id, j(items), j(stats)), /lease_lost/);
  const done = await rpc("public.gen_commit_batch($1::uuid, $2::uuid, $3::jsonb, $4::jsonb, $5::jsonb)", c1.batch.id, c1.token, j(items), j([{ ref: "2", severity: "error", code: "french", message: "Français" }]), j(stats));
  assert.equal(done.inserted, 2);
  const states = (await db.query("select status, needs_review, source, generation_job_id from questions where prompt like 'Item 90_:%' order by prompt")).rows;
  assert.deepEqual(states.map((s) => s.status), ["review", "draft"]);
  assert.ok(states.every((s) => s.source === "ai" && s.generation_job_id === job.id));
  const again = await rpc("public.gen_commit_batch($1::uuid, $2::uuid, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)", c1.batch.id, c1.token);
  assert.equal(again.already_done, true);
  let jb = (await db.query("select * from generation_jobs where id = $1", [job.id])).rows[0];
  assert.equal(jb.generated_count, 3);
  assert.equal(Number(jb.actual_usd), 0.004);
  assert.equal(jb.validated_count, 1);
  assert.equal(jb.flagged_count, 1);
  assert.equal(jb.rejected_count, 1);

  // Échec avec nouvel essai, puis échec définitif après 3 tentatives ; coût facturé conservé.
  let f = await rpc("public.gen_fail_batch($1::uuid, $2::uuid, 'JSON invalide', 0.002, true)", c2.batch.id, c2.token);
  assert.equal(f.final, false);
  for (let i = 0; i < 2; i += 1) {
    const c = await rpc("public.gen_claim_batch($1::uuid, 120, 'w3')", job.id);
    assert.equal(c.batch.idx, 1);
    f = await rpc("public.gen_fail_batch($1::uuid, $2::uuid, 'JSON invalide', 0.002, true)", c.batch.id, c.token);
  }
  assert.equal(f.final, true);
  const c3 = await rpc("public.gen_claim_batch($1::uuid, 120, 'w3')", job.id);
  assert.equal(c3.batch.idx, 2);
  await rpc("public.gen_commit_batch($1::uuid, $2::uuid, '[]'::jsonb, '[]'::jsonb, $3::jsonb)", c3.batch.id, c3.token, j({ generated: 0, cost_usd: 0 }));
  jb = (await db.query("select * from generation_jobs where id = $1", [job.id])).rows[0];
  assert.equal(jb.status, "completed");
  assert.equal(jb.batches_done, 2);
  assert.equal(jb.batches_failed, 1);
  assert.equal(Number(jb.actual_usd), 0.01);
  assert.equal(jb.errors.length, 3);
  assert.equal(await rpc("public.gen_claim_batch($1::uuid)", job.id), null);

  // Reprise : le lot en échec repart.
  const resumed = await rpc("public.gen_resume_job($1::uuid)", job.id);
  assert.equal(resumed.status, "queued");
  const c4 = await rpc("public.gen_claim_batch($1::uuid, 120, 'w4')", job.id);
  assert.equal(c4.batch.idx, 1);
  assert.equal(c4.batch.attempts, 1);

  // Annulation : les lots en attente sont annulés.
  const j2 = await create(40);
  const cancelled = await rpc("public.gen_cancel_job($1::uuid, 'alice')", j2.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(await rpc("public.gen_claim_batch($1::uuid)", j2.id), null);
  assert.equal((await db.query("select count(*)::int n from generation_batches where job_id = $1 and status = 'cancelled'", [j2.id])).rows[0].n, 2);

  // Pause / reprise.
  const j3 = await create(20);
  await rpc("public.gen_pause_job($1::uuid, true)", j3.id);
  assert.equal(await rpc("public.gen_claim_batch($1::uuid)", j3.id), null);
  await rpc("public.gen_pause_job($1::uuid, false)", j3.id);
  assert.ok(await rpc("public.gen_claim_batch($1::uuid)", j3.id));
});

test("file de génération : bail expiré repris par une autre exécution, plafond de jobs par heure", async () => {
  const job = await rpc("public.gen_create_job($1::jsonb, 'bob', 2)", j({ part: 5, kind: "grammar", difficulty: 1, total: 20, batch_size: 20 }));
  const c1 = await rpc("public.gen_claim_batch($1::uuid, 120, 'dead-worker')", job.id);
  await db.query("update generation_batches set lease_until = now() - interval '1 minute' where id = $1", [c1.batch.id]);
  const c2 = await rpc("public.gen_claim_batch($1::uuid, 120, 'live-worker')", job.id);
  assert.equal(c2.batch.id, c1.batch.id);
  assert.equal(c2.batch.attempts, 2);
  // L'exécution morte ne peut plus rien enregistrer (jeton périmé).
  await assert.rejects(rpc("public.gen_commit_batch($1::uuid, $2::uuid, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)", c1.batch.id, c1.token), /lease_lost/);
  await rpc("public.gen_create_job($1::jsonb, 'bob', 2)", j({ part: 5, kind: "grammar", difficulty: 1, total: 20, batch_size: 20 }));
  await assert.rejects(rpc("public.gen_create_job($1::jsonb, 'bob', 2)", j({ part: 5, kind: "grammar", difficulty: 1, total: 20, batch_size: 20 })), /rate_limit/);
});

test("passage modifié : l'empreinte des questions suit, droits des fonctions d'administration", async () => {
  const pid = (await db.query("select id from passages where title = 'Memo partial'")).rows[0].id;
  const before = (await db.query("select content_hash from questions where passage_id = $1 limit 1", [pid])).rows[0].content_hash;
  await rpc("public.bank_update_passage($1::uuid, 'Memo partial', $2::jsonb, 'alice')", pid, j([{ kind: "memo", title: "Changed", body: ["New body (1)______"] }]));
  const after = (await db.query("select content_hash from questions where passage_id = $1 limit 1", [pid])).rows[0].content_hash;
  assert.notEqual(before, after);
  for (const call of ["public.bank_admin_stats()", "public.bank_set_status(array[]::uuid[], 'draft', 'x')", "public.gen_claim_batch()"]) {
    const msg = await asRole(db, "anon", () => db.query(`select ${call}`).then(() => "ok", (e) => e.message));
    assert.match(msg, /permission denied/, call);
  }
  const ok = await asRole(db, "anon", async () => (await db.query("select public.bank_public_counts() as c")).rows[0].c);
  assert.ok(ok.by_part["5"] >= 600);
});

test("volume : 20 000 questions, tirage et liste restent rapides", async () => {
  // Chargement en masse : triggers suspendus (empreinte fournie) pour ne mesurer que les lectures.
  await db.exec("alter table questions disable trigger trg_bank_questions_biu");
  await db.exec(`insert into questions (part, prompt, options, correct_key, difficulty, category, status, content_hash)
    select 5, 'Volume question ' || g || ' ' || md5(g::text), jsonb_build_array(
      jsonb_build_object('key','A','text','a' || g), jsonb_build_object('key','B','text','b' || g),
      jsonb_build_object('key','C','text','c' || g), jsonb_build_object('key','D','text','d' || g)),
      'A', 1 + g % 3, (array['prepositions','connectors','vocabulary','verb-tenses'])[1 + g % 4], 'published', md5('v' || g)
    from generate_series(1, 20000) g`);
  await db.exec("alter table questions enable trigger trg_bank_questions_biu");
  await db.exec("analyze questions");
  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) {
    const r = await rpc("public.bank_pick_questions(5, 20, 2, 'vocabulary')");
    assert.equal(r.questions.length, 20);
  }
  const pickMs = (performance.now() - t0) / 20;
  const t1 = performance.now();
  const page = await rpc(`public.bank_admin_list('{"part":5,"status":"published"}'::jsonb, 25, 5000)`);
  const listMs = performance.now() - t1;
  assert.ok(page.total >= 20000 && page.rows.length === 25);
  assert.ok(pickMs < 400, `tirage trop lent : ${pickMs.toFixed(0)} ms`);
  assert.ok(listMs < 2000, `liste trop lente : ${listMs.toFixed(0)} ms`);
});
