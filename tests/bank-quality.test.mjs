import test from "node:test";
import assert from "node:assert/strict";
import {
  answerBalance, canShuffle, checkPassageGroup, checkQuestion, estimateDifficulty, outcomeFor, rebalanceAnswers,
} from "../server/bank/quality.mjs";

const opts = (a, b, c, d) => [a, b, c, d].map((text, i) => ({ key: "ABCD"[i], text }));
const q5 = (over = {}) => ({
  part: 5,
  prompt: "All invoices must be submitted ______ the end of the month.",
  options: opts("by", "until", "since", "during"),
  correctKey: "A",
  difficulty: 1,
  category: "prepositions",
  ...over,
});
const codes = (r) => [...r.errors, ...r.warnings].map((i) => i.code);

test("question valide : aucune erreur ni alerte", () => {
  const r = checkQuestion(q5());
  assert.deepEqual(codes(r), []);
  assert.equal(r.question.tags.length, 0);
});

test("erreurs bloquantes : schéma, anglais, trou manquant, propositions identiques", () => {
  assert.ok(codes(checkQuestion(q5({ correctKey: "E" }))).includes("schema"));
  assert.ok(codes(checkQuestion(q5({ options: opts("by", "until", "since") }))).includes("schema"));
  assert.ok(codes(checkQuestion(q5({ prompt: "Vous devez envoyer les factures pour les clients dans une semaine ______." }))).includes("not_english"));
  assert.ok(codes(checkQuestion(q5({ prompt: "All invoices must be submitted by the end of the month." }))).includes("blank_missing"));
  assert.ok(codes(checkQuestion(q5({ options: opts("by", "By", "since ", "during") }))).includes("duplicate_options"));
  assert.ok(codes(checkQuestion(q5({ difficulty: 5 }))).includes("schema"));
});

test("catégorie d'une autre partie : ignorée avec alerte, pas de rejet", () => {
  const r = checkQuestion(q5({ category: "reading-detail" }));
  assert.equal(r.errors.length, 0);
  assert.ok(codes(r).includes("unknown_category"));
  assert.equal(r.question.category, null);
});

test("réponses multiples possibles : repérées dans les justifications et l'explication", () => {
  const suspectRationale = checkQuestion(q5({ options: opts("by", "until", "since", "during"), optionRationales: { B: "« until » est aussi correct dans ce contexte." } }), { source: "ai" });
  assert.ok(codes(suspectRationale).includes("multiple_correct_suspect"));
  const suspectExplanation = checkQuestion(q5({ explanation: "Les deux réponses A et B sont possibles ici, mais A est plus naturelle." }));
  assert.ok(codes(suspectExplanation).includes("multiple_correct_suspect"));
  const fine = checkQuestion(q5({ optionRationales: { B: "« until » exprime une durée, pas une échéance." } }));
  assert.ok(!codes(fine).includes("multiple_correct_suspect"));
  const noText = checkQuestion(q5({ options: opts("all of the above", "until", "since", "during") }));
  assert.ok(codes(noText).includes("option_refers_to_options"));
});

test("fuite de la réponse, explication en anglais, justifications manquantes (IA)", () => {
  assert.ok(codes(checkQuestion(q5({ prompt: "The end of the month is the deadline, ______ the end of the month.", options: opts("the end of the month", "until", "since", "during") }))).includes("answer_in_prompt"));
  assert.ok(codes(checkQuestion(q5({ explanation: "This is the correct answer because the sentence needs a preposition of time." }))).includes("explanation_language"));
  const ai = checkQuestion(q5(), { source: "ai" });
  assert.ok(codes(ai).includes("explanation_missing"));
  assert.ok(codes(ai).includes("rationales_missing"));
  const complete = checkQuestion(q5({
    explanation: "« by » indique une échéance : la facture doit arriver au plus tard à cette date.",
    optionRationales: { B: "« until » décrit une durée continue.", C: "« since » marque un point de départ.", D: "« during » précède une période." },
  }), { source: "ai" });
  assert.deepEqual(codes(complete), []);
});

test("difficulté : estimation grossière, alerte seulement sur un écart d'au moins 2 niveaux", () => {
  const easy = q5({ difficulty: 3 });
  assert.equal(estimateDifficulty(easy), 1);
  assert.ok(codes(checkQuestion(easy)).includes("difficulty_mismatch"));
  const hard = q5({
    prompt: "Notwithstanding the unanticipated restructuring of the department, the committee decided that all outstanding reimbursements ______ processed promptly.",
    options: opts("must be", "must have", "must to be", "must being"), difficulty: 3,
  });
  assert.ok(estimateDifficulty(hard) >= 2);
  assert.ok(!codes(checkQuestion(hard)).includes("difficulty_mismatch"));
  assert.ok(!codes(checkQuestion(q5({ difficulty: 2 }))).includes("difficulty_mismatch"), "un seul niveau d'écart n'alerte pas");
});

const p6doc = (body) => ({ title: "Memo — Move", documents: [{ kind: "memo", title: "To: Staff", body }] });
const p6q = (n, sentence, correct = "A") => ({
  part: 6, prompt: sentence, options: opts("w1", "w2", "w3", "w4"), correctKey: correct, difficulty: 2, orderIndex: n,
});

