// Composition d'un examen Reading complet : 100 questions, 75 minutes.
//   Partie 5 : 30 questions · Partie 6 : 16 questions (4 documents de 4 trous) ·
//   Partie 7 : 54 questions (ensembles de documents cohérents, de 2 à 5 questions).
//
// Logique pure (aucun accès réseau ni navigateur), testée dans tests/exam-builder.test.mjs.
// Un document n'est JAMAIS coupé : toutes ses questions entrent dans l'examen ou aucune.

import type { Passage, Question } from "./types.ts";

export const EXAM_TARGET = { p5: 30, p6: 16, p7: 54 } as const;
export const EXAM_TOTAL = EXAM_TARGET.p5 + EXAM_TARGET.p6 + EXAM_TARGET.p7;
/** Répartition cible des difficultés (facile / intermédiaire / avancée) pour la partie 5. */
const P5_MIX = [0.3, 0.45, 0.25] as const;

export interface Pool {
  p5: Question[];
  p6: { passages: Passage[]; questions: Question[] };
  p7: { passages: Passage[]; questions: Question[] };
}

export interface BuiltExam {
  /** Questions dans l'ordre de l'examen (parties 5, 6 puis 7). */
  questions: Question[];
  /** Documents utilisés (parties 6 et 7). */
  passages: Passage[];
  counts: { p5: number; p6: number; p7: number };
  /** Vrai si l'examen ne compte pas exactement 30 + 16 + 54 questions : examen RÉDUIT. */
  reduced: boolean;
  /** Questions manquantes par partie par rapport à un examen complet. */
  shortfall: { p5: number; p6: number; p7: number };
  /** Questions déjà vues dans cet examen (la banque n'avait pas assez d'inédites). */
  repeated: number;
  difficulty: { 1: number; 2: number; 3: number };
}

type Rng = () => number;

function shuffle<T>(list: T[], rng: Rng): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Partie 5 : 30 questions, inédites d'abord, difficultés réparties 30 % / 45 % / 25 %. */
export function pickPart5(pool: Question[], seen: Set<string>, rng: Rng): Question[] {
  const unique = new Map<string, Question>();
  for (const q of pool) if (q.part === 5 && !q.passageId) unique.set(q.id, q);
  const ordered = (items: Question[]) => [...shuffle(items.filter((q) => !seen.has(q.id)), rng), ...shuffle(items.filter((q) => seen.has(q.id)), rng)];
  const all = [...unique.values()];
  const target = EXAM_TARGET.p5;
  // 9 faciles, 14 intermédiaires, 7 avancées pour 30 questions.
  const easy = Math.round(P5_MIX[0] * target);
  const hard = Math.floor(P5_MIX[2] * target);
  const quotas = [easy, target - easy - hard, hard];
  const chosen: Question[] = [];
  const used = new Set<string>();
  ([1, 2, 3] as const).forEach((level, i) => {
    for (const q of ordered(all.filter((x) => x.difficulty === level)).slice(0, quotas[i])) {
      chosen.push(q);
      used.add(q.id);
    }
  });
  // Un niveau en manque est complété par les autres niveaux (inédites d'abord).
  for (const q of ordered(all.filter((x) => !used.has(x.id)))) {
    if (chosen.length >= target) break;
    chosen.push(q);
  }
  return shuffle(chosen.slice(0, target), rng);
}

interface PassageSet {
  passage: Passage;
  questions: Question[];
  unseen: boolean;
}

function groupSets(data: Pool["p6"], seen: Set<string>): PassageSet[] {
  const byId = new Map(data.passages.map((p) => [p.id, p]));
  const groups = new Map<string, Question[]>();
  for (const q of data.questions) if (q.passageId && byId.has(q.passageId)) groups.set(q.passageId, [...(groups.get(q.passageId) ?? []), q]);
  return [...groups.entries()].map(([id, questions]) => ({
    passage: byId.get(id)!,
    questions: [...questions].sort((a, b) => a.orderIndex - b.orderIndex),
    unseen: questions.every((q) => !seen.has(q.id)),
  }));
}

