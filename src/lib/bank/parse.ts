// Lecture d'un fichier d'import (CSV, XLSX ou JSON) dans le navigateur : le fichier n'est jamais
// envoyé en une seule fois au serveur, seules des lignes validables par blocs le sont.

import { parseCsv } from "./csv.ts";
import { readXlsx } from "./xlsx.ts";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ROWS = 20000;
export const MAX_COLUMNS = 80;
export const MAX_CELL_CHARS = 6000;

export type ImportFormat = "csv" | "xlsx" | "json";
export type RowData = Record<string, string>;
export interface NumberedRow {
  /** Numéro de ligne dans le fichier (1 = ligne d'en-tête pour CSV/XLSX). */
  n: number;
  data: RowData;
}
export interface ParsedFile {
  format: ImportFormat;
  headers: string[];
  rows: NumberedRow[];
  /** Lignes vides ignorées. */
  skipped: number;
  /** Cellules tronquées parce qu'elles dépassaient la longueur maximale. */
  truncated: number;
}

/** Détermine le format d'après le nom du fichier (jamais d'après son contenu déclaré). */
export function formatOf(filename: string): ImportFormat {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "csv" || ext === "tsv" || ext === "txt") return "csv";
  if (ext === "xlsx") return "xlsx";
  if (ext === "json") return "json";
  if (ext === "xlsm" || ext === "xls") throw new Error("Formats .xls et .xlsm non pris en charge : enregistrez le fichier en .xlsx, .csv ou .json.");
  throw new Error("Format non pris en charge : utilisez un fichier .csv, .xlsx ou .json.");
}

