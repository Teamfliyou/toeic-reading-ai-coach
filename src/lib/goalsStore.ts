// Stockage des objectifs (localStorage, par propriétaire) et de l'historique des
// examens blancs (local à l'appareil). Les objectifs sont synchronisés avec
// Supabase pour un utilisateur connecté (voir sync.ts).

import { DATA_EVENT, currentUserId, requestSyncSoon } from "./tracker";
import { DEFAULT_GOALS, type ExamRecord, type Goals } from "./goals";

const GOALS_KEY = "lernoviq_goals_v1";
const EXAMS_KEY = "lernoviq_exam_history_v1";
const keyFor = (userId: string | null) => `${GOALS_KEY}:${userId ?? "anon"}`;

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DATA_EVENT));
}

export function readGoals(userId: string | null = currentUserId()): Goals {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(userId)) || "null") as Partial<Goals> | null;
    if (!raw) return DEFAULT_GOALS;
    return {
      examDate: typeof raw.examDate === "string" ? raw.examDate : null,
      targetScore: Number.isInteger(raw.targetScore) ? (raw.targetScore as number) : null,
      dailyGoal: Number.isInteger(raw.dailyGoal) ? (raw.dailyGoal as number) : DEFAULT_GOALS.dailyGoal,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : DEFAULT_GOALS.updatedAt,
    };
  } catch {
    return DEFAULT_GOALS;
  }
}

export function writeGoals(goals: Goals, userId: string | null = currentUserId()) {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(goals));
  } catch {
    /* Stockage bloqué : les objectifs ne sont pas conservés. */
  }
  notify();
}

export function saveGoals(value: Omit<Goals, "updatedAt">) {
  writeGoals({ ...value, updatedAt: new Date().toISOString() });
  requestSyncSoon();
}

/** Reprend les objectifs saisis hors connexion si le compte n'en a pas encore. */
export function claimAnonymousGoals(userId: string) {
  const anonymous = readGoals(null);
  if (anonymous.updatedAt === DEFAULT_GOALS.updatedAt) return;
  if (Date.parse(anonymous.updatedAt) > Date.parse(readGoals(userId).updatedAt)) writeGoals(anonymous, userId);
}

export function readExamHistory(): ExamRecord[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(EXAMS_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((r): r is ExamRecord => !!r && typeof r.at === "string" && Number.isFinite(r.score))
      : [];
  } catch {
    return [];
  }
}

export function addExamRecord(record: ExamRecord) {
  try {
    localStorage.setItem(EXAMS_KEY, JSON.stringify([record, ...readExamHistory()].slice(0, 30)));
  } catch {
    /* Historique facultatif. */
  }
  notify();
}
