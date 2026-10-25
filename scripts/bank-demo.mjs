// Démonstration locale de la bibliothèque, de l'importation et de la génération massive,
// SANS Supabase ni clé DeepSeek : une base PostgreSQL en mémoire (PGlite) charge la vraie
// migration SQL, et un faux DeepSeek produit des questions de démonstration.
//
//   npm run demo:bank      puis ouvrir http://localhost:4173/#/admin
//   DEMO_BULK=1 npm run demo:bank   ajoute 200 questions publiées (examen complet de 100 questions possible)
//
// Au premier lancement, l'application est compilée dans dist-demo/ avec l'adresse « Supabase »
// pointant sur ce serveur : les écrans élèves (exercices, examen, révision) lisent donc la même
// base en mémoire que l'administration.
//
// L'authentification d'administration est volontairement contournée (compte « demo »,
// rôle admin) : ce script ne doit jamais être exposé sur Internet.
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const strip = (sql) => sql.replace(/create extension if not exists\s+"?pgcrypto"?;/gi, "");

const port = Number(process.env.PORT) || 4173;
const dist = join(root, "dist-demo");
if (!existsSync(join(dist, "index.html")) || process.argv.includes("--rebuild")) {
  console.log("Compilation de l'application de démonstration (dist-demo)…");
  process.env.VITE_SUPABASE_URL = `http://localhost:${port}/supabase`;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "demo-anon-key";
  const { build } = await import("vite");
  await build({ root, logLevel: "warn", build: { outDir: dist, emptyOutDir: true } });
}

const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
for (const f of ["schema.sql", "questions_slug.sql", "questions_category.sql", "seed.sql", "question_bank.sql", "ai_explanations.sql", "ai_hardening.sql"]) {
  await db.exec(strip(read(`supabase/${f}`)));
}

