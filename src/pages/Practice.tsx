import { useEffect, useState } from "react";
import type { Part, Question, Passage } from "@/lib/types";
import { loadPart } from "@/lib/data";
import { getPartInfo } from "@/lib/parts";
import PracticeClient from "@/components/PracticeClient";
import Part6Inline from "@/components/Part6Inline";
import SettingsButton from "@/components/SettingsButton";
import { readMistakes } from "@/lib/progress";

export default function Practice({ part, reviewMode = false }: { part: Part; reviewMode?: boolean }) {
  const info = getPartInfo(part);
  const mistakeIds = reviewMode ? new Set(readMistakes().filter(m => m.part === part).map(m => m.id)) : null;
  const [dataset, setDataset] = useState<{ questions: Question[]; passages: Passage[] } | null>(null);
  useEffect(() => {
    let active = true;
    setDataset(null);
    loadPart(part).then((result) => { if (active) setDataset(result); });
    return () => { active = false; };
  }, [part]);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex items-center justify-between">
        <a href="#/" className="glass-btn inline-flex items-center gap-2 px-3 py-2">← Tableau de bord</a>
        <span className="text-sm font-semibold gradient-text">TOEIC Reading AI Coach</span>
        <SettingsButton />
      </header>
      <div className="mb-6 animate-fade-up">
        <p className="text-xs font-medium uppercase tracking-wider text-white/45">Partie {part} · {info.tagline}</p>
        <h1 className="mt-1 text-2xl font-bold text-white/95">{reviewMode ? "Réviser mes erreurs" : info.name}</h1>\n        {reviewMode && <p className="mt-2 text-sm text-white/60">Partie {part} · Une bonne réponse retire la question de vos erreurs à revoir.</p>}
      </div>
      {!dataset ? (
        <div className="glass p-8 text-center text-white/70">Chargement des exercices…</div>
      ) : reviewMode && !dataset.questions.some(q => mistakeIds?.has(q.id)) ? (\n        <div className="glass p-8 text-center text-white/80">Aucune erreur à réviser pour cette partie. <a className="text-cyan-300 underline" href="#/">Retour à l’accueil</a></div>\n      ) : reviewMode ? (\n        <PracticeClient key={`${part}-review`} part={part} reviewMode questions={dataset.questions.filter(q => mistakeIds?.has(q.id))} passages={dataset.passages} />\n      ) : part === 6 ? (
        <Part6Inline key={part} questions={dataset.questions} passages={dataset.passages} />
      ) : (
        <PracticeClient key={part} part={part} questions={dataset.questions} passages={dataset.passages} />
      )}
    </main>
  );
}
