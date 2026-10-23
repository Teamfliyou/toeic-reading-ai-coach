// Stockage du carnet de vocabulaire : localStorage (par propriétaire) + signal de
// synchronisation Supabase (voir sync.ts). Les mots d'un visiteur anonyme sont
// rattachés au premier compte qui se connecte sur l'appareil.

import { DATA_EVENT, currentUserId, newId, requestSyncSoon } from "./tracker";
import {
  activeWords,
  createWord,
  markDeleted,
  mergeWords,
  reviewWord,
  validateWord,
  type VocabWord,
  type WordInput,
} from "./vocab";

const KEY = "lernoviq_vocab_v1";
const keyFor = (userId: string | null) => `${KEY}:${userId ?? "anon"}`;

const isWord = (x: unknown): x is VocabWord => {
  const w = x as VocabWord | null;
  return (
    !!w &&
    typeof w.id === "string" &&
    typeof w.term === "string" &&
    typeof w.meaning === "string" &&
    typeof w.due === "string" &&
    typeof w.updatedAt === "string" &&
    Number.isFinite(w.box)
  );
};

/** Tous les mots du propriétaire, suppressions comprises (nécessaires à la synchronisation). */
export function readAllWords(userId: string | null = currentUserId()): VocabWord[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(keyFor(userId)) || "[]");
    return Array.isArray(raw) ? raw.filter(isWord) : [];
  } catch {
    return [];
  }
}

export function writeWords(words: VocabWord[], userId: string | null = currentUserId()) {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(words.slice(0, 2000)));
  } catch {
    /* Stockage plein ou bloqué : le carnet reste en mémoire pour cette page seulement. */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DATA_EVENT));
}

/** Mots non supprimés, les plus récents d'abord. */
export function readWords(): VocabWord[] {
  return activeWords(readAllWords()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function addWord(input: WordInput): { ok: true; word: VocabWord } | { ok: false; error: string } {
  const all = readAllWords();
  const checked = validateWord(input, all);
  if (!checked.ok) return checked;
  const word = createWord(checked.value, newId());
  writeWords([word, ...all]);
  requestSyncSoon();
  return { ok: true, word };
}

export function removeWord(id: string) {
  writeWords(readAllWords().map((w) => (w.id === id ? markDeleted(w) : w)));
  requestSyncSoon();
}

export function answerWord(id: string, correct: boolean) {
  writeWords(readAllWords().map((w) => (w.id === id ? reviewWord(w, correct) : w)));
  requestSyncSoon();
}

/** Rattache à `userId` les mots saisis hors connexion. */
export function claimAnonymousWords(userId: string) {
  const anonymous = readAllWords(null);
  if (!anonymous.length) return;
  writeWords(mergeWords(readAllWords(userId), anonymous), userId);
  writeWords([], null);
}
