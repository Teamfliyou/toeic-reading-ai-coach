// Contenu Listening (Part 2 : question-réponse). Voir docs/listening-design.md.
import raw from "../../data/listening.json";

export type ListeningKey = "A" | "B" | "C";

export interface ListeningItem {
  id: string;
  part: 2;
  category: string;
  /** Phrase prononcée en premier (question ou affirmation). */
  prompt: string;
  /** Trois réponses, jamais affichées avant que l'élève ait répondu. */
  options: { key: ListeningKey; text: string }[];
  correctKey: ListeningKey;
  /** URL d'un enregistrement (mp3) ; sinon la synthèse vocale du navigateur est utilisée. */
  audio?: string;
}

export function getPart2Items(): ListeningItem[] {
  return (raw as { part2: ListeningItem[] }).part2;
}

/** Séquence lue à voix haute : l'énoncé, puis chaque réponse précédée de sa lettre. */
export function speechScript(item: ListeningItem): { text: string; pauseMs: number }[] {
  return [
    { text: item.prompt, pauseMs: 1500 },
    ...item.options.map((o) => ({ text: `${o.key}. ${o.text}`, pauseMs: 900 })),
  ];
}
