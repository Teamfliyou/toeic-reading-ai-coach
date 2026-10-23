
import { useState } from "react";
import type { AiExplanation, Question } from "@/lib/types";
import FollowUp from "./FollowUp";
import AddWordForm from "./AddWordForm";

function PointCard({
  index,
  title,
  body,
  tone,
}: {
  index: string;
  title: string;
  body: string;
  tone: string;
}) {
  return (
    <div className="glass p-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold ${tone}`}
        >
          {index}
        </span>
        <span className="text-sm font-semibold text-white/90">{title}</span>
      </div>
      <p className="text-sm leading-relaxed text-white/75">{body}</p>
    </div>
  );
}

export default function AiExplanation({
  explanation,
  loading,
  error,
  onVote,
  question,
  selectedKey,
}: {
  explanation: AiExplanation | null;
  loading: boolean;
  error: string | null;
  onVote: (value: 1 | -1) => void;
  /** Question et réponse choisie : activent la question de relance. */
  question?: Question;
  selectedKey?: string | null;
}) {
  const [vote, setVote] = useState<1 | -1 | null>(null);

  const handleVote = (value: 1 | -1) => {
    setVote(value);
    onVote(value);
  };

  return (
    <div className="animate-fade-up">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-cyan-500 text-xs">
          IA
        </span>
        <h3 className="text-sm font-semibold text-white/90">
          Explication du coach
        </h3>
      </div>

      {loading && (
        <div className="glass space-y-3 p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <div
                className="h-3 w-1/3 rounded-full bg-white/10"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg, rgba(255,255,255,0.06), rgba(255,255,255,0.16), rgba(255,255,255,0.06))",
                  backgroundSize: "200% 100%",
                  animation: "shimmer 1.4s linear infinite",
                }}
              />
              <div className="h-3 w-full rounded-full bg-white/[0.06]" />
              <div className="h-3 w-2/3 rounded-full bg-white/[0.06]" />
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="glass border-red-400/30 p-4 text-sm text-red-200">
          {error}
        </div>
      )}

      {!loading && !error && explanation && (
        <div className="space-y-3">
          <PointCard
            index="1"
            title="Diagnostic"
            body={explanation.diagnostic}
            tone="bg-red-500/20 text-red-300"
          />
          <PointCard
            index="2"
            title="Résolution"
            body={explanation.resolution}
            tone="bg-emerald-500/20 text-emerald-300"
          />
          <PointCard
            index="3"
            title="Tip TOEIC"
            body={explanation.tip}
            tone="bg-cyan-500/20 text-cyan-300"
          />

          {question && <AddWordForm key={`word-${question.id}`} question={question} />}

          {question && selectedKey && (
            <FollowUp key={`${question.id}:${selectedKey}`} question={question} selectedKey={selectedKey} />
          )}

          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-white/50">
              Cette explication vous a-t-elle été utile ?
            </span>
            <button
              onClick={() => handleVote(1)}
              aria-label="Utile"
              className={`glass-btn px-2.5 py-1 text-sm ${
                vote === 1 ? "border-emerald-400/50 bg-emerald-500/20" : ""
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 10v12" />
                <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z" />
              </svg>
            </button>
            <button
              onClick={() => handleVote(-1)}
              aria-label="Pas utile"
              className={`glass-btn px-2.5 py-1 text-sm ${
                vote === -1 ? "border-red-400/50 bg-red-500/20" : ""
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 rotate-180"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 10v12" />
                <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
