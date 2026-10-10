import type { Question, Passage, Part } from "./types";
import rawData from "../../data/questions.json";

type Dataset = {
  passages: Passage[];
  questions: Question[];
};

const fallback = rawData as Dataset;

/**
 * Couche de données.
 *
 * Les questions sont chargées depuis le jeu de données local embarqué
 * (`data/questions.json`) : aucune configuration requise pour tester.
 *
 * Pour brancher Supabase plus tard, remplacez ces fonctions par des appels
 * à l'API REST PostgREST (voir `supabase/schema.sql` et `supabase/seed.sql`).
 */

export function getQuestions(part: Part): Question[] {
  return fallback.questions
    .filter((q) => q.part === part)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export function getPassages(part: Part): Passage[] {
  return fallback.passages.filter((p) => p.part === part);
}
