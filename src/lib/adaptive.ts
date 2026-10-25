// Entraînement adaptatif : analyse de l'historique (bonnes réponses, vitesse, répétitions,
// évolution, objectifs) et recommandations de séances. Logique PURE, testée dans
// tests/adaptive.test.mjs. Les recommandations sont des suggestions : l'élève reste libre.

import { MAX_COUNTED_TIME_MS, type Attempt } from "./attempts.ts";
import type { Goals } from "./goals.ts";

const DAY_MS = 86_400_000;
/** Une réponse perd la moitié de son poids tous les 14 jours : l'état récent compte davantage. */
export const HALF_LIFE_DAYS = 14;
/** Temps moyen visé par question (ms) : ordre de grandeur d'un examen de 75 minutes. */
export const TARGET_TIME_MS: Record<number, number> = { 5: 25_000, 6: 35_000, 7: 60_000 };
/** Précision a priori d'une catégorie sans historique (évite de juger sur 1 ou 2 réponses). */
const PRIOR = 0.6;
const PRIOR_WEIGHT = 3;

export interface SkillStat {
  part: number;
  category: string;
  attempts: number;
  correct: number;
  /** Précision pondérée par l'ancienneté et lissée par l'a priori (0 à 1). */
  accuracy: number;
  avgTimeMs: number | null;
  /** > 1 : plus lent que la cible de la partie. */
  speedRatio: number | null;
  /** Variation de la précision entre les 5 dernières réponses et les 5 précédentes (-1 à 1). */
  trend: number | null;
  /** Questions ratées au moins deux fois. */
  repeatedErrors: number;
  lastAt: string | null;
  /** Besoin de travail (0 à 1) : plus c'est haut, plus la catégorie est prioritaire. */
  need: number;
}

const answered = (a: Attempt) => a.selectedKey !== "-" && Boolean(a.category);

/** Identifiants des dernières questions vues (récentes d'abord), pour proposer des questions inédites. */
export function recentSeenIds(attempts: Attempt[], parts: number[], max = 400): string[] {
  const ids: string[] = [];
  const known = new Set<string>();
  for (const a of [...attempts].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))) {
    if (!parts.includes(a.part) || known.has(a.questionId)) continue;
    known.add(a.questionId);
    ids.push(a.questionId);
    if (ids.length >= max) break;
  }
  return ids;
}

