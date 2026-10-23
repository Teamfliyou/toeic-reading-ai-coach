import test from "node:test";
import assert from "node:assert/strict";
import {
  activeWords, createWord, dueWords, exampleFromPrompt, markDeleted, mergeWords,
  normalizeTerm, reviewWord, validateWord,
} from "../src/lib/vocab.ts";
import { INTERVAL_DAYS } from "../src/lib/srs.ts";

const DAY = 86_400_000;
const t0 = new Date("2026-10-01T10:00:00Z");
const word = (over = {}) => ({ ...createWord({ term: "leaving", meaning: "partir", example: "" }, "w1", t0), ...over });

test("validateWord : nettoie, borne et exige le mot et son sens", () => {
  const ok = validateWord({ term: "  cost-effective  ", meaning: " rentable ", example: "" }, []);
  assert.deepEqual([ok.ok, ok.value.term, ok.value.meaning], [true, "cost-effective", "rentable"]);
  assert.equal(validateWord({ term: "", meaning: "x" }, []).ok, false);
  assert.match(validateWord({ term: "word", meaning: "  " }, []).error, /sens/);
  const long = validateWord({ term: "x".repeat(200), meaning: "y".repeat(900), example: "z".repeat(900) }, []);
  assert.equal(long.value.term.length, 80);
  assert.equal(long.value.meaning.length, 300);
  assert.equal(long.value.example.length, 300);
});

test("validateWord : refuse un doublon (casse et espaces ignorés) sauf si supprimé", () => {
  const existing = [word({ term: "Cost-Effective" })];
  assert.match(validateWord({ term: " cost-effective ", meaning: "x" }, existing).error, /déjà/);
  assert.equal(validateWord({ term: "cost-effective", meaning: "x" }, [markDeleted(existing[0])]).ok, true);
  assert.equal(normalizeTerm("  ÉCOLE "), "école");
});

test("un nouveau mot est à réviser tout de suite, en boîte 1", () => {
  const w = word();
  assert.equal(w.box, 1);
  assert.deepEqual(dueWords([w], t0).map((x) => x.id), ["w1"]);
});

test("réviser : « je savais » fait monter de boîte avec le délai Leitner, « à revoir » repart en boîte 1", () => {
  let w = reviewWord(word(), true, t0);
  assert.equal(w.box, 2);
  assert.equal(Date.parse(w.due) - t0.getTime(), INTERVAL_DAYS[1] * DAY);
  assert.deepEqual(dueWords([w], t0), []);
  const later = new Date(t0.getTime() + 3 * DAY);
  w = reviewWord(w, true, later);
  assert.equal(w.box, 3);
  w = reviewWord(w, false, new Date(later.getTime() + 5 * DAY));
  assert.equal(w.box, 1);
  assert.equal(w.lapses, 1);
});

test("maîtrise après la boîte 5 ; un mot supprimé n'est plus proposé", () => {
  let w = word({ box: 5 });
  w = reviewWord(w, true, t0);
  assert.equal(w.mastered, true);
  assert.deepEqual(dueWords([w], new Date(t0.getTime() + 999 * DAY)), []);
  const gone = markDeleted(word(), t0);
  assert.deepEqual(dueWords([gone], t0), []);
  assert.deepEqual(activeWords([gone, word({ id: "w2" })]).map((x) => x.id), ["w2"]);
});

test("mergeWords : la version la plus récente gagne, la suppression se propage", () => {
  const a = word({ updatedAt: "2026-10-02T00:00:00Z", meaning: "ancien" });
  const b = word({ updatedAt: "2026-10-03T00:00:00Z", meaning: "récent" });
  assert.equal(mergeWords([a], [b])[0].meaning, "récent");
  const deleted = markDeleted(a, new Date("2026-10-05T00:00:00Z"));
  assert.equal(mergeWords([deleted], [b])[0].deleted, true);
  assert.equal(mergeWords([a], [word({ id: "w9", term: "other" })]).length, 2);
});

test("exampleFromPrompt : remplace le blanc par la bonne réponse", () => {
  assert.equal(exampleFromPrompt("Despite ______ late, the train arrived.", "leaving"), "Despite leaving late, the train arrived.");
  assert.equal(exampleFromPrompt("The training (2)______ a presentation.", "includes"), "The training includes a presentation.");
  assert.equal(exampleFromPrompt("The report must be ______.", "filed"), "The report must be filed.");
  assert.equal(exampleFromPrompt("What is the main purpose of the email?", "x"), "");
});
