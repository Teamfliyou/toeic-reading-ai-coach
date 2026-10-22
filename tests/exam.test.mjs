import test from "node:test";
import assert from "node:assert/strict";
import {
  EXAM_DURATION_MS, addTime, buildExam, estimateReadingScore, formatClock, gradeExam,
  newExamState, remainingMs, setAnswer, toggleFlag,
} from "../src/lib/exam.ts";

const q = (id, part, orderIndex, correctKey = "A") => ({ id, part, orderIndex, correctKey });
const questions = [q("p7-b", 7, 2), q("p5-b", 5, 2, "B"), q("p6-a", 6, 1), q("p5-a", 5, 1), q("p7-a", 7, 1), q("l2", 2, 1)];

test("score estimé : bornes 5 et 495, multiples de 5, croissant", () => {
  assert.equal(estimateReadingScore(0, 100), 5);
  assert.equal(estimateReadingScore(100, 100), 495);
  assert.equal(estimateReadingScore(50, 100), 240);
  let previous = 0;
  for (let c = 0; c <= 100; c += 1) {
    const s = estimateReadingScore(c, 100);
    assert.ok(s >= previous && s % 5 === 0 && s >= 5 && s <= 495, `c=${c} s=${s}`);
    previous = s;
  }
});

test("score estimé : extrapolé à 100 quand l'examen est plus court", () => {
  assert.equal(estimateReadingScore(33, 33), 495);
  assert.equal(estimateReadingScore(15, 30), estimateReadingScore(50, 100));
  assert.equal(estimateReadingScore(0, 0), 5);
  assert.equal(estimateReadingScore(200, 100), 495); // valeur aberrante bornée
});

test("buildExam : parties 5 → 6 → 7 dans l'ordre, sans Listening", () => {
  assert.deepEqual(buildExam(questions), ["p5-a", "p5-b", "p6-a", "p7-a", "p7-b"]);
});

test("chronomètre : 75 minutes, décompte, arrêt à la fin", () => {
  const state = newExamState(["a"], 1_000);
  assert.equal(state.deadline - state.startedAt, EXAM_DURATION_MS);
  assert.equal(remainingMs(state, 1_000), 75 * 60_000);
  assert.equal(remainingMs(state, 1_000 + 60_000), 74 * 60_000);
  assert.equal(remainingMs(state, state.deadline + 5000), 0);
  assert.equal(remainingMs({ ...state, finishedAt: 5 }, 2_000), 0);
  assert.equal(formatClock(75 * 60_000), "1:15:00");
  assert.equal(formatClock(59_001), "01:00");
  assert.equal(formatClock(-5), "00:00");
});

test("réponses, marquage « à revoir » et temps cumulé", () => {
  let s = newExamState(["a", "b"], 0);
  s = setAnswer(s, "a", "C");
  s = setAnswer(s, "a", "D"); // changement de réponse
  s = toggleFlag(s, "b");
  assert.deepEqual(s.answers, { a: "D" });
  assert.deepEqual(s.flagged, ["b"]);
  assert.deepEqual(toggleFlag(s, "b").flagged, []);
  s = addTime(addTime(s, "a", 1500), "a", 500);
  assert.equal(s.timeSpent.a, 2000);
  assert.equal(addTime(s, "a", -5), s);
  const done = { ...s, finishedAt: 10 };
  assert.equal(setAnswer(done, "b", "A"), done); // plus de modification après la fin
});

test("gradeExam : bonnes, fausses, non répondues, par partie, score", () => {
  const ids = buildExam(questions);
  let s = newExamState(ids, 0);
  s = setAnswer(s, "p5-a", "A"); // juste
  s = setAnswer(s, "p5-b", "A"); // faux (B attendu)
  s = setAnswer(s, "p7-a", "A"); // juste
  const r = gradeExam(s, questions);
  assert.equal(r.total, 5);
  assert.equal(r.correct, 2);
  assert.equal(r.answered, 3);
  assert.deepEqual(r.wrong, ["p5-b"]);
  assert.deepEqual(r.unanswered, ["p6-a", "p7-b"]);
  assert.deepEqual(r.byPart[5], { total: 2, correct: 1 });
  assert.deepEqual(r.byPart[6], { total: 1, correct: 0 });
  assert.equal(r.reduced, true);
  assert.equal(r.score, estimateReadingScore(2, 5));
});
