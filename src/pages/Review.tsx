import { useEffect, useMemo, useRef, useState } from "react";
import type { Passage, Question } from "@/lib/types";
import { loadAll } from "@/lib/data";
import { dueNow, readCards, recordAnswer } from "@/lib/tracker";
import { INTERVAL_DAYS } from "@/lib/srs";
import QuestionView from "@/components/QuestionView";
import ReportButton from "@/components/ReportButton";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import "./lexora.css";
import "./phase2.css";

/** Séance « À réviser aujourd'hui » : les cartes dues, de la boîte 1 à la boîte 5. */
export default function Review() {
  const [data, setData] = useState<{ questions: Question[]; passages: Passage[] } | null>(null);
  const [failed, setFailed] = useState(false);
  // Liste figée au début de la séance : répondre ne la fait pas bouger sous les pieds.
  const [queue] = useState(() => dueNow().map((c) => c.questionId));
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const shownAt = useRef(performance.now());

  useEffect(() => {
    let active = true;
    loadAll().then((d) => active && setData(d)).catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const questions = useMemo(() => {
    const byId = new Map((data?.questions ?? []).map((q) => [q.id, q]));
    return queue.map((id) => byId.get(id)).filter((q): q is Question => Boolean(q));
  }, [data, queue]);

  const nextDue = useMemo(() => {
    const upcoming = readCards().filter((c) => !c.mastered && Date.parse(c.due) > Date.now());
    return upcoming.length ? new Date(Math.min(...upcoming.map((c) => Date.parse(c.due)))) : null;
  }, []);

  const header = (
    <header className="lexora-nav"><div className="lexora-shell">
      <a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a>
      <div className="lexora-navright"><a className="lexora-smalllink" href="#/stats">Statistiques</a><AuthButton /><SettingsButton withLabel /></div>
    </div></header>
  );

  const question = questions[index];
  const done = data !== null && index >= questions.length;

  const check = () => {
    if (!question || !selected || checked) return;
    const correct = selected === question.correctKey;
    recordAnswer({ question, selectedKey: selected, correct, timeMs: performance.now() - shownAt.current, mode: "review" });
    if (correct) setCorrectCount((n) => n + 1);
    setChecked(true);
  };
  const next = () => {
    setIndex((i) => i + 1);
    setSelected(null);
    setChecked(false);
    shownAt.current = performance.now();
  };

  return (
    <div className="lexora-page lexora-exercises">
      {header}
      <main className="lexora-shell lexora-content">
        <p className="lexora-eyebrow">Répétition espacée</p>
        <h1 className="lexora-heading">À réviser aujourd'hui</h1>
        {failed ? (
          <div className="lexora-card"><p className="lexora-muted">Impossible de charger les questions pour le moment.</p><a className="lexora-secondary" href="#/">Retour</a></div>
        ) : !data ? (
          <div className="lexora-card">Chargement…</div>
        ) : questions.length === 0 ? (
          <section className="lexora-hero">
            <div>
              <h2>Rien à réviser pour le moment</h2>
              <p className="lexora-muted">{nextDue ? `Prochaine révision le ${nextDue.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}.` : "Les questions que vous ratez reviennent ici automatiquement, à intervalles croissants."}</p>
            </div>
            <a className="lexora-primary" href="#/practice/part5">S'entraîner →</a>
          </section>
        ) : done ? (
          <section className="lexora-card" aria-live="polite">
            <p className="lexora-scorebig">{correctCount}/{questions.length}</p>
            <p className="lexora-muted" style={{ marginTop: 12 }}>Les bonnes réponses montent d'une boîte (prochain rappel dans {INTERVAL_DAYS[1]} jours ou plus) ; les erreurs repartent en boîte 1 pour être revues bientôt.</p>
            <div className="lexora-actions"><a className="lexora-secondary" href="#/">Tableau de bord</a><a className="lexora-primary" href="#/stats">Voir mes statistiques →</a></div>
          </section>
        ) : (
          <>
            <div className="lexora-progressline" role="progressbar" aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={index} aria-label="Progression de la révision"><div style={{ width: `${(index / questions.length) * 100}%` }} /></div>
            <QuestionView
              key={question.id}
              question={question}
              passage={question.passageId ? data.passages.find((p) => p.id === question.passageId) ?? null : null}
              number={index + 1}
              selected={selected}
              onSelect={setSelected}
              reveal={checked}
              disabled={checked}
            />
            {checked && <ReportButton key={question.id} questionId={question.id} part={question.part} />}
            <div className="lexora-actions" style={{ marginTop: 16 }} role="status" aria-live="polite">
              <a className="lexora-secondary" href="#/">Quitter</a>
              {checked ? (
                <>
                  <strong>{selected === question.correctKey ? "Bonne réponse !" : "Pas tout à fait : la bonne réponse est signalée en vert."}</strong>
                  <button type="button" className="lexora-primary" onClick={next}>{index + 1 === questions.length ? "Terminer" : "Suivante"} →</button>
                </>
              ) : (
                <button type="button" className="lexora-primary" disabled={!selected} onClick={check}>Valider ma réponse</button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
