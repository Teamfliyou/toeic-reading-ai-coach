// Migration des données : ajoute `category` et `tags` aux questions existantes
// de data/questions.json. Idempotent : relançable sans effet de bord.
// Usage : node scripts/tag-questions.mjs   (puis npm run seed:generate)
import { readFileSync, writeFileSync } from "node:fs";

const TAGS = {
  "q5-01": ["passive-modals", "modal passive"],
  "q5-02": ["verb-patterns", "gerund"],
  "q5-03": ["verb-tenses", "conditional"],
  "q5-04": ["word-forms", "adverb"],
  "q5-05": ["prepositions", "time"],
  "q5-06": ["subject-verb-agreement", "neither-nor"],
  "q5-07": ["connectors", "cause"],
  "q5-08": ["passive-modals", "passive"],
  "q5-09": ["prepositions", "place"],
  "q5-10": ["connectors", "concession"],
  "q5-11": ["word-forms", "participle"],
  "q5-12": ["clauses", "that-clause"],
  "q5-13": ["verb-tenses", "conditional"],
  "q5-14": ["vocabulary", "collocation"],
  "q5-15": ["prepositions", "verb+preposition"],
  "q6-1-1": ["word-forms", "participle"],
  "q6-1-2": ["subject-verb-agreement", "present simple"],
  "q6-1-3": ["vocabulary", "collocation"],
  "q6-1-4": ["verb-patterns", "subjunctive"],
  "q6-2-1": ["verb-tenses", "future"],
  "q6-2-2": ["connectors", "cause"],
  "q6-2-3": ["word-forms", "adverb"],
  "q6-2-4": ["passive-modals", "passive"],
  "q7-1-1": ["reading-purpose", "email"],
  "q7-1-2": ["reading-detail", "email"],
  "q7-1-3": ["reading-inference", "email"],
  "q7-2-1": ["reading-detail", "schedule"],
  "q7-2-2": ["reading-detail", "schedule"],
  "q7-2-3": ["reading-detail", "schedule"],
  "q7-3-1": ["reading-detail", "multi-document"],
  "q7-3-2": ["reading-cross", "multi-document"],
  "q7-3-3": ["reading-cross", "multi-document"],
  "q7-3-4": ["reading-detail", "multi-document"],
};

const path = new URL("../data/questions.json", import.meta.url);
const data = JSON.parse(readFileSync(path, "utf8"));
let changed = 0;
for (const q of data.questions) {
  const entry = TAGS[q.id];
  if (!entry) continue;
  const [category, ...tags] = entry;
  if (q.category !== category || JSON.stringify(q.tags) !== JSON.stringify(tags)) changed += 1;
  q.category = category;
  q.tags = tags;
}
writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
console.log(`${changed} question(s) mise(s) à jour.`);