if (process.env.DEMO_BULK) {
  const W = "manager report budget client invoice meeting schedule contract supplier shipment warehouse delivery customer account proposal agreement department director employee training seminar project deadline revenue forecast inventory purchase refund software network printer office conference reception visitor policy payroll".split(" ");
  const V = "approved reviewed submitted updated cancelled postponed confirmed revised signed delivered requested completed".split(" ");
  let r = 5;
  const rnd = () => (r = (r * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pk = (l) => l[Math.floor(rnd() * l.length)];
  const opts = (id) => ["A", "B", "C", "D"].map((key, i) => ({ key, text: `${["by", "until", "since", "during"][i]} ${id}` }));
  const items = [];
  for (let i = 0; i < 150; i += 1) {
    items.push({ ref: i, part: 5, passage: null, question: { prompt: `The ${pk(W)} ${pk(V)} the ${pk(W)} ${pk(W)} ${i} before the ______ ${pk(W)}.`, options: opts(`p5-${i}`), correct_key: "ABCD"[i % 4], difficulty: 1 + (i % 3), category: ["prepositions", "vocabulary", "verb-tenses", "connectors"][i % 4] } });
  }
  for (let d = 0; d < 12; d += 1) {
    const sentences = [1, 2, 3, 4].map((n) => `The ${pk(W)} ${pk(V)} the ${pk(W)} d${d}x${n} (${n})______ ${pk(W)}.`);
    const passage = { key: `p6-${d}`, title: `Memo ${d}`, documents: [{ kind: "memo", title: "To: Staff", body: [sentences.join(" ")] }] };
    sentences.forEach((s2, n) => items.push({ ref: 1000 + d * 10 + n, part: 6, passage, question: { prompt: s2, options: opts(`p6-${d}-${n}`), correct_key: "ABCD"[(d + n) % 4], difficulty: 1 + ((d + n) % 3), category: "vocabulary", order_index: n + 1 } }));
  }
  for (let d = 0; d < 24; d += 1) {
    const size = 2 + (d % 4);
    const text = Array.from({ length: 5 }, (_, n) => `The ${pk(W)} ${pk(V)} the ${pk(W)} d${d}y${n} and the ${pk(W)} ${pk(V)} on time.`).join(" ");
    const docs = [{ kind: "notice", title: "Notice", body: [text] }, ...(d % 3 === 0 ? [{ kind: "email", title: "Reply", body: [`Thank you for the ${pk(W)} d${d}. We ${pk(V)} it ${pk(W)} yesterday afternoon.`] }] : [])];
    const passage = { key: `p7-${d}`, title: `Set ${d}`, documents: docs };
    for (let n = 0; n < size; n += 1) items.push({ ref: 2000 + d * 10 + n, part: 7, passage, question: { prompt: `What did the ${pk(W)} do about d${d}q${n}?`, options: opts(`p7-${d}-${n}`), correct_key: "ABCD"[(d + n) % 4], difficulty: 1 + ((d + n) % 3), category: "reading-detail", order_index: n + 1 } });
  }
  for (let i = 0; i < items.length; i += 100) {
    await db.query("select public.bank_insert_items($1::jsonb, $2::jsonb)", [JSON.stringify(items.slice(i, i + 100)), JSON.stringify({ status: "draft", source: "import", actor: "demo" })]);
  }
  await db.exec("update questions set status = 'published' where status = 'draft'; update passages set status = 'published'");
  console.log(`Banque de démonstration : ${items.length} questions publiées en plus du jeu de départ.`);
}

// --- Faux Supabase (RPC → PGlite) et faux DeepSeek -------------------------------------------
const meta = new Map();
let chain = Promise.resolve();
const describe = async (name) => {
  if (!meta.has(name)) {
    const { rows } = await db.query(
      `select p.proargnames names, (select array_agg(format_type(t, null) order by o) from unnest(p.proargtypes::oid[]) with ordinality u(t, o)) types
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name]);
    meta.set(name, rows[0]);
  }
  return meta.get(name);
};
const expr = (arg, type) => {
  const raw = `(($1::jsonb)->'${arg}')`;
  if (type === "jsonb") return `nullif(${raw}, 'null'::jsonb)`;
  if (type.endsWith("[]")) return `(case when ${raw} is null or jsonb_typeof(${raw}) = 'null' then null else array(select jsonb_array_elements_text(${raw}))::${type} end)`;
  if (type === "text") return `(($1::jsonb)->>'${arg}')`;
  return `(($1::jsonb)->>'${arg}')::${type}`;
};
const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body ?? null), json: async () => body });
async function rpc(name, args) {
  const fn = await describe(name);
  if (!fn) return reply(404, { code: "PGRST202", message: "Could not find the function" });
  const parts = Object.keys(args).map((k) => `${k} => ${expr(k, fn.types[fn.names.indexOf(k)])}`);
  await db.exec("set role service_role");
  try {
    const { rows } = await db.query(`select public.${name}(${parts.join(", ")}) as r`, parts.length ? [JSON.stringify(args)] : []);
    return reply(200, rows[0]?.r);
  } catch (e) {
    return reply(400, { code: e.code, message: e.message });
  } finally {
    await db.exec("reset role");
  }
}

const WORDS = "manager report budget client invoice meeting schedule contract supplier shipment warehouse delivery customer account proposal agreement department director employee training seminar project deadline quarterly annual revenue forecast inventory purchase refund warranty software network printer office conference reception visitor policy payroll recruit interview candidate salary bonus promotion transfer vacation overtime supervisor technician engineer designer analyst auditor consultant".split(" ");
const VERBS = "approved reviewed submitted updated cancelled postponed confirmed revised signed delivered requested completed prepared scheduled arranged".split(" ");
let seq = 0;
const pick = (l) => l[Math.floor(Math.random() * l.length)];
const demoQuestion = (difficulty, prompt) => {
  seq += 1;
  const stem = prompt ?? `The ${pick(WORDS)} ${pick(VERBS)} the ${pick(WORDS)} ${pick(WORDS)} ${seq.toString(36)} before the ______ ${pick(WORDS)} meeting.`;
  return {
    prompt: stem,
    options: ["approved", "approving", "approval", "approve"].map((w, i) => ({ key: "ABCD"[i], text: `${w}${seq}${i}` })),
    correctKey: "A", difficulty, category: "word-forms", theme: "Office",
    explanation: "La phrase exige la forme grammaticale de la proposition correcte dans ce contexte professionnel.",
    optionRationales: { B: "Cette forme ne convient pas à la structure de la phrase.", C: "Ce nom ne peut pas suivre ce mot.", D: "Cette forme verbale est incorrecte ici." },
  };
};
async function fakeDeepSeek(init) {
  const body = JSON.parse(init.body);
  const user = body.messages[1].content;
  await new Promise((r) => setTimeout(r, 700));
  const answer = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 800, completion_tokens: 1500, prompt_cache_hit_tokens: 0 } }), text: async () => "" });
  if (/meticulous English-test reviewer/.test(body.messages[0].content)) {
    const bundle = JSON.parse(user.slice(user.lastIndexOf("\n\n[") + 2));
    return answer({ results: bundle.map((b) => ({ index: b.index, answer: b.options.find((o) => /^approved/.test(o.text))?.key ?? "A", ambiguous: false, note: "" })) });
  }
  const n = Number(user.match(/EXACTLY (\d+)/)[1]);
  const difficulty = Number(user.match(/Difficulty (\d)\/3/)[1]);
  if (/Part 5/.test(user)) return answer({ questions: Array.from({ length: n }, () => demoQuestion(difficulty)) });
  const qpp = /Part 6/.test(user) ? 4 : 3;
  const passages = Array.from({ length: n }, () => {
    const sentences = Array.from({ length: qpp }, (_, i) => `The ${pick(WORDS)} ${pick(VERBS)} the ${pick(WORDS)} ${seq++} (${i + 1})______ ${pick(WORDS)}.`);
    const isP6 = qpp === 4;
    return {
      title: `Notice ${seq}`,
      documents: [{ kind: "notice", title: "Demo", body: [isP6 ? sentences.join(" ") : `${sentences.join(" ")} ${sentences.join(" ").replace(/\(\d\)______/g, "carefully")} The team ${pick(VERBS)} the ${pick(WORDS)} on time for every client in the region.`] }],
      questions: sentences.map((s, i) => demoQuestion(difficulty, isP6 ? s : `What did the ${pick(WORDS)} do ${seq} in step ${i + 1}?`)),
    };
  });
  return answer({ passages });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const href = String(url);
  const m = href.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)$/);
  if (m) {
    const next = chain.then(() => rpc(m[1], JSON.parse(init.body || "{}")));
    chain = next.catch(() => {});
    return next;
  }
  if (href.includes("api.deepseek.com")) return fakeDeepSeek(init);
  if (href.includes("/rest/v1/")) return Promise.resolve(reply(200, []));
  return realFetch(url, init);
};
process.env.SUPABASE_URL = "https://demo.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "demo";
process.env.DEEPSEEK_API_KEY = "sk-demo-key-000000000";
process.env.GEN_JOBS_PER_HOUR = "100";

const { handleBankAction, isBankAction } = await import("../server/bank/api.mjs");

const app = express();
const user = { id: "demo", username: "demo", role: process.env.DEMO_ROLE === "editor" ? "editor" : "admin" };
const send = (res, status, data) => { res.status(status).set("Cache-Control", "no-store").json(data); };
app.all("/api/admin", express.json({ limit: "4mb" }), async (req, res) => {
  const action = String(req.query.action ?? "session");
  if (action === "session") return send(res, 200, { authenticated: true, user, configured: true, needsSetup: false, generationConfigured: true, publicationConfigured: true, bankConfigured: true });
  if (action === "logout") return send(res, 200, { ok: true });
  if (action === "reports") return send(res, 200, { reports: [] });
  if (action === "users") return send(res, 200, { users: [] });
  if (action === "audit") return send(res, 200, { entries: [] });
  if (isBankAction(action)) return handleBankAction(action, { req, res, user, json: (r, s, d) => send(r, s, d), readBody: async (r) => r.body });
  return send(res, 404, { error: "Action absente de la démonstration" });
});
// Adresse « Supabase » des écrans élèves : fonctions publiques de la banque (lecture seule).
app.post("/supabase/rest/v1/rpc/:name", express.json({ limit: "1mb" }), async (req, res) => {
  const name = String(req.params.name);
  if (!/^bank_(pick_questions|pick_passages|exam_candidates|public_counts|questions_by_ids)$/.test(name)) return res.status(404).json({ code: "PGRST202", message: "Could not find the function" });
  const out = await rpc(name, req.body ?? {});
  res.status(out.status).type("json").send(await out.text());
});
app.use("/supabase", (_req, res) => res.status(200).json([]));
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(join(dist, "index.html")));
app.listen(port, "127.0.0.1", () => console.log(`Démo de la bibliothèque : http://localhost:${port}/#/admin  (rôle ${user.role}, base en mémoire)`));
