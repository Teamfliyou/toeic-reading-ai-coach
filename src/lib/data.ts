import type { Part, Question, Passage } from "./types";
import rawData from "../../data/questions.json";
import { supabaseUrl, supabasePublishableKey } from "./supabaseConfig";
import { examCandidates, loadByIds, pickSet, type Dataset, type ExamPool, type PickOptions, type PickedSet, type Source } from "./bank/practice";

const fallback = rawData as Dataset;

const source = (): Source => ({ url: supabaseUrl, key: supabasePublishableKey, local: fallback });

export type { Dataset, ExamPool, PickOptions, PickedSet };

/** Jeu local complet (33 questions) : secours hors ligne, jamais la banque Supabase. */
export function getQuestions(part: Part): Question[] {
  return fallback.questions.filter((q) => q.part === part).sort((a,b) => a.orderIndex - b.orderIndex);
}
export function getPassages(part: Part): Passage[] {
  return fallback.passages.filter((p) => p.part === part);
}

/**
 * Une série d'exercices pour une partie (20 questions en partie 5, 3 documents en parties 6 et 7
 * par défaut). La banque peut compter 100 000 questions : seule la série demandée est chargée,
 * tirée au hasard côté serveur, les questions déjà vues passant en dernier. Si Supabase est
 * inaccessible, le jeu local (data/questions.json) prend le relais.
 */
export function loadPart(part: Part, options: PickOptions = {}): Promise<PickedSet> {
  return pickSet(source(), part, options);
}

/** Questions (et documents) retrouvées par identifiant : révision espacée, historique. */
export function loadQuestionsByIds(ids: string[]): Promise<Dataset> {
  return loadByIds(source(), ids);
}

/** Candidats pour composer un examen Reading complet. */
export function loadExamPool(exclude: string[] = []): Promise<ExamPool> {
  return examCandidates(source(), exclude);
}

export interface SeriesRequest {
  category?: string;
  /** Séance mixte (partie 5) : plusieurs catégories alternées. */
  categories?: string[];
  difficulty?: number;
  limit?: number;
}

/**
 * Série d'entraînement avec filtres : une catégorie, ou un mélange de catégories en partie 5.
 * Les questions déjà vues (`exclude`) ne sont proposées qu'en dernier recours.
 */
export async function loadSeries(part: Part, request: SeriesRequest = {}, exclude: string[] = []): Promise<PickedSet> {
  const { categories, ...rest } = request;
  if (!categories || categories.length < 2 || part !== 5) {
    return pickSet(source(), part, { ...rest, category: rest.category ?? categories?.[0], exclude });
  }
  const limit = rest.limit ?? 15;
  const per = Math.ceil(limit / categories.length);
  const sets = await Promise.all(categories.map((category) => pickSet(source(), part, { limit: per, difficulty: rest.difficulty, category, exclude })));
  const seen = new Set<string>();
  const questions = sets.flatMap((s) => s.questions).filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)));
  // Alternance des catégories (et non un bloc par catégorie).
  const mixed = [...questions].sort(() => Math.random() - 0.5).slice(0, limit);
  return {
    passages: [],
    questions: mixed,
    origin: sets.some((s) => s.origin === "local") ? "local" : sets[0].origin,
    relaxed: [...new Set(sets.flatMap((s) => s.relaxed))],
  };
}