test("partie 6 : le nombre de trous du document doit correspondre aux questions", () => {
  const body = ["We (1)______ move in March. Please (2)______ your boxes by Friday and (3)______ the desk."];
  const ok = checkPassageGroup(6, p6doc(body), [
    p6q(1, "We (1)______ move in March."), p6q(2, "Please (2)______ your boxes by Friday and (3)______ the desk.".replace(" and (3)______ the desk", "")), p6q(3, "Please (3)______ the desk."),
  ].slice(0, 2));
  assert.ok(ok.errors.some((e) => e.code === "passage_blank_mismatch"), "3 trous mais 2 questions");

  const good = checkPassageGroup(6, p6doc(["We (1)______ move in March. Please (2)______ your boxes by Friday."]), [
    p6q(1, "We (1)______ move in March."), p6q(2, "Please (2)______ your boxes by Friday."),
  ]);
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.warnings, []);

  const paraphrased = checkPassageGroup(6, p6doc(["We (1)______ move in March. Please (2)______ your boxes by Friday."]), [
    p6q(1, "We (1)______ move in March."), p6q(2, "Kindly (2)______ every box before the weekend arrives."),
  ]);
  assert.ok(paraphrased.warnings.some((w) => w.code === "prompt_not_in_passage" && w.index === 1));

  const bad = checkPassageGroup(6, p6doc(["No blanks here at all in this document."]), [p6q(1, "Prompt with ______ blank here")]);
  assert.ok(bad.errors.some((e) => e.code === "passage_blanks_missing"));
  const skipped = checkPassageGroup(6, p6doc(["We (1)______ and (3)______ now."]), [p6q(1, "We (1)______ and now."), p6q(3, "and (3)______ now.")]);
  assert.ok(skipped.errors.some((e) => e.code === "passage_blanks_invalid"));
  const french = checkPassageGroup(6, p6doc(["Nous allons (1)______ dans les nouveaux locaux pour une réunion avec vous."]), [p6q(1, "Nous allons (1)______ dans")]);
  assert.ok(french.errors.some((e) => e.code === "passage_not_english"));
});

test("partie 7 : document court et nombre de questions hors 2 à 5 signalés", () => {
  const passage = { title: "Notice", documents: [{ kind: "notice", title: "Closed", body: ["The office is closed on Monday."] }] };
  const q = (n) => ({ part: 7, prompt: `Question ${n}?`, options: opts("a", "b", "c", "d"), correctKey: "A", difficulty: 1 });
  const r = checkPassageGroup(7, passage, [q(1)]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ["passage_too_short", "question_count"]);
  assert.ok(checkPassageGroup(7, { title: "", documents: [] }, [q(1)]).errors.length > 0);
});

test("équilibre des réponses : détection puis rééquilibrage sans changer le contenu", () => {
  const questions = Array.from({ length: 20 }, (_, i) => ({
    ...q5({ prompt: `Question ${i} ______ here for everyone`, options: opts(`right${i}`, `x${i}`, `y${i}`, `z${i}`), correctKey: "A", optionRationales: { A: "ok", B: "b", C: "c", D: "d" } }),
  }));
  assert.equal(answerBalance(questions).balanced, false);
  const rebalanced = rebalanceAnswers(questions, 42);
  const balance = answerBalance(rebalanced);
  assert.equal(balance.balanced, true);
  assert.ok(Object.values(balance.distribution).every((n) => n >= 3 && n <= 8), JSON.stringify(balance.distribution));
  rebalanced.forEach((r, i) => {
    const correct = r.options.find((o) => o.key === r.correctKey).text;
    assert.equal(correct, `right${i}`, "la bonne réponse suit son texte");
    assert.equal(r.optionRationales[r.correctKey], "ok", "la justification suit sa proposition");
    assert.deepEqual(r.options.map((o) => o.key), ["A", "B", "C", "D"]);
    assert.deepEqual(r.options.map((o) => o.text).sort(), [`right${i}`, `x${i}`, `y${i}`, `z${i}`].sort());
  });
  assert.deepEqual(rebalanceAnswers(questions, 42), rebalanced, "déterministe");
  assert.equal(canShuffle(q5({ options: opts("all of the above", "b", "c", "d") })), false);
  assert.equal(canShuffle(q5({ options: opts("Both A and B", "b", "c", "d") })), false);
  assert.equal(answerBalance(questions.slice(0, 5)).balanced, true, "lot trop petit pour conclure");
});

test("issue d'un contrôle : rejet, brouillon à vérifier ou prêt pour validation", () => {
  assert.equal(outcomeFor({ errors: [{}], warnings: [] }).outcome, "rejected");
  assert.deepEqual(outcomeFor({ errors: [], warnings: [{}] }), { outcome: "flagged", status: "draft", needsReview: true });
  assert.deepEqual(outcomeFor({ errors: [], warnings: [] }, { clean: "review" }), { outcome: "accepted", status: "review", needsReview: false });
  assert.equal(outcomeFor({ errors: [], warnings: [] }).status, "draft");
});
