import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

function stableUuid(str) {
  const h = createHash("sha1").update(str).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  }${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const data = JSON.parse(
  readFileSync(new URL("../data/questions.json", import.meta.url), "utf8")
);

const esc = (s) => String(s).replace(/'/g, "''");
const lines = [
  "-- Seed Supabase généré automatiquement depuis data/questions.json",
  "-- Exécutez-le après supabase/schema.sql (IDs stables via hash).",
  "",
];

for (const p of data.passages) {
  const id = stableUuid(p.id);
  const docs = JSON.stringify(p.documents).replace(/'/g, "''");
  lines.push(
    `insert into passages (id, part, title, documents) values ('${id}', ${p.part}, '${esc(p.title)}', '${docs}');`
  );
}

for (const q of data.questions) {
  const id = stableUuid(q.id);
  const passageId = q.passageId ? `'${stableUuid(q.passageId)}'` : "null";
  const options = JSON.stringify(q.options).replace(/'/g, "''");
  lines.push(
    `insert into questions (id, part, passage_id, order_index, prompt, options, correct_key, difficulty) values ('${id}', ${q.part}, ${passageId}, ${q.orderIndex}, '${esc(q.prompt)}', '${options}', '${q.correctKey}', ${q.difficulty});`
  );
}

writeFileSync(new URL("../supabase/seed.sql", import.meta.url), lines.join("\n") + "\n");
console.log("supabase/seed.sql généré.");
