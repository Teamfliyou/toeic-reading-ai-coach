// Carnet de vocabulaire : mots enregistrés depuis les explications, révisés avec
// les mêmes boîtes Leitner que les questions (srs.ts). Logique pure et testée.
import { applyAnswer, isDue, type ReviewCard } from "./srs.ts";

export interface VocabWord {
  id: string;
  term: string;
  meaning: string;
  example: string;
  sourceQuestionId?: string;
  createdAt: string;
  updatedAt: string;
  box: number;
  due: string;
  mastered: boolean;
  lapses: number;
  /** Mot supprimé : conservé comme « pierre tombale » pour que la suppression se synchronise. */
  deleted?: boolean;
}

export const LIMITS = { term: 80, meaning: 300, example: 300 } as const;

export interface WordInput {
  term: string;
  meaning: string;
  example?: string;
  sourceQuestionId?: string;
}

const clean = (value: unknown, max: number) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const normalizeTerm = (term: string) => term.normalize("NFC").toLowerCase().trim();

/** Valide une saisie ; renvoie le mot nettoyé ou un message d'erreur en français. */
export function validateWord(
  input: WordInput,
  existing: VocabWord[]
): { ok: true; value: Required<Pick<WordInput, "term" | "meaning" | "example">> & WordInput } | { ok: false; error: string } {
  const term = clean(input.term, LIMITS.term);
  const meaning = clean(input.meaning, LIMITS.meaning);
  const example = clean(input.example, LIMITS.example);
  if (!term) return { ok: false, error: "Saisissez le mot ou l'expression." };
  if (!meaning) return { ok: false, error: "Ajoutez son sens en français pour pouvoir le réviser." };
  if (existing.some((w) => !w.deleted && normalizeTerm(w.term) === normalizeTerm(term))) {
    return { ok: false, error: "Ce mot est déjà dans votre carnet." };
  }
  return { ok: true, value: { ...input, term, meaning, example } };
}

export function createWord(
  value: { term: string; meaning: string; example: string; sourceQuestionId?: string },
  id: string,
  now: Date = new Date()
): VocabWord {
  const iso = now.toISOString();
  return {
    id,
    term: value.term,
    meaning: value.meaning,
    example: value.example,
    sourceQuestionId: value.sourceQuestionId,
    createdAt: iso,
    updatedAt: iso,
    box: 1,
    due: iso, // à réviser dès maintenant
    mastered: false,
    lapses: 0,
  };
}

const toCard = (w: VocabWord): ReviewCard => ({
  questionId: w.id,
  part: 0,
  box: w.box,
  due: w.due,
  mastered: w.mastered,
  lapses: w.lapses,
  updatedAt: w.updatedAt,
});

/** Applique une révision (« je savais » / « à revoir ») avec la logique Leitner. */
export function reviewWord(word: VocabWord, correct: boolean, now: Date = new Date()): VocabWord {
  const [card] = applyAnswer([toCard(word)], { questionId: word.id, part: 0, correct }, now);
  return { ...word, box: card.box, due: card.due, mastered: card.mastered, lapses: card.lapses, updatedAt: card.updatedAt };
}

export function dueWords(words: VocabWord[], now: Date = new Date()): VocabWord[] {
  return words
    .filter((w) => !w.deleted && isDue(toCard(w), now))
    .sort((a, b) => a.box - b.box || Date.parse(a.due) - Date.parse(b.due));
}

export const activeWords = (words: VocabWord[]) => words.filter((w) => !w.deleted);

export function markDeleted(word: VocabWord, now: Date = new Date()): VocabWord {
  return { ...word, deleted: true, updatedAt: now.toISOString() };
}

/** Fusion de deux listes (appareils différents) : la version la plus récente de chaque mot gagne. */
export function mergeWords(local: VocabWord[], remote: VocabWord[]): VocabWord[] {
  const byId = new Map<string, VocabWord>();
  for (const word of [...local, ...remote]) {
    const known = byId.get(word.id);
    if (!known || Date.parse(word.updatedAt) > Date.parse(known.updatedAt)) byId.set(word.id, word);
  }
  return [...byId.values()];
}

/**
 * Propose un exemple à partir d'une phrase à trous : le blanc est remplacé par la
 * bonne réponse. Renvoie une chaîne vide si l'énoncé n'a pas de blanc (Part 7).
 */
export function exampleFromPrompt(prompt: string, answer: string): string {
  if (!/(\(\d+\))?\s*_{3,}/.test(prompt)) return "";
  return prompt.replace(/(\(\d+\))?\s*_{3,}/, ` ${answer}`).replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}
