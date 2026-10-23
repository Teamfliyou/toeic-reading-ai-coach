import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GOALS, answeredToday, buildPlan, daysUntil, latestExamScore, validateGoals,
} from "../src/lib/goals.ts";

const now = new Date("2026-10-10T09:00:00");
const goals = (over = {}) => ({ ...DEFAULT_GOALS, ...over });

test("validateGoals : accepte une saisie cohérente, borne les valeurs", () => {
  const ok = validateGoals({ examDate: "2026-12-15", targetScore: "400", dailyGoal: "15" }, now);
  assert.deepEqual(ok.value, { examDate: "2026-12-15", targetScore: 400, dailyGoal: 15 });
  assert.deepEqual(validateGoals({}, now).value, { examDate: null, targetScore: null, dailyGoal: 10 });
  assert.equal(validateGoals({ examDate: "2026-10-10" }, now).ok, true); // aujourd'hui accepté
});

test("validateGoals : refuse date passée/invalide, score hors bornes, objectif absurde", () => {
  assert.match(validateGoals({ examDate: "2026-10-09" }, now).error, /aujourd'hui ou plus tard/);
  assert.match(validateGoals({ examDate: "2026-02-30" }, now).error, /invalide/);
  assert.match(validateGoals({ examDate: "demain" }, now).error, /invalide/);
  assert.match(validateGoals({ targetScore: 500 }, now).error, /entre 5 et 495/);
  assert.match(validateGoals({ targetScore: 12.5 }, now).error, /entre 5 et 495/);
  assert.match(validateGoals({ dailyGoal: 0 }, now).error, /entre 1 et 200/);
  assert.match(validateGoals({ dailyGoal: 1000 }, now).error, /entre 1 et 200/);
});

test("daysUntil : jours calendaires, indépendants de l'heure", () => {
  assert.equal(daysUntil(null, now), null);
  assert.equal(daysUntil("2026-10-10", now), 0);
  assert.equal(daysUntil("2026-10-11", new Date("2026-10-10T23:59:00")), 1);
  assert.equal(daysUntil("2026-12-15", now), 66);
  assert.equal(daysUntil("2026-10-09", now), -1);
});

test("answeredToday : ne compte que les réponses du jour", () => {
  const at = (iso) => ({ id: iso, questionId: "q", part: 5, selectedKey: "A", correct: true, timeMs: 1, at: iso, mode: "practice", owner: null, synced: false });
  const list = [at("2026-10-10T08:00:00"), at("2026-10-10T20:00:00"), at("2026-10-09T23:00:00")];
  assert.equal(answeredToday(list, now), 2);
});

test("latestExamScore : dernier examen blanc par date", () => {
  assert.equal(latestExamScore([]), null);
  assert.equal(latestExamScore([{ at: "2026-09-01T10:00:00Z", score: 300 }, { at: "2026-10-01T10:00:00Z", score: 340 }]), 340);
});

test("plan : sans date, ou sans examen blanc, il guide vers la prochaine étape", () => {
  assert.match(buildPlan({ goals: goals(), lastExamScore: null, weakCategories: [], now }).summary, /date d'examen/);
  const p = buildPlan({ goals: goals({ examDate: "2026-12-15", targetScore: 400 }), lastExamScore: null, weakCategories: [], now });
  assert.match(p.summary, /examen blanc/);
  assert.equal(p.gap, null);
  assert.equal(p.recommendedDaily, 10);
});

test("plan : rythme quotidien selon l'écart et les jours restants, plafonné", () => {
  const p = buildPlan({
    goals: goals({ examDate: "2026-12-15", targetScore: 400, dailyGoal: 10 }),
    lastExamScore: 330, weakCategories: ["prepositions", "connectors", "vocabulary", "clauses"], now,
  });
  assert.equal(p.gap, 70);
  assert.equal(p.daysLeft, 66);
  assert.equal(p.recommendedDaily, 10); // 140 questions / 66 j ≈ 3 : l'objectif choisi l'emporte
  assert.equal(p.mockExamsPerWeek, 1);
  assert.deepEqual(p.focus, ["prepositions", "connectors", "vocabulary"]);

  const tight = buildPlan({ goals: goals({ examDate: "2026-10-20", targetScore: 450, dailyGoal: 10 }), lastExamScore: 250, weakCategories: [], now });
  assert.equal(tight.recommendedDaily, 40); // 400 questions / 10 j
  assert.equal(tight.mockExamsPerWeek, 0); // moins de 2 semaines
  const capped = buildPlan({ goals: goals({ examDate: "2026-10-11", targetScore: 495, dailyGoal: 10 }), lastExamScore: 5, weakCategories: [], now });
  assert.equal(capped.recommendedDaily, 60);
});

test("plan : objectif déjà atteint ou jour J", () => {
  const reached = buildPlan({ goals: goals({ examDate: "2026-11-10", targetScore: 300 }), lastExamScore: 320, weakCategories: [], now });
  assert.equal(reached.gap, 0);
  assert.match(reached.summary, /atteint déjà l'objectif/);
  assert.match(buildPlan({ goals: goals({ examDate: "2026-10-10" }), lastExamScore: null, weakCategories: [], now }).summary, /aujourd'hui/);
});
