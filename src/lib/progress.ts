import type { Part } from "./types";
export type Session = { part: Part; correct: number; total: number; date: string };
const STORAGE = "toeic_practice_history_v1";
export function readSessions(): Session[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is Session => typeof x === "object" && x !== null && [5,6,7].includes(x.part) && Number.isFinite(x.correct) && Number.isFinite(x.total) && typeof x.date === "string");
  } catch { return []; }
}
export function saveSession(part: Part, correct: number, total: number) {
  if (!total || typeof window === "undefined") return;
  try {
    const previous = readSessions();
    // Un montage/démontage React en mode strict peut invoquer deux fois l'effet.
    const now = new Date();
    const last = previous[0];
    if (last && last.part === part && last.correct === correct && last.total === total && now.getTime() - Date.parse(last.date) < 3000) return;
    localStorage.setItem(STORAGE, JSON.stringify([{part,correct,total,date:now.toISOString()},...previous].slice(0,100)));
  } catch { /* Le suivi reste optionnel si le stockage est bloqué. */ }
}

const ERRORS_KEY = "toeic_mistakes_v1";
export type Mistake = { id: string; part: Part; updatedAt: string };
export function readMistakes(): Mistake[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(ERRORS_KEY) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is Mistake => typeof r === "object" && r !== null && typeof r.id === "string" && [5,6,7].includes(r.part) && typeof r.updatedAt === "string");
  } catch { return []; }
}
export function recordMistake(id: string, part: Part) {
  try {
    const items = readMistakes().filter(item => item.id !== id);
    localStorage.setItem(ERRORS_KEY, JSON.stringify([{id, part, updatedAt: new Date().toISOString()},...items].slice(0,300)));
  } catch { /* Historique local indisponible */ }
}
export function resolveMistake(id: string) {
  try { localStorage.setItem(ERRORS_KEY, JSON.stringify(readMistakes().filter(item => item.id !== id))); }
  catch { /* Historique local indisponible */ }
}
