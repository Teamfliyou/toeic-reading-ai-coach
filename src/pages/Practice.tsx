import { useEffect, useState } from "react";
import type { Part, Question, Passage } from "@/lib/types";
import { loadPart } from "@/lib/data";
import { getPartInfo } from "@/lib/parts";
import PracticeClient from "@/components/PracticeClient";
import Part6Inline from "@/components/Part6Inline";
import SettingsButton from "@/components/SettingsButton";

export default function Practice({ part }: { part: Part }) {
  const info = getPartInfo(part);
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
        <h1 className="mt-1 text-2xl font-bold text-white/95">{info.name}</h1>
      </div>
      {!dataset ? (
        <div className="glass p-8 text-center text-white/70">Chargement des exercices…</div>
      ) : part === 6 ? (
        <Part6Inline key={part} questions={dataset.questions} passages={dataset.passages} />
      ) : (
        <PracticeClient key={part} part={part} questions={dataset.questions} passages={dataset.passages} />
      )}
    </main>
  );
}
