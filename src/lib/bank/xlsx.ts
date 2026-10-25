// Lecture et écriture de classeurs XLSX, sans dépendance lourde (fflate pour le ZIP).
//
// Lecture prudente : seules les parties utiles du classeur sont décompressées, la taille
// décompressée est plafonnée (bombe ZIP), les macros (.xlsm / vbaProject.bin) sont refusées,
// les formules ne sont jamais évaluées (on lit la valeur mise en cache) et le XML est lu avec
// des expressions régulières (aucune entité externe n'est jamais résolue : pas de XXE).

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export const MAX_UNCOMPRESSED_BYTES = 120 * 1024 * 1024;
export const MAX_ENTRIES = 400;

export interface SheetRow {
  /** Numéro de ligne dans la feuille (1 = première ligne). */
  n: number;
  cells: string[];
}
export interface ReadSheet {
  name: string;
  rows: SheetRow[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** Décode les entités XML (une seule passe : « &amp;lt; » devient « &lt; », jamais « < »). */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name] ?? whole;
  });
}

/** Échappe un texte pour le XML en retirant les caractères interdits. */
export function encodeXml(text: string): string {
  return String(text ?? "")
    .split("")
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** « C » → 2, « AA » → 26. */
export function columnIndex(ref: string): number {
  let index = 0;
  for (const char of ref.replace(/[^A-Za-z]/g, "").toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

const attr = (tag: string, name: string): string | null => {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
};

const textOf = (xml: string): string => {
  const parts: string[] = [];
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) parts.push(decodeXml(m[1]));
  return parts.join("");
};

/** Décompresse le classeur en refusant les archives suspectes. */
function openArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  let count = 0;
  let macro = false;
  try {
    unzipSync(bytes, {
      filter(file) {
        count += 1;
        total += file.originalSize;
        if (/vbaProject\.bin$/i.test(file.name)) macro = true;
        return false;
      },
    });
  } catch {
    throw new Error("Fichier XLSX illisible ou corrompu.");
  }
  if (macro) throw new Error("Les classeurs avec macros (.xlsm) sont refusés : enregistrez-le en .xlsx.");
  if (count > MAX_ENTRIES || total > MAX_UNCOMPRESSED_BYTES) throw new Error("Classeur trop volumineux une fois décompressé.");
  const wanted = /^(\[Content_Types\]\.xml|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/worksheets\/[^/]+\.xml)$/;
  return unzipSync(bytes, { filter: (file) => wanted.test(file.name) });
}

/** Lit la première feuille visible d'un classeur .xlsx. */
export function readXlsx(bytes: Uint8Array): ReadSheet {
  const files = openArchive(bytes);
  const workbook = files["xl/workbook.xml"];
  if (!workbook) throw new Error("Ce fichier n'est pas un classeur .xlsx valide.");
  const workbookXml = strFromU8(workbook);
  const relsXml = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }
  const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*>/g)]
    .map((m) => ({ name: attr(m[0], "name") ?? "Feuille", rid: attr(m[0], "r:id") ?? attr(m[0], "id"), hidden: /state="(hidden|veryHidden)"/.test(m[0]) }))
    .filter((s) => !s.hidden);
  const sheet = sheets[0];
  const path = sheet?.rid ? targets.get(sheet.rid) : undefined;
  const sheetFile = path ? files[path] : undefined;
  if (!sheet || !sheetFile) throw new Error("Aucune feuille lisible dans ce classeur.");

  const shared: string[] = [];
  if (files["xl/sharedStrings.xml"]) {
    const xml = strFromU8(files["xl/sharedStrings.xml"]);
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  }

  const rows: SheetRow[] = [];
  const xml = strFromU8(sheetFile);
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const n = Number(attr(rowMatch[1], "r")) || rows.length + 1;
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cellMatch[1], "r");
      const type = attr(cellMatch[1], "t");
      const body = cellMatch[2] ?? "";
      let value = "";
      if (type === "s") value = shared[Number(body.match(/<v>([\s\S]*?)<\/v>/)?.[1])] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else if (type === "b") value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] === "1" ? "TRUE" : "FALSE";
      else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        value = v === undefined ? "" : decodeXml(v);
      }
      const index = ref ? columnIndex(ref) : cells.length;
      if (index < 0 || index > 200) continue;
      while (cells.length < index) cells.push("");
      cells[index] = value;
    }
    rows.push({ n, cells });
  }
  return { name: sheet.name, rows };
}

// --- Écriture ---------------------------------------------------------------------------------

export interface WriteSheet {
  name: string;
  rows: (string | number)[][];
  /** Largeurs de colonnes (en caractères). */
  widths?: number[];
  boldHeader?: boolean;
}

const colName = (index: number): string => {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const sheetXml = (sheet: WriteSheet): string => {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${colName(c)}${r + 1}`;
          if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
          const style = r === 0 && sheet.boldHeader ? 2 : 1;
          return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${encodeXml(String(value ?? ""))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheet.boldHeader ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ""}${cols}<sheetData>${rows}</sheetData></worksheet>`;
};

/** Construit un classeur .xlsx (cellules texte, retours à la ligne conservés). */
export function buildXlsx(sheets: WriteSheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}</Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${encodeXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>`
    ),
  };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet));
  });
  return zipSync(files, { level: 6 });
}
