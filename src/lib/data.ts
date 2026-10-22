import type { Question, Passage, Part } from "./types";
import rawData from "../../data/questions.json";
import { supabaseUrl, supabasePublishableKey } from "./supabaseConfig";

type Dataset = { passages: Passage[]; questions: Question[] };
const fallback = rawData as Dataset;
const localByPrompt = new Map(fallback.questions.map((q) => [q.prompt, q]));

export function getQuestions(part: Part): Question[] {
  return fallback.questions.filter((q) => q.part === part).sort((a,b) => a.orderIndex - b.orderIndex);
}
export function getPassages(part: Part): Passage[] {
  return fallback.passages.filter((p) => p.part === part);
}

async function fetchRows(table: "questions" | "passages", part: Part): Promise<Record<string, unknown>[]> {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("part", `eq.${part}`);
  url.searchParams.set("select", "*");
  if (table === "questions") url.searchParams.set("order", "order_index.asc");
  const response = await fetch(url.toString(), {
    headers: { apikey: supabasePublishableKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase ${table}: HTTP ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("Réponse Supabase invalide");
  return rows as Record<string, unknown>[];
}

/** Toutes les questions de lecture (parties 5 à 7), chaque partie avec son repli local. */
export async function loadAll(): Promise<Dataset> {
  const parts = await Promise.all(([5, 6, 7] as Part[]).map((part) => loadPart(part)));
  return {
    questions: parts.flatMap((p) => p.questions),
    passages: parts.flatMap((p) => p.passages),
  };
}

/** Charge Supabase en priorité et conserve le JSON local en secours. */
export async function loadPart(part: Part): Promise<Dataset> {
  try {
    const [questions, passages] = await Promise.all([
      fetchRows("questions", part),
      part === 5 ? Promise.resolve([]) : fetchRows("passages", part),
    ]);
    if (!questions.length) throw new Error("Aucune question disponible dans Supabase");
    return {
      questions: questions.map((q) => ({
        id: (q.slug as string | null) ?? (q.id as string), part: q.part as Part, passageId: q.passage_id as string | null,
        orderIndex: q.order_index as number, prompt: q.prompt as string,
        options: q.options as Question["options"], correctKey: q.correct_key as Question["correctKey"],
        difficulty: q.difficulty as Question["difficulty"],
        // Avant la migration SQL, la catégorie est reprise du jeu local (même énoncé).
        category: (q.category as string | null) ?? localByPrompt.get(q.prompt as string)?.category,
        tags: Array.isArray(q.tags) && q.tags.length ? (q.tags as string[]) : localByPrompt.get(q.prompt as string)?.tags,
      })),
      passages: passages.map((p) => ({
        id: p.id as string, part: p.part as Part, title: p.title as string,
        documents: p.documents as Passage["documents"],
      })),
    };
  } catch (error) {
    console.warn("Supabase inaccessible : chargement du jeu local.", error);
    return { questions: getQuestions(part), passages: part === 5 ? [] : getPassages(part) };
  }
}
