// Listening centralisé (Partie 2 aujourd'hui) : validation et importation en masse.
// Les enregistrements audio ne sont JAMAIS fabriqués ici : une piste n'existe que si une URL
// d'enregistrement (ou de synthèse vocale produite hors de l'application) est fournie.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { BankError, rpc } from "./db.mjs";
import { looksFrench } from "./language.mjs";
import { norm } from "./text.mjs";

const CATEGORIES = JSON.parse(readFileSync(new URL("../../data/categories.json", import.meta.url), "utf8"));
const LISTENING_CATEGORIES = CATEGORIES.filter((c) => c.parts.includes(2)).map((c) => c.id);

export const MAX_ROWS = 250;
const AUDIO_URL = /^(https:\/\/|\/)[^\s]+\.(mp3|m4a|ogg|wav)$/i;

const itemSchema = z.object({
  prompt: z.string().trim().min(5).max(400),
  transcript: z.string().trim().max(2000).optional(),
  options: z.array(z.object({ key: z.enum(["A", "B", "C"]), text: z.string().trim().min(1).max(300) })).length(3)
    .refine((o) => o.every((x, i) => x.key === "ABC"[i]), "réponses A, B, C dans l'ordre"),
  correct_key: z.enum(["A", "B", "C"]),
  difficulty: z.number().int().min(1).max(3),
  category: z.string().nullable().optional(),
  theme: z.string().max(80).nullable().optional(),
  audio_url: z.string().regex(AUDIO_URL, "URL audio invalide (https ou chemin, .mp3/.m4a/.ogg/.wav)").nullable().optional(),
  duration_ms: z.number().int().min(500).max(600000).nullable().optional(),
  speaker: z.string().max(80).nullable().optional(),
  provider: z.enum(["recording", "tts", "external"]).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/i).nullable().optional(),
});

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());
const pick = (row, ...names) => {
  for (const n of names) if (text(row[n])) return text(row[n]);
  return "";
};

/** Ligne tabulaire (en-têtes libres anglais/français) → exercice Listening ou liste d'erreurs. */
export function normalizeListeningRow(row) {
  const errors = [];
  const options = ["a", "b", "c"].map((k) => ({ key: k.toUpperCase(), text: pick(row, `option_${k}`, `option ${k}`, k, `reponse_${k}`, `response_${k}`, `choice_${k}`) }));
  const correctRaw = pick(row, "correct", "correct_key", "answer", "bonne_reponse", "reponse");
  const letter = correctRaw.match(/^[([]?\s*([A-Ca-c1-3])\s*[)\].:]?$/);
  const correct = letter ? (/\d/.test(letter[1]) ? "ABC"[Number(letter[1]) - 1] : letter[1].toUpperCase()) : "";
  const difficultyRaw = pick(row, "difficulty", "difficulte", "level");
  const difficulty = difficultyRaw ? Number(difficultyRaw) : 2;
  const item = {
    prompt: pick(row, "prompt", "question", "enonce", "énoncé"),
    transcript: pick(row, "transcript", "transcription") || undefined,
    options,
    correct_key: correct,
    difficulty,
    category: pick(row, "category", "categorie", "catégorie") || null,
    theme: pick(row, "theme", "thème") || null,
    audio_url: pick(row, "audio_url", "audio", "url") || null,
    duration_ms: pick(row, "duration_ms") ? Number(pick(row, "duration_ms")) : null,
    speaker: pick(row, "speaker", "voix") || null,
    provider: pick(row, "provider") || undefined,
    slug: pick(row, "slug", "id", "external_id") || null,
  };
  const parsed = itemSchema.safeParse(item);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push({ code: "schema", message: `${i.path.join(".") || "ligne"} : ${i.message}` });
    return { item: null, errors, warnings: [] };
  }
  const data = parsed.data;
  const warnings = [];
  if ([data.prompt, ...data.options.map((o) => o.text)].some(looksFrench)) errors.push({ code: "not_english", message: "Le contenu Listening doit être en anglais." });
  if (new Set(data.options.map((o) => norm(o.text))).size < 3) errors.push({ code: "duplicate_options", message: "Deux réponses sont identiques." });
  if (data.category && !LISTENING_CATEGORIES.includes(data.category)) {
    warnings.push({ code: "unknown_category", message: `Catégorie « ${data.category} » inconnue pour la partie 2 : ignorée.` });
    data.category = null;
  }
  if (!data.audio_url) warnings.push({ code: "no_audio", message: "Aucun enregistrement : la synthèse vocale du navigateur sera utilisée (qualité variable)." });
  if (!data.transcript) data.transcript = [data.prompt, ...data.options.map((o) => `${o.key}. ${o.text}`)].join(" ");
  return { item: data, errors, warnings };
}

const bodySchema = z.object({
  rows: z.array(z.record(z.string(), z.union([z.string().max(4000), z.number(), z.null()]))).min(1).max(MAX_ROWS),
});

/** Importe un lot (250 lignes max). Idempotent : rejouer un lot ne crée aucun doublon. */
export async function importListening(body, actor) {
  const { rows } = bodySchema.parse(body);
  const items = [];
  const issues = [];
  const bad = new Set();
  rows.forEach((row, i) => {
    const ref = String(i + 1);
    const r = normalizeListeningRow(row);
    for (const w of r.warnings) issues.push({ ref, severity: "warning", code: w.code, message: w.message });
    if (r.errors.length) {
      bad.add(ref);
      for (const e of r.errors) issues.push({ ref, severity: "error", code: e.code, message: e.message });
      return;
    }
    items.push({ ref, part: 2, item: { ...r.item, needs_review: r.warnings.length > 0 } });
  });
  let result = { inserted: 0, duplicates: 0, results: [] };
  if (items.length) result = await rpc("listening_insert_items", { p_items: items, p_ctx: { status: "draft", source: "import", actor } });
  return { inserted: result.inserted, duplicates: result.duplicates, rejected: bad.size, issues };
}

export async function listListening(body) {
  const status = ["draft", "review", "published", "archived"].includes(body?.status) ? body.status : null;
  return rpc("listening_admin_list", { p_status: status, p_limit: Math.min(Number(body?.limit) || 25, 100), p_offset: Math.max(Number(body?.offset) || 0, 0) });
}

const statusSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  status: z.enum(["draft", "review", "published", "archived"]),
  ack: z.boolean().default(false),
});
export async function setListeningStatus(body, actor) {
  const input = statusSchema.parse(body);
  return rpc("listening_set_status", { p_ids: input.ids, p_status: input.status, p_actor: actor, p_ack: input.ack });
}

export { BankError };
