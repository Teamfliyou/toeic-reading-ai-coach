import categories from "../../../data/categories.json";

export interface BatchQuestion {
  part: number;
  prompt: string;
  options: { key: string; text: string }[];
  correctKey: string;
  explanation: string;
  category?: string | null;
}

export interface BatchDocument {
  title: string;
  kind: string;
  body: string[];
}

export interface BatchBase {
  questions: BatchQuestion[];
  passage: null | { title: string; documents: BatchDocument[] };
}

const CATEGORIES = categories as { id: string; label: string; parts: number[] }[];

/**
 * Relecture et modification d'un lot généré avant publication : chaque question et
 * chaque document est modifiable ; une question peut être retirée ; la publication
 * reste une action volontaire, après confirmation que tout a été relu.
 */
export default function ReviewBatch<T extends BatchBase>({
  part,
  result,
  onChange,
  disabled,
  reviewed,
  onReviewedChange,
}: {
  part: number;
  result: T;
  onChange: (next: T) => void;
  disabled: boolean;
  reviewed: boolean;
  onReviewedChange: (value: boolean) => void;
}) {
  const allowed = CATEGORIES.filter((c) => c.parts.includes(part));

  // Toute modification invalide la confirmation de relecture.
  const update = (next: T) => {
    onChange(next);
    onReviewedChange(false);
  };
  const patchQuestion = (index: number, patch: Partial<BatchQuestion>) =>
    update({ ...result, questions: result.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)) });
  const patchOption = (index: number, optionIndex: number, text: string) =>
    patchQuestion(index, {
      options: result.questions[index].options.map((o, i) => (i === optionIndex ? { ...o, text } : o)),
    });
  const patchDocument = (docIndex: number, patch: Partial<BatchDocument>) =>
    result.passage &&
    update({
      ...result,
      passage: {
        ...result.passage,
        documents: result.passage.documents.map((d, i) => (i === docIndex ? { ...d, ...patch } : d)),
      },
    });

  return (
    <div>
      {result.passage && (
        <fieldset disabled={disabled} className="lexora-admin-document" style={{ display: "grid", gap: 10 }}>
          <legend><strong>Document</strong></legend>
          <label>Titre du passage
            <input className="lexora-admin-input" value={result.passage.title}
              onChange={(e) => update({ ...result, passage: { ...result.passage!, title: e.target.value } })} />
          </label>
          {result.passage.documents.map((doc, i) => (
            <div key={i} style={{ display: "grid", gap: 6 }}>
              <label>Document {i + 1} · titre
                <input className="lexora-admin-input" value={doc.title} onChange={(e) => patchDocument(i, { title: e.target.value })} />
              </label>
              <label>Texte (un paragraphe par ligne vide)
                <textarea className="lexora-admin-input" rows={8} value={doc.body.join("\n\n")}
                  onChange={(e) => patchDocument(i, { body: e.target.value.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) })} />
              </label>
            </div>
          ))}
        </fieldset>
      )}

      {result.questions.map((q, i) => (
        <fieldset key={i} disabled={disabled} className="lexora-admin-question" style={{ display: "grid", gap: 8, border: 0, borderTop: "1px solid #e6ebf0", margin: 0, minWidth: 0 }}>
          <legend><strong>Question {i + 1}</strong></legend>
          <label>Énoncé
            <textarea className="lexora-admin-input" rows={2} value={q.prompt} onChange={(e) => patchQuestion(i, { prompt: e.target.value })} />
          </label>
          {q.options.map((o, j) => (
            <label key={o.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="radio" name={`correct-${i}`} checked={q.correctKey === o.key} onChange={() => patchQuestion(i, { correctKey: o.key })}
                aria-label={`${o.key} est la bonne réponse`} />
              <span style={{ width: 18, fontWeight: 700 }}>{o.key}</span>
              <input className="lexora-admin-input" style={{ marginTop: 0 }} value={o.text} onChange={(e) => patchOption(i, j, e.target.value)} />
            </label>
          ))}
          <label>Type de piège
            <select className="lexora-admin-input" value={q.category ?? ""} onChange={(e) => patchQuestion(i, { category: e.target.value || null })}>
              <option value="">Non classée</option>
              {allowed.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label>Explication (français)
            <textarea className="lexora-admin-input" rows={2} value={q.explanation} onChange={(e) => patchQuestion(i, { explanation: e.target.value })} />
          </label>
          <button type="button" className="lexora-secondary" style={{ justifySelf: "start" }}
            onClick={() => update({ ...result, questions: result.questions.filter((_, k) => k !== i) })}>
            Retirer cette question
          </button>
        </fieldset>
      ))}

      <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18 }}>
        <input type="checkbox" checked={reviewed} disabled={disabled || result.questions.length === 0} onChange={(e) => onReviewedChange(e.target.checked)} />
        J'ai relu et validé toutes les questions (réponses, langue, explications).
      </label>
    </div>
  );
}
