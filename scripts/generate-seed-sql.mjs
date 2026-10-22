import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function stableUuid(str) {
  const h = createHash("sha1").update(str).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  }${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const esc = (s) => String(s).replace(/'/g, "''");
const sqlTextArray = (items) =>
  items?.length ? `array[${items.map((t) => `'${esc(t)}'`).join(", ")}]::text[]` : "'{}'::text[]";

/** Construit le contenu de supabase/seed.sql à partir du jeu de données. */
export function buildSeedSql(data) {
  const lines = [
    "-- Seed Supabase généré automatiquement depuis data/questions.json (npm run seed:generate)",
    "-- Exécutez-le après supabase/schema.sql (et supabase/questions_slug.sql puis supabase/questions_category.sql sur une base existante).",
    "-- Idempotent : peut être relancé ; les IDs sont stables (hash), `slug` garde l'identifiant lisible.",
    "",
  ];

  for (const p of data.passages) {
    const id = stableUuid(p.id);
    const docs = JSON.stringify(p.documents).replace(/'/g, "''");
    lines.push(
      `insert into passages (id, part, title, documents) values ('${id}', ${p.part}, '${esc(p.title)}', '${docs}') ` +
        "on conflict (id) do update set part = excluded.part, title = excluded.title, documents = excluded.documents;"
    );
  }

  for (const q of data.questions) {
    const id = stableUuid(q.id);
    const passageId = q.passageId ? `'${stableUuid(q.passageId)}'` : "null";
    const options = JSON.stringify(q.options).replace(/'/g, "''");
    lines.push(
      `insert into questions (id, slug, category, tags, part, passage_id, order_index, prompt, options, correct_key, difficulty) values ('${id}', '${esc(q.id)}', ${q.category ? `'${esc(q.category)}'` : "null"}, ${sqlTextArray(q.tags)}, ${q.part}, ${passageId}, ${q.orderIndex}, '${esc(q.prompt)}', '${options}', '${q.correctKey}', ${q.difficulty}) ` +
        "on conflict (id) do update set slug = excluded.slug, category = excluded.category, tags = excluded.tags, part = excluded.part, passage_id = excluded.passage_id, order_index = excluded.order_index, prompt = excluded.prompt, options = excluded.options, correct_key = excluded.correct_key, difficulty = excluded.difficulty;"
    );
  }

  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = JSON.parse(
    readFileSync(new URL("../data/questions.json", import.meta.url), "utf8")
  );
  writeFileSync(new URL("../supabase/seed.sql", import.meta.url), buildSeedSql(data));
  console.log("supabase/seed.sql généré.");
}
