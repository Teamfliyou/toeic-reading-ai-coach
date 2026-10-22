import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateDataset } from "../scripts/check-data.mjs";

const load = () => JSON.parse(readFileSync(new URL("../data/questions.json", import.meta.url), "utf8"));
const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
const has = (errors, text) => errors.some((e) => e.includes(text));

test("le jeu de données réel est valide et le seed synchronisé", () => {
  assert.deepEqual(validateDataset(load(), { seedSql }), []);
});

test("détecte id en double, choix manquant et bonne réponse invalide", () => {
  const d = load();
  d.questions[1].id = d.questions[0].id;
  d.questions[2].options.pop();
  d.questions[3].correctKey = "E";
  const errors = validateDataset(d);
  assert.ok(has(errors, "id en double"));
  assert.ok(has(errors, "exactement 4 choix"));
  assert.ok(has(errors, "correctKey « E » invalide"));
});

test("détecte une incohérence de partie, un passage manquant et un blanc absent", () => {
  const d = load();
  const p6 = d.questions.find((q) => q.part === 6);
  p6.passageId = "inconnu";
  const p7 = d.questions.find((q) => q.part === 7);
  p7.part = 6; // question 6 rattachée à un passage de partie 7
  const p5 = d.questions.find((q) => q.part === 5);
  p5.prompt = "Sentence without blank.";
  const errors = validateDataset(d);
  assert.ok(has(errors, "introuvable"));
  assert.ok(has(errors, "≠ partie du passage"));
  assert.ok(has(errors, "doit contenir un blanc"));
});

test("détecte des réponses déséquilibrées et un seed désynchronisé", () => {
  const d = load();
  for (const q of d.questions) {
    const from = q.options.find((o) => o.key === q.correctKey);
    const to = q.options.find((o) => o.key === "A");
    [from.text, to.text] = [to.text, from.text];
    q.correctKey = "A";
  }
  const errors = validateDataset(d, { seedSql });
  assert.ok(has(errors, "déséquilibrées"));
  assert.ok(has(errors, "n'est pas synchronisé"));
});

test("les bonnes réponses du jeu réel sont équilibrées (aucune lettre > 40 %)", () => {
  const d = load();
  const counts = {};
  for (const q of d.questions) counts[q.correctKey] = (counts[q.correctKey] ?? 0) + 1;
  for (const [key, n] of Object.entries(counts)) assert.ok(n / d.questions.length <= 0.4, key);
});