/** Compétences (partie × catégorie) de la plus urgente à la plus solide. */
export function analyzeSkills(attempts: Attempt[], now: Date = new Date()): SkillStat[] {
  const groups = new Map<string, Attempt[]>();
  for (const a of attempts.filter(answered)) {
    if (a.part === 2) continue; // Listening : hors du parcours de lecture
    const key = `${a.part}:${a.category}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const stats: SkillStat[] = [];
  for (const [key, list] of groups) {
    const [part, category] = [Number(key.split(":")[0]), key.slice(key.indexOf(":") + 1)];
    const sorted = [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); // récentes d'abord
    let weighted = 0;
    let weights = 0;
    let correct = 0;
    let time = 0;
    let timed = 0;
    const wrongByQuestion = new Map<string, number>();
    for (const a of sorted) {
      const age = Math.max(0, (now.getTime() - Date.parse(a.at)) / DAY_MS);
      const w = 0.5 ** (age / HALF_LIFE_DAYS);
      weighted += w * (a.correct ? 1 : 0);
      weights += w;
      if (a.correct) correct += 1;
      else wrongByQuestion.set(a.questionId, (wrongByQuestion.get(a.questionId) ?? 0) + 1);
      if (a.timeMs > 0) {
        time += Math.min(a.timeMs, MAX_COUNTED_TIME_MS);
        timed += 1;
      }
    }
    const n = sorted.length;
    const accuracy = (weighted + PRIOR * PRIOR_WEIGHT * (weights / n)) / (weights + PRIOR_WEIGHT * (weights / n));
    const avgTimeMs = timed ? Math.round(time / timed) : null;
    const speedRatio = avgTimeMs !== null ? avgTimeMs / (TARGET_TIME_MS[part] ?? 40_000) : null;
    let trend: number | null = null;
    if (n >= 8) {
      const rate = (xs: Attempt[]) => xs.filter((a) => a.correct).length / xs.length;
      trend = rate(sorted.slice(0, 5)) - rate(sorted.slice(5, 10));
    }
    const lastAt = sorted[0].at;
    const staleDays = (now.getTime() - Date.parse(lastAt)) / DAY_MS;
    const repeatedErrors = [...wrongByQuestion.values()].filter((c) => c >= 2).length;
    const need =
      (1 - accuracy) * 0.62 +
      (speedRatio !== null && speedRatio > 1.3 ? Math.min(0.15, (speedRatio - 1.3) * 0.15) : 0) +
      Math.min(0.12, staleDays / 30 * 0.12) +
      (trend !== null && trend < 0 ? Math.min(0.1, -trend * 0.2) : 0) +
      Math.min(0.1, repeatedErrors * 0.03);
    stats.push({ part, category, attempts: n, correct, accuracy, avgTimeMs, speedRatio, trend, repeatedErrors, lastAt, need });
  }
  return stats.sort((a, b) => b.need - a.need);
}

/** Difficulté progressive : on monte d'un niveau quand la catégorie est maîtrisée. */
export function difficultyFor(skill: Pick<SkillStat, "accuracy" | "attempts"> | undefined): 1 | 2 | 3 {
  if (!skill || skill.attempts < 3) return 2;
  if (skill.accuracy < 0.5) return 1;
  if (skill.accuracy < 0.8) return 2;
  return 3;
}

export type RecommendationKind = "review" | "targeted" | "mixed" | "unseen" | "progressive" | "exam";
export interface Recommendation {
  kind: RecommendationKind;
  title: string;
  reason: string;
  part?: number;
  category?: string;
  difficulty?: number;
  /** Questions (partie 5) ou documents (parties 6 et 7) de la série. */
  limit?: number;
  href: string;
}

/** Paramètres d'une série d'entraînement, transportés dans l'adresse (#/practice/part5?category=…). */
export interface SeriesParams {
  category?: string;
  categories?: string[];
  difficulty?: number;
  limit?: number;
  unseen?: boolean;
}

export function seriesHref(part: number, params: SeriesParams): string {
  const q = new URLSearchParams();
  if (params.categories?.length) q.set("categories", params.categories.join(","));
  else if (params.category) q.set("category", params.category);
  if (params.difficulty) q.set("difficulty", String(params.difficulty));
  if (params.limit) q.set("limit", String(params.limit));
  if (params.unseen) q.set("unseen", "1");
  const query = q.toString();
  return `#/practice/part${part}${query ? `?${query}` : ""}`;
}

/** Lit les paramètres d'une série dans l'adresse ; toute valeur invalide est ignorée. */
export function parseSeriesParams(search: string, part: number, validCategories: string[]): SeriesParams {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: SeriesParams = {};
  const category = q.get("category");
  if (category && validCategories.includes(category)) out.category = category;
  const categories = (q.get("categories") ?? "").split(",").filter((c) => validCategories.includes(c)).slice(0, 4);
  if (categories.length) out.categories = categories;
  const difficulty = Number(q.get("difficulty"));
  if ([1, 2, 3].includes(difficulty)) out.difficulty = difficulty;
  const limit = Number(q.get("limit"));
  const max = part === 5 ? 40 : 6;
  if (Number.isInteger(limit) && limit >= 1 && limit <= max) out.limit = limit;
  if (q.get("unseen") === "1") out.unseen = true;
  return out;
}

export interface PlanInput {
  attempts: Attempt[];
  /** Cartes à revoir maintenant (répétition espacée). */
  dueCount: number;
  goals?: Goals;
  /** Dernier score d'examen blanc, s'il existe. */
  lastExamScore?: number | null;
  now?: Date;
  labels?: Record<string, string>;
}

export interface AdaptivePlan {
  skills: SkillStat[];
  recommendations: Recommendation[];
  /** Questions visées aujourd'hui (objectif de l'élève). */
  dailyTarget: number;
  summary: string;
}

/**
 * Plan de séance : révisions dues, exercices ciblés sur les compétences les plus fragiles, séance mixte,
 * questions jamais vues et difficulté progressive. Sans historique, on propose un parcours de découverte.
 */
export function buildAdaptivePlan(input: PlanInput): AdaptivePlan {
  const now = input.now ?? new Date();
  const label = (c: string) => input.labels?.[c] ?? c;
  const skills = analyzeSkills(input.attempts, now);
  const daily = input.goals?.dailyGoal ?? 10;
  const recs: Recommendation[] = [];

  if (input.dueCount > 0) {
    recs.push({
      kind: "review", title: `Réviser ${input.dueCount} question${input.dueCount > 1 ? "s" : ""} à revoir`,
      reason: "Répétition espacée : ces questions reviennent au moment où vous risquez de les oublier.", href: "#/review",
    });
  }

  const weak = skills.filter((s) => s.attempts >= 2 && s.accuracy < 0.85).slice(0, 3);
  for (const s of weak) {
    const difficulty = difficultyFor(s);
    const why = [`${Math.round(s.accuracy * 100)} % de réussite sur ${s.attempts} réponse${s.attempts > 1 ? "s" : ""}`];
    if (s.speedRatio !== null && s.speedRatio > 1.3) why.push(`réponses ${Math.round((s.speedRatio - 1) * 100)} % plus lentes que la cible`);
    if (s.trend !== null && s.trend < -0.1) why.push("en baisse récemment");
    if (s.repeatedErrors > 0) why.push(`${s.repeatedErrors} question${s.repeatedErrors > 1 ? "s" : ""} ratée${s.repeatedErrors > 1 ? "s" : ""} plusieurs fois`);
    const limit = s.part === 5 ? 10 : s.part === 6 ? 2 : 2;
    recs.push({
      kind: "targeted", title: `Cibler : ${label(s.category)} (partie ${s.part})`, reason: why.join(" · "),
      part: s.part, category: s.category, difficulty, limit,
      href: seriesHref(s.part, { category: s.category, difficulty, limit, unseen: true }),
    });
  }

  // Séance mixte de partie 5 sur les catégories les plus fragiles (sinon sur toutes).
  const p5Weak = skills.filter((s) => s.part === 5 && s.accuracy < 0.9).slice(0, 3).map((s) => s.category);
  if (p5Weak.length >= 2) {
    recs.push({
      kind: "mixed", title: "Séance mixte de partie 5", reason: `Mélange de ${p5Weak.map(label).join(", ")} pour alterner les pièges.`,
      part: 5, limit: Math.max(10, Math.min(daily, 20)), href: seriesHref(5, { categories: p5Weak, limit: Math.max(10, Math.min(daily, 20)), unseen: true }),
    });
  }

  // Parties encore peu travaillées : questions jamais vues, niveau progressif.
  const attemptsByPart = new Map<number, number>();
  for (const a of input.attempts) attemptsByPart.set(a.part, (attemptsByPart.get(a.part) ?? 0) + 1);
  const leastPracticed = [5, 6, 7].sort((a, b) => (attemptsByPart.get(a) ?? 0) - (attemptsByPart.get(b) ?? 0))[0];
  recs.push({
    kind: "unseen", title: `Questions jamais vues · partie ${leastPracticed}`,
    reason: (attemptsByPart.get(leastPracticed) ?? 0) === 0 ? "Vous n'avez pas encore travaillé cette partie." : "La partie la moins travaillée : de nouvelles questions pour élargir votre entraînement.",
    part: leastPracticed, limit: leastPracticed === 5 ? 15 : 2, href: seriesHref(leastPracticed, { unseen: true, limit: leastPracticed === 5 ? 15 : 2 }),
  });

  const strong = skills.find((s) => s.attempts >= 5 && s.accuracy >= 0.8);
  if (strong) {
    recs.push({
      kind: "progressive", title: `Monter d'un cran : ${label(strong.category)} (partie ${strong.part})`,
      reason: `${Math.round(strong.accuracy * 100)} % de réussite : place aux questions avancées.`, part: strong.part, category: strong.category, difficulty: 3,
      limit: strong.part === 5 ? 10 : 2, href: seriesHref(strong.part, { category: strong.category, difficulty: 3, limit: strong.part === 5 ? 10 : 2, unseen: true }),
    });
  }

  if (input.goals?.examDate || input.goals?.targetScore) {
    const goal = input.goals.targetScore;
    recs.push({
      kind: "exam", title: "Examen blanc complet",
      reason: goal && input.lastExamScore ? `Objectif ${goal}, dernier score estimé ${input.lastExamScore} : mesurez votre progression.` : "Mesurez votre niveau en conditions réelles (100 questions, 75 minutes).",
      href: "#/exam",
    });
  }

  const summary = skills.length === 0
    ? "Pas encore d'historique : commencez par une série découverte, vos recommandations s'adapteront à vos réponses."
    : weak.length === 0
      ? "Vos résultats sont solides : consolidez avec des questions avancées ou un examen blanc."
      : `Priorité du moment : ${weak.map((s) => label(s.category)).join(", ")}.`;
  return { skills, recommendations: recs, dailyTarget: daily, summary };
}
