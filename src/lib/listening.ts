// Contenu Listening (Part 2 : question-réponse). Voir docs/listening-design.md.
import raw from "../../data/listening.json";
import { supabaseUrl, supabasePublishableKey } from "./supabaseConfig";
import { pickListening, type ListeningItem, type ListeningSet } from "./bank/listeningPick";

export type { ListeningItem, ListeningKey } from "./bank/listeningPick";

/** Fichier local : secours hors ligne et contenu de départ de la bibliothèque centralisée. */
export function getPart2Items(): ListeningItem[] {
  return (raw as { part2: ListeningItem[] }).part2;
}

/**
 * Exercices de la partie 2 : bibliothèque centralisée (supabase/listening_bank.sql) quand elle contient
 * des exercices publiés, sinon fichier local (comportement historique conservé pendant la migration).
 */
export function loadPart2Items(exclude: string[] = []): Promise<ListeningSet> {
  return pickListening({ url: supabaseUrl, key: supabasePublishableKey, local: getPart2Items() }, { exclude });
}

/** Séquence lue à voix haute : l'énoncé, puis chaque réponse précédée de sa lettre. */
export function speechScript(item: ListeningItem): { text: string; pauseMs: number }[] {
  return [
    { text: item.prompt, pauseMs: 1500 },
    ...item.options.map((o) => ({ text: `${o.key}. ${o.text}`, pauseMs: 900 })),
  ];
}
