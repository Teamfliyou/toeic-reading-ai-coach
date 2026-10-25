// Base Postgres locale (PGlite, WASM) pour tester réellement les migrations SQL et
// les fonctions de la banque d'exercices. Aucun serveur ni réseau requis.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../supabase/${name}`, import.meta.url), "utf8");
// PGlite embarque gen_random_uuid() : pas besoin de l'extension pgcrypto.
const strip = (sql) => sql.replace(/create extension if not exists\s+"?pgcrypto"?;/gi, "");

/** Crée une base avec les rôles Supabase, le schéma de départ, le seed et la migration. */
export async function createBankDb({ seed = true, migrate = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to public;
  `);
  for (const file of ["schema.sql", "questions_slug.sql", "questions_category.sql"]) await db.exec(strip(read(file)));
  if (seed) await db.exec(strip(read("seed.sql")));
  if (migrate) await db.exec(strip(read("question_bank.sql")));
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
