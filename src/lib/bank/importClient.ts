// Importation par blocs depuis le navigateur : analyse, correspondance des colonnes, envoi
// séquentiel de blocs de 200 lignes maximum, reprise d'un import interrompu et rapport.

import { adminRequest } from "./api.ts";
import type { NumberedRow, ParsedFile } from "./parse.ts";

export type Mapping = Record<string, string>;

export interface FieldInfo {
  id: string;
  label: string;
  required: boolean;
}
export interface PreviewRow {
  row: number;
  ok: boolean;
  question: null | { part: number; prompt: string; options: { key: string; text: string }[]; correctKey: string; difficulty: number; category: string | null };
  passage: null | { title: string; documents: { kind: string; title: string; body: string[] }[] };
  issues: { severity: "error" | "warning" | "info"; code: string; message: string }[];
}
export interface Analysis {
  fields: FieldInfo[];
  mapping: Mapping;
  unmapped: string[];
  missing: string[];
  needsDefaultPart: boolean;
  preview: PreviewRow[];
  categories: Record<number, string[]>;
  limits: { maxRows: number; chunkRows: number };
}
export interface ImportDefaults {
  defaultPart: 5 | 6 | 7 | null;
  defaultDifficulty: 1 | 2 | 3;
}
export interface BatchInfo {
  id: string;
  filename: string;
  status: "processing" | "completed" | "failed" | "cancelled";
  total_rows: number;
  rows_done: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  flagged: number;
  chunks_total: number;
  chunks_done: number[];
  resumed?: boolean;
}

export const CHUNK_ROWS = 200;
const PREVIEW_ROWS = 50;

/** Étape 1-2 : correspondance suggérée et aperçu des premières lignes. */
export function analyzeFile(parsed: ParsedFile, defaults: ImportDefaults, mapping?: Mapping): Promise<Analysis> {
  return adminRequest<Analysis>("bank-import-analyze", {
    headers: parsed.headers,
    rows: parsed.rows.slice(0, PREVIEW_ROWS).map((r) => r.data),
    ...(mapping ? { mapping } : {}),
    defaultPart: defaults.defaultPart,
    defaultDifficulty: defaults.defaultDifficulty,
  });
}

/**
 * Découpe en blocs sans séparer un document de ses questions (même règle que
 * server/bank/import.mjs : référence du document, sinon texte du premier document).
 */
export function chunkRows(rows: NumberedRow[], mapping: Mapping, size = CHUNK_ROWS): NumberedRow[][] {
  const limit = Math.min(Math.max(size, 1), 250);
  const column = mapping.passage_ref || mapping.doc1_text;
  const order: NumberedRow[][] = [];
  const byRef = new Map<string, NumberedRow[]>();
  for (const row of rows) {
    const ref = column ? String(row.data[column] ?? "").trim() : "";
    if (!ref) {
      order.push([row]);
      continue;
    }
    let group = byRef.get(ref);
    if (!group) {
      group = [];
      byRef.set(ref, group);
      order.push(group);
    }
    group.push(row);
  }
  const chunks: NumberedRow[][] = [];
  let current: NumberedRow[] = [];
  for (const group of order) {
    if (current.length && current.length + group.length > limit) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export interface ImportProgress {
  batchId: string;
  chunk: number;
  chunks: number;
  rowsDone: number;
  totalRows: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  flagged: number;
  resumed: boolean;
}

interface ChunkResponse {
  alreadyDone: boolean;
  batch: BatchInfo;
}

/**
 * Envoie le fichier bloc par bloc. Un import déjà commencé pour le même fichier est repris :
 * les blocs enregistrés sont ignorés. Chaque bloc est rejoué jusqu'à 4 fois en cas de coupure.
 */
export async function runImport(args: {
  parsed: ParsedFile;
  filename: string;
  fingerprint: string | null;
  mapping: Mapping;
  defaults: ImportDefaults;
  onProgress?: (p: ImportProgress) => void;
  signal?: AbortSignal;
}): Promise<BatchInfo> {
  const { parsed, mapping, defaults, signal } = args;
  const chunks = chunkRows(parsed.rows, mapping);
  const { batch } = await adminRequest<{ batch: BatchInfo }>("bank-import-start", {
    filename: args.filename,
    format: parsed.format,
    fingerprint: args.fingerprint,
    totalRows: parsed.rows.length,
    chunkSize: CHUNK_ROWS,
    chunksTotal: chunks.length,
    mapping,
  }, { signal, retries: 2 });
  let current = batch;
  const emit = (chunk: number) =>
    args.onProgress?.({
      batchId: current.id, chunk, chunks: chunks.length, rowsDone: current.rows_done, totalRows: current.total_rows,
      accepted: current.accepted, duplicates: current.duplicates, rejected: current.rejected, flagged: current.flagged,
      resumed: Boolean(batch.resumed),
    });
  emit(current.chunks_done.length);
  for (let i = 0; i < chunks.length; i += 1) {
    if (current.chunks_done.includes(i)) continue;
    if (signal?.aborted) throw new DOMException("Annulé", "AbortError");
    const res = await adminRequest<ChunkResponse>("bank-import-chunk", {
      batchId: batch.id, chunk: i, rows: chunks[i], mapping,
      defaultPart: defaults.defaultPart, defaultDifficulty: defaults.defaultDifficulty,
    }, { signal, retries: 3 });
    current = res.batch;
    emit(i + 1);
  }
  return current;
}
