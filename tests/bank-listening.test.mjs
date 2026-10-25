// Listening centralisé : migration SQL, import en masse, tirage, repli sur le JSON actuel.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importListening, normalizeListeningRow } from "../server/bank/listening.mjs";
import { handleBankAction } from "../server/bank/api.mjs";
import { mapListeningRow, pickListening } from "../src/lib/bank/listeningPick.ts";
import { buildListeningSeedSql } from "../scripts/generate-listening-sql.mjs";
import { createBankDb, fakeSupabase } from "./pg-helper.mjs";
import { makeReq, makeRes, parseBody } from "./helpers.mjs";

const local = JSON.parse(readFileSync(new URL("../data/listening.json", import.meta.url), "utf8"));
const localItems = local.part2;
const strip = (sql) => sql.replace(/create extension if not exists\s+"?pgcrypto"?;/gi, "");

let db;
const realFetch = globalThis.fetch;
before(async () => {
  db = await createBankDb({ seed: false });
  await db.exec(strip(readFileSync(new URL("../supabase/listening_bank.sql", import.meta.url), "utf8")));
  process.env.SUPABASE_URL = "https://demo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  globalThis.fetch = fakeSupabase(db);
});
import { after } from "node:test";
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const row = (over = {}) => ({ prompt: "When does the new accountant start working here?", option_a: "On the second floor.", option_b: "Next Monday, I think.", option_c: "She has ten years of experience.", correct: "B", difficulty: "2", category: "listening-wh", ...over });

test("migration du Listening : script idempotent, 12 exercices du JSON repris, publiés, sans audio inventé", async () => {
  const seed = buildListeningSeedSql(local);
  await db.exec(strip(seed));
  await db.exec(strip(seed)); // relance : aucun doublon
  const { rows } = await db.query("select count(*)::int n, count(*) filter (where status = 'published')::int p, count(track_id)::int t, min(slug) s from listening_items");
  assert.deepEqual(rows[0], { n: 12, p: 12, t: 0, s: "l2-01" });
  assert.equal((await db.query("select count(*)::int n from listening_tracks")).rows[0].n, 0, "aucune piste fabriquée");
  const item = (await db.query("select * from listening_items where slug = 'l2-01'")).rows[0];
  assert.equal(item.correct_key, "B");
  assert.match(item.transcript, /When does the new accountant start working here\? A\./);
  assert.equal(item.source, "json");
});

