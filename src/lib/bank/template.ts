// Modèle d'importation téléchargeable : exemples valides des parties 5, 6 et 7.
// Source unique : data/import-template.json (régénéré par scripts/build-import-template.mjs et
// vérifié par tests/bank-import.test.mjs : il s'importe sans erreur ni alerte).

import template from "../../../data/import-template.json" with { type: "json" };
import categories from "../../../data/categories.json" with { type: "json" };
import { toCsv } from "./csv.ts";
import { buildXlsx, type WriteSheet } from "./xlsx.ts";

type TemplateRow = Record<string, string | number>;
const headers = template.headers as string[];
const rows = template.rows as TemplateRow[];

const table = (): (string | number)[][] => [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ""))];

/** CSV avec BOM UTF-8 : Excel affiche correctement les accents. */
export function templateCsv(): string {
  return "﻿" + toCsv(table());
}

export function templateSheets(): WriteSheet[] {
  const widths = headers.map((h) => (/text$/.test(h) ? 60 : /prompt|explanation|rationale|title/.test(h) ? 40 : h.startsWith("option_") ? 24 : 16));
  return [
    { name: "Modèle", rows: table(), widths, boldHeader: true },
    { name: "Instructions", rows: [["Instructions"], ...template.notes.map((n) => [n])], widths: [120], boldHeader: true },
    {
      name: "Catégories",
      rows: [["Identifiant (colonne category)", "Description", "Parties"], ...categories.map((c) => [c.id, c.label, c.parts.join(", ")])],
      widths: [30, 60, 12],
      boldHeader: true,
    },
  ];
}

export const templateXlsx = (): Uint8Array => buildXlsx(templateSheets());

/** Déclenche le téléchargement d'un fichier généré dans le navigateur. */
export function downloadFile(filename: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
