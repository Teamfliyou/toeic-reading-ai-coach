import { useState } from "react";
import type { Question } from "@/lib/types";
import { addWord } from "@/lib/vocabStore";
import { LIMITS, exampleFromPrompt } from "@/lib/vocab";

/**
 * « Ajouter à mes mots » : enregistre un mot ou une expression de l'explication
 * dans le carnet, avec un exemple pré-rempli à partir de la question.
 */
export default function AddWordForm({ question }: { question: Question }) {
  const correct = question.options.find((o) => o.key === question.correctKey)?.text ?? "";
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState(correct);
  const [meaning, setMeaning] = useState("");
  const [example, setExample] = useState(() => exampleFromPrompt(question.prompt, correct));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const result = addWord({ term, meaning, example, sourceQuestionId: question.id });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setSaved(true);
    setOpen(false);
  };

  if (saved) {
    return (
      <p className="text-sm text-emerald-300" role="status">
        Ajouté à vos mots ✓ · <a className="underline" href="#/vocab">Voir mon carnet</a>
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" className="glass-btn px-3 py-2 text-sm font-semibold" onClick={() => setOpen(true)}>
        ＋ Ajouter à mes mots
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="glass space-y-2 p-4" aria-label="Ajouter un mot à mon carnet">
      <label className="block text-sm font-medium text-white/80" htmlFor={`vw-term-${question.id}`}>Mot ou expression</label>
      <input id={`vw-term-${question.id}`} value={term} maxLength={LIMITS.term} onChange={(e) => setTerm(e.target.value)}
        className="w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm text-white" />
      <label className="block text-sm font-medium text-white/80" htmlFor={`vw-meaning-${question.id}`}>Sens en français</label>
      <input id={`vw-meaning-${question.id}`} value={meaning} maxLength={LIMITS.meaning} onChange={(e) => setMeaning(e.target.value)}
        placeholder="Ex : rentable" className="w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm text-white" />
      <label className="block text-sm font-medium text-white/80" htmlFor={`vw-example-${question.id}`}>Exemple (facultatif)</label>
      <input id={`vw-example-${question.id}`} value={example} maxLength={LIMITS.example} onChange={(e) => setExample(e.target.value)}
        className="w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm text-white" />
      {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="glass-btn px-4 py-2 text-sm font-semibold">Enregistrer</button>
        <button type="button" className="glass-btn px-4 py-2 text-sm" onClick={() => setOpen(false)}>Annuler</button>
      </div>
    </form>
  );
}