test("fichier local : le seed est identique au contenu de data/listening.json (check:data)", () => {
  const onDisk = readFileSync(new URL("../supabase/listening_seed.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(onDisk, buildListeningSeedSql(local));
});

test("RLS : les élèves ne lisent que les exercices publiés ; l'administration est fermée", async () => {
  await db.exec("insert into listening_items (prompt, options, correct_key, status) values ('Draft question here today?', '[{\"key\":\"A\",\"text\":\"a1\"},{\"key\":\"B\",\"text\":\"b1\"},{\"key\":\"C\",\"text\":\"c1\"}]', 'A', 'draft')");
  await db.exec("set role anon");
  const visible = (await db.query("select count(*)::int n from listening_items")).rows[0].n;
  const denied = await db.query("select public.listening_admin_list()").then(() => "ok", (e) => e.message);
  const write = await db.query("insert into listening_items (prompt, options, correct_key) values ('x', '[]', 'A')").then(() => "ok", (e) => e.message);
  await db.exec("reset role");
  assert.equal(visible, 12, "le brouillon reste invisible");
  assert.match(denied, /permission denied/);
  assert.match(write, /row-level security|permission denied/);
});

test("tirage : paginé, inédits d'abord, catégorie filtrable, piste audio jointe", async () => {
  await db.exec("insert into listening_tracks (audio_url, duration_ms) values ('https://cdn.example.com/part2/l2-01.mp3', 4200); update listening_items set track_id = (select id from listening_tracks limit 1) where slug = 'l2-01'");
  const src = { url: "https://demo.supabase.co", key: "anon", local: localItems, fetchImpl: fakeSupabase(db) };
  const set = await pickListening(src, { limit: 5 });
  assert.equal(set.origin, "bank");
  assert.equal(set.items.length, 5);
  assert.ok(set.items.every((i) => i.part === 2 && i.options.length === 3));
  const seen = set.items.map((i) => i.id);
  const next = await pickListening(src, { limit: 5, exclude: seen });
  assert.equal(next.items.filter((i) => seen.includes(i.id)).length, 0);
  const wh = await pickListening(src, { limit: 12, category: "listening-wh" });
  assert.ok(wh.items.length > 0 && wh.items.every((i) => i.category === "listening-wh"));
  const all = await pickListening(src, { limit: 12 });
  assert.equal(all.items.find((i) => i.id === "l2-01").audio, "https://cdn.example.com/part2/l2-01.mp3");
  assert.equal(all.items.find((i) => i.id === "l2-02").audio, undefined, "sans enregistrement : synthèse du navigateur");
});

test("repli : Supabase inaccessible, non migré ou vide → les 12 exercices du fichier, dans l'ordre", async () => {
  const down = { url: "https://x.supabase.co", key: "k", local: localItems, fetchImpl: async () => { throw new Error("réseau"); } };
  const a = await pickListening(down);
  assert.equal(a.origin, "local");
  assert.deepEqual(a.items.map((i) => i.id), localItems.map((i) => i.id));
  const missing = await pickListening({ ...down, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(missing.origin, "local");
  const empty = await pickListening({ ...down, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) });
  assert.equal(empty.origin, "local");
  assert.equal((await pickListening({ url: "", key: "", local: localItems })).origin, "local");
  assert.equal(mapListeningRow({ slug: "x", prompt: "Hi there?", options: [{ key: "A", text: "a" }], correct_key: "A" }), null, "ligne mal formée ignorée");
  assert.equal(mapListeningRow({ slug: "x", prompt: "Hi there?", options: [{ key: "A", text: "a" }, { key: "B", text: "b" }, { key: "C", text: "c" }], correct_key: "A", audio_url: "javascript:alert(1).mp3" }).audio, undefined, "URL audio non conforme ignorée");
});

test("validation d'une ligne : réponses, langue, URL audio, catégorie, doublons de réponses", () => {
  assert.equal(normalizeListeningRow(row()).errors.length, 0);
  const ok = normalizeListeningRow(row({ audio_url: "https://cdn.example.com/a.mp3" }));
  assert.equal(ok.warnings.length, 0);
  assert.equal(normalizeListeningRow(row()).warnings[0].code, "no_audio");
  assert.match(normalizeListeningRow(row()).item.transcript, /A\. On the second floor/);
  const codes = (r) => [...r.errors, ...r.warnings].map((e) => e.code);
  assert.ok(codes(normalizeListeningRow(row({ correct: "D" }))).includes("schema"));
  assert.ok(codes(normalizeListeningRow(row({ option_c: "" }))).includes("schema"));
  assert.ok(codes(normalizeListeningRow(row({ audio_url: "http://insecure.example.com/a.mp3" }))).includes("schema"));
  assert.ok(codes(normalizeListeningRow(row({ audio_url: "https://x.example.com/a.exe" }))).includes("schema"));
  assert.ok(codes(normalizeListeningRow(row({ prompt: "Quand le nouveau comptable commence-t-il à travailler pour vous ici ?" }))).includes("not_english"));
  assert.ok(codes(normalizeListeningRow(row({ option_a: "same", option_b: "Same", option_c: "other" }))).includes("duplicate_options"));
  assert.ok(codes(normalizeListeningRow(row({ category: "prepositions" }))).includes("unknown_category"));
  assert.equal(normalizeListeningRow(row({ correct: "(b)" })).item.correct_key, "B");
  assert.equal(normalizeListeningRow(row({ correct: "2" })).item.correct_key, "B");
});

test("import en masse : brouillons, rejets expliqués, doublons ignorés, lot rejouable sans effet", async () => {
  const rows = [
    row({ prompt: "Where is the printer paper stored in this office?", option_a: "In the supply room.", option_b: "Yes, I printed it.", option_c: "About twenty pages.", correct: "A", category: "listening-wh", audio_url: "https://cdn.example.com/part2/new-1.mp3" }),
    row({ prompt: "Could you send me the updated budget today?", option_a: "Sure, I'll do it now.", option_b: "At the bank downtown.", option_c: "It was very expensive.", correct: "A", category: "listening-request" }),
    row({ correct: "Z" }),
    row({ prompt: "Quand commence la formation de tous les employés dans les locaux ?" }),
    ...localItems.slice(0, 1).map((i) => ({ prompt: i.prompt, option_a: i.options[0].text, option_b: i.options[1].text, option_c: i.options[2].text, correct: i.correctKey, category: i.category })),
  ];
  const first = await importListening({ rows }, "ed");
  assert.equal(first.inserted, 2);
  assert.equal(first.rejected, 2);
  assert.equal(first.duplicates, 1, "déjà dans la bibliothèque (migration)");
  assert.ok(first.issues.some((i) => i.ref === "3" && i.severity === "error"));
  const states = (await db.query("select status, needs_review, source from listening_items where prompt like 'Where is the printer%' or prompt like 'Could you send me%' order by prompt")).rows;
  assert.deepEqual(states.map((s) => [s.status, s.source]), [["draft", "import"], ["draft", "import"]]);
  assert.deepEqual(states.map((s) => s.needs_review), [true, false], "sans enregistrement : à vérifier");
  const again = await importListening({ rows }, "ed");
  assert.equal(again.inserted, 0, "lot rejoué : aucune création");
  assert.equal(again.duplicates, 3);
  assert.equal((await db.query("select count(*)::int n from listening_tracks where audio_url like '%new-1.mp3'")).rows[0].n, 1);
  await assert.rejects(importListening({ rows: [] }, "ed"));
  await assert.rejects(importListening({ rows: Array.from({ length: 300 }, () => row()) }, "ed"));
});

test("publication : un brouillon à vérifier exige une confirmation explicite", async () => {
  const user = { id: "u", username: "ed", role: "editor" };
  const call = async (action, body) => {
    const res = makeRes();
    await handleBankAction(action, { req: makeReq({ body }), res, user, json: (r, s, d) => { r.statusCode = s; r.body = JSON.stringify(d); }, readBody: async (r) => r.body });
    return { status: res.statusCode, body: parseBody(res) };
  };
  const list = await call("bank-listening-list", { status: "draft" });
  assert.equal(list.status, 200);
  const flagged = list.body.rows.find((r) => r.needs_review && /Could you send me/.test(r.prompt));
  assert.ok(flagged);
  const refused = await call("bank-listening-status", { ids: [flagged.id], status: "published" });
  assert.equal(refused.body.changed, 0);
  assert.equal(refused.body.skipped[0].reason, "needs_review");
  const ok = await call("bank-listening-status", { ids: [flagged.id], status: "published", ack: true });
  assert.equal(ok.body.changed, 1);
  const bad = await call("bank-listening-status", { ids: ["nope"], status: "published" });
  assert.equal(bad.status, 400);
});
