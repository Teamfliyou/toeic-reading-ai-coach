import { useEffect, useState } from "react";
import type { Part, Question, Passage } from "@/lib/types";
import { loadQuestionsByIds, loadSeries, type PickedSet } from "@/lib/data";
import { parseSeriesParams, recentSeenIds } from "@/lib/adaptive";
import categories from "../../data/categories.json";
import { getPartInfo } from "@/lib/parts";
import PracticeClient from "@/components/PracticeClient";
import Part6Inline from "@/components/Part6Inline";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import { myAttempts, readCards } from "@/lib/tracker";
import "./lexora.css";

export default function Practice({ part, reviewMode = false, search = "" }: { part: Part; reviewMode?: boolean; search?: string }) {
  const info = getPartInfo(part);
  // Révision d'une partie : toutes les cartes non maîtrisées (dues ou non).
  const mistakeIds = reviewMode ? new Set(readCards().filter(c => c.part === part && !c.mastered).map(c => c.questionId)) : null;
  const [dataset, setDataset] = useState<(PickedSet | { questions: Question[]; passages: Passage[]; origin?: undefined; relaxed?: undefined }) | null>(null);
  // Chaque « nouvelle série » tire d'autres questions dans la banque (jamais toute la banque).
  const [series, setSeries] = useState(0);
  const params = parseSeriesParams(search, part, categories.filter((c) => c.parts.includes(part)).map((c) => c.id));
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    let active = true;
    setDataset(null);
    const load = reviewMode
      ? loadQuestionsByIds([...(mistakeIds ?? [])])
      : loadSeries(part, params, recentSeenIds(myAttempts(), [part], 400));
    load.then((result) => { if (active) setDataset(result); }).catch(() => { if (active) setDataset({ questions: [], passages: [] }); });
    return () => { active = false; };
    // mistakeIds et params sont dérivés de reviewMode, part et de l'adresse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part, reviewMode, series, paramsKey]);
  const newSeries = () => setSeries((n) => n + 1);
  const category = params.category ?? params.categories?.map((id) => categories.find((c) => c.id === id)?.label ?? id).join(", ");
  const categoryLabel = params.category ? categories.find((c) => c.id === params.category)?.label ?? params.category : category;
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
          {!reviewMode && dataset && (
            <p className="lexora-subtle" role="status" style={{ marginTop: 8 }}>
              {categoryLabel ? `Série ciblée : ${categoryLabel}${params.difficulty ? ` · niveau ${params.difficulty}/3` : ""}. ` : "Série tirée au hasard dans la banque. "}
              Les questions que vous n'avez jamais vues passent en premier.
              {dataset.relaxed && dataset.relaxed.length > 0 ? ` La banque manque de questions pour tous vos filtres : ${dataset.relaxed.join(", ")} élargi(s).` : ""}
              {dataset.origin === "local" ? " Mode secours : jeu de questions local (connexion à la banque impossible)." : ""}
            </p>
          )}
        </div>
      {!dataset ? (
        <div className="glass p-8 text-center text-slate-600">Chargement des exercices…</div>
      ) : reviewMode && !dataset.questions.some(q => mistakeIds?.has(q.id)) ? ( 
        <div className="glass p-8 text-center text-slate-700">Aucune erreur à réviser pour cette partie. <a className="text-blue-700 underline" href="#/">Retour à l’accueil</a></div> 
      ) : reviewMode ? ( 
        <PracticeClient key={`${part}-review`} part={part} reviewMode questions={dataset.questions.filter(q => mistakeIds?.has(q.id))} passages={dataset.passages} /> 
      ) : part === 6 ? (
        <Part6Inline key={`${part}-${series}`} questions={dataset.questions} passages={dataset.passages} onNewSeries={newSeries} />
      ) : (
        <PracticeClient key={`${part}-${series}`} part={part} questions={dataset.questions} passages={dataset.passages} onNewSeries={newSeries} />
      )}
      </main>
    </div>
  );
}
