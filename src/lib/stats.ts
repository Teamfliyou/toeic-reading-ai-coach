// Statistiques calculées à partir de l'historique des tentatives (logique pure).
import { MAX_COUNTED_TIME_MS, type Attempt } from "./attempts.ts";

export interface Rate {
  total: number;
  correct: number;
  /** Pourcentage entier, ou null s'il n'y a aucune tentative. */
  rate: number | null;
}

export interface Stats {
  overall: Rate;
  avgTimeMs: number | null;
  byPart: Record<number, Rate>;
  /** Catégories triées de la plus fragile à la plus solide. */
  byCategory: (Rate & { category: string })[];
  /** Taux de réussite par jour (AAAA-MM-JJ), ordre chronologique. */
  progression: (Rate & { day: string })[];
}

const rate = (correct: number, total: number): Rate => ({
  total,
  correct,
  rate: total ? Math.round((correct / total) * 100) : null,
});

/** Jour local au format AAAA-MM-JJ. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function computeStats(attempts: Attempt[], maxDays = 30): Stats {
  const parts: Record<number, { total: number; correct: number }> = {};
  const cats = new Map<string, { total: number; correct: number }>();
  const days = new Map<string, { total: number; correct: number }>();
  let correct = 0;
  let timeSum = 0;
  let timeCount = 0;

  for (const a of attempts) {
    if (a.correct) correct += 1;
    const p = (parts[a.part] ??= { total: 0, correct: 0 });
    p.total += 1;
    if (a.correct) p.correct += 1;
    if (a.category) {
      const c = cats.get(a.category) ?? { total: 0, correct: 0 };
      c.total += 1;
      if (a.correct) c.correct += 1;
      cats.set(a.category, c);
    }
    const key = dayKey(a.at);
    const d = days.get(key) ?? { total: 0, correct: 0 };
    d.total += 1;
    if (a.correct) d.correct += 1;
    days.set(key, d);
    if (a.timeMs > 0 && a.timeMs <= MAX_COUNTED_TIME_MS) {
      timeSum += a.timeMs;
      timeCount += 1;
    }
  }

  return {
    overall: rate(correct, attempts.length),
    avgTimeMs: timeCount ? Math.round(timeSum / timeCount) : null,
    byPart: Object.fromEntries(
      Object.entries(parts).map(([part, v]) => [Number(part), rate(v.correct, v.total)])
    ),
    byCategory: [...cats.entries()]
      .map(([category, v]) => ({ category, ...rate(v.correct, v.total) }))
      .sort((a, b) => (a.rate ?? 0) - (b.rate ?? 0) || b.total - a.total),
    progression: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-maxDays)
      .map(([day, v]) => ({ day, ...rate(v.correct, v.total) })),
  };
}

/** Série de jours consécutifs avec au moins une tentative, jusqu'à aujourd'hui (ou hier). */
export function currentStreak(attempts: Attempt[], now: Date = new Date()): number {
  const active = new Set(attempts.map((a) => dayKey(a.at)));
  const cursor = new Date(now);
  if (!active.has(dayKey(cursor.toISOString()))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (active.has(dayKey(cursor.toISOString()))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
