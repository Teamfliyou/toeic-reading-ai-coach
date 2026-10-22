// Tests de la logique pure du suivi : répétition espacée, historique, statistiques.
// Les modules TypeScript sont importés directement (Node retire les types).
import test from "node:test";
import assert from "node:assert/strict";
import {
  INTERVAL_DAYS, applyAnswer, boxCounts, dueCards, isDue, mergeCards,
} from "../src/lib/srs.ts";
import {
  fromRow, mergeAttempts, pendingSync, toRow, visibleAttempts,
} from "../src/lib/attempts.ts";
import { computeStats, currentStreak, dayKey } from "../src/lib/stats.ts";

const DAY = 86_400_000;
const t0 = new Date("2026-10-01T10:00:00Z");
const later = (days) => new Date(t0.getTime() + days * DAY);

// --- Leitner -----------------------------------------------------------------
test("une erreur crée une carte en boîte 1, à revoir immédiatement", () => {
  const cards = applyAnswer([], { questionId: "q1", part: 5, correct: false }, t0);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].box, 1);
  assert.equal(cards[0].lapses, 1);
  assert.ok(isDue(cards[0], t0));
});

test("bonne réponse sans carte : rien ne change", () => {
  assert.deepEqual(applyAnswer([], { questionId: "q1", part: 5, correct: true }, t0), []);
});

test("promotion boîte par boîte avec des délais croissants, puis maîtrise", () => {
  let cards = applyAnswer([], { questionId: "q1", part: 5, correct: false }, t0);
  let now = t0;
  for (let box = 1; box < 5; box += 1) {
    cards = applyAnswer(cards, { questionId: "q1", part: 5, correct: true }, now);
    assert.equal(cards[0].box, box + 1);
    const expectedDelay = INTERVAL_DAYS[box] * DAY;
    assert.equal(Date.parse(cards[0].due) - now.getTime(), expectedDelay);
    assert.ok(!isDue(cards[0], new Date(now.getTime() + expectedDelay - 1)));
    now = new Date(now.getTime() + expectedDelay);
    assert.ok(isDue(cards[0], now));
  }
  cards = applyAnswer(cards, { questionId: "q1", part: 5, correct: true }, now);
  assert.equal(cards[0].mastered, true);
  assert.equal(dueCards(cards, later(999)).length, 0);
});

test("une bonne réponse sur une carte non due ne la fait pas monter", () => {
  let cards = applyAnswer([], { questionId: "q1", part: 5, correct: false }, t0);
  cards = applyAnswer(cards, { questionId: "q1", part: 5, correct: true }, t0); // -> boîte 2, due +2 j
  const again = applyAnswer(cards, { questionId: "q1", part: 5, correct: true }, later(1));
  assert.equal(again[0].box, 2);
});

test("une erreur renvoie en boîte 1, même depuis une boîte avancée ou maîtrisée", () => {
  let cards = applyAnswer([], { questionId: "q1", part: 6, correct: false }, t0);
  cards = applyAnswer(cards, { questionId: "q1", part: 6, correct: true }, t0);
  cards = applyAnswer(cards, { questionId: "q1", part: 6, correct: false }, later(1));
  assert.equal(cards[0].box, 1);
  assert.equal(cards[0].lapses, 2);
  assert.ok(isDue(cards[0], later(1)));
  cards = [{ ...cards[0], mastered: true, box: 5 }];
  cards = applyAnswer(cards, { questionId: "q1", part: 6, correct: false }, later(2));
  assert.equal(cards[0].mastered, false);
});

test("dueCards trie par boîte puis ancienneté ; boxCounts ventile", () => {
  const mk = (id, box, due, mastered = false) => ({
    questionId: id, part: 5, box, due, mastered, lapses: 0, updatedAt: due,
  });
  const cards = [
    mk("b3", 3, "2026-09-01T00:00:00Z"),
    mk("b1-new", 1, "2026-09-20T00:00:00Z"),
    mk("b1-old", 1, "2026-09-10T00:00:00Z"),
    mk("future", 2, "2027-01-01T00:00:00Z"),
    mk("done", 5, "2026-09-01T00:00:00Z", true),
  ];
  assert.deepEqual(dueCards(cards, t0).map((c) => c.questionId), ["b1-old", "b1-new", "b3"]);
  assert.deepEqual(boxCounts(cards), { boxes: [2, 1, 1, 0, 0], mastered: 1 });
});

test("mergeCards garde la version la plus récente de chaque carte", () => {
  const a = { questionId: "q1", part: 5, box: 2, due: "x", mastered: false, lapses: 1, updatedAt: "2026-10-02T00:00:00Z" };
  const b = { ...a, box: 4, updatedAt: "2026-10-03T00:00:00Z" };
  const c = { ...a, questionId: "q2", box: 1 };
  const merged = mergeCards([a, c], [b]);
  assert.equal(merged.find((x) => x.questionId === "q1").box, 4);
  assert.equal(merged.length, 2);
});

