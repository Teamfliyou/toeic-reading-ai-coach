import type { Part, Question, OptionKey } from "./types";

export type Lesson = {
  id: string; part: Part; questionId: string; selectedKey: OptionKey;
  topic: string; title: string; rule: string; example: string; exercise: string;
  answer: string; tip: string; createdAt: string; status: "pending" | "ready" | "error";
};
const KEY = "lexora_personal_lessons_v1";
export function readLessons(): Lesson[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(rows) ? rows.filter((row): row is Lesson =>
      !!row && typeof row === "object" && typeof row.id === "string" &&
      typeof row.questionId === "string" && typeof row.title === "string" &&
      [5, 6, 7].includes(row.part)
    ) : [];
  } catch { return []; }
}
function save(items: Lesson[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items.slice(0, 200))); }
  catch { /* Local storage may be disabled. */ }
}
export function startLesson(q: Question, selectedKey: OptionKey): string {
  const id = `${q.id}:${selectedKey}`;
  const current = readLessons();
  if (!current.some(l => l.id === id)) {
    save([{
      id, part: q.part, questionId: q.id, selectedKey,
      topic: "À identifier", title: `Erreur à travailler · Partie ${q.part}`,
      rule: "", example: "", exercise: "", answer: "", tip: "",
      createdAt: new Date().toISOString(), status: "pending",
    }, ...current]);
  }
  return id;
}
export type GeneratedLesson = Pick<Lesson, "topic" | "title" | "rule" | "example" | "exercise" | "answer" | "tip">;
export function completeLesson(id: string, generated: GeneratedLesson) {
  save(readLessons().map(l => l.id === id ? {
    ...l, ...generated, status: "ready" as const,
  } : l));
}
export function failLesson(id: string) {
  save(readLessons().map(l => l.id === id && l.status === "pending" ? {...l, status:"error" as const} : l));
}
