import "@/pages/phase2.css";
import { useState } from "react";

const REASONS: [string, string][] = [
  ["wrong_answer", "La bonne réponse me semble fausse"],
  ["typo", "Faute de frappe ou texte incorrect"],
  ["ambiguous", "Plusieurs réponses possibles"],
  ["unclear_audio", "Audio inaudible ou incorrect"],
  ["other", "Autre problème"],
];

/** Signalement d'une question erronée : petit formulaire, envoyé à /api/report. */
export default function ReportButton({ questionId, part, audio = false }: { questionId: string; part: number; audio?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("wrong_answer");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reasons = REASONS.filter(([value]) => audio || value !== "unclear_audio");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, part, reason, comment }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Le signalement n'a pas pu être envoyé.");
      setMessage({ ok: true, text: "Merci ! Votre signalement a été transmis." });
      setOpen(false);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Le signalement n'a pas pu être envoyé." });
    } finally {
      setBusy(false);
    }
  };

  if (message?.ok) return <p className="lexora-subtle" role="status">{message.text}</p>;

  return (
    <div className="lexora-report">
      {!open ? (
        <button type="button" className="lexora-linkbutton" onClick={() => setOpen(true)}>⚑ Signaler une erreur dans cette question</button>
      ) : (
        <form onSubmit={submit} className="lexora-card" aria-label="Signaler une question erronée" style={{ display: "grid", gap: 10, marginTop: 8 }}>
          <label htmlFor={`rp-reason-${questionId}`}>Motif</label>
          <select id={`rp-reason-${questionId}`} value={reason} onChange={(e) => setReason(e.target.value)} className="lexora-admin-input">
            {reasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <label htmlFor={`rp-comment-${questionId}`}>Précisions {reason === "other" ? "" : "(facultatif)"}</label>
          <textarea id={`rp-comment-${questionId}`} value={comment} maxLength={500} rows={3} onChange={(e) => setComment(e.target.value)} className="lexora-admin-input" />
          {message && <p role="alert" style={{ color: "#9a3232", margin: 0 }}>{message.text}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="lexora-primary" disabled={busy}>{busy ? "Envoi…" : "Envoyer"}</button>
            <button type="button" className="lexora-secondary" onClick={() => setOpen(false)}>Annuler</button>
          </div>
        </form>
      )}
    </div>
  );
}
