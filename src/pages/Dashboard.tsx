import { useEffect, useState } from "react";
import { PARTS } from "@/lib/parts";
import PartIcon from "@/components/PartIcon";
import SettingsButton from "@/components/SettingsButton";
import { useSettings } from "@/lib/SettingsContext";
import { readSessions, type Session } from "@/lib/progress";

export default function Dashboard() {
  const { hasPersonalKey } = useSettings();
  const [history, setHistory] = useState<Session[]>([]);
  useEffect(() => { setHistory(readSessions()); }, []);
  const attempted = history.reduce((n, item) => n + item.total, 0);
  const correct = history.reduce((n, item) => n + item.correct, 0);
  const average = attempted ? Math.round(correct / attempted * 100) : 0;
  const [hasDeepSeekKey, setHasDeepSeekKey] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { hasDeepSeekKey?: boolean }) =>
        setHasDeepSeekKey(Boolean(d.hasDeepSeekKey))
      )
      .catch(() => setHasDeepSeekKey(false));
  }, []);

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-8 sm:py-12">
      <div className="absolute right-5 top-5 sm:right-6 sm:top-6">
        <SettingsButton withLabel />
      </div>

      <header className="mb-10 text-center animate-fade-up">
        <span className="chip mb-5">Votre espace d’entraînement</span>
        <h1 className="text-balance text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">
          <span className="gradient-text">TOEIC Reading</span>
          <br className="sm:hidden" /> AI Coach
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-pretty text-base text-white/60">
          Entraînez-vous à la compréhension écrite avec un coach IA qui corrige
          vos erreurs et vous explique précisément pourquoi, comme un
          professeur particulier.
        </p>

        {hasDeepSeekKey === false && !hasPersonalKey && (
          <p className="mx-auto mt-5 inline-flex max-w-xl items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
            Aucune clé DeepSeek configurée : les explications IA seront désactivées.
            Ajoutez votre clé dans les Paramètres (engrenage) ou définissez{" "}
            <code className="font-mono">DEEPSEEK_API_KEY</code> dans les variables d’environnement Vercel.
          </p>
        )}
      </header>

      <section aria-label="Votre progression" className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: "Sessions terminées", value: String(history.length), helper: "Entraînements réalisés" },
          { label: "Réussite moyenne", value: attempted ? average + "%" : "—", helper: attempted ? correct + " bonnes réponses sur " + attempted : "Votre progression commence ici" },
          { label: "Dernière session", value: history.length ? "Partie " + history[0].part : "—", helper: history.length ? new Date(history[0].date).toLocaleDateString("fr-FR") : "Aucune session pour le moment" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
            <p className="text-xs font-medium text-white/55">{stat.label}</p>
            <p className="mt-2 text-3xl font-bold tracking-tight text-white">{stat.value}</p>
            <p className="mt-1 text-xs text-white/45">{stat.helper}</p>
          </div>
        ))}
      </section>

      <div className="mb-4 flex items-end justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-cyan-300">Programme</p>
          <h2 className="mt-1 text-xl font-semibold text-white">Choisissez votre entraînement</h2></div>
        <span className="hidden text-sm text-white/45 sm:block">Reading · Parties 5, 6 et 7</span>
      </div>
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {PARTS.map((part, i) => (
          <a
            key={part.part}
            href={`#/practice/${part.slug}`}
            className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/10 bg-[#151c2b] p-6 transition-all duration-200 hover:-translate-y-1 hover:border-cyan-300/40 hover:bg-[#1b2638] hover:shadow-xl hover:shadow-black/20"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div
              className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-cyan-400/5 blur-2xl"
            />

            <div
              className="flex h-12 w-12 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200"
            >
              <PartIcon name={part.icon} className="h-6 w-6" />
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-white/45">
                Partie {part.part}
              </p>
              <h2 className="mt-1 text-xl font-bold text-white/95">
                {part.name}
              </h2>
              <p className="text-xs italic text-white/50">{part.tagline}</p>
            </div>

            <p className="text-sm leading-relaxed text-white/65">
              {part.description}
            </p>

            <div className="mt-auto flex items-center justify-between border-t border-white/10 pt-4">
              <span className="chip">{part.questionCount}</span>
              <span className="flex items-center gap-1 text-sm font-semibold text-white/80 transition-all duration-200 group-hover:gap-2 group-hover:text-white">
                Commencer
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </span>
            </div>
          </a>
        ))}
      </section>

      <footer className="mt-12 text-center text-xs text-white/35">
        TOEIC Reading AI Coach — Propulsé par DeepSeek · Uniquement la partie
        compréhension écrite pour le moment.
      </footer>
    </main>
  );
}
