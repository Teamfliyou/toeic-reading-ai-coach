import test from "node:test";
import assert from "node:assert/strict";
import { jaccard, lshBands, norm, passageHash, questionHash, shareBand, similarWithin, similarityText } from "../server/bank/text.mjs";
import { createBankDb } from "./pg-helper.mjs";

test("norm : minuscules, ponctuation et espaces ignorés", () => {
  assert.equal(norm("  The Manager's   REPORT — due (Friday)! "), "the manager s report due friday");
  assert.equal(norm(null), "");
});

test("empreintes : parité exacte JavaScript ↔ SQL (questions et documents)", async () => {
  const db = await createBankDb({ seed: false });
  const options = [
    { key: "A", text: "a b" }, { key: "B", text: "ab" }, { key: "C", text: "a-c" }, { key: "D", text: "Été & 9 Zoo" },
  ];
  const cases = [
    [5, "All invoices must be submitted ______ the end of the month.", options, null],
    [6, "We (1)______ the café’s “new” menu — it’s été!", options, "abc123"],
    [7, "What is the purpose of the e-mail?", options.slice().reverse(), "def456"],
  ];
  for (const [part, prompt, opts, ph] of cases) {
    const { rows } = await db.query("select public.bank_question_hash($1, $2, $3::jsonb, $4) as h", [part, prompt, JSON.stringify(opts), ph]);
    assert.equal(questionHash(part, prompt, opts, ph), rows[0].h, prompt);
  }
  // L'ordre des propositions ne change pas l'empreinte.
  assert.equal(questionHash(5, "x ______ y", options, null), questionHash(5, "x ______ y", options.slice().reverse(), null));
  const docs = [
    { kind: "email", title: "To: All Staff", body: ["From: HR", "Meeting at 9:00 — bring your laptop."] },
    { kind: "schedule", title: "Day 1", body: "9:00 Registration" },
  ];
  const { rows } = await db.query("select public.bank_passage_hash($1, $2, $3::jsonb) as h", [7, "Memo — Café", JSON.stringify(docs)]);
  assert.equal(passageHash(7, "Memo — Café", docs), rows[0].h);
});

test("similarité : Jaccard et bandes LSH retrouvent les quasi-doublons sans comparer toute la banque", () => {
  const a = "The quarterly report must be submitted by Friday afternoon to the finance department.";
  const near = "The quarterly report must be submitted by Friday morning to the finance department.";
  const far = "Please remind all employees to wear their identification badges at the reception desk.";
  assert.ok(jaccard(a, near) > 0.7);
  assert.ok(jaccard(a, far) < 0.2);
  assert.equal(lshBands(a).length, 12);
  assert.ok(lshBands(a).every((n) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647));
  assert.ok(shareBand(lshBands(a), lshBands(a)));
  assert.equal(shareBand(lshBands(a), lshBands(far)), false);
  assert.deepEqual(lshBands("Hello"), [], "texte trop court : pas de détection approchée");
  const result = similarWithin([a, far, near, a + " "]);
  assert.deepEqual(result[1], []);
  assert.deepEqual(result[2].map((r) => r.index), [0]);
  assert.ok(result[3].some((r) => r.index === 0 && r.score === 1));
});

test("texte de similarité : la phrase en partie 5, énoncé + choix ensuite", () => {
  const opts = [{ text: "by" }, { text: "until" }];
  assert.equal(similarityText(5, "P ______", opts), "P ______");
  assert.match(similarityText(7, "Why?", opts), /Why\? by until/);
});
