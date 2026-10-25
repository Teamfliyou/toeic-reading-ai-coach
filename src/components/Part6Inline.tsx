import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AiExplanation as AiExplanationData,
  OptionKey,
  Passage,
  Question,
} from "@/lib/types";
import InlineSelect, { type BlankState } from "./InlineSelect";
import AiExplanation from "./AiExplanation";
import ScoreBoard from "./ScoreBoard";
import { recordAnswer } from "@/lib/tracker";
import { OFFLINE_AI_MESSAGE } from "@/lib/online";
import { startLesson, completeLesson, failLesson, type GeneratedLesson } from "@/lib/lessons";
import { useSettings } from "@/lib/SettingsContext";
import { getAccessToken } from "@/lib/supabaseAuth";

const KIND_LABELS: Record<string, string> = {
  email: "E-mail",
  memo: "Note interne",
  article: "Article",
  notice: "Avis",
  schedule: "Programme",
  letter: "Lettre",
  message: "Message",
};

type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "blank"; question: Question; number: number; label: string };

interface ActiveExplanation {
  questionId: string;
  label: string;
  data: AiExplanationData | null;
  loading: boolean;
  error: string | null;
  latencyMs: number | null;
}

export default function Part6Inline({
  questions,
  passages,
  onNewSeries,
}: {
  questions: Question[];
  passages: Passage[];
  /** Charge une nouvelle série (banque volumineuse) au lieu de rejouer les mêmes textes. */
  onNewSeries?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, BlankState>>({});
  const [passageIndex, setPassageIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const [expl, setExpl] = useState<ActiveExplanation | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { apiKey } = useSettings();

  const groups = useMemo(
    () =>
      passages
        .map((passage) => ({
          passage,
          questions: questions
            .filter((q) => q.passageId === passage.id)
            .sort((a, b) => a.orderIndex - b.orderIndex),
        }))
        .filter((g) => g.questions.length > 0),
    [passages, questions]
  );

  const totalBlanks = questions.length;
  const currentGroup = groups[passageIndex];
  const isLast = passageIndex + 1 >= groups.length;

  const correctTotal = Object.values(answers).filter(
    (a) => a.status === "correct"
  ).length;
  const currentTotal = currentGroup?.questions.length ?? 0;
  const currentAnswered = currentGroup
    ? currentGroup.questions.filter(
        (q) => answers[q.id] && answers[q.id].status !== "idle"
      ).length
    : 0;
  const currentDone = currentTotal > 0 && currentAnswered >= currentTotal;

  const inlineContent = useMemo(() => {
    if (!currentGroup) return [];
    let pos = 0;
    return currentGroup.passage.documents.map((doc) => ({
      doc,
      paragraphs: doc.body.map((para) => {
        const parts = para.split(/(\(\d+\)_{2,})/);
        const nodes: InlineNode[] = [];
        for (const part of parts) {
          const m = part.match(/^\((\d+)\)_{2,}$/);
          if (m) {
            const question = currentGroup.questions[pos];
            if (question) {
              pos += 1;
              nodes.push({
                kind: "blank",
                question,
                number: pos,
                label: `Texte ${passageIndex + 1} · Trou ${pos}`,
              });
            } else {
              nodes.push({ kind: "text", text: part });
            }
          } else {
            nodes.push({ kind: "text", text: part });
          }
        }
        return nodes;
      }),
    }));
  }, [currentGroup, passageIndex]);

  // Requêtes d'explication en cours : annulées au démontage ou au changement de passage.
  const explainAborts = useRef<Set<AbortController>>(new Set());
  useEffect(() => {
    const aborts = explainAborts.current;
    return () => {
      aborts.forEach((c) => c.abort());
      aborts.clear();
    };
  }, []);
  useEffect(() => {
    explainAborts.current.forEach((c) => c.abort());
    explainAborts.current.clear();
  }, [passageIndex]);

  const fetchExplanation = useCallback(
    async (q: Question, key: OptionKey, label: string) => {
      const lessonId = startLesson(q, key);
      const controller = new AbortController();
      explainAborts.current.add(controller);
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        failLesson(lessonId);
        explainAborts.current.delete(controller);
        setExpl({ questionId: q.id, label, data: null, loading: false, error: OFFLINE_AI_MESSAGE, latencyMs: null });
        return;
      }
      setExpl({
        questionId: q.id,
        label,
        data: null,
        loading: true,
        error: null,
        latencyMs: null,
      });
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) headers["X-DeepSeek-Api-Key"] = apiKey;
        const token = await getAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch("/api/explain", {
          method: "POST",
          headers,
          body: JSON.stringify({ questionId: q.id, selectedKey: key }),
          signal: controller.signal,
        });
        const data = (await res.json()) as {
          explanation?: AiExplanationData;
          latencyMs?: number;
          error?: string;
          lesson?: GeneratedLesson | null;
        };
        if (controller.signal.aborted) {
          failLesson(lessonId);
          return;
        }
        if (!res.ok || data.error || !data.lesson) failLesson(lessonId);
        else completeLesson(lessonId, data.lesson);
        setExpl((prev) => {
          if (!prev || prev.questionId !== q.id) return prev;
          if (!res.ok || data.error) {
            return {
              ...prev,
              loading: false,
              error:
                data.error ??
                "Impossible d'obtenir une explication pour le moment.",
            };
          }
          return {
            ...prev,
            loading: false,
            data: data.explanation ?? null,
            latencyMs: data.latencyMs ?? null,
          };
        });
      } catch {
        failLesson(lessonId);
        if (controller.signal.aborted) return;
        setExpl((prev) => {
          if (!prev || prev.questionId !== q.id) return prev;
          return {
            ...prev,
            loading: false,
            error:
              "Connexion impossible au coach IA. Vérifiez votre connexion internet et réessayez ; les exercices restent accessibles.",
          };
        });
      } finally {
        explainAborts.current.delete(controller);
      }
    },
    [apiKey]
  );

  // Évite un double traitement (double-clic) : une seule réponse par blanc.
  const answeredIds = useRef<Set<string>>(new Set());
  // Horodatage de la dernière réponse (ou du début du passage) : temps par blanc.
  const lastEventAt = useRef(performance.now());

  const handleSelect = useCallback(
    (q: Question, key: OptionKey, label: string) => {
      if (answeredIds.current.has(q.id)) return;
      answeredIds.current.add(q.id);
      setAnswers((prev) => {
        if (prev[q.id] && prev[q.id].status !== "idle") return prev;
        return {
          ...prev,
          [q.id]: {
            selected: key,
            status: key === q.correctKey ? "correct" : "incorrect",
          },
        };
      });
      const now = performance.now();
      recordAnswer({
        question: q,
        selectedKey: key,
        correct: key === q.correctKey,
        timeMs: now - lastEventAt.current,
        mode: "practice",
      });
      lastEventAt.current = now;
      if (key !== q.correctKey) {
        fetchExplanation(q, key, label);
      }
    },
    [fetchExplanation]
  );

  useEffect(() => {
    if (expl?.loading && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [expl?.loading]);

  const handleNext = useCallback(() => {
    if (isLast) {
      setFinished(true);
    } else {
      setPassageIndex((i) => i + 1);
      setExpl(null);
      lastEventAt.current = performance.now();
    }
  }, [isLast]);

  const handleRestart = useCallback(() => {
    if (onNewSeries) {
      onNewSeries();
      return;
    }
    answeredIds.current.clear();
    lastEventAt.current = performance.now();
    setAnswers({});
    setPassageIndex(0);
    setFinished(false);
    setExpl(null);
  }, [onNewSeries]);

  const handleVote = useCallback((_value: 1 | -1) => {
    // MVP : le vote est mémorisé côté composant AiExplanation.
  }, []);

  if (finished) {
    return (
      <ScoreBoard
        part={6}
        correct={correctTotal}
        total={totalBlanks}
        onRestart={handleRestart}
        restartLabel={onNewSeries ? "Nouvelle série de textes" : undefined}
      />
    );
  }

  if (!currentGroup) {
    return (
      <div className="glass p-8 text-center text-white/70">
        Aucun texte disponible pour cette partie.
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-5 flex items-center justify-between gap-3">
        <span className="chip">
          Texte {passageIndex + 1} sur {groups.length}
        </span>
        <span className="text-sm text-white/70">
          <span className="font-semibold text-white">{correctTotal}</span>
          <span className="text-white/40"> / {totalBlanks} bonnes réponses</span>
        </span>
      </div>

      <div className="lexora-progress-track mb-3 h-1.5 w-full overflow-hidden rounded-full">
        <div
          className="lexora-progress-fill h-full rounded-full transition-all duration-500 ease-out"
          style={{ width: `${currentTotal ? (currentAnswered / currentTotal) * 100 : 0}%` }}
        />
      </div>

      <div className="flex flex-col gap-4">
        {inlineContent.map(({ doc, paragraphs }) => (
          <article key={doc.id} className="glass animate-fade-up p-5 sm:p-7">
            <div className="mb-4 flex items-start justify-between gap-3">
              <h3 className="text-sm font-semibold text-white/90">{doc.title}</h3>
              <span className="chip uppercase tracking-wide">
                {KIND_LABELS[doc.kind] ?? doc.kind}
              </span>
            </div>
            <div className="space-y-4">
              {paragraphs.map((nodes, pi) => (
                <p
                  key={pi}
                  className="text-[15px] leading-loose text-white/85 sm:text-base"
                >
                  {nodes.map((node, ni) => {
                    if (node.kind === "text") {
                      return <span key={ni}>{node.text}</span>;
                    }
                    const state = answers[node.question.id];
                    const correctOption = node.question.options.find(
                      (o) => o.key === node.question.correctKey
                    );
                    return (
                      <span key={ni}>
                        <InlineSelect
                          question={node.question}
                          number={node.number}
                          state={state}
                          onSelect={(key) =>
                            handleSelect(node.question, key, node.label)
                          }
                        />
                        {state?.status === "incorrect" && correctOption && (
                          <span className="mx-1 inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 align-middle text-xs font-medium text-emerald-200">
                            <svg
                              viewBox="0 0 24 24"
                              className="h-3 w-3 shrink-0"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                            {correctOption.key}. {correctOption.text}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </p>
              ))}
            </div>
          </article>
        ))}

        {expl && (
          <div ref={panelRef} className="animate-fade-up space-y-3">
            <div className="glass-strong p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs font-medium uppercase tracking-wider text-white/45">
                  {expl.label}
                </span>
                {expl.latencyMs !== null && (
                  <span className="text-[11px] text-white/40">
                    Réponse IA en {expl.latencyMs} ms
                  </span>
                )}
              </div>
              <a className="lexora-secondary" href="#/lessons">Voir mes leçons →</a>
              <AiExplanation
                explanation={expl.data}
                loading={expl.loading}
                error={expl.error}
                onVote={handleVote}
                question={questions.find((q) => q.id === expl.questionId)}
                selectedKey={answers[expl.questionId]?.selected ?? null}
              />
            </div>
          </div>
        )}

        {currentDone && (
          <button
            onClick={handleNext}
            className="w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90"
          >
            {isLast ? "Voir mon score" : "Texte suivant"}
          </button>
        )}
      </div>
    </div>
  );
}
