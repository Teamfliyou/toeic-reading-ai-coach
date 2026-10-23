// Contrastes WCAG AA (4,5:1 pour le texte courant) des couleurs de texte de la feuille
// de style principale sur les fonds réellement utilisés.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = ["src/pages/lexora.css", "src/pages/phase2.css"]
  .map((p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8"))
  .join("\n");

function luminance(hex) {
  const [r, g, b] = hex.replace("#", "").match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Couleur de texte déclarée pour un sélecteur de la feuille de style. */
function colorOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{[^}]*?(?<![-\\w])color:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  assert.ok(match, `couleur introuvable pour ${selector}`);
  return match[1];
}

const BACKGROUNDS = { carte: "#ffffff", page: "#f7f8fa", hero: "#ecf1f7", encart: "#f3f6fa" };
const TEXTS = [
  ".lexora-muted", ".lexora-subtle", ".lexora-statlabel", ".lexora-eyebrow", ".lexora-smalllink",
  ".lexora-disclaimer", ".lexora-legend", ".lexora-boxes span", ".lexora-linkbutton",
];

for (const selector of TEXTS) {
  test(`AA : ${selector} lisible sur les fonds clairs`, () => {
    const color = colorOf(selector);
    for (const [name, bg] of Object.entries(BACKGROUNDS)) {
      assert.ok(ratio(color, bg) >= 4.5, `${selector} ${color} sur ${name} ${bg} : ${ratio(color, bg).toFixed(2)}`);
    }
  });
}

test("AA : étapes de génération inactives et boutons principaux", () => {
  assert.ok(ratio(colorOf(".lexora-generation-status li"), "#f6f9fd") >= 4.5);
  assert.ok(ratio("#ffffff", "#27456c") >= 4.5); // bouton principal
  assert.ok(ratio("#ffffff", "#172239") >= 4.5); // bandeau hors connexion
});

test("l'utilitaire de contraste est correct (noir/blanc = 21:1)", () => {
  assert.equal(Math.round(ratio("#000000", "#ffffff")), 21);
});
