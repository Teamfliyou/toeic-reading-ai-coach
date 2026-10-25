
import { getPartInfo } from "@/lib/parts";
import type { Part } from "@/lib/types";
import { saveSession } from "@/lib/progress";
import { useEffect } from "react";

export default function ScoreBoard({
  part,
  correct,
  total,
  onRestart,
  restartLabel = "Recommencer cette partie",
}: {
  part: Part;
  correct: number;
  total: number;
  onRestart: () => void;
  restartLabel?: string;
}) {
  const info = getPartInfo(part);
  useEffect(() => { saveSession(part, correct, total); }, [part, correct, total]);
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

  const message =
    pct >= 80
      ? "Excellent travail ! Vous maîtrisez cette partie."
      : pct >= 50
        ? "Bon début ! Continuez à vous entraîner pour progresser."
        : "Chaque erreur est une occasion d'apprendre. Persévérez !";

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="glass-strong animate-fade-up p-8 text-center">
        <span className="chip mb-5">
          {info.name} — {info.tagline}
        </span>

        <div className="my-8 rounded-2xl border border-white/10 bg-white/[0.035] px-6 py-8">
          <div className="text-6xl font-bold tracking-tight text-white">{pct}<span className="text-3xl text-cyan-300">%</span></div>
          <p className="mt-2 text-sm text-white/55">Taux de réussite</p>
          <div className="mt-6 h-2.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-cyan-400 transition-all duration-500" style={{width: `${pct}%`}} />
          </div>
          <div className="mt-4 flex justify-between text-sm text-white/65">
            <span>{correct} bonnes réponses</span><span>{total-correct} erreurs</span>
          </div>
        </div>

        <p className="text-lg font-semibold text-white/90">
          {correct} bonne{correct > 1 ? "s" : ""} réponse
          {correct > 1 ? "s" : ""} sur {total}
        </p>
        <p className="mt-2 text-sm text-white/60">{message}</p>

        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            onClick={onRestart}
            className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90"
          >
            {restartLabel}
          </button>
          <a
            href="#/"
            className="glass-btn px-6 py-3 text-center text-sm font-semibold"
          >
            Retour au tableau de bord
          </a>
        </div>
      </div>
    </div>
  );
}
