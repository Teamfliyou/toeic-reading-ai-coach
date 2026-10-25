// Accessibilité des nouveaux écrans d'administration : contrastes AA des pastilles et textes
// secondaires de bank.css, et présence des libellés / rôles essentiels dans les composants.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/components/admin/bank.css", import.meta.url), "utf8");
const read = (p) => readFileSync(new URL(`../src/components/admin/${p}`, import.meta.url), "utf8");

function luminance(hex) {
  const [r, g, b] = hex.replace("#", "").match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("AA : pastilles de statut (texte sur fond) ≥ 4,5:1", () => {
  const rules = [...css.matchAll(/\.bank-badge(?:\[data-tone=(\w+)\])?\{([^}]*)\}/g)];
  assert.ok(rules.length >= 7, "pastilles déclarées");
  let checked = 0;
  for (const [, tone, body] of rules) {
    const bg = body.match(/background:(#[0-9a-f]{6})/i)?.[1];
    const fg = body.match(/(?<![-\w])color:(#[0-9a-f]{6})/i)?.[1];
    if (!bg || !fg) continue;
    checked += 1;
    assert.ok(ratio(fg, bg) >= 4.5, `pastille ${tone ?? "défaut"} : ${fg} sur ${bg} = ${ratio(fg, bg).toFixed(2)}`);
  }
  assert.ok(checked >= 7);
});

test("AA : textes secondaires, alertes et en-têtes de table sur les fonds clairs", () => {
  const pairs = [
    [".bank-muted-small", "#ffffff"], [".bank-muted-small", "#f7f8fa"],
    [".bank-flag", "#ffffff"], [".bank-stat span", "#ffffff"], [".bank-count-row span", "#ffffff"],
    [".bank-steps li", "#ffffff"], [".bank-table th", "#ffffff"], [".bank-field", "#ffffff"],
  ];
  for (const [selector, bg] of pairs) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`${escaped}\\{[^}]*?(?<![-\\w])color:(#[0-9a-f]{6})`, "i").exec(css);
    assert.ok(m, `couleur introuvable pour ${selector}`);
    assert.ok(ratio(m[1], bg) >= 4.5, `${selector} ${m[1]} sur ${bg} : ${ratio(m[1], bg).toFixed(2)}`);
  }
  // Étape active et étape terminée.
  assert.ok(ratio("#27456c", "#edf3fa") >= 4.5);
  assert.ok(ratio("#176443", "#ecf9f3") >= 4.5);
  assert.ok(ratio("#ffffff", "#27456c") >= 4.5, "onglet actif");
});

test("composants : champs étiquetés, régions et états annoncés aux lecteurs d'écran", () => {
  const editor = read("QuestionEditor.tsx");
  const list = read("LibraryQuestions.tsx");
  const wizard = read("ImportWizard.tsx");
  const jobs = read("GenerationJobs.tsx");
  assert.match(editor, /htmlFor="q-prompt"/);
  assert.match(editor, /aria-label=\{`Proposition \$\{key\}`\}/);
  assert.match(editor, /aria-live="polite"/);
  assert.match(list, /aria-label="Pagination"/);
  assert.match(list, /aria-label=\{`Sélectionner \$\{q\.slug\}`\}/);
  assert.match(list, /role="search"/);
  assert.match(wizard, /role="progressbar"/);
  assert.match(wizard, /htmlFor=\{id\}/, "chaque champ de correspondance a son étiquette");
  assert.match(wizard, /aria-current=\{s\.id === step \? "step"/);
  assert.match(jobs, /role="progressbar"/);
  assert.match(jobs, /aria-pressed=/);
  // Aucune confirmation destructive sans window.confirm (suppression, annulation, publication à vérifier).
  assert.match(list, /window\.confirm\(`Supprimer/);
  assert.match(jobs, /window\.confirm\(confirmText\)/);
  assert.match(jobs, /"Annuler cette génération \?/);
  assert.match(wizard, /window\.confirm\("Annuler définitivement/);
});

test("affichage adaptatif : tableau remplacé par des cartes sous 760 px, sans défilement horizontal", () => {
  assert.match(css, /@media\(max-width:760px\)\{[\s\S]*\.bank-table\{display:none\}/);
  assert.match(css, /\.bank-cards\{display:grid/);
  assert.match(css, /\.bank-wide\{max-width:1240px!important\}/);
});
