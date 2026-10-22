// Suivi des réponses : historique, cartes de révision espacée et stockage local.
//
// Les données sont d'abord écrites dans le localStorage (visiteurs anonymes
// compris) ; un utilisateur connecté les voit synchronisées avec Supabase par
// sync.ts. Tout accès au stockage est protégé : le suivi reste optionnel si le
// navigateur le bloque.

import { getSession } from "./supabaseAuth";
import {
  MAX_COUNTED_TIME_MS,
  MAX_LOCAL_ATTEMPTS,
  visibleAttempts,
  type Attempt,
  type AttemptMode,
} from "./attempts";
import { applyAnswer, dueCards, mergeCards, type ReviewCard } from "./srs";
import { readMistakes } from "./progress";

const ATTEMPTS_KEY = "lernoviq_attempts_v1";
const CARDS_KEY = "lernoviq_review_cards_v1";
const MIGRATED_KEY = "lernoviq_legacy_migrated_v1";

export const DATA_EVENT = "lernoviq:data";

export function currentUserId(): string | null {
  return getSession()?.user.id ?? null;
}

function readJson<T>(key: string): T[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(raw) ? (raw as T[]) : [];
  } catch {
    return [];
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Stockage plein ou bloqué : le suivi est facultatif. */
  }
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DATA_EVENT));
}

const isAttempt = (x: unknown): x is Attempt => {
  const a = x as Attempt | null;
  return (
    !!a &&
    typeof a.id === "string" &&
    typeof a.questionId === "string" &&
    typeof a.correct === "boolean" &&
    typeof a.at === "string" &&
    Number.isFinite(a.part)
  );
};

const isCard = (x: unknown): x is ReviewCard => {
  const c = x as ReviewCard | null;
  return (
    !!c &&
    typeof c.questionId === "string" &&
    Number.isFinite(c.box) &&
    typeof c.due === "string" &&
    typeof c.updatedAt === "string"
  );
};

/** Toutes les tentatives stockées sur cet appareil (tous propriétaires). */
export function readAllAttempts(): Attempt[] {
  return readJson<unknown>(ATTEMPTS_KEY).filter(isAttempt);
}
export function writeAttempts(attempts: Attempt[]) {
  writeJson(ATTEMPTS_KEY, attempts.slice(0, MAX_LOCAL_ATTEMPTS));
  notify();
}

/** Tentatives de l'utilisateur courant (ou anonymes). */
export function myAttempts(): Attempt[] {
  return visibleAttempts(readAllAttempts(), currentUserId());
}

const cardsKey = (userId: string | null) => `${CARDS_KEY}:${userId ?? "anon"}`;

export function readCards(userId: string | null = currentUserId()): ReviewCard[] {
  return readJson<unknown>(cardsKey(userId)).filter(isCard);
}
export function writeCards(cards: ReviewCard[], userId: string | null = currentUserId()) {
  writeJson(cardsKey(userId), cards);
  notify();
}

/** Rattache à `userId` les cartes créées hors connexion sur cet appareil. */
export function claimAnonymousCards(userId: string) {
  const anonymous = readCards(null);
  if (!anonymous.length) return;
  writeJson(cardsKey(userId), mergeCards(readCards(userId), anonymous));
  writeJson(cardsKey(null), []);
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Repli (anciens navigateurs) : UUID v4 approximatif, suffisant comme clé de fusion.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export interface AnswerInput {
  question: { id: string; part: number; category?: string };
  selectedKey: string;
  correct: boolean;
  timeMs: number;
  mode: AttemptMode;
  /** Faux pour les contenus hors révision espacée (ex. Listening). */
  spaced?: boolean;
}

type SyncRequest = () => void;
let requestSync: SyncRequest | null = null;
/** Enregistre la fonction appelée après chaque réponse (évite une dépendance circulaire). */
export function setSyncRequester(fn: SyncRequest) {
  requestSync = fn;
}

/** Enregistre une réponse : historique + carte de révision. */
export function recordAnswer(input: AnswerInput) {
  const owner = currentUserId();
  const now = new Date();
  const timeMs = Math.min(Math.max(Math.round(input.timeMs) || 0, 0), MAX_COUNTED_TIME_MS * 4);
  const attempt: Attempt = {
    id: newId(),
    questionId: input.question.id,
    part: input.question.part,
    category: input.question.category,
    selectedKey: input.selectedKey,
    correct: input.correct,
    timeMs,
    at: now.toISOString(),
    mode: input.mode,
    owner,
    synced: false,
  };
  writeAttempts([attempt, ...readAllAttempts()]);

  if (input.spaced !== false) {
    writeCards(
      applyAnswer(
        readCards(owner),
        { questionId: input.question.id, part: input.question.part, correct: input.correct },
        now
      ),
      owner
    );
  }
  requestSync?.();
}

/** Cartes à revoir maintenant pour l'utilisateur courant. */
export function dueNow(now: Date = new Date()): ReviewCard[] {
  return dueCards(readCards(), now);
}

/**
 * Reprend l'ancien carnet d'erreurs (toeic_mistakes_v1) sous forme de cartes de
 * révision, une seule fois. Les questions déjà suivies ne sont pas modifiées.
 */
export function migrateLegacyMistakes() {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const cards = readCards(null);
    const known = new Set(cards.map((c) => c.questionId));
    const added: ReviewCard[] = readMistakes()
      .filter((m) => !known.has(m.id))
      .map((m) => ({
        questionId: m.id,
        part: m.part,
        box: 1,
        due: m.updatedAt,
        mastered: false,
        lapses: 1,
        updatedAt: m.updatedAt,
      }));
    if (added.length) writeCards([...added, ...cards], null);
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    /* Migration facultative. */
  }
}
