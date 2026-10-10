import type { Part } from "@/lib/types";
import { getQuestions, getPassages } from "@/lib/data";
import { getPartInfo } from "@/lib/parts";
import PracticeClient from "@/components/PracticeClient";
import Part6Inline from "@/components/Part6Inline";

export default function Practice({ part }: { part: Part }) {
  const info = getPartInfo(part);
  const questions = getQuestions(part);
  const passages = part === 5 ? [] : getPassages(part);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex items-center justify-between">
        <a
          href="#/"
          className="glass-btn inline-flex items-center gap-2 px-3 py-2 text-sm"
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
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Tableau de bord
        </a>
        <span className="text-sm font-semibold gradient-text">
          TOEIC Reading AI Coach
        </span>
      </header>

      <div className="mb-6 animate-fade-up">
        <p className="text-xs font-medium uppercase tracking-wider text-white/45">
          Partie {part} · {info.tagline}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-white/95">{info.name}</h1>
      </div>

      {part === 6 ? (
        <Part6Inline questions={questions} passages={passages} />
      ) : (
        <PracticeClient part={part} questions={questions} passages={passages} />
      )}
    </main>
  );
}
