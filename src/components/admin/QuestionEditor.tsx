import { useCallback, useEffect, useState } from "react";
import { adminRequest } from "@/lib/bank/api";
import type { OptionRow, PassageDoc, QuestionDetail, QuestionRow, QStatus } from "@/lib/bank/types";
import { DIFFICULTY_LABELS, SOURCE_LABELS, STATUS_LABELS } from "@/lib/bank/types";
import categories from "../../../data/categories.json";

const KEYS: OptionRow["key"][] = ["A", "B", "C", "D"];
const KINDS = ["email", "memo", "article", "notice", "schedule", "letter", "message"];

/** Surligne les trous « (1)______ » d'un texte. */
export function WithBlanks({ text }: { text: string }) {
  const parts = text.split(/(\(\d{1,2}\)\s*_{2,}|_{3,})/g);
  return <>{parts.map((p, i) => (/^(\(\d{1,2}\)\s*)?_{2,}$/.test(p) ? <span className="bank-blank" key={i}>{p}</span> : <span key={i}>{p}</span>))}</>;
}

export function PassageView({ title, documents }: { title: string; documents: PassageDoc[] }) {
  return (
    <div className="bank-passage" role="region" aria-label={`Document : ${title}`}>
      <h4>{title}</h4>
      {documents.map((d, i) => (
        <div key={i} style={{ marginTop: i ? 12 : 0 }}>
          <strong>{d.title || d.kind}</strong> <span className="bank-badge">{d.kind}</span>
          {(Array.isArray(d.body) ? d.body : [String(d.body)]).map((paragraph, j) => <p key={j}><WithBlanks text={paragraph} /></p>)}
        </div>
      ))}
    </div>
  );
}

interface Props {
  id: string;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
}

