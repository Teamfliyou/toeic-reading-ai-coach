import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Passage, Question } from "@/lib/types";
import { loadAll } from "@/lib/data";
import { recordAnswer } from "@/lib/tracker";
import { addExamRecord } from "@/lib/goalsStore";
import {
  EXAM_DURATION_MS,
  addTime,
  buildExam,
  formatClock,
  gradeExam,
  newExamState,
  remainingMs,
  setAnswer,
  toggleFlag,
  type ExamState,
} from "@/lib/exam";
import QuestionView from "@/components/QuestionView";
import ReportButton from "@/components/ReportButton";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import { getPartInfo } from "@/lib/parts";
import "./lexora.css";
import "./phase2.css";

const STORE_KEY = "lernoviq_exam_v1";

function readExam(): ExamState | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    const s = raw as ExamState | null;
    return s && Array.isArray(s.questionIds) && typeof s.deadline === "number" && s.answers ? s : null;
  } catch {
    return null;
  }
}
function writeExam(state: ExamState | null) {
  try {
    if (state) localStorage.setItem(STORE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* Sans stockage, l'examen fonctionne mais ne survit pas à un rechargement. */
  }
}

export default function Exam() {
  const [data, setData] = useState<{ questions: Question[]; passages: Passage[] } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [state, setState] = useState<ExamState | null>(() => readExam());
  const [index, setIndex] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const enteredAt = useRef(performance.now());

  useEffect(() => {
    let active = true;
    loadAll()
      .then((result) => active && setData(result))
      .catch(() => active && setLoadError(true));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => writeExam(state), [state]);

  const questions = useMemo(() => new Map((data?.questions ?? []).map((q) => [q.id, q])), [data]);
  const ids = useMemo(
    () => (state?.questionIds ?? []).filter((id) => questions.has(id)),
    [state?.questionIds, questions]
  );
  const running = Boolean(state && !state.finishedAt);

  /** Ajoute le temps passé sur la question affichée avant de changer d'écran. */
  const flush = useCallback(
    (current: ExamState): ExamState => {
      const elapsed = performance.now() - enteredAt.current;
      enteredAt.current = performance.now();
      const id = current.questionIds[index];
      return id ? addTime(current, id, elapsed) : current;
    },
    [index]
  );

  // L'enregistrement des réponses a des effets de bord : il ne doit pas se trouver
  // dans une fonction de mise à jour React (exécutée deux fois en mode strict).
  const stateRef = useRef(state);
  stateRef.current = state;

  const finish = useCallback(() => {
    const prev = stateRef.current;
    if (!prev || prev.finishedAt || !data) return;
    let next = { ...flush(prev), finishedAt: Date.now() };
    if (!next.recorded) {
      // Une réponse enregistrée par question ; « - » pour une question laissée vide.
      for (const id of next.questionIds) {
        const q = data.questions.find((x) => x.id === id);
        if (!q) continue;
        const key = next.answers[id];
        recordAnswer({
          question: q,
          selectedKey: key ?? "-",
          correct: key === q.correctKey,
          timeMs: next.timeSpent[id] ?? 0,
          mode: "exam",
        });
      }
      next = { ...next, recorded: true };
      const graded = gradeExam(next, data.questions);
      addExamRecord({ at: new Date().toISOString(), score: graded.score, correct: graded.correct, total: graded.total });
    }
    stateRef.current = next;
    setState(next);
    setConfirmEnd(false);
  }, [data, flush]);

  // Chronomètre : calculé depuis l'échéance, donc exact même après un rechargement.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const remaining = state ? remainingMs(state, now) : 0;
  useEffect(() => {
    if (running && data && remaining <= 0) finish();
  }, [running, data, remaining, finish]);

  const goTo = (target: number) => {
    if (!state || target < 0 || target >= ids.length) return;
    setState(flush(state));
    setIndex(target);
  };

  const start = () => {
    if (!data) return;
    const next = newExamState(buildExam(data.questions), Date.now());
    enteredAt.current = performance.now();
    setIndex(0);
    setNow(Date.now());
    setState(next);
  };
  const reset = () => {
    setState(null);
    setIndex(0);
  };

  const header = (
    <header className="lexora-nav">
      <div className="lexora-shell">
        <a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a>
        <div className="lexora-navright">
          <a className="lexora-smalllink" href="#/">Tableau de bord</a>
          <AuthButton />
          <SettingsButton withLabel />
        </div>
      </div>
    </header>
  );

  if (loadError) {
    return (
      <div className="lexora-page lexora-exercises">{header}
        <main className="lexora-shell lexora-content"><div className="lexora-card">
          <h1>Examen indisponible</h1>
          <p className="lexora-muted">Impossible de charger les questions pour le moment.</p>
          <a className="lexora-secondary" href="#/">Retour à l'accueil</a>
        </div></main>
      </div>
    );
  }
  if (!data) {
    return <div className="lexora-page lexora-exercises">{header}<main className="lexora-shell lexora-content"><div className="lexora-card">Chargement de l'examen…</div></main></div>;
  }

  // --- Accueil ---------------------------------------------------------------
  if (!state) {
    const total = buildExam(data.questions).length;
    const perPart = ([5, 6, 7] as const).map((p) => ({ p, n: data.questions.filter((q) => q.part === p).length }));
    return (
      <div className="lexora-page lexora-exercises">{header}
        <main className="lexora-shell lexora-content" style={{ maxWidth: 780 }}>
          <p className="lexora-eyebrow">Examen blanc · Reading</p>
          <h1 className="lexora-heading">Conditions d'examen, sans explication en cours de route.</h1>
          <p className="lexora-muted">Parties 5, 6 et 7 à la suite, avec un minuteur de {EXAM_DURATION_MS / 60000} minutes. Vous pouvez naviguer librement, modifier vos réponses et marquer des questions « à revoir ». Les corrections et le score estimé s'affichent à la fin.</p>
          <section className="lexora-card" style={{ margin: "24px 0" }}>
            <p className="lexora-statlabel">Contenu de cet examen</p>
            <p className="lexora-statvalue">{total} questions</p>
            <p className="lexora-subtle">{perPart.map(({ p, n }) => `Partie ${p} : ${n}`).join(" · ")}</p>
            {total < 100 && <p className="lexora-disclaimer">Le jeu de questions actuel est plus court qu'un vrai examen Reading (100 questions). Le score estimé est donc extrapolé à partir de votre pourcentage de réussite.</p>}
          </section>
          <div className="lexora-actions">
            <a className="lexora-secondary" href="#/">Retour</a>
            <button type="button" className="lexora-primary" onClick={start} disabled={!total}>Commencer l'examen →</button>
          </div>
        </main>
      </div>
    );
  }

  // --- Résultats -------------------------------------------------------------
  if (state.finishedAt) {
    const result = gradeExam(state, data.questions);
    const spent = Math.max(0, state.finishedAt - state.startedAt);
    const tone = (pct: number) => (pct >= 75 ? "high" : pct >= 50 ? "mid" : "low");
    return (
      <div className="lexora-page lexora-exercises">{header}
        <main className="lexora-shell lexora-content" style={{ maxWidth: 860 }}>
          <p className="lexora-eyebrow">Examen terminé</p>
          <h1 className="lexora-heading">Vos résultats</h1>
          <section className="lexora-card" aria-live="polite">
            <p className="lexora-statlabel">Score Reading estimé (sur 495)</p>
            <p className="lexora-scorebig">{result.score}</p>
            <p className="lexora-muted" style={{ marginTop: 12 }}>{result.correct} bonnes réponses sur {result.total} · {result.unanswered.length} sans réponse · temps utilisé {formatClock(Math.min(spent, EXAM_DURATION_MS))}</p>
            <p className="lexora-disclaimer">Estimation indicative issue d'une table de conversion approximative : le barème officiel varie d'une session à l'autre et n'est pas publié. Ce n'est pas un score officiel.{result.reduced ? ` L'examen compte ${result.total} questions au lieu de 100 : le score est extrapolé.` : ""}</p>
            <div className="lexora-rows">
              {([5, 6, 7] as const).map((p) => {
                const r = result.byPart[p];
                if (!r) return null;
                const pct = Math.round((r.correct / r.total) * 100);
                return (
                  <div className="lexora-row" key={p}>
                    <span>Partie {p} · {getPartInfo(p).name}</span>
                    <div className="lexora-bar" data-tone={tone(pct)} role="img" aria-label={`${pct} % de réussite`}><div style={{ width: `${pct}%` }} /></div>
                    <span>{r.correct}/{r.total} ({pct} %)</span>
                  </div>
                );
              })}
            </div>
          </section>

          {(result.wrong.length > 0 || result.unanswered.length > 0) && (
            <section style={{ marginTop: 28 }}>
              <h2>À retravailler ({result.wrong.length + result.unanswered.length})</h2>
              <p className="lexora-muted">Ces questions ont été ajoutées à vos révisions espacées.</p>
              <div className="lexora-wrong-list">
                {[...result.wrong, ...result.unanswered].map((id) => {
                  const q = questions.get(id);
                  if (!q) return null;
                  const mine = q.options.find((o) => o.key === state.answers[id]);
                  const good = q.options.find((o) => o.key === q.correctKey);
                  return (
                    <article key={id}>
                      <span className="lexora-pill">Partie {q.part}</span>
                      <p style={{ margin: "8px 0" }}>{q.prompt}</p>
                      <p style={{ margin: 0, color: "#9a3232" }}>Votre réponse : {mine ? `${mine.key}. ${mine.text}` : "aucune"}</p>
                      <p style={{ margin: 0, color: "#176443" }}>Bonne réponse : {good?.key}. {good?.text}</p>
                      <ReportButton questionId={q.id} part={q.part} />
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <div className="lexora-actions" style={{ marginTop: 28 }}>
            <button type="button" className="lexora-secondary" onClick={reset}>Refaire un examen</button>
            <span style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <a className="lexora-secondary" href="#/stats">Mes statistiques</a>
              <a className="lexora-primary" href="#/review">Réviser mes erreurs →</a>
            </span>
          </div>
        </main>
      </div>
    );
  }

  // --- Examen en cours -------------------------------------------------------
  const id = ids[index];
  const question = id ? questions.get(id) : undefined;
  if (!question) {
    return <div className="lexora-page lexora-exercises">{header}<main className="lexora-shell lexora-content"><div className="lexora-card">Questions de cet examen introuvables. <button type="button" className="lexora-secondary" onClick={reset}>Recommencer</button></div></main></div>;
  }
  const passage = question.passageId ? data.passages.find((p) => p.id === question.passageId) ?? null : null;
  const answeredCount = ids.filter((x) => state.answers[x]).length;
  const minutesLeft = Math.ceil(remaining / 60000);
  const announce = [10, 5, 1].includes(minutesLeft) && remaining % 60000 > 0 ? `Il reste ${minutesLeft} minute${minutesLeft > 1 ? "s" : ""}.` : "";
  const unanswered = ids.length - answeredCount;

  return (
    <div className="lexora-page lexora-exercises">
      <div className="lexora-exam-bar">
        <div className="lexora-shell">
          <span><strong>Examen blanc</strong> <span className="lexora-subtle">· {answeredCount}/{ids.length} répondues</span></span>
          <span className="lexora-clock" data-low={remaining < 5 * 60000} role="timer" aria-label={`Temps restant ${formatClock(remaining)}`}>{formatClock(remaining)}</span>
          <button type="button" className="lexora-primary" onClick={() => setConfirmEnd(true)}>Terminer l'examen</button>
        </div>
      </div>
      <div className="lexora-sr" role="status" aria-live="polite">{announce}</div>
      <main className="lexora-shell lexora-content" style={{ paddingTop: 28 }}>
        {confirmEnd && (
          <div className="lexora-card" role="alertdialog" aria-labelledby="end-title" style={{ marginBottom: 18, borderColor: "#d98b1f" }}>
            <h2 id="end-title" style={{ fontSize: 18 }}>Terminer l'examen ?</h2>
            <p className="lexora-muted">{unanswered > 0 ? `${unanswered} question(s) sans réponse compteront comme fausses.` : "Toutes les questions ont une réponse."} {state.flagged.length > 0 && `${state.flagged.length} question(s) sont marquées « à revoir ».`}</p>
            <div className="lexora-actions">
              <button type="button" className="lexora-secondary" onClick={() => setConfirmEnd(false)}>Continuer l'examen</button>
              <button type="button" className="lexora-primary" onClick={finish}>Oui, terminer</button>
            </div>
          </div>
        )}

        <QuestionView
          key={question.id}
          question={question}
          passage={passage}
          number={index + 1}
          selected={state.answers[question.id] ?? null}
          onSelect={(key) => setState(setAnswer(state, question.id, key))}
        />

        <div className="lexora-actions" style={{ marginTop: 16 }}>
          <button type="button" className="lexora-secondary" onClick={() => goTo(index - 1)} disabled={index === 0}>← Précédente</button>
          <button type="button" className={`lexora-secondary ${state.flagged.includes(question.id) ? "lexora-flag-on" : ""}`} aria-pressed={state.flagged.includes(question.id)} onClick={() => setState(toggleFlag(state, question.id))}>
            {state.flagged.includes(question.id) ? "Marquée à revoir" : "Marquer à revoir"}
          </button>
          <button type="button" className="lexora-primary" onClick={() => goTo(index + 1)} disabled={index === ids.length - 1}>Suivante →</button>
        </div>

        <nav aria-label="Navigation entre les questions" style={{ marginTop: 26 }}>
          <div className="lexora-palette">
            {ids.map((qid, i) => (
              <button key={qid} type="button" onClick={() => goTo(i)} aria-current={i === index} data-answered={Boolean(state.answers[qid])} data-flagged={state.flagged.includes(qid)} aria-label={`Question ${i + 1}${state.answers[qid] ? ", répondue" : ", sans réponse"}${state.flagged.includes(qid) ? ", à revoir" : ""}`}>
                {i + 1}
              </button>
            ))}
          </div>
          <p className="lexora-legend"><span>Fond bleu : répondue</span><span>Point orange : à revoir</span><span>Contour : question affichée</span></p>
        </nav>
      </main>
    </div>
  );
}
