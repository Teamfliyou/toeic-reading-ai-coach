// Entraînement adaptatif : compétences pondérées par l'ancienneté, vitesse, tendance,
// répétitions, difficulté progressive et recommandations de séances.
import test from "node:test";
import assert from "node:assert/strict";
import {
  HALF_LIFE_DAYS, analyzeSkills, buildAdaptivePlan, difficultyFor, parseSeriesParams, recentSeenIds, seriesHref,
} from "../src/lib/adaptive.ts";

const NOW = new Date("2026-10-25T12:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
let n = 0;
const attempt = (over) => ({ id: `a${++n}`, questionId: `q${n}`, part: 5, category: "prepositions", selectedKey: "A", correct: true, timeMs: 15_000, at: daysAgo(1), mode: "practice", owner: null, synced: true, ...over });
const many = (count, over) => Array.from({ length: count }, (_, i) => attempt({ questionId: `${over?.category ?? "c"}-${i}`, ...over }));

test("compétences : précision pondérée, a priori prudent sur les petits échantillons", () => {
  const strong = many(12, { category: "connectors", correct: true });
  const weak = many(12, { category: "prepositions", correct: false });
  const few = many(1, { category: "vocabulary", correct: false });
  const stats = analyzeSkills([...strong, ...weak, ...few], NOW);
  const by = Object.fromEntries(stats.map((s) => [s.category, s]));
  assert.ok(by.connectors.accuracy > 0.85, `forte : ${by.connectors.accuracy}`);
  assert.ok(by.prepositions.accuracy < 0.25, `faible : ${by.prepositions.accuracy}`);
  assert.ok(by.vocabulary.accuracy > by.prepositions.accuracy, "une seule erreur ne condamne pas une catégorie");
  assert.equal(stats[0].category, "prepositions", "triées de la plus urgente à la plus solide");
  assert.equal(stats.at(-1).category, "connectors");
});

test("ancienneté : une erreur récente pèse plus qu'une ancienne erreur (demi-vie de 14 jours)", () => {
  assert.equal(HALF_LIFE_DAYS, 14);
  const oldErrors = [...many(5, { correct: false, at: daysAgo(90) }), ...many(5, { correct: true, at: daysAgo(1) })];
  const recentErrors = [...many(5, { correct: true, at: daysAgo(90) }), ...many(5, { correct: false, at: daysAgo(1) })];
  assert.ok(analyzeSkills(oldErrors, NOW)[0].accuracy > analyzeSkills(recentErrors, NOW)[0].accuracy);
});

test("vitesse, tendance, erreurs répétées et oubli font monter le besoin de travail", () => {
  const base = many(10, { correct: true, timeMs: 12_000, at: daysAgo(2) });
  const slow = many(10, { correct: true, timeMs: 60_000, at: daysAgo(2) });
  assert.ok(analyzeSkills(slow, NOW)[0].speedRatio > 2);
  assert.ok(analyzeSkills(slow, NOW)[0].need > analyzeSkills(base, NOW)[0].need, "lent = priorité");
  assert.ok(analyzeSkills(many(10, { at: daysAgo(40) }), NOW)[0].need > analyzeSkills(base, NOW)[0].need, "oublié depuis longtemps = priorité");
  // Tendance : de bonnes réponses puis 5 erreurs récentes.
  const sliding = [...many(6, { correct: true, at: daysAgo(10) }), ...many(5, { correct: false, at: daysAgo(1) })];
  assert.ok(analyzeSkills(sliding, NOW)[0].trend < -0.5);
  assert.equal(analyzeSkills(many(4, {}), NOW)[0].trend, null, "trop peu de réponses pour une tendance");
  // Même question ratée deux fois.
  const repeated = [attempt({ questionId: "same", correct: false }), attempt({ questionId: "same", correct: false }), attempt({ questionId: "other" })];
  assert.equal(analyzeSkills(repeated, NOW)[0].repeatedErrors, 1);
  // Listening et réponses vides ignorés.
  assert.deepEqual(analyzeSkills([attempt({ part: 2 }), attempt({ selectedKey: "-" }), attempt({ category: undefined })], NOW), []);
});

test("difficulté progressive : facile si fragile, avancée si maîtrisée, intermédiaire sans données", () => {
  assert.equal(difficultyFor(undefined), 2);
  assert.equal(difficultyFor({ accuracy: 0.3, attempts: 10 }), 1);
  assert.equal(difficultyFor({ accuracy: 0.65, attempts: 10 }), 2);
  assert.equal(difficultyFor({ accuracy: 0.9, attempts: 10 }), 3);
  assert.equal(difficultyFor({ accuracy: 0.9, attempts: 2 }), 2, "peu de données : niveau intermédiaire");
});

test("questions déjà vues : récentes d'abord, sans doublon, par partie, plafonnées", () => {
  const attempts = [attempt({ questionId: "a", at: daysAgo(5) }), attempt({ questionId: "b", at: daysAgo(1) }), attempt({ questionId: "a", at: daysAgo(2) }), attempt({ questionId: "z", part: 7 }), attempt({ questionId: "l", part: 2 })];
  assert.deepEqual(recentSeenIds(attempts, [5], 10), ["b", "a"]);
  assert.equal(recentSeenIds(attempts, [5, 7], 2).length, 2);
  assert.equal(recentSeenIds(attempts, [5, 6, 7], 1).length, 1);
});

test("plan : révisions dues, exercices ciblés, séance mixte, jamais vues, progression, examen", () => {
  const attempts = [
    ...many(10, { category: "prepositions", correct: false }),
    ...many(10, { category: "connectors", correct: false, at: daysAgo(3) }),
    ...many(8, { category: "vocabulary", correct: true }),
    ...many(8, { category: "reading-detail", part: 7, correct: true, timeMs: 50_000 }),
  ];
  const labels = { prepositions: "Prépositions", connectors: "Connecteurs", vocabulary: "Vocabulaire", "reading-detail": "Information précise" };
  const plan = buildAdaptivePlan({ attempts, dueCount: 7, goals: { examDate: "2026-12-01", targetScore: 400, dailyGoal: 12, updatedAt: "x" }, lastExamScore: 300, now: NOW, labels });
  const kinds = plan.recommendations.map((r) => r.kind);
  assert.equal(kinds[0], "review", "les révisions dues d'abord");
  assert.match(plan.recommendations[0].title, /7 questions/);
  assert.deepEqual(kinds.filter((k) => k === "targeted").length, 2);
  for (const kind of ["mixed", "unseen", "progressive", "exam"]) assert.ok(kinds.includes(kind), kind);
  const targeted = plan.recommendations.filter((r) => r.kind === "targeted");
  assert.ok(targeted.every((r) => r.difficulty === 1), "catégories fragiles : niveau facile d'abord");
  assert.ok(targeted.some((r) => r.category === "prepositions"));
  assert.ok(targeted.every((r) => r.href.startsWith("#/practice/part5?") && r.href.includes("unseen=1")));
  const mixed = plan.recommendations.find((r) => r.kind === "mixed");
  assert.match(mixed.href, /categories=(prepositions|connectors)%2C(prepositions|connectors)/);
  const progressive = plan.recommendations.find((r) => r.kind === "progressive");
  assert.equal(progressive.difficulty, 3);
  assert.equal(plan.dailyTarget, 12);
  assert.match(plan.summary, /Prépositions/);
  assert.match(plan.recommendations.find((r) => r.kind === "exam").reason, /400.*300/);
});

test("plan sans historique : parcours de découverte, aucune recommandation inventée", () => {
  const plan = buildAdaptivePlan({ attempts: [], dueCount: 0, now: NOW });
  assert.match(plan.summary, /Pas encore d'historique/);
  assert.deepEqual(plan.recommendations.map((r) => r.kind), ["unseen"]);
  assert.equal(plan.skills.length, 0);
});

test("adresse d'une série : écriture et lecture robustes (valeurs invalides ignorées)", () => {
  const valid = ["prepositions", "connectors", "vocabulary"];
  const href = seriesHref(5, { categories: ["prepositions", "connectors"], difficulty: 2, limit: 15, unseen: true });
  assert.equal(href, "#/practice/part5?categories=prepositions%2Cconnectors&difficulty=2&limit=15&unseen=1");
  const parsed = parseSeriesParams(href.split("?")[1], 5, valid);
  assert.deepEqual(parsed, { categories: ["prepositions", "connectors"], difficulty: 2, limit: 15, unseen: true });
  assert.deepEqual(parseSeriesParams("category=hack&difficulty=9&limit=9999&unseen=0", 5, valid), {});
  assert.deepEqual(parseSeriesParams("limit=50", 5, valid), {}, "plafond de 40 questions en partie 5");
  assert.deepEqual(parseSeriesParams("limit=7", 7, valid), {}, "plafond de 6 documents en partie 7");
  assert.equal(parseSeriesParams("?category=vocabulary", 5, valid).category, "vocabulary");
  assert.equal(seriesHref(7, {}), "#/practice/part7");
});