/** Édition complète d'une question (et de son document pour les parties 6 et 7). */
export default function QuestionEditor({ id, onClose, onChanged, onOpen }: Props) {
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [draft, setDraft] = useState<QuestionRow | null>(null);
  const [passageDraft, setPassageDraft] = useState<{ title: string; documents: PassageDoc[] } | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setMessage(null);
    try {
      const d = await adminRequest<QuestionDetail>("bank-get", { id });
      setDetail(d);
      setDraft(d.question);
      setPassageDraft(d.passage ? { title: d.passage.title, documents: d.passage.documents.map((x) => ({ ...x, body: [...x.body] })) } : null);
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }, [id]);
  useEffect(() => { setDetail(null); void load(); }, [load]);

  if (!detail || !draft) {
    return <section className="bank-editor" aria-busy="true">{message ? <p role="alert" className="lexora-notice">{message.text}</p> : "Chargement de la question…"}</section>;
  }

  const set = <K extends keyof QuestionRow>(key: K, value: QuestionRow[K]) => setDraft({ ...draft, [key]: value });
  const setOption = (key: OptionRow["key"], text: string) => set("options", draft.options.map((o) => (o.key === key ? { ...o, text } : o)));
  const setRationale = (key: string, text: string) => set("option_rationales", { ...(draft.option_rationales ?? {}), [key]: text });
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail.question);
  const partCategories = categories.filter((c) => c.parts.includes(draft.part));

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await adminRequest<{ question: QuestionRow; warnings: { message: string }[] }>("bank-update", {
        id: draft.id,
        expectedVersion: draft.version,
        patch: {
          prompt: draft.prompt, options: draft.options, correct_key: draft.correct_key, difficulty: draft.difficulty,
          category: draft.category || null, theme: draft.theme || null, explanation: draft.explanation || null,
          option_rationales: draft.option_rationales && Object.keys(draft.option_rationales).length ? draft.option_rationales : null,
          tags: draft.tags,
        },
      });
      const warnings = res.warnings.map((w) => w.message);
      setMessage({ tone: "ok", text: `Enregistré (version ${res.question.version}).${warnings.length ? ` À vérifier : ${warnings.join(" ")}` : ""}` });
      await load();
      onChanged();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function savePassage() {
    if (!detail?.passage || !passageDraft) return;
    setBusy(true);
    try {
      await adminRequest("bank-update-passage", { id: detail.passage.id, title: passageDraft.title, documents: passageDraft.documents });
      setMessage({ tone: "ok", text: "Document enregistré." });
      await load();
      onChanged();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: QStatus) {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      let res = await adminRequest<{ changed: number; skipped: { reason: string }[] }>("bank-status", { ids: [draft.id], status });
      if (res.skipped.some((s) => s.reason === "needs_review")) {
        const ok = window.confirm("Cette question comporte des alertes de qualité. Confirmez-vous l'avoir relue et vouloir la publier ?");
        if (ok) res = await adminRequest("bank-status", { ids: [draft.id], status, ack: true });
      }
      setMessage(res.changed ? { tone: "ok", text: `Statut : ${STATUS_LABELS[status]}.` } : { tone: "error", text: `Changement refusé (${res.skipped.map((s) => s.reason).join(", ") || "inchangé"}).` });
      await load();
      onChanged();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const q = detail.question;
  const transitions: { to: QStatus; label: string }[] = ({
    draft: [{ to: "review", label: "Passer en validation" }, { to: "published", label: "Publier" }, { to: "archived", label: "Archiver" }],
    review: [{ to: "published", label: "Publier" }, { to: "draft", label: "Remettre en brouillon" }, { to: "archived", label: "Archiver" }],
    published: [{ to: "archived", label: "Archiver (retirer des exercices)" }],
    archived: [{ to: "draft", label: "Restaurer en brouillon" }, { to: "published", label: "Republier" }],
  } as Record<QStatus, { to: QStatus; label: string }[]>)[q.status];

  return (
    <section className="bank-editor" aria-label="Édition de la question">
      <div className="lexora-actions" style={{ alignItems: "flex-start" }}>
        <div>
          <h3>Partie {q.part} · {q.slug}</h3>
          <p className="bank-muted-small" style={{ margin: 0 }}>
            <span className="bank-badge" data-tone={q.status}>{STATUS_LABELS[q.status]}</span>{" "}
            {SOURCE_LABELS[q.source]} · version {q.version}{q.origin_version ? ` (${q.origin_version})` : ""} · créée le {new Date(q.created_at).toLocaleDateString("fr-FR")}{q.created_by ? ` par ${q.created_by}` : ""}
          </p>
        </div>
        <button type="button" className="lexora-secondary" onClick={onClose}>Fermer</button>
      </div>

      {q.needs_review && (
        <div className="lexora-notice" role="note">
          <strong>À vérifier avant publication :</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{q.review_flags.map((f, i) => <li key={i}>{f.message}</li>)}</ul>
        </div>
      )}
      {detail.reports.length > 0 && (
        <div className="lexora-notice" role="note">
          <strong>Signalements d'élèves ({detail.reports.filter((r) => r.status === "open").length} ouverts) :</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{detail.reports.map((r) => <li key={r.id}>{r.reason}{r.comment ? ` — ${r.comment}` : ""} ({r.status})</li>)}</ul>
        </div>
      )}

      {detail.passage && passageDraft && (
        <div style={{ margin: "16px 0" }}>
          <PassageView title={detail.passage.title} documents={detail.passage.documents} />
          <details className="bank-detail" style={{ marginTop: 10 }}>
            <summary>Modifier le document</summary>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              <label className="bank-field">Titre<input className="lexora-admin-input" value={passageDraft.title} maxLength={250} onChange={(e) => setPassageDraft({ ...passageDraft, title: e.target.value })} /></label>
              {passageDraft.documents.map((d, i) => (
                <div key={i} className="bank-editor-grid">
                  <label className="bank-field">Document {i + 1} · type
                    <select className="lexora-admin-input" value={d.kind} onChange={(e) => setPassageDraft({ ...passageDraft, documents: passageDraft.documents.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)) })}>
                      {KINDS.map((k) => <option key={k}>{k}</option>)}
                    </select>
                  </label>
                  <label className="bank-field">Titre du document<input className="lexora-admin-input" value={d.title} onChange={(e) => setPassageDraft({ ...passageDraft, documents: passageDraft.documents.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} /></label>
                  <label className="bank-field" style={{ gridColumn: "1 / -1" }}>Texte (un paragraphe par ligne)
                    <textarea className="lexora-admin-input" style={{ minHeight: 140 }} value={d.body.join("\n")} onChange={(e) => setPassageDraft({ ...passageDraft, documents: passageDraft.documents.map((x, j) => (j === i ? { ...x, body: e.target.value.split("\n").filter((l) => l.trim()) } : x)) })} />
                  </label>
                </div>
              ))}
              <div><button type="button" className="lexora-secondary" disabled={busy} onClick={savePassage}>Enregistrer le document</button></div>
            </div>
          </details>
          {detail.siblings.length > 1 && (
            <p className="bank-muted-small" style={{ marginTop: 10 }}>
              Questions de ce document :{" "}
              {detail.siblings.map((s) => (
                <button key={s.id} type="button" className="lexora-linkbutton" aria-current={s.id === q.id} onClick={() => onOpen(s.id)} style={{ marginRight: 10, fontWeight: s.id === q.id ? 800 : 600 }}>
                  {s.order_index}. {STATUS_LABELS[s.status]}
                </button>
              ))}
            </p>
          )}
        </div>
      )}

      <div className="bank-field" style={{ marginTop: 14 }}>
        <label htmlFor="q-prompt">{q.part === 7 ? "Question" : "Énoncé (le trou s'écrit ______)"}</label>
        <textarea id="q-prompt" className="lexora-admin-input" value={draft.prompt} maxLength={1500} onChange={(e) => set("prompt", e.target.value)} />
        {q.part !== 7 && <span className="bank-muted-small">Aperçu : <WithBlanks text={draft.prompt} /></span>}
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: "12px 0" }}>
        <legend className="bank-field" style={{ marginBottom: 4 }}>Propositions et bonne réponse</legend>
        {KEYS.map((key) => {
          const opt = draft.options.find((o) => o.key === key) ?? { key, text: "" };
          return (
            <div className="bank-option" key={key} data-correct={draft.correct_key === key}>
              <span className="bank-option-key" aria-hidden="true">{key}</span>
              <input className="lexora-admin-input" style={{ marginTop: 0 }} aria-label={`Proposition ${key}`} value={opt.text} maxLength={400} onChange={(e) => setOption(key, e.target.value)} />
              <label className="bank-radio"><input type="radio" name="correct" checked={draft.correct_key === key} onChange={() => set("correct_key", key)} /> Bonne réponse</label>
            </div>
          );
        })}
      </fieldset>

      <div className="bank-editor-grid">
        <label className="bank-field">Difficulté
          <select className="lexora-admin-input" value={draft.difficulty} onChange={(e) => set("difficulty", Number(e.target.value) as 1 | 2 | 3)}>
            {[1, 2, 3].map((d) => <option key={d} value={d}>{d} · {DIFFICULTY_LABELS[d]}</option>)}
          </select>
        </label>
        <label className="bank-field">Catégorie
          <select className="lexora-admin-input" value={draft.category ?? ""} onChange={(e) => set("category", e.target.value || null)}>
            <option value="">(aucune)</option>
            {partCategories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className="bank-field">Thème professionnel<input className="lexora-admin-input" value={draft.theme ?? ""} maxLength={80} onChange={(e) => set("theme", e.target.value)} /></label>
        <label className="bank-field">Étiquettes (séparées par des virgules)<input className="lexora-admin-input" value={draft.tags.join(", ")} onChange={(e) => set("tags", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))} /></label>
      </div>

      <label className="bank-field" style={{ marginTop: 12 }}>Explication pédagogique (français)
        <textarea className="lexora-admin-input" value={draft.explanation ?? ""} maxLength={2000} onChange={(e) => set("explanation", e.target.value)} />
      </label>
      <details className="bank-detail" style={{ marginTop: 10 }} open={Boolean(draft.option_rationales)}>
        <summary>Justification de chaque mauvaise réponse</summary>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {KEYS.filter((k) => k !== draft.correct_key).map((k) => (
            <label key={k} className="bank-field">Pourquoi {k} est faux
              <input className="lexora-admin-input" value={draft.option_rationales?.[k] ?? ""} maxLength={600} onChange={(e) => setRationale(k, e.target.value)} />
            </label>
          ))}
        </div>
      </details>

      <div className="lexora-actions" style={{ marginTop: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="lexora-primary" disabled={busy || !dirty} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer les modifications"}</button>
          {dirty && <button type="button" className="lexora-secondary" disabled={busy} onClick={() => setDraft(detail.question)}>Annuler</button>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {transitions.map((t) => <button key={t.to} type="button" className="lexora-secondary" disabled={busy || dirty} title={dirty ? "Enregistrez d'abord vos modifications" : undefined} onClick={() => changeStatus(t.to)}>{t.label}</button>)}
        </div>
      </div>
      <div aria-live="polite">{message && <p className="lexora-notice" role={message.tone === "error" ? "alert" : "status"} style={message.tone === "ok" ? { borderColor: "#bfe3d0", background: "#ecf9f3", color: "#176443" } : undefined}>{message.text}</p>}</div>

      <details className="bank-detail" style={{ marginTop: 14 }}>
        <summary>Historique des modifications ({detail.revisions.length})</summary>
        {detail.revisions.length === 0 ? <p className="bank-muted-small">Aucune modification depuis la création.</p> : (
          <ul style={{ paddingLeft: 18 }}>
            {detail.revisions.map((r) => (
              <li key={r.id} className="bank-muted-small">v{r.version} remplacée le {new Date(r.created_at).toLocaleString("fr-FR")} par {r.changed_by} ({r.change_type === "status" ? "statut" : "contenu"}) — « {String(r.snapshot.prompt ?? "").slice(0, 90)} »</li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