const clean = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/** Transforme un tableau de lignes de cellules (avec en-tête) en lignes nommées. */
function fromTable(table: { n: number; cells: string[] }[]): Pick<ParsedFile, "headers" | "rows" | "skipped" | "truncated"> {
  const isEmpty = (cells: string[]) => cells.every((c) => !String(c ?? "").trim());
  const headerIndex = table.findIndex((r) => r.cells.filter((c) => String(c ?? "").trim()).length >= 2);
  if (headerIndex < 0) throw new Error("Aucun en-tête de colonnes trouvé dans le fichier.");
  const rawHeaders = table[headerIndex].cells.map((c) => String(c ?? "").trim());
  const used = new Map<string, number>();
  const headers = rawHeaders.map((h, i) => {
    const base = h || `Colonne ${i + 1}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count > 1 ? `${base} (${count})` : base;
  });
  if (headers.length > MAX_COLUMNS) throw new Error(`Trop de colonnes (${headers.length}) : ${MAX_COLUMNS} au maximum.`);
  const rows: NumberedRow[] = [];
  let skipped = 0;
  let truncated = 0;
  for (const row of table.slice(headerIndex + 1)) {
    if (isEmpty(row.cells)) {
      skipped += 1;
      continue;
    }
    if (rows.length >= MAX_ROWS) throw new Error(`Trop de lignes : ${MAX_ROWS} au maximum par fichier. Découpez-le en plusieurs fichiers.`);
    const data: RowData = Object.create(null) as RowData;
    headers.forEach((header, i) => {
      let value = clean(row.cells[i]).split("\u0000").join("").trim();
      if (value.length > MAX_CELL_CHARS) {
        value = value.slice(0, MAX_CELL_CHARS);
        truncated += 1;
      }
      data[header] = value;
    });
    rows.push({ n: row.n, data });
  }
  return { headers, rows, skipped, truncated };
}

// --- JSON ---------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

const joinText = (value: unknown): string => (Array.isArray(value) ? value.map(clean).join("\n") : clean(value));

/** Aplatit une question JSON (format du dépôt ou format tabulaire) en une ligne. */
function flattenQuestion(q: Json, passages: Map<string, Json>): RowData {
  const row: RowData = Object.create(null) as RowData;
  const set = (key: string, value: unknown) => {
    const text = joinText(value);
    if (text) row[key] = text;
  };
  const passage = (isObject(q.passage) ? q.passage : null) ?? (typeof q.passageId === "string" ? passages.get(q.passageId) : undefined) ?? null;
  set("part", q.part);
  set("prompt", q.prompt ?? q.question);
  const options = q.options;
  if (Array.isArray(options)) {
    options.forEach((o, i) => {
      const key = isObject(o) && typeof o.key === "string" ? o.key.toUpperCase() : "ABCD"[i];
      set(`option_${key.toLowerCase()}`, isObject(o) ? o.text : o);
    });
  } else if (isObject(options)) {
    for (const [key, text] of Object.entries(options)) set(`option_${key.toLowerCase()}`, text);
  }
  set("correct", q.correctKey ?? q.correct_key ?? q.correct ?? q.answer);
  set("difficulty", q.difficulty);
  set("category", q.category);
  set("theme", q.theme);
  set("tags", Array.isArray(q.tags) ? q.tags.join(";") : q.tags);
  set("explanation", q.explanation);
  const rationales = q.optionRationales ?? q.option_rationales;
  if (isObject(rationales)) for (const [key, text] of Object.entries(rationales)) set(`rationale_${key.toLowerCase()}`, text);
  set("question_number", q.orderIndex ?? q.order_index ?? q.question_number);
  set("external_id", q.id ?? q.external_id ?? q.slug);
  if (passage) {
    set("passage_ref", passage.id ?? passage.ref ?? q.passageId);
    set("passage_title", passage.title);
    const documents = Array.isArray(passage.documents) ? passage.documents : [];
    documents.slice(0, 3).forEach((doc, i) => {
      if (!isObject(doc)) return;
      set(`doc${i + 1}_kind`, doc.kind);
      set(`doc${i + 1}_title`, doc.title);
      set(`doc${i + 1}_text`, doc.body ?? doc.text);
    });
  }
  // Colonnes supplémentaires (déjà au format tabulaire) conservées telles quelles.
  for (const [key, value] of Object.entries(q)) {
    if (!(key in row) && !["options", "passage", "passageId", "optionRationales", "option_rationales"].includes(key) && !isObject(value)) set(key, value);
  }
  return row;
}

export function parseJson(text: string): Pick<ParsedFile, "headers" | "rows" | "skipped" | "truncated"> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Fichier JSON invalide.");
  }
  let questions: unknown[];
  const passages = new Map<string, Json>();
  if (Array.isArray(data)) questions = data;
  else if (isObject(data) && Array.isArray(data.questions)) {
    questions = data.questions;
    if (Array.isArray(data.passages)) for (const p of data.passages) if (isObject(p) && typeof p.id === "string") passages.set(p.id, p);
  } else throw new Error("Le JSON doit être un tableau de questions, ou un objet { passages, questions }.");
  if (questions.length > MAX_ROWS) throw new Error(`Trop de questions : ${MAX_ROWS} au maximum par fichier.`);
  const headerSet = new Set<string>();
  const rows: NumberedRow[] = [];
  let truncated = 0;
  questions.forEach((q, i) => {
    if (!isObject(q)) return;
    const row = flattenQuestion(q, passages);
    for (const key of Object.keys(row)) {
      if (row[key].length > MAX_CELL_CHARS) {
        row[key] = row[key].slice(0, MAX_CELL_CHARS);
        truncated += 1;
      }
      headerSet.add(key);
    }
    rows.push({ n: i + 1, data: row });
  });
  if (headerSet.size > MAX_COLUMNS) throw new Error("Trop de champs différents dans le JSON.");
  const headers = [...headerSet];
  // Chaque ligne expose toutes les colonnes (valeur vide si absente).
  for (const r of rows) for (const h of headers) if (!(h in r.data)) r.data[h] = "";
  return { headers, rows, skipped: questions.length - rows.length, truncated };
}

// --- Entrée principale ----------------------------------------------------------------------------

/** Lit un fichier déjà chargé en mémoire. Lève une erreur au message lisible si le fichier est refusé. */
export function parseImportBytes(filename: string, bytes: Uint8Array): ParsedFile {
  if (bytes.byteLength === 0) throw new Error("Le fichier est vide.");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`Fichier trop volumineux (${Math.round(bytes.byteLength / 1048576)} Mo) : ${MAX_FILE_BYTES / 1048576} Mo au maximum.`);
  const format = formatOf(filename);
  if (format === "xlsx") {
    // Une archive ZIP commence par « PK » : un fichier renommé en .xlsx est refusé tout de suite.
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("Ce fichier n'est pas un classeur .xlsx valide.");
    const sheet = readXlsx(bytes);
    return { format, ...fromTable(sheet.rows) };
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (format === "json") return { format, ...parseJson(text) };
  const rows = parseCsv(text).map((cells, i) => ({ n: i + 1, cells }));
  return { format, ...fromTable(rows) };
}

/** Lit un `File` du navigateur. */
export async function parseImportFile(file: File): Promise<ParsedFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`Fichier trop volumineux (${Math.round(file.size / 1048576)} Mo) : ${MAX_FILE_BYTES / 1048576} Mo au maximum.`);
  return parseImportBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}

/** Empreinte SHA-256 (32 premiers caractères hexadécimaux) : identifie le fichier pour reprendre un import. */
export async function fingerprintOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
