import { useEffect, useState } from "react";
import type { Part, Question, Passage } from "@/lib/types";
import { loadPart } from "@/lib/data";
import { getPartInfo } from "@/lib/parts";
import PracticeClient from "@/components/PracticeClient";
import Part6Inline from "@/components/Part6Inline";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import { readMistakes } from "@/lib/progress";
import "./lexora.css";

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
    <div className="lexora-page lexora-exercises">
      <header className="lexora-nav">
        <div className="lexora-shell">
          <a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a>
          <div className="lexora-navright">
            <a className="lexora-smalllink" href="#/">Tableau de bord</a>
            <a className="lexora-smalllink" href="#/diagnostic">Diagnostic</a>
            <AuthButton />
            <SettingsButton withLabel />
          </div>
        </div>
      </header>
      <main className="lexora-shell lexora-practice-main">
        <div className="lexora-practice-heading">
          <p className="lexora-eyebrow">Partie {part} · {info.tagline}</p>
          <h1>{reviewMode ? "Réviser mes erreurs" : info.name}</h1>
          <p className="lexora-muted">{reviewMode
            ? "Une bonne réponse retire la question de vos erreurs à revoir."
            : "Prenez votre temps, choisissez votre réponse et progressez à votre rythme."}</p>
        </div>
      {!dataset ? (
        <div className="glass p-8 text-center text-slate-600">Chargement des exercices…</div>
      ) : reviewMode && !dataset.questions.some(q => mistakeIds?.has(q.id)) ? ( 
        <div className="glass p-8 text-center text-slate-700">Aucune erreur à réviser pour cette partie. <a className="text-blue-700 underline" href="#/">Retour à l’accueil</a></div> 
      ) : reviewMode ? ( 
        <PracticeClient key={`${part}-review`} part={part} reviewMode questions={dataset.questions.filter(q => mistakeIds?.has(q.id))} passages={dataset.passages} /> 
      ) : part === 6 ? (
        <Part6Inline key={part} questions={dataset.questions} passages={dataset.passages} />
      ) : (
        <PracticeClient key={part} part={part} questions={dataset.questions} passages={dataset.passages} />
      )}
      </main>
    </div>
  );
}
