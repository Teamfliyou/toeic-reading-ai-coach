
import { getPartInfo } from "@/lib/parts";
import type { Part } from "@/lib/types";

export default function ScoreBoard({
  part,
  correct,
  total,
  onRestart,
}: {
  part: Part;
  correct: number;
  total: number;
  onRestart: () => void;
}) {
  const info = getPartInfo(part);
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

        <div className="my-6 flex items-center justify-center">
          <div className="relative flex h-40 w-40 items-center justify-center">
            <svg className="h-40 w-40 -rotate-90" viewBox="0 0 120 120">
              <circle
                cx="60"
                cy="60"
                r="52"
                fill="none"
                stroke="rgba(255,255,255,0.08)"
                strokeWidth="10"
              />
              <circle
                cx="60"
                cy="60"
                r="52"
                fill="none"
                stroke="url(#scoreGrad)"
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={`${(pct / 100) * 326.7} 326.7`}
              />
              <defs>
                <linearGradient id="scoreGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" />
                  <stop offset="100%" stopColor="#22d3ee" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute text-center">
              <div className="text-4xl font-bold gradient-text">{pct}%</div>
              <div className="text-xs text-white/50">de réussite</div>
            </div>
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
            Recommencer cette partie
          </button>
          <a
            href="/"
            className="glass-btn px-6 py-3 text-center text-sm font-semibold"
          >
            Retour au tableau de bord
          </a>
        </div>
      </div>
    </div>
  );
}
