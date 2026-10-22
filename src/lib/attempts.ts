// Historique des tentatives : types et fonctions pures (stockage et synchronisation
// sont dans tracker.ts / sync.ts).

export type AttemptMode = "practice" | "review" | "exam" | "diagnostic" | "listening";

export interface Attempt {
  /** UUID généré côté client (clé de fusion avec Supabase). */
  id: string;
  questionId: string;
  /** 2 = Listening Part 2 ; 5, 6, 7 = Reading. */
  part: number;
  category?: string;
  selectedKey: string;
  correct: boolean;
  timeMs: number;
  /** Date ISO de la réponse. */
  at: string;
  mode: AttemptMode;
  /** Identifiant Supabase du propriétaire (null : tentative anonyme locale). */
  owner: string | null;
  /** Vrai une fois enregistrée dans Supabase. */
  synced: boolean;
}

export const MAX_LOCAL_ATTEMPTS = 5000;
/** Au-delà, un temps est considéré comme une pause (onglet laissé ouvert). */
export const MAX_COUNTED_TIME_MS = 5 * 60_000;

/** Tentatives visibles par un utilisateur : les siennes et les anonymes locales. */
export function visibleAttempts(attempts: Attempt[], userId: string | null): Attempt[] {
  return attempts.filter((a) => a.owner === null || a.owner === userId);
}

/** Tentatives à envoyer à Supabase pour `userId` (anonymes revendiquées comprises). */
export function pendingSync(attempts: Attempt[], userId: string): Attempt[] {
  return attempts.filter((a) => !a.synced && (a.owner === null || a.owner === userId));
}

/** Fusionne les tentatives locales et distantes (dédoublonnées par id), récentes d'abord. */
export function mergeAttempts(local: Attempt[], remote: Attempt[]): Attempt[] {
  const byId = new Map<string, Attempt>();
  for (const a of remote) byId.set(a.id, a);
  for (const a of local) {
    const known = byId.get(a.id);
    byId.set(a.id, known ? { ...a, synced: true, owner: known.owner } : a);
  }
  return [...byId.values()]
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    .slice(0, MAX_LOCAL_ATTEMPTS);
}

export interface AttemptRow {
  id: string;
  user_id?: string;
  question_id: string;
  part: number;
  category: string | null;
  selected_key: string;
  correct: boolean;
  time_ms: number;
  mode: string;
  created_at: string;
}

export function toRow(a: Attempt, userId: string): AttemptRow {
  return {
    id: a.id,
    user_id: userId,
    question_id: a.questionId,
    part: a.part,
    category: a.category ?? null,
    selected_key: a.selectedKey,
    correct: a.correct,
    time_ms: Math.round(a.timeMs),
    mode: a.mode,
    created_at: a.at,
  };
}

export function fromRow(row: AttemptRow): Attempt {
  return {
    id: row.id,
    questionId: row.question_id,
    part: row.part,
    category: row.category ?? undefined,
    selectedKey: row.selected_key,
    correct: row.correct,
    timeMs: row.time_ms,
    at: row.created_at,
    mode: row.mode as AttemptMode,
    owner: row.user_id ?? null,
    synced: true,
  };
}
