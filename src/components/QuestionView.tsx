import type { Passage, Question } from "@/lib/types";
import PassageView from "./PassageView";

/**
 * Affichage d'une question de lecture (parties 5, 6, 7) avec son document, utilisé
 * par l'examen blanc et la révision. `reveal` colore la bonne et la mauvaise réponse.
 */
export default function QuestionView({
  question,
  passage,
  selected,
  onSelect,
  reveal = false,
  disabled = false,
  number,
}: {
  question: Question;
  passage: Passage | null;
  selected: string | null;
  onSelect: (key: string) => void;
  reveal?: boolean;
  disabled?: boolean;
  number?: number;
}) {
  const split = question.part === 7 && passage;
  return (
    <div className={split ? "lexora-split" : "lexora-stack"}>
      {passage && (
        <div className={split ? "lexora-split-passage" : undefined} tabIndex={split ? 0 : undefined} aria-label="Document à lire">
          <PassageView passage={passage} />
        </div>
      )}
      <section className="lexora-card" aria-label="Question">
        <p className="lexora-eyebrow">
          {number ? `Question ${number} · ` : ""}Partie {question.part}
        </p>
        <p className="lexora-question">{question.prompt}</p>
        <div className="lexora-options" role="group" aria-label="Choix de réponse">
          {question.options.map((option) => {
            const state = !reveal
              ? undefined
              : option.key === question.correctKey
                ? "correct"
                : option.key === selected
                  ? "wrong"
                  : undefined;
            return (
              <button
                key={option.key}
                type="button"
                className="lexora-option"
                aria-pressed={selected === option.key}
                data-state={state}
                disabled={disabled}
                onClick={() => onSelect(option.key)}
              >
                <span className="lexora-optionkey">{option.key}</span>
                {option.text}
                {state === "correct" && <span className="lexora-sr"> (bonne réponse)</span>}
                {state === "wrong" && <span className="lexora-sr"> (votre réponse, incorrecte)</span>}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
