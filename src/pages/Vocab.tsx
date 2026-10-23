import { useEffect, useMemo, useState } from "react";
import { DATA_EVENT } from "@/lib/tracker";
import { answerWord, readWords, removeWord } from "@/lib/vocabStore";
import { dueWords, type VocabWord } from "@/lib/vocab";
import { useAuth } from "@/lib/AuthContext";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import "./lexora.css";
import "./phase2.css";

/** Carnet de vocabulaire : liste des mots et séance de flashcards (Leitner). */
export default function Vocab() {
  const { user } = useAuth();
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<"list" | "cards">("list");
  // File de la séance : figée au démarrage, les mots « à revoir » reviennent en fin de file.
  const [queue, setQueue] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);

  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    window.addEventListener(DATA_EVENT, refresh);
    return () => window.removeEventListener(DATA_EVENT, refresh);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` et l'utilisateur déclenchent la relecture du stockage local
  const words = useMemo(() => readWords(), [version, user?.id]);
  const byId = useMemo(() => new Map(words.map((w) => [w.id, w])), [words]);
  const dueCount = useMemo(() => dueWords(words).length, [words]);
  const current: VocabWord | undefined = queue.length ? byId.get(queue[0]) : undefined;

  const start = () => {
    setQueue(dueWords(words).map((w) => w.id));
    setDone(0);
    setRevealed(false);
    setMode("cards");
  };

  const answer = (correct: boolean) => {
    if (!current) return;
    answerWord(current.id, correct);
    setRevealed(false);
    setQueue((q) => (correct ? q.slice(1) : [...q.slice(1), q[0]].filter((id, i, a) => a.indexOf(id) === i)));
    if (correct) setDone((n) => n + 1);
  };

  return (
    <div className="lexora-page">
      <header className="lexora-nav"><div className="lexora-shell">
        <a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a>
        <div className="lexora-navright"><a className="lexora-smalllink" href="#/">Tableau de bord</a><AuthButton /><SettingsButton withLabel /></div>
      </div></header>
      <main className="lexora-shell lexora-content" style={{ maxWidth: 820 }}>
        <p className="lexora-eyebrow">Mon vocabulaire</p>
        <h1 className="lexora-heading">Mes mots</h1>
        <p className="lexora-muted">Ajoutez des mots depuis les explications du coach, puis révisez-les en flashcards avec le même rythme espacé que vos erreurs.</p>

        {mode === "cards" ? (
          <section className="lexora-card" aria-live="polite">
            {current ? (
              <>
                <p className="lexora-eyebrow">Flashcard · {queue.length} restante(s)</p>
                <p className="lexora-scorebig" style={{ fontSize: 40, letterSpacing: -1 }}>{current.term}</p>
                {revealed ? (
                  <div className="lexora-transcript">
                    <p style={{ margin: 0 }}><strong>{current.meaning}</strong></p>
                    {current.example && <p style={{ margin: "8px 0 0" }}><em>{current.example}</em></p>}
                  </div>
                ) : (
                  <p className="lexora-muted" style={{ marginTop: 14 }}>Cherchez le sens, puis révélez-le.</p>
                )}
                <div className="lexora-actions" style={{ marginTop: 20 }}>
                  <button type="button" className="lexora-secondary" onClick={() => setMode("list")}>Arrêter</button>
                  {revealed ? (
                    <span style={{ display: "flex", gap: 10 }}>
                      <button type="button" className="lexora-secondary" onClick={() => answer(false)}>À revoir</button>
                      <button type="button" className="lexora-primary" onClick={() => answer(true)}>Je savais ✓</button>
                    </span>
                  ) : (
                    <button type="button" className="lexora-primary" onClick={() => setRevealed(true)} autoFocus>Afficher le sens</button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="lexora-scorebig">{done}</p>
                <p className="lexora-muted" style={{ marginTop: 12 }}>mot(s) validé(s) pour cette séance. Les mots reviendront à intervalles croissants.</p>
                <div className="lexora-actions"><span /><button type="button" className="lexora-primary" onClick={() => setMode("list")}>Retour à mes mots</button></div>
              </>
            )}
          </section>
        ) : (
          <>
            <section className="lexora-hero" style={{ margin: "24px 0" }}>
              <div>
                <h2>{dueCount ? `${dueCount} mot(s) à réviser` : "Aucun mot à réviser maintenant"}</h2>
                <p className="lexora-muted">{words.length ? `${words.length} mot(s) dans votre carnet.` : "Votre carnet est vide : utilisez « Ajouter à mes mots » sous une explication."}</p>
              </div>
              <button type="button" className="lexora-primary" disabled={!dueCount} onClick={start}>Réviser en flashcards →</button>
            </section>
            {words.length > 0 && (
              <ul className="lexora-wrong-list" aria-label="Mes mots">
                {words.map((w) => (
                  <li key={w.id} style={{ listStyle: "none" }}>
                    <article>
                      <div className="lexora-actions">
                        <strong>{w.term}</strong>
                        <span className="lexora-pill">{w.mastered ? "Maîtrisé" : `Boîte ${w.box}`}</span>
                      </div>
                      <p style={{ margin: "6px 0" }}>{w.meaning}</p>
                      {w.example && <p className="lexora-subtle" style={{ margin: 0 }}><em>{w.example}</em></p>}
                      <button type="button" className="lexora-secondary" style={{ marginTop: 10 }} onClick={() => removeWord(w.id)} aria-label={`Supprimer ${w.term}`}>Supprimer</button>
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
}
