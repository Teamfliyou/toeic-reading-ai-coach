// Répétition espacée de type Leitner (boîtes 1 à 5), logique pure et testable.
//
// - Une question ratée entre (ou retourne) en boîte 1 et est à revoir tout de suite.
// - Une bonne réponse donnée quand la carte est à revoir la fait monter d'une
//   boîte ; elle revient après le délai de sa nouvelle boîte.
// - Une bonne réponse en boîte 5 la marque « maîtrisée » (elle ne revient plus
//   tant qu'on ne la rate pas à nouveau).
// - Répondre juste à une carte qui n'est pas encore due ne la fait pas monter
//   (sinon un simple entraînement libre vider les boîtes sans réel rappel).

/** Délai (en jours) avant la prochaine révision, selon la boîte d'arrivée. */
export const INTERVAL_DAYS = [1, 2, 4, 8, 16] as const;
export const MAX_BOX = INTERVAL_DAYS.length;
const DAY_MS = 86_400_000;

export interface ReviewCard {
  questionId: string;
  part: number;
  /** Boîte actuelle, de 1 (difficile) à 5 (presque acquise). */
  box: number;
  /** Date ISO à partir de laquelle la carte est à revoir. */
  due: string;
  mastered: boolean;
  lapses: number;
  updatedAt: string;
}

export function isDue(card: ReviewCard, now: Date = new Date()): boolean {
  return !card.mastered && Date.parse(card.due) <= now.getTime();
}

export function dueCards(cards: ReviewCard[], now: Date = new Date()): ReviewCard[] {
  return cards
    .filter((card) => isDue(card, now))
    .sort((a, b) => a.box - b.box || Date.parse(a.due) - Date.parse(b.due));
}

/** Compte des cartes par boîte (boîtes 1 à 5) et des cartes maîtrisées. */
export function boxCounts(cards: ReviewCard[]): { boxes: number[]; mastered: number } {
  const boxes = Array.from({ length: MAX_BOX }, () => 0);
  let mastered = 0;
  for (const card of cards) {
    if (card.mastered) mastered += 1;
    else boxes[Math.min(Math.max(card.box, 1), MAX_BOX) - 1] += 1;
  }
  return { boxes, mastered };
}

export interface AnswerEvent {
  questionId: string;
  part: number;
  correct: boolean;
}

/** Applique une réponse à la liste de cartes et renvoie la nouvelle liste. */
export function applyAnswer(
  cards: ReviewCard[],
  event: AnswerEvent,
  now: Date = new Date()
): ReviewCard[] {
  const iso = now.toISOString();
  const existing = cards.find((c) => c.questionId === event.questionId);

  if (!event.correct) {
    const next: ReviewCard = {
      questionId: event.questionId,
      part: event.part,
      box: 1,
      due: iso,
      mastered: false,
      lapses: (existing?.lapses ?? 0) + 1,
      updatedAt: iso,
    };
    return existing
      ? cards.map((c) => (c.questionId === event.questionId ? next : c))
      : [next, ...cards];
  }

  if (!existing || !isDue(existing, now)) return cards;

  const promoted: ReviewCard =
    existing.box >= MAX_BOX
      ? { ...existing, mastered: true, updatedAt: iso }
      : {
          ...existing,
          box: existing.box + 1,
          due: new Date(now.getTime() + INTERVAL_DAYS[existing.box] * DAY_MS).toISOString(),
          updatedAt: iso,
        };
  return cards.map((c) => (c.questionId === event.questionId ? promoted : c));
}

/** Fusion de deux listes de cartes (appareils différents) : la plus récente gagne. */
export function mergeCards(local: ReviewCard[], remote: ReviewCard[]): ReviewCard[] {
  const byId = new Map<string, ReviewCard>();
  for (const card of [...local, ...remote]) {
    const known = byId.get(card.questionId);
    if (!known || Date.parse(card.updatedAt) > Date.parse(known.updatedAt)) {
      byId.set(card.questionId, card);
    }
  }
  return [...byId.values()];
}
