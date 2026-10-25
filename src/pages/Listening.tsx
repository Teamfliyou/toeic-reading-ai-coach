import { useEffect, useRef, useState } from "react";
import { getPart2Items, loadPart2Items, type ListeningItem } from "@/lib/listening";
import { myAttempts, recordAnswer } from "@/lib/tracker";
import AudioPlayer from "@/components/AudioPlayer";
import ReportButton from "@/components/ReportButton";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import categories from "../../data/categories.json";
import "./lexora.css";
import "./phase2.css";

const CATEGORY_LABELS = new Map((categories as { id: string; label: string }[]).map((c) => [c.id, c.label]));

/** Listening · Partie 2 (question-réponse) : un seul jeu de lecture, transcription après réponse. */
export default function Listening() {
  // Bibliothèque centralisée si elle contient des exercices, sinon fichier local (comportement historique).
  const [items, setItems] = useState<ListeningItem[] | null>(null);
  useEffect(() => {
    let active = true;
    const seen = myAttempts().filter((a) => a.part === 2).map((a) => a.questionId);
    loadPart2Items(seen).then((set) => active && setItems(set.items)).catch(() => active && setItems(getPart2Items()));
    return () => { active = false; };
  }, []);

  if (!items) {
    return <div className="lexora-page lexora-exercises"><main className="lexora-shell lexora-content"><div className="lexora-card" role="status">Chargement des exercices…</div></main></div>;
  }
  return <ListeningSession items={items} />;
}

function ListeningSession({ items }: { items: ListeningItem[] }) {
  const [index, setIndex] = useState(0);
  const [heard, setHeard] = useState(false);
  const [readingMode, setReadingMode] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const shownAt = useRef(performance.now());
  const heardAt = useRef(0);

  const item = items[index];
  const finished = index >= items.length;
  // Les réponses ne sont affichées qu'après l'écoute (ou en mode lecture).
  const canAnswer = heard || readingMode;

  const validate = () => {
    if (!selected || answered) return;
    const correct = selected === item.correctKey;
    recordAnswer({
      question: { id: item.id, part: 2, category: item.category },
      selectedKey: selected,
      correct,
      // Temps de réflexion après la fin de l'audio (ou depuis l'affichage en mode lecture).
      timeMs: performance.now() - (heardAt.current || shownAt.current),
      mode: "listening",
      spaced: false,
    });
    if (correct) setScore((s) => s + 1);
    setAnswered(true);
  };
  const resetQuestion = () => {
    setHeard(false);
    setReadingMode(false);
    setSelected(null);
    setAnswered(false);
    shownAt.current = performance.now();
    heardAt.current = 0;
  };
  const next = () => {
    setIndex((i) => i + 1);
    resetQuestion();
  };
  const restart = () => {
    setIndex(0);
    setScore(0);
    resetQuestion();
  };

  return (
    <div className="lexora-page lexora-exercises">
      <header className="lexora-nav"><div className="lexora-shell">
        <a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a>
        <div className="lexora-navright"><a className="lexora-smalllink" href="#/">Tableau de bord</a><AuthButton /><SettingsButton withLabel /></div>
      </div></header>
      <main className="lexora-shell lexora-content" style={{ maxWidth: 780 }}>
        <p className="lexora-eyebrow">Listening · Partie 2 · Question-réponse</p>
        <h1 className="lexora-heading">Écoutez, puis choisissez la meilleure réponse.</h1>

        {finished ? (
          <section className="lexora-card" aria-live="polite">
            <p className="lexora-scorebig">{score}/{items.length}</p>
            <p className="lexora-muted" style={{ marginTop: 12 }}>{Math.round((score / items.length) * 100)} % de réussite. Vos résultats alimentent vos statistiques par type de question.</p>
            <div className="lexora-actions"><a className="lexora-secondary" href="#/">Tableau de bord</a><button type="button" className="lexora-primary" onClick={restart}>Recommencer</button></div>
          </section>
        ) : (
          <>
            <div className="lexora-progressline" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={index} aria-label="Progression"><div style={{ width: `${(index / items.length) * 100}%` }} /></div>
            <section className="lexora-card">
              <p className="lexora-eyebrow">Question {index + 1} / {items.length}</p>
              <AudioPlayer
                key={item.id}
                item={item}
                onHeard={() => { heardAt.current = performance.now(); setHeard(true); }}
                onUnavailable={() => setReadingMode(true)}
              />

              {readingMode && !heard && (
                <p className="lexora-disclaimer">Mode lecture : l'énoncé est affiché faute de son. Cet exercice entraîne moins bien l'oreille.</p>
              )}
              {readingMode && <p className="lexora-question" style={{ fontSize: 20 }}>{item.prompt}</p>}

              <div className="lexora-options" role="group" aria-label="Choix de réponse">
                {item.options.map((o) => {
                  const state = !answered ? undefined : o.key === item.correctKey ? "correct" : o.key === selected ? "wrong" : undefined;
                  return (
                    <button key={o.key} type="button" className="lexora-option" aria-pressed={selected === o.key} data-state={state}
                      disabled={!canAnswer || answered} onClick={() => setSelected(o.key)}>
                      <span className="lexora-optionkey">{o.key}</span>
                      {(readingMode || answered) ? o.text : <span className="lexora-subtle">Réponse {o.key}</span>}
                      {state === "correct" && <span className="lexora-sr"> (bonne réponse)</span>}
                      {state === "wrong" && <span className="lexora-sr"> (votre réponse, incorrecte)</span>}
                    </button>
                  );
                })}
              </div>

              {answered && (
                <div className="lexora-transcript" role="status" aria-live="polite">
                  <strong>{selected === item.correctKey ? "Bonne réponse !" : `Bonne réponse : ${item.correctKey}.`}</strong>
                  <ReportButton key={item.id} questionId={item.id} part={2} audio />
                  <p style={{ margin: "8px 0 4px" }}><span className="lexora-pill">{CATEGORY_LABELS.get(item.category) ?? item.category}</span></p>
                  <p style={{ margin: "8px 0 0" }}><strong>Transcription</strong><br />
                    « {item.prompt} »<br />
                    {item.options.map((o) => <span key={o.key}>{o.key}. {o.text}<br /></span>)}
                  </p>
                </div>
              )}

              <div className="lexora-actions" style={{ marginTop: 18 }}>
                <a className="lexora-secondary" href="#/">Quitter</a>
                {answered ? (
                  <button type="button" className="lexora-primary" onClick={next}>{index + 1 === items.length ? "Voir mon score" : "Suivante"} →</button>
                ) : (
                  <button type="button" className="lexora-primary" disabled={!selected || !canAnswer} onClick={validate}>Valider ma réponse</button>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
