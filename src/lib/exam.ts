// Examen blanc Reading : composition, chronomètre, correction et score estimé.
// Logique pure (aucun accès au navigateur), testée dans tests/exam.test.mjs.

export const EXAM_DURATION_MS = 75 * 60_000;

export interface ExamQuestionRef {
  id: string;
  part: number;
  orderIndex: number;
  correctKey: string;
}

export interface ExamState {
  /** Horodatages en ms (Date.now). */
  startedAt: number;
  deadline: number;
  questionIds: string[];
  answers: Record<string, string>;
  flagged: string[];
  /** Temps cumulé passé sur chaque question, en ms. */
  timeSpent: Record<string, number>;
  /** Renseigné quand l'examen est terminé (rendu ou temps écoulé). */
  finishedAt?: number;
  /** Vrai une fois les réponses enregistrées dans l'historique. */
  recorded?: boolean;
}

/**
 * Table de conversion APPROXIMATIVE : nombre de bonnes réponses sur 100 → score
 * Reading (5 à 495). Les barèmes officiels ETS varient d'une session à l'autre
 * et ne sont pas publiés ; il s'agit d'une estimation indicative.
 */
const CONVERSION: [number, number][] = [
  [0, 5], [10, 40], [20, 90], [30, 140], [40, 190], [50, 240],
  [60, 290], [70, 345], [80, 400], [90, 455], [100, 495],
];

/**
 * Score Reading estimé (5 à 495, par pas de 5). Si l'examen compte moins de
 * 100 questions, la proportion de bonnes réponses est ramenée à 100.
 */
export function estimateReadingScore(correct: number, total: number): number {
  if (!(total > 0)) return 5;
  const ratio = Math.min(Math.max(correct / total, 0), 1) * 100;
  for (let i = 1; i < CONVERSION.length; i += 1) {
    const [x1, y1] = CONVERSION[i];
    if (ratio <= x1) {
      const [x0, y0] = CONVERSION[i - 1];
      const value = y0 + ((ratio - x0) / (x1 - x0)) * (y1 - y0);
      return Math.min(495, Math.max(5, Math.round(value / 5) * 5));
    }
  }
  return 495;
}

/** Ordre de l'examen : partie 5, puis 6, puis 7, chacune dans l'ordre du jeu de données. */
export function buildExam(questions: ExamQuestionRef[]): string[] {
  return [...questions]
    .filter((q) => [5, 6, 7].includes(q.part))
    .sort((a, b) => a.part - b.part || a.orderIndex - b.orderIndex)
    .map((q) => q.id);
}

export function newExamState(questionIds: string[], now: number, durationMs = EXAM_DURATION_MS): ExamState {
  return {
    startedAt: now,
    deadline: now + durationMs,
    questionIds,
    answers: {},
    flagged: [],
    timeSpent: {},
  };
}

export function remainingMs(state: ExamState, now: number): number {
  if (state.finishedAt) return 0;
  return Math.max(0, state.deadline - now);
}

/** Format « 74:59 » (ou « 1:14:59 » au-delà d'une heure). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function toggleFlag(state: ExamState, id: string): ExamState {
  const flagged = state.flagged.includes(id)
    ? state.flagged.filter((x) => x !== id)
    : [...state.flagged, id];
  return { ...state, flagged };
}

export function setAnswer(state: ExamState, id: string, key: string): ExamState {
  if (state.finishedAt) return state;
  return { ...state, answers: { ...state.answers, [id]: key } };
}

export function addTime(state: ExamState, id: string, ms: number): ExamState {
  if (state.finishedAt || !(ms > 0)) return state;
  return { ...state, timeSpent: { ...state.timeSpent, [id]: (state.timeSpent[id] ?? 0) + ms } };
}

export interface ExamResult {
  total: number;
  correct: number;
  answered: number;
  unanswered: string[];
  wrong: string[];
  byPart: Record<number, { total: number; correct: number }>;
  /** Score Reading estimé (5 à 495). */
  score: number;
  /** Vrai si l'examen compte moins de 100 questions (score extrapolé). */
  reduced: boolean;
}

/** Corrige l'examen : une question sans réponse compte comme fausse. */
export function gradeExam(state: ExamState, questions: ExamQuestionRef[]): ExamResult {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const byPart: ExamResult["byPart"] = {};
  const wrong: string[] = [];
  const unanswered: string[] = [];
  let correct = 0;
  let answered = 0;
  let total = 0;
  for (const id of state.questionIds) {
    const q = byId.get(id);
    if (!q) continue;
    total += 1;
    const part = (byPart[q.part] ??= { total: 0, correct: 0 });
    part.total += 1;
    const answer = state.answers[id];
    if (!answer) {
      unanswered.push(id);
      continue;
    }
    answered += 1;
    if (answer === q.correctKey) {
      correct += 1;
      part.correct += 1;
    } else wrong.push(id);
  }
  return {
    total,
    correct,
    answered,
    unanswered,
    wrong,
    byPart,
    score: estimateReadingScore(correct, total),
    reduced: total < 100,
  };
}
