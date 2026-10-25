import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Passage, Question } from "@/lib/types";
import { loadExamPool, loadQuestionsByIds } from "@/lib/data";
import { buildReadingExam, reducedNotice, EXAM_TARGET, type BuiltExam } from "@/lib/examBuilder";
import { recentSeenIds } from "@/lib/adaptive";
import { myAttempts, recordAnswer } from "@/lib/tracker";
import { addExamRecord } from "@/lib/goalsStore";
import {
  EXAM_DURATION_MS,
  addTime,
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
/** Questions et documents de l'examen en cours : la banque est tirée au hasard, on les mémorise. */
const SNAPSHOT_KEY = "lernoviq_exam_snapshot_v1";
/** Question affichée : l'élève retrouve sa place après un rechargement. */
const INDEX_KEY = "lernoviq_exam_index_v1";
function readIndex(): number {
  try {
    const n = Number(localStorage.getItem(INDEX_KEY));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

interface Snapshot {
  questions: Question[];
  passages: Passage[];
  reduced: boolean;
  counts: BuiltExam["counts"];
  notice: string;
}

function readSnapshot(): Snapshot | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
    const s = raw as Snapshot | null;
    return s && Array.isArray(s.questions) && Array.isArray(s.passages) ? s : null;
  } catch {
    return null;
  }
}
function writeSnapshot(snapshot: Snapshot | null) {
  try {
    if (snapshot) localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    else localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* Sans stockage, l'examen ne survivra pas à un rechargement. */
  }
}
const toSnapshot = (exam: BuiltExam): Snapshot => ({ questions: exam.questions, passages: exam.passages, reduced: exam.reduced, counts: exam.counts, notice: reducedNotice(exam) });

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
  const [state, setState] = useState<ExamState | null>(() => readExam());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => readSnapshot());
  const [prepared, setPrepared] = useState<BuiltExam | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const data = useMemo(() => (snapshot ? { questions: snapshot.questions, passages: snapshot.passages } : null), [snapshot]);
  const [index, setIndex] = useState(() => (readExam() ? readIndex() : 0));
  const [now, setNow] = useState(() => Date.now());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const enteredAt = useRef(performance.now());

  // Tire et compose un examen (parties 5, 6, 7) sans jamais charger toute la banque.
  const prepare = useCallback(async () => {
    setPreparing(true);
    setLoadError(false);
    try {
      const seen = recentSeenIds(myAttempts(), [5, 6, 7], 600);
      const pool = await loadExamPool(seen);
      setPrepared(buildReadingExam(pool, seen));
    } catch {
      setLoadError(true);
    } finally {
      setPreparing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (state) {
      // Examen commencé avant l'enregistrement de son contenu : on le reconstitue par identifiants.
      if (!snapshot) {
        loadQuestionsByIds(state.questionIds)
          .then((d) => active && setSnapshot({ questions: d.questions, passages: d.passages, reduced: state.questionIds.length < 100, counts: { p5: 0, p6: 0, p7: 0 }, notice: "" }))
          .catch(() => active && setLoadError(true));
      }
    } else if (!prepared && !preparing) void prepare();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state === null]);

  useEffect(() => writeExam(state), [state]);
  useEffect(() => {
    try {
      if (state) localStorage.setItem(INDEX_KEY, String(index));
      else localStorage.removeItem(INDEX_KEY);
    } catch {
      /* Sans stockage, la position n'est pas conservée. */
    }
  }, [state, index]);
  useEffect(() => writeSnapshot(state ? snapshot : null), [state, snapshot]);

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
    if (!prepared || !prepared.questions.length) return;
    // Durée : 75 minutes pour 100 questions ; proportionnelle pour un examen réduit.
    const duration = Math.max(10 * 60_000, Math.round((EXAM_DURATION_MS * prepared.questions.length) / 100));
    const next = newExamState(prepared.questions.map((q) => q.id), Date.now(), prepared.reduced ? duration : EXAM_DURATION_MS);
    setSnapshot(toSnapshot(prepared));
    enteredAt.current = performance.now();
    setIndex(0);
    setNow(Date.now());
    setState(next);
  };
  const reset = () => {
    setState(null);
    setSnapshot(null);
    setPrepared(null);
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

  if (loadError && (state ? !data : !prepared)) {
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
  if (state && !data) {
    return <div className="lexora-page lexora-exercises">{header}<main className="lexora-shell lexora-content"><div className="lexora-card">Chargement de l'examen…</div></main></div>;
  }

  // --- Accueil ---------------------------------------------------------------
  if (!state) {
    if (!prepared) {
      return <div className="lexora-page lexora-exercises">{header}<main className="lexora-shell lexora-content"><div className="lexora-card" role="status">{preparing ? "Composition de l'examen…" : "Préparation de l'examen…"}</div></main></div>;
    }
    const total = prepared.questions.length;
    const perPart = ([5, 6, 7] as const).map((p) => ({ p, n: prepared.counts[`p${p}` as "p5" | "p6" | "p7"], target: EXAM_TARGET[`p${p}` as "p5" | "p6" | "p7"] }));
    return (
      <div className="lexora-page lexora-exercises">{header}
        <main className="lexora-shell lexora-content" style={{ maxWidth: 780 }}>
          <p className="lexora-eyebrow">Examen blanc · Reading</p>
          <h1 className="lexora-heading">Conditions d'examen, sans explication en cours de route.</h1>
          <p className="lexora-muted">Parties 5, 6 et 7 à la suite, avec un minuteur de {EXAM_DURATION_MS / 60000} minutes pour un examen complet. Vous pouvez naviguer librement, revenir aux questions précédentes, modifier vos réponses et marquer des questions « à revoir ». La correction et le score estimé s'affichent à la fin.</p>
          <section className="lexora-card" style={{ margin: "24px 0" }}>
            <p className="lexora-statlabel">Contenu de cet examen</p>
            <p className="lexora-statvalue">{total} question{total > 1 ? "s" : ""}{prepared.reduced ? " · examen réduit" : " · examen complet"}</p>
            <p className="lexora-subtle">{perPart.map(({ p, n, target }) => `Partie ${p} : ${n}/${target}`).join(" · ")} · niveaux {prepared.difficulty[1]} faciles, {prepared.difficulty[2]} intermédiaires, {prepared.difficulty[3]} avancées</p>
            {prepared.reduced && <p className="lexora-disclaimer" role="alert"><strong>Examen réduit.</strong> {reducedNotice(prepared)} La durée est ajustée en proportion.</p>}
            {!prepared.reduced && prepared.repeated > 0 && <p className="lexora-disclaimer">{prepared.repeated} question(s) de cet examen vous ont déjà été proposées : la banque n'a pas assez de questions inédites pour cette composition.</p>}
            {!prepared.reduced && prepared.repeated === 0 && <p className="lexora-subtle">Aucune question déjà vue : tirage varié à chaque examen.</p>}
          </section>
          {loadError && <p className="lexora-notice" role="alert">Impossible de charger les questions pour le moment.</p>}
          <div className="lexora-actions">
            <a className="lexora-secondary" href="#/">Retour</a>
            <span style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" className="lexora-secondary" onClick={() => { setPrepared(null); void prepare(); }} disabled={preparing}>Tirer un autre examen</button>
              <button type="button" className="lexora-primary" onClick={start} disabled={!total}>Commencer l'examen →</button>
            </span>
          </div>
        </main>
      </div>
    );
  }

  if (!data) return null; // (état en cours sans contenu : déjà traité plus haut)

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
            <p className="lexora-disclaimer">Estimation indicative issue d'une table de conversion approximative : le barème officiel varie d'une session à l'autre et n'est pas publié. Ce n'est pas un score officiel ETS.{result.reduced ? ` L'examen compte ${result.total} questions au lieu de 100 : le score est extrapolé.` : ""}</p>
            {(result.reduced || snapshot?.reduced) && <p className="lexora-disclaimer" role="note"><strong>Examen réduit :</strong> {snapshot?.notice || "ce n'est pas un examen complet de 100 questions."}</p>}
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
                      {q.explanation && <p className="lexora-subtle" style={{ margin: "6px 0 0" }}>{q.explanation}</p>}
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
