
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiExplanation as AiExplanationData,
  OptionKey,
  Part,
  Passage,
  Question,
} from "@/lib/types";
import ProgressBar from "./ProgressBar";
import PassageView from "./PassageView";
import AiExplanation from "./AiExplanation";
import ScoreBoard from "./ScoreBoard";

type Status = "idle" | "correct" | "incorrect";

export default function PracticeClient({
  part,
  questions,
  passages,
}: {
  part: Part;
  questions: Question[];
  passages: Passage[];
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

  const question = questions[index];
  const passage = question?.passageId
    ? passages.find((p) => p.id === question.passageId) ?? null
    : null;
  const total = questions.length;

  const resetForNext = useCallback(() => {
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
    };
  }, []);

  const fetchExplanation = useCallback(
    async (questionId: string, key: OptionKey) => {
      setAiLoading(true);
      setAiError(null);
      const started = performance.now();
      try {
        const res = await fetch("/api/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, selectedKey: key }),
        });
        const data = (await res.json()) as {
          explanation?: AiExplanationData;
          latencyMs?: number;
          error?: string;
        };
        if (!res.ok || data.error) {
          setAiError(
            data.error ??
              "Impossible d'obtenir une explication pour le moment."
          );
        } else if (data.explanation) {
          setExplanation(data.explanation);
          setLatencyMs(data.latencyMs ?? null);
        }
      } catch {
        setAiError(
          "Connexion impossible au coach IA. Vérifiez votre connexion et la clé DEEPSEEK_API_KEY."
        );
      } finally {
        const elapsed = Math.round(performance.now() - started);
        setLatencyMs((prev) => prev ?? elapsed);
        setAiLoading(false);
      }
    },
    []
  );

  const handleValidate = useCallback(() => {
    if (!selectedKey || status !== "idle" || !question) return;

    const isCorrect = selectedKey === question.correctKey;
    setStatus(isCorrect ? "correct" : "incorrect");
    if (isCorrect) {
      setCorrectCount((c) => c + 1);
      advanceTimer.current = setTimeout(goNext, 1200);
    } else {
      fetchExplanation(question.id, selectedKey);
    }
  }, [selectedKey, status, question, goNext, fetchExplanation]);

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

            <div className="mt-5 space-y-2.5">
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
                    onClick={() => setSelectedKey(opt.key)}
                    className={`${style} flex items-center gap-3 transition-all duration-150 ${
                      status === "idle" ? "hover:bg-white/[0.12]" : "cursor-default"
                    }`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10 text-xs font-bold text-white/80">
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
              <div className="mt-5">
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
            <div className="space-y-4">
              <AiExplanation
                explanation={explanation}
                loading={aiLoading}
                error={aiError}
                onVote={handleVote}
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
