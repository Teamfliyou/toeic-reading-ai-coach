// Listening Partie 2 : tirage depuis la bibliothèque centralisée (Supabase) avec repli sur
// data/listening.json. Tant que la table est vide, absente ou inaccessible, le comportement
// actuel (les 12 exercices du fichier, dans l'ordre) est conservé.

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
  /** Transcription affichée après la réponse (sinon : énoncé + réponses). */
  transcript?: string;
}

export interface ListeningSource {
  url: string;
  key: string;
  local: ListeningItem[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ListeningSet {
  items: ListeningItem[];
  origin: "bank" | "local";
}

const AUDIO = /^(https:\/\/|\/)[^\s]+\.(mp3|m4a|ogg|wav)$/i;

export function mapListeningRow(row: Record<string, unknown>): ListeningItem | null {
  const options = row.options;
  if (!Array.isArray(options) || options.length !== 3 || typeof row.prompt !== "string") return null;
  const correct = String(row.correct_key);
  if (!["A", "B", "C"].includes(correct)) return null;
  const audio = typeof row.audio_url === "string" && AUDIO.test(row.audio_url) ? row.audio_url : undefined;
  return {
    id: String(row.slug ?? row.id),
    part: 2,
    category: String(row.category ?? "listening-wh"),
    prompt: row.prompt,
    options: options.map((o: { key: string; text: string }) => ({ key: o.key as ListeningKey, text: String(o.text) })),
    correctKey: correct as ListeningKey,
    audio,
    transcript: typeof row.transcript === "string" ? row.transcript : undefined,
  };
}

/** Série d'exercices Listening Partie 2 : banque centralisée, sinon fichier local inchangé. */
export async function pickListening(src: ListeningSource, options: { limit?: number; exclude?: string[]; category?: string; difficulty?: number } = {}): Promise<ListeningSet> {
  if (src.url && src.key) {
    try {
      const response = await (src.fetchImpl ?? fetch)(`${src.url}/rest/v1/rpc/listening_pick`, {
        method: "POST",
        headers: { apikey: src.key, "Content-Type": "application/json" },
        body: JSON.stringify({
          p_part: 2, p_limit: options.limit ?? 12, p_difficulty: options.difficulty ?? null,
          p_category: options.category ?? null, p_exclude: (options.exclude ?? []).slice(0, 400),
        }),
        signal: AbortSignal.timeout(src.timeoutMs ?? 6000),
      });
      if (response.ok) {
        const data = (await response.json()) as { items?: Record<string, unknown>[] };
        const items = (data.items ?? []).map(mapListeningRow).filter((x): x is ListeningItem => x !== null);
        if (items.length) return { items, origin: "bank" };
      }
    } catch {
      /* Supabase inaccessible ou non migré : fichier local */
    }
  }
  return { items: src.local, origin: "local" };
}
