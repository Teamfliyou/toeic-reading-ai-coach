import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksFrench, isEnglishContent } from "../server/admin.mjs";

const data = JSON.parse(readFileSync(new URL("../data/questions.json", import.meta.url), "utf8"));

test("seed TOEIC questions and passages are entirely in English", () => {
  const texts = [];
  for (const q of data.questions) texts.push(q.prompt, ...q.options.map((o) => o.text));
  for (const p of data.passages) texts.push(p.title, ...p.documents.flatMap((d) => [d.title, ...d.body]));
  const french = texts.filter(looksFrench);
  assert.deepEqual(french, []);
});

test("looksFrench detects French exam content only", () => {
  assert.equal(looksFrench("La formation inclut une présentation sur la sécurité incendie."), true);
  assert.equal(looksFrench("The training includes a presentation on fire safety."), false);
  assert.equal(looksFrench("scheduled"), false);
});

test("isEnglishContent rejects a French passage", () => {
  const q = [{ prompt: "The report ______ submitted by Friday.", options: [{ text: "must be" }] }];
  const fr = { title: "Note interne", documents: [{ title: "À : Tout le personnel", body: ["Nous vous informons que la formation se déroulera dans l'auditorium."] }] };
  assert.equal(isEnglishContent(q, null), true);
  assert.equal(isEnglishContent(q, fr), false);
});
