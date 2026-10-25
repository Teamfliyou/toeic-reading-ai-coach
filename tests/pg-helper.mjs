// Base Postgres locale (PGlite, WASM) pour tester réellement les migrations SQL et
// les fonctions de la banque d'exercices. Aucun serveur ni réseau requis.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../supabase/${name}`, import.meta.url), "utf8");
// PGlite embarque gen_random_uuid() : pas besoin de l'extension pgcrypto.
const strip = (sql) => sql.replace(/create extension if not exists\s+"?pgcrypto"?;/gi, "");

/** Crée une base avec les rôles Supabase, le schéma de départ, le seed et la migration. */
export async function createBankDb({ seed = true, migrate = true, withAi = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  for (const file of ["schema.sql", "questions_slug.sql", "questions_category.sql"]) await db.exec(strip(read(file)));
  if (seed) await db.exec(strip(read("seed.sql")));
  if (migrate) await db.exec(strip(read("question_bank.sql")));
  // Tables de quotas et de budget IA (partagées avec les explications).
  if (withAi) for (const file of ["ai_explanations.sql", "ai_hardening.sql"]) await db.exec(strip(read(file)));
  return db;
}

export const runMigration = (db) => db.exec(strip(read("question_bank.sql")));

/** Exécute une fonction/requête en simulant un rôle Supabase (RLS appliquée). */
export async function asRole(db, role, fn) {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

/**
 * `fetch` simulé qui répond comme PostgREST à `POST /rest/v1/rpc/<fonction>` en exécutant la
 * vraie fonction SQL dans PGlite (rôle service_role). Permet de tester les services serveur
 * de bout en bout, SQL compris. Les autres URL sont transmises à `fallback`.
 */
export function fakeSupabase(db, fallback = async () => { throw new Error("fetch non simulé"); }) {
  const meta = new Map();
  let chain = Promise.resolve();
  const describe = async (name) => {
    if (meta.has(name)) return meta.get(name);
    const { rows } = await db.query(
      `select p.proargnames as names, (select array_agg(format_type(t, null) order by o) from unnest(p.proargtypes::oid[]) with ordinality u(t, o)) as types
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name]);
    meta.set(name, rows[0] ?? null);
    return rows[0] ?? null;
  };
  const expr = (arg, type) => {
    const raw = `(($1::jsonb)->'${arg}')`;
    if (type === "jsonb") return `nullif(${raw}, 'null'::jsonb)`;
    if (type.endsWith("[]")) return `(case when ${raw} is null or jsonb_typeof(${raw}) = 'null' then null else array(select jsonb_array_elements_text(${raw}))::${type} end)`;
    if (type === "text") return `(($1::jsonb)->>'${arg}')`;
    return `(($1::jsonb)->>'${arg}')::${type}`;
  };
  const respond = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    json: async () => body,
  });
  const run = async (name, args) => {
    const fn = await describe(name);
    if (!fn) return respond(404, { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` });
    const names = fn.names ?? [];
    const parts = Object.keys(args).map((k) => {
      const i = names.indexOf(k);
      if (i < 0) throw new Error(`argument inconnu ${k} pour ${name}`);
      return `${k} => ${expr(k, fn.types[i])}`;
    });
    await db.exec("set role service_role");
    try {
      const { rows } = await db.query(`select public.${name}(${parts.join(", ")}) as r`, parts.length ? [JSON.stringify(args)] : []);
      return respond(200, rows[0]?.r ?? null);
    } catch (error) {
      return respond(400, { code: error.code ?? "XX000", message: error.message });
    } finally {
      await db.exec("reset role");
    }
  };
  const fetchImpl = (url, init = {}) => {
    const href = String(url);
    const match = href.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)$/);
    if (!match) return fallback(url, init);
    const next = chain.then(() => run(match[1], JSON.parse(init.body || "{}")));
    chain = next.catch(() => {});
    return next;
  };
  fetchImpl.calls = [];
  return fetchImpl;
}
