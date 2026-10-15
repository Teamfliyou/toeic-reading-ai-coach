import { useEffect, useMemo, useState } from "react";
import type { Question, OptionKey } from "@/lib/types";
import { loadPart } from "@/lib/data";
import "./lexora.css";

export const DIAGNOSTIC_KEY = "lexora_diagnostic_v1";
export type DiagnosticResult = { correct: number; total: number; date: string; wrongIds: string[] };
export function readDiagnostic(): DiagnosticResult | null {
  try {
    const raw = localStorage.getItem(DIAGNOSTIC_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as DiagnosticResult;
    return Number.isFinite(value.correct) && Number.isFinite(value.total) && typeof value.date === "string" && Array.isArray(value.wrongIds) ? value : null;
  } catch { return null; }
}
export default function Diagnostic() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<OptionKey | null>(null);
  const [answers, setAnswers] = useState<{ id: string; answer: OptionKey; correct: boolean }[]>([]);
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    let active = true;
    loadPart(5).then(({ questions: all }) => {
      if (active) { setQuestions(all.slice(0, 15)); setLoading(false); }
    }).catch(() => { if (active) { setError(true); setLoading(false); } });
    return () => { active = false; };
  }, []);
  const question = questions[index];
  const correct = useMemo(() => answers.filter(a => a.correct).length, [answers]);
  function submit() {
    if (!selected || !question) return;
    const next = [...answers, { id: question.id, answer: selected, correct: selected === question.correctKey }];
    setAnswers(next);
    setSelected(null);
    if (index + 1 === questions.length) {
      const result: DiagnosticResult = {
        correct: next.filter(a => a.correct).length,
        total: next.length,
        date: new Date().toISOString(),
        wrongIds: next.filter(a => !a.correct).map(a => a.id),
      };
      try { localStorage.setItem(DIAGNOSTIC_KEY, JSON.stringify(result)); } catch { /* Storage optional */ }
      setFinished(true);
    } else setIndex(index + 1);
  }
  return <div className="lexora-page">
    <header className="lexora-nav"><div className="lexora-shell"><a className="lexora-brand" href="#/"><span className="lexora-mark">N</span> Lernoviq</a><span className="lexora-subtle">Évaluation initiale · Reading</span></div></header>
    <main className="lexora-shell"><div className="lexora-assessment">
      {loading ? <div className="lexora-card">Préparation de votre diagnostic…</div> :
       error || !questions.length ? <div className="lexora-card"><h1>Diagnostic indisponible</h1><p className="lexora-muted">Impossible de charger les questions pour le moment.</p><a className="lexora-secondary" href="#/">Retour à l'accueil</a></div> :
       finished ? <section className="lexora-card" aria-live="polite"><p className="lexora-eyebrow">Votre diagnostic est terminé</p><h1 className="lexora-heading">Votre point de départ</h1><span className="lexora-resultmark">{Math.round(correct / questions.length * 100)} %</span><p className="lexora-muted">{correct} bonnes réponses sur {questions.length}. Ce résultat mesure uniquement cette série de questions de grammaire et de vocabulaire : il ne constitue pas une estimation officielle de votre niveau CECRL ou d'un score d'examen.</p><p className="lexora-muted">Vous avez {questions.length-correct} question(s) à retravailler. Poursuivez avec des séances ciblées pour progresser.</p><div className="lexora-actions"><a className="lexora-secondary" href="#/">Tableau de bord</a><a className="lexora-primary" href="#/practice/part5">Continuer l'entraînement →</a></div></section> :
       <><p className="lexora-eyebrow">Évaluation initiale</p><h1 className="lexora-heading">Faisons le point sur votre anglais.</h1><p className="lexora-muted">Un diagnostic court, sans chronomètre. Choisissez une réponse par question.</p><div className="lexora-progressline" role="progressbar" aria-valuenow={index} aria-valuemin={0} aria-valuemax={questions.length} aria-label="Progression du diagnostic"><div style={{ width: `${index/questions.length*100}%` }}/></div>
       <div className="lexora-card"><p className="lexora-eyebrow">Question {index+1} / {questions.length}</p><p className="lexora-question">{question.prompt}</p><div className="lexora-options">{question.options.map(option => <button type="button" className="lexora-option" aria-pressed={selected === option.key} key={option.key} onClick={() => setSelected(option.key)}><span className="lexora-optionkey">{option.key}</span>{option.text}</button>)}</div><div className="lexora-actions"><a href="#/" className="lexora-secondary">Quitter</a><button type="button" className="lexora-primary" disabled={!selected} onClick={submit}>{index + 1 === questions.length ? "Voir mes résultats" : "Question suivante"} →</button></div></div></>}
    </div></main>
  </div>;
}