// --- Historique --------------------------------------------------------------
const attempt = (over = {}) => ({
  id: "a1", questionId: "q1", part: 5, category: "prepositions", selectedKey: "A",
  correct: true, timeMs: 10_000, at: "2026-10-01T10:00:00Z", mode: "practice",
  owner: null, synced: false, ...over,
});

test("pendingSync : tentatives non synchronisées de l'utilisateur ou anonymes", () => {
  const list = [
    attempt({ id: "anon" }),
    attempt({ id: "mine", owner: "u1" }),
    attempt({ id: "other", owner: "u2" }),
    attempt({ id: "done", owner: "u1", synced: true }),
  ];
  assert.deepEqual(pendingSync(list, "u1").map((a) => a.id), ["anon", "mine"]);
  assert.deepEqual(visibleAttempts(list, "u1").map((a) => a.id), ["anon", "mine", "done"]);
  assert.deepEqual(visibleAttempts(list, null).map((a) => a.id), ["anon"]);
});

test("mergeAttempts : dédoublonne par id, marque synchronisé, trie du plus récent", () => {
  const local = [attempt({ id: "a", at: "2026-10-01T10:00:00Z" }), attempt({ id: "b", at: "2026-10-03T10:00:00Z" })];
  const remote = [attempt({ id: "a", owner: "u1", synced: true }), attempt({ id: "c", at: "2026-10-02T10:00:00Z", owner: "u1", synced: true })];
  const merged = mergeAttempts(local, remote);
  assert.deepEqual(merged.map((a) => a.id), ["b", "c", "a"]);
  assert.equal(merged.find((a) => a.id === "a").synced, true);
  assert.equal(merged.find((a) => a.id === "b").synced, false);
});

test("toRow / fromRow : aller-retour sans perte", () => {
  const a = attempt({ timeMs: 1234.6 });
  const row = toRow(a, "u1");
  assert.equal(row.user_id, "u1");
  assert.equal(row.time_ms, 1235);
  const back = fromRow(row);
  assert.equal(back.questionId, "q1");
  assert.equal(back.owner, "u1");
  assert.equal(back.synced, true);
});

// --- Statistiques ------------------------------------------------------------
test("computeStats : taux global, par partie, par catégorie, temps moyen", () => {
  const list = [
    attempt({ id: "1", part: 5, category: "prepositions", correct: true, timeMs: 10_000 }),
    attempt({ id: "2", part: 5, category: "prepositions", correct: false, timeMs: 20_000 }),
    attempt({ id: "3", part: 6, category: "connectors", correct: false, timeMs: 30_000 }),
    attempt({ id: "4", part: 7, category: "reading-detail", correct: true, timeMs: 3_600_000 }), // pause ignorée
    attempt({ id: "5", part: 5, category: undefined, correct: true, timeMs: 0 }),
  ];
  const s = computeStats(list);
  assert.deepEqual(s.overall, { total: 5, correct: 3, rate: 60 });
  assert.equal(s.byPart[5].rate, 67);
  assert.equal(s.byPart[6].rate, 0);
  assert.equal(s.avgTimeMs, 20_000);
  assert.deepEqual(s.byCategory.map((c) => c.category), ["connectors", "prepositions", "reading-detail"]);
  assert.equal(s.byCategory[1].rate, 50);
});

test("computeStats : progression par jour, ordre chronologique et limite", () => {
  const list = [
    attempt({ id: "1", at: "2026-10-03T12:00:00" , correct: true }),
    attempt({ id: "2", at: "2026-10-01T12:00:00", correct: false }),
    attempt({ id: "3", at: "2026-10-01T15:00:00", correct: true }),
  ];
  const s = computeStats(list);
  assert.deepEqual(s.progression.map((p) => [p.day, p.rate]), [["2026-10-01", 50], ["2026-10-03", 100]]);
  assert.equal(computeStats(list, 1).progression.length, 1);
  assert.equal(computeStats([]).overall.rate, null);
});

test("currentStreak : jours consécutifs, tolère « pas encore aujourd'hui »", () => {
  const noon = (d) => new Date(`2026-10-${d}T12:00:00`).toISOString();
  const list = ["10", "09", "08", "06"].map((d, i) => attempt({ id: String(i), at: noon(d) }));
  assert.equal(currentStreak(list, new Date("2026-10-10T20:00:00")), 3);
  assert.equal(currentStreak(list, new Date("2026-10-11T08:00:00")), 3); // hier actif, aujourd'hui pas encore
  assert.equal(currentStreak(list, new Date("2026-10-13T08:00:00")), 0);
  assert.equal(dayKey("2026-10-05T12:00:00"), "2026-10-05");
});
