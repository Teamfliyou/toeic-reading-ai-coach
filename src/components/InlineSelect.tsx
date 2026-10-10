import { useEffect, useRef, useState } from "react";
import type { OptionKey, Question } from "@/lib/types";

export type BlankState = {
  selected: OptionKey | null;
  status: "idle" | "correct" | "incorrect";
};

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 opacity-60"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 text-emerald-300"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 text-red-300"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export default function InlineSelect({
  question,
  number,
  state,
  onSelect,
}: {
  question: Question;
  number: number;
  state: BlankState | undefined;
  onSelect: (key: OptionKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const answered = !!state && state.status !== "idle";
  const selectedOption = state?.selected
    ? question.options.find((o) => o.key === state.selected)
    : null;

  let triggerClass =
    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition-all duration-150 align-middle ";
  if (state?.status === "correct") {
    triggerClass +=
      "border-emerald-400/60 bg-emerald-900/90 text-emerald-100 ";
  } else if (state?.status === "incorrect") {
    triggerClass +=
      "border-red-400/60 bg-red-900/90 text-red-100 ";
  } else {
    triggerClass +=
      "border-white/20 bg-slate-900/95 text-white hover:border-white/40 hover:bg-slate-800/95 ";
  }

  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button
        type="button"
        onClick={() => {
          if (!answered) setOpen((o) => !o);
        }}
        disabled={answered}
        className={`${triggerClass} ${answered ? "cursor-default" : "cursor-pointer"}`}
      >
        {answered && selectedOption ? (
          <span className="font-semibold">
            {selectedOption.key}. {selectedOption.text}
          </span>
        ) : (
          <span className="text-white/70">n°{number}</span>
        )}
        {state?.status === "correct" && <CheckIcon />}
        {state?.status === "incorrect" && <CrossIcon />}
        {!answered && <ChevronDown />}
      </button>

      {open && !answered && (
        <div className="absolute left-0 top-full z-30 mt-2 w-72 max-w-[80vw] overflow-hidden rounded-xl border border-white/20 bg-slate-900 p-1.5 shadow-2xl shadow-black/60">
          {question.options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                onSelect(opt.key);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-white transition-colors hover:bg-white/15"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/15 text-xs font-bold text-white">
                {opt.key}
              </span>
              <span>{opt.text}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