/** Partie 6 : 4 documents de 4 trous, inédits d'abord, niveaux variés. */
export function pickPart6(data: Pool["p6"], seen: Set<string>, rng: Rng): PassageSet[] {
  const sets = shuffle(groupSets(data, seen).filter((s) => s.questions.length === 4), rng);
  const ordered = [...sets.filter((s) => s.unseen), ...sets.filter((s) => !s.unseen)];
  const picked: PassageSet[] = [];
  const level = (s: PassageSet) => s.questions.reduce((n, q) => n + q.difficulty, 0) / s.questions.length;
  while (picked.length < EXAM_TARGET.p6 / 4 && ordered.length) {
    // Parmi les 3 meilleurs candidats, on garde celui qui rapproche la moyenne de 2 (niveau intermédiaire).
    const window = ordered.slice(0, 3);
    const avg = picked.length ? picked.reduce((n, s) => n + level(s), 0) / picked.length : 2;
    const best = window.reduce((a, b) => (Math.abs((avg * picked.length + level(a)) / (picked.length + 1) - 2) <= Math.abs((avg * picked.length + level(b)) / (picked.length + 1) - 2) ? a : b));
    picked.push(best);
    ordered.splice(ordered.indexOf(best), 1);
  }
  return picked;
}

/**
 * Partie 7 : choisit des ensembles de documents dont le total vaut EXACTEMENT 54 questions
 * (sac à dos). Les ensembles inédits et à plusieurs documents sont favorisés. Si 54 est
 * inatteignable, le plus grand total possible est retenu (examen réduit).
 */
export function pickPart7(data: Pool["p7"], seen: Set<string>, rng: Rng): PassageSet[] {
  const target = EXAM_TARGET.p7;
  const sets = shuffle(groupSets(data, seen).filter((s) => s.questions.length >= 2 && s.questions.length <= 5), rng);
  const weight = (s: PassageSet) => (s.unseen ? 10 : 0) + (s.passage.documents.length > 1 ? 3 : 0) + rng();
  // best[t] = meilleur poids pour un total de t questions ; choice[i][t] = ensemble i retenu.
  const best: number[] = Array(target + 1).fill(-Infinity);
  best[0] = 0;
  const take: boolean[][] = sets.map(() => Array(target + 1).fill(false));
  sets.forEach((s, i) => {
    const size = s.questions.length;
    const w = weight(s);
    for (let t = target; t >= size; t -= 1) {
      if (best[t - size] + w > best[t]) {
        best[t] = best[t - size] + w;
        take[i][t] = true;
      }
    }
  });
  let total = target;
  while (total > 0 && best[total] === -Infinity) total -= 1;
  const chosen: PassageSet[] = [];
  for (let i = sets.length - 1, t = total; i >= 0 && t > 0; i -= 1) {
    if (take[i][t]) {
      chosen.push(sets[i]);
      t -= sets[i].questions.length;
    }
  }
  // Documents simples d'abord, puis ensembles à plusieurs documents (ordre habituel de l'examen).
  return chosen.sort((a, b) => a.passage.documents.length - b.passage.documents.length);
}

/** Compose l'examen à partir d'un lot de candidats (voir `loadExamPool`). */
export function buildReadingExam(pool: Pool, seenIds: Iterable<string> = [], rng: Rng = Math.random): BuiltExam {
  const seen = new Set(seenIds);
  const p5 = pickPart5(pool.p5, seen, rng);
  const p6 = pickPart6(pool.p6, seen, rng);
  const p7 = pickPart7(pool.p7, seen, rng);
  const questions = [...p5, ...p6.flatMap((s) => s.questions), ...p7.flatMap((s) => s.questions)];
  const counts = { p5: p5.length, p6: p6.reduce((n, s) => n + s.questions.length, 0), p7: p7.reduce((n, s) => n + s.questions.length, 0) };
  const difficulty = { 1: 0, 2: 0, 3: 0 };
  for (const q of questions) difficulty[q.difficulty] += 1;
  return {
    questions,
    passages: [...p6, ...p7].map((s) => s.passage),
    counts,
    reduced: counts.p5 !== EXAM_TARGET.p5 || counts.p6 !== EXAM_TARGET.p6 || counts.p7 !== EXAM_TARGET.p7,
    shortfall: { p5: EXAM_TARGET.p5 - counts.p5, p6: EXAM_TARGET.p6 - counts.p6, p7: EXAM_TARGET.p7 - counts.p7 },
    repeated: questions.filter((q) => seen.has(q.id)).length,
    difficulty,
  };
}

/** Texte expliquant pourquoi l'examen est réduit (vide si l'examen est complet). */
export function reducedNotice(exam: Pick<BuiltExam, "reduced" | "counts">): string {
  if (!exam.reduced) return "";
  const { p5, p6, p7 } = exam.counts;
  const total = p5 + p6 + p7;
  return `Examen RÉDUIT : ${total} question${total > 1 ? "s" : ""} au lieu de 100 (partie 5 : ${p5}/30 · partie 6 : ${p6}/16 · partie 7 : ${p7}/54). La banque ne contient pas encore assez de questions publiées : ce n'est pas un examen complet et le score est seulement extrapolé.`;
}
