import { useEffect, useRef, useState } from "react";
import type { Question } from "@/lib/types";
import { useSettings } from "@/lib/SettingsContext";
import { aiHeaders } from "@/lib/aiClient";
import { OFFLINE_AI_MESSAGE, useOnline } from "@/lib/online";

const MAX_FOLLOW_UPS = 3;
const MAX_CHARS = 300;

interface Turn {
  q: string;
  a: string;
}

/**
 * Question de relance après une explication. L'historique est limité à la
 * question en cours (le composant est remonté à chaque nouvelle question) et à
 * trois échanges ; mêmes quotas et budget que l'explication.
 */
export default function FollowUp({ question, selectedKey }: { question: Question; selectedKey: string }) {
  const { apiKey } = useSettings();
  const online = useOnline();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const reachedLimit = turns.length >= MAX_FOLLOW_UPS;
  const text = draft.trim();
  const canAsk = online && !loading && !reachedLimit && text.length >= 3 && text.length <= MAX_CHARS;

  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canAsk) return;
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: await aiHeaders(apiKey),
        body: JSON.stringify({ questionId: question.id, selectedKey, question: text, history: turns }),
        signal: controller.signal,
      });
      const data = (await res.json()) as { answer?: string; error?: string };
      if (controller.signal.aborted) return;
      if (!res.ok || !data.answer) {
        setError(data.error ?? "Impossible d'obtenir une réponse pour le moment.");
      } else {
        setTurns((previous) => [...previous, { q: text, a: data.answer as string }]);
        setDraft("");
      }
    } catch {
      if (!controller.signal.aborted) {
        setError("Connexion impossible au coach IA. Vérifiez votre connexion internet et réessayez.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  return (
    <section className="glass p-4" aria-label="Question de relance au coach">
      <h4 className="mb-2 text-sm font-semibold text-white/90">Une question sur cette explication ?</h4>

      {turns.length > 0 && (
        <ol className="mb-3 space-y-3">
          {turns.map((turn, i) => (
            <li key={i} className="space-y-1 text-sm">
              <p className="font-medium text-white/90">Vous : {turn.q}</p>
              <p className="whitespace-pre-line text-white/75">Coach : {turn.a}</p>
            </li>
          ))}
        </ol>
      )}

      {reachedLimit ? (
        <p className="text-sm text-white/60">
          Limite de {MAX_FOLLOW_UPS} questions atteinte pour cette question. Passez à la suivante !
        </p>
      ) : (
        <form onSubmit={ask} className="space-y-2">
          <label htmlFor={`followup-${question.id}`} className="sr-only">
            Votre question au coach
          </label>
          <textarea
            id={`followup-${question.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_CHARS}
            rows={2}
            disabled={!online || loading}
            placeholder="Ex : pourquoi pas « because of » ici ?"
            className="w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-white/50">
              {draft.length}/{MAX_CHARS} · {MAX_FOLLOW_UPS - turns.length} question(s) restante(s)
            </span>
            <button
              type="submit"
              disabled={!canAsk}
              className="glass-btn px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "Le coach réfléchit…" : "Poser ma question"}
            </button>
          </div>
        </form>
      )}

      {!online && <p className="mt-2 text-xs text-red-300" role="status">{OFFLINE_AI_MESSAGE}</p>}
      {error && <p className="mt-2 text-sm text-red-300" role="alert">{error}</p>}
    </section>
  );
}
