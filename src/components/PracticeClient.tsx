
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiExplanation as AiExplanationData,
  OptionKey,
  Part,
  Passage,
  Question,
} from "@/lib/types";
import { useSettings } from "@/lib/SettingsContext";
import { getAccessToken } from "@/lib/supabaseAuth";
import ProgressBar from "./ProgressBar";
import { recordAnswer } from "@/lib/tracker";
import { OFFLINE_AI_MESSAGE } from "@/lib/online";
import { startLesson, completeLesson, failLesson, type GeneratedLesson } from "@/lib/lessons";
import PassageView from "./PassageView";
import AiExplanation from "./AiExplanation";
import ScoreBoard from "./ScoreBoard";
import ReportButton from "./ReportButton";

type Status = "idle" | "correct" | "incorrect";

export default function PracticeClient({
  part,
  questions,
  passages,
  reviewMode = false,
}: {
  part: Part;
  questions: Question[];
  passages: Passage[];
  reviewMode?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [selectedKey, setSelectedKey] = useState<OptionKey | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [explanation, setExplanation] = useState<AiExplanationData | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Requête d'explication en cours : annulée si l'élève change de question ou quitte la page.
  const explainAbort = useRef<AbortController | null>(null);
  // Début de la question affichée, pour mesurer le temps de réponse.
  const shownAt = useRef(performance.now());
  const { apiKey } = useSettings();

  const question = questions[index];
  const passage = question?.passageId
    ? passages.find((p) => p.id === question.passageId) ?? null
    : null;
  const total = questions.length;

  const resetForNext = useCallback(() => {
    explainAbort.current?.abort();
    shownAt.current = performance.now();
    setSelectedKey(null);
    setStatus("idle");
    setExplanation(null);
    setAiError(null);
    setLatencyMs(null);
    setAiLoading(false);
  }, []);

  const goNext = useCallback(() => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    if (index + 1 >= total) {
      setFinished(true);
    } else {
      setIndex((i) => i + 1);
      resetForNext();
    }
  }, [index, total, resetForNext]);

  useEffect(() => {
    return () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      explainAbort.current?.abort();
    };
  }, []);

  const fetchExplanation = useCallback(
    async (questionId: string, key: OptionKey) => {
      const lessonId = question ? startLesson(question, key) : null;
      explainAbort.current?.abort();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        if (lessonId) failLesson(lessonId);
        setAiLoading(false);
        setAiError(OFFLINE_AI_MESSAGE);
        return;
      }
      const controller = new AbortController();
      explainAbort.current = controller;
      setAiLoading(true);
      setAiError(null);
      const started = performance.now();
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
          body: JSON.stringify({ questionId, selectedKey: key }),
          signal: controller.signal,
        });
        const data = (await res.json()) as {
          explanation?: AiExplanationData;
          latencyMs?: number;
          error?: string;
          lesson?: GeneratedLesson | null;
        };
        if (controller.signal.aborted) {
          if (lessonId) failLesson(lessonId);
          return;
        }
        if (!res.ok || data.error) {
          if (lessonId) failLesson(lessonId);
          setAiError(
            data.error ??
              "Impossible d'obtenir une explication pour le moment."
          );
        } else if (data.explanation) {
          setExplanation(data.explanation);
          if (lessonId) {
            if (data.lesson) completeLesson(lessonId, data.lesson);
            else failLesson(lessonId);
          }
          setLatencyMs(data.latencyMs ?? null);
        }
      } catch {
        if (lessonId) failLesson(lessonId);
        if (!controller.signal.aborted) {
          setAiError(
            "Connexion impossible au coach IA. Vérifiez votre connexion internet et réessayez ; les exercices restent accessibles."
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          const elapsed = Math.round(performance.now() - started);
          setLatencyMs((prev) => prev ?? elapsed);
          setAiLoading(false);
        }
      }
    },
    [apiKey, question]
  );

  const handleValidate = useCallback(() => {
    if (!selectedKey || status !== "idle" || !question) return;

    const isCorrect = selectedKey === question.correctKey;
    setStatus(isCorrect ? "correct" : "incorrect");
    recordAnswer({
      question,
      selectedKey,
      correct: isCorrect,
      timeMs: performance.now() - shownAt.current,
      mode: reviewMode ? "review" : "practice",
    });
    if (isCorrect) {
      setCorrectCount((c) => c + 1);
      advanceTimer.current = setTimeout(goNext, 1200);
    } else {
      fetchExplanation(question.id, selectedKey);
    }
  }, [selectedKey, status, question, goNext, fetchExplanation, reviewMode]);

  const handleVote = useCallback((_value: 1 | -1) => {
    // MVP : le vote 👍/👎 est déjà mémorisé par le composant AiExplanation.
    // Pour le synchroniser avec Supabase, brancher ici un appel d'API.
  }, []);

  const handleRestart = useCallback(() => {
    setIndex(0);
    setFinished(false);
    setCorrectCount(0);
    resetForNext();
  }, [resetForNext]);

  if (finished) {
    return (
      <ScoreBoard
        part={part}
        correct={correctCount}
        total={total}
        onRestart={handleRestart}
      />
    );
  }

  if (!question) {
    return (
      <div className="glass p-8 text-center text-white/70">
        Aucune question disponible pour cette partie.
      </div>
    );
  }

  const options = question.options;
  const isPart7 = part === 7;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-5">
        <ProgressBar current={index + 1} total={total} />
      </div>

      <div
        className={
          isPart7
            ? "grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_1fr]"
            : "flex flex-col gap-5"
        }
      >
        {passage && (
          <div
            className={
              isPart7 ? "lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto scrollbar-thin lg:pr-1" : ""
            }
          >
            <PassageView passage={passage} />
          </div>
        )}

        <div className="flex flex-col gap-4">
          <div className="glass-strong animate-fade-up p-5 sm:p-6" key={question.id}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="chip">
                {part === 6 ? "Complétez le texte" : "Question"} n° {index + 1}
              </span>
              {latencyMs !== null && status === "incorrect" && (
                <span className="text-[11px] text-white/40">
                  Réponse IA en {latencyMs} ms
                </span>
              )}
            </div>

            <p className="text-lg leading-relaxed text-white/95">
              {question.prompt}
            </p>

            <div className="mt-5 space-y-2.5" role="group" aria-label="Choix de réponse">
              {options.map((opt) => {
                const isSelected = selectedKey === opt.key;
                const isCorrectOption = question.correctKey === opt.key;
                const revealed = status !== "idle";

                let style = "glass-btn w-full justify-start text-left";
                if (revealed && isCorrectOption) {
                  style =
                    "w-full justify-start text-left rounded-xl border border-emerald-400/50 bg-emerald-500/15 px-4 py-3 text-sm font-medium text-emerald-100";
                } else if (revealed && isSelected && !isCorrectOption) {
                  style =
                    "w-full justify-start text-left rounded-xl border border-red-400/50 bg-red-500/15 px-4 py-3 text-sm font-medium text-red-100";
                } else if (!revealed && isSelected) {
                  style =
                    "w-full justify-start text-left rounded-xl border border-violet-400/50 bg-violet-500/15 px-4 py-3 text-sm font-medium text-white";
                }

                return (
                  <button
                    key={opt.key}
                    disabled={status !== "idle"}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedKey(opt.key)}
                    className={`${style} flex items-center gap-3 transition-all duration-150 ${
                      status === "idle" ? "hover:bg-white/[0.12]" : "cursor-default"
                    }`}
                  >
                    <span className="lexora-answer-key flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold">
                      {opt.key}
                    </span>
                    <span className="flex-1">{opt.text}</span>
                    {revealed && isCorrectOption && (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-5 w-5 shrink-0 text-emerald-300"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                    {revealed && isSelected && !isCorrectOption && (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-5 w-5 shrink-0 text-red-300"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>

            {status === "idle" ? (
              <button
                onClick={handleValidate}
                disabled={!selectedKey}
                className="mt-5 w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Valider ma réponse
              </button>
            ) : (
              <div className="mt-5" role="status" aria-live="polite">
                <ReportButton key={question.id} questionId={question.id} part={question.part} />
                {status === "correct" && (
                  <div className="animate-fade-up flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-200">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    Bonne réponse ! Passage à la question suivante…
                  </div>
                )}
              </div>
            )}
          </div>

          {status === "incorrect" && (
            <div className="space-y-4" role="status" aria-live="polite">
              <a href="#/lessons" className="lexora-secondary">Voir mes leçons →</a>
              <AiExplanation
                explanation={explanation}
                loading={aiLoading}
                error={aiError}
                onVote={handleVote}
                question={question}
                selectedKey={selectedKey}
              />
              <button
                onClick={goNext}
                className="w-full rounded-xl bg-white/[0.08] px-4 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-white/[0.14]"
              >
                Question suivante
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
