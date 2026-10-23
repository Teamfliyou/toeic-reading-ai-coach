// Objectif et plan d'étude : date d'examen, score visé, objectif quotidien, série.
// Logique pure et testée (tests/goals.test.mjs).
import { dayKey } from "./stats.ts";
import type { Attempt } from "./attempts.ts";

export interface Goals {
  /** Date de l'examen au format AAAA-MM-JJ, ou null. */
  examDate: string | null;
  /** Score Reading visé (5 à 495), ou null. */
  targetScore: number | null;
  /** Nombre de questions à traiter chaque jour. */
  dailyGoal: number;
  updatedAt: string;
}

export const DEFAULT_GOALS: Goals = { examDate: null, targetScore: null, dailyGoal: 10, updatedAt: "1970-01-01T00:00:00.000Z" };
const DAY_MS = 86_400_000;

export interface GoalsInput {
  examDate?: string | null;
  targetScore?: number | string | null;
  dailyGoal?: number | string | null;
}

/** Valide la saisie du formulaire ; renvoie des objectifs cohérents ou un message en français. */
export function validateGoals(
  input: GoalsInput,
  now: Date = new Date()
): { ok: true; value: Omit<Goals, "updatedAt"> } | { ok: false; error: string } {
  let examDate: string | null = null;
  if (input.examDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.examDate)) return { ok: false, error: "Date d'examen invalide." };
    const date = new Date(`${input.examDate}T12:00:00`);
    if (Number.isNaN(date.getTime()) || dayKey(date.toISOString()) !== input.examDate) {
      return { ok: false, error: "Date d'examen invalide." };
    }
    if (input.examDate < dayKey(now.toISOString())) return { ok: false, error: "La date d'examen doit être aujourd'hui ou plus tard." };
    examDate = input.examDate;
  }

  let targetScore: number | null = null;
  if (input.targetScore !== null && input.targetScore !== undefined && input.targetScore !== "") {
    const value = Number(input.targetScore);
    if (!Number.isInteger(value) || value < 5 || value > 495) {
      return { ok: false, error: "Le score visé doit être un entier entre 5 et 495." };
    }
    targetScore = value;
  }

  const daily = Number(input.dailyGoal ?? DEFAULT_GOALS.dailyGoal);
  if (!Number.isInteger(daily) || daily < 1 || daily > 200) {
    return { ok: false, error: "L'objectif quotidien doit être un entier entre 1 et 200 questions." };
  }
  return { ok: true, value: { examDate, targetScore, dailyGoal: daily } };
}

/** Jours restants jusqu'à l'examen (0 = aujourd'hui), ou null sans date. */
export function daysUntil(examDate: string | null, now: Date = new Date()): number | null {
  if (!examDate) return null;
  const today = new Date(`${dayKey(now.toISOString())}T12:00:00`).getTime();
  const exam = new Date(`${examDate}T12:00:00`).getTime();
  return Math.round((exam - today) / DAY_MS);
}

/** Nombre de questions traitées aujourd'hui (Reading et Listening). */
export function answeredToday(attempts: Attempt[], now: Date = new Date()): number {
  const today = dayKey(now.toISOString());
  return attempts.filter((a) => dayKey(a.at) === today).length;
}

export interface ExamRecord {
  at: string;
  score: number;
  correct: number;
  total: number;
}

export function latestExamScore(history: ExamRecord[]): number | null {
  if (!history.length) return null;
  return [...history].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0].score;
}

export interface StudyPlan {
  daysLeft: number | null;
  weeksLeft: number | null;
  /** Écart entre le score visé et le dernier examen blanc (null si l'un des deux manque). */
  gap: number | null;
  recommendedDaily: number;
  mockExamsPerWeek: number;
  /** Catégories les plus fragiles à travailler en priorité. */
  focus: string[];
  summary: string;
}

/**
 * Plan d'étude INDICATIF. Hypothèse simple et assumée : chaque point de score à
 * gagner demande environ deux questions travaillées. On répartit cet effort sur
 * les jours restants, sans descendre sous l'objectif quotidien choisi.
 */
export function buildPlan(options: {
  goals: Goals;
  lastExamScore: number | null;
  weakCategories: string[];
  now?: Date;
}): StudyPlan {
  const { goals, lastExamScore, weakCategories } = options;
  const daysLeft = daysUntil(goals.examDate, options.now);
  const gap =
    goals.targetScore !== null && lastExamScore !== null ? Math.max(0, goals.targetScore - lastExamScore) : null;

  let recommended = goals.dailyGoal;
  if (daysLeft !== null && daysLeft > 0 && gap !== null && gap > 0) {
    recommended = Math.min(60, Math.max(goals.dailyGoal, Math.ceil((gap * 2) / daysLeft)));
  }
  const weeksLeft = daysLeft === null ? null : Math.max(0, Math.ceil(daysLeft / 7));
  const mockExamsPerWeek = daysLeft !== null && daysLeft >= 14 ? 1 : 0;

  let summary: string;
  if (daysLeft === null) summary = "Ajoutez une date d'examen pour obtenir un plan jusqu'au jour J.";
  else if (daysLeft === 0) summary = "L'examen est aujourd'hui : relisez vos fiches et reposez-vous. Bonne chance !";
  else if (gap === null) summary = `Il reste ${daysLeft} jour(s). Passez un examen blanc pour mesurer votre point de départ.`;
  else if (gap === 0) summary = `Il reste ${daysLeft} jour(s) : votre dernier examen blanc atteint déjà l'objectif, consolidez avec ${recommended} questions par jour.`;
  else summary = `Il reste ${daysLeft} jour(s) et ${gap} points à gagner : environ ${recommended} questions par jour${mockExamsPerWeek ? " et un examen blanc par semaine" : ""}.`;

  return { daysLeft, weeksLeft, gap, recommendedDaily: recommended, mockExamsPerWeek, focus: weakCategories.slice(0, 3), summary };
}
