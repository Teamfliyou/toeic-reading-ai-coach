import { useCallback, useEffect, useState } from "react";

interface Report {
  id: string;
  question_id: string;
  part: number | null;
  question_prompt: string | null;
  reason: string;
  comment: string;
  status: "open" | "resolved" | "rejected";
  handled_by: string | null;
  created_at: string;
}

const REASON_LABELS: Record<string, string> = {
  wrong_answer: "Bonne réponse contestée",
  typo: "Faute / texte incorrect",
  ambiguous: "Plusieurs réponses possibles",
  unclear_audio: "Audio inaudible",
  other: "Autre",
};
const STATUS_LABELS = { open: "À traiter", resolved: "Résolus", rejected: "Rejetés" } as const;

type Request = (action: string, body: unknown) => Promise<{ reports?: Report[] }>;

/** Liste des signalements d'élèves, avec traitement (résolu / rejeté / rouvert). */
export default function ReportsTab({ request }: { request: Request }) {
  const [status, setStatus] = useState<keyof typeof STATUS_LABELS>("open");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setReports((await request("reports", { status })).reports ?? []);
    } catch (e) {
      setReports([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [request, status]);
  useEffect(() => void load(), [load]);

  const change = async (id: string, next: Report["status"]) => {
    setError("");
    try {
      await request("report-status", { id, status: next });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="lexora-card" aria-label="Signalements de questions">
      <h2>Signalements</h2>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }} role="tablist">
        {(Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s} className={status === s ? "lexora-primary" : "lexora-secondary"} onClick={() => setStatus(s)}>
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="lexora-notice">{error}</p>}
      {reports === null ? <p className="lexora-muted">Chargement…</p> : reports.length === 0 ? (
        <p className="lexora-muted">Aucun signalement dans cette catégorie.</p>
      ) : reports.map((r) => (
        <article key={r.id} className="lexora-admin-question">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <strong>{REASON_LABELS[r.reason] ?? r.reason}</strong>
            <span className="lexora-subtle">{new Date(r.created_at).toLocaleString("fr-FR")}{r.part ? ` · Partie ${r.part}` : ""}</span>
          </div>
          {r.question_prompt && <p>« {r.question_prompt} »</p>}
          {r.comment && <p><em>{r.comment}</em></p>}
          <p className="lexora-subtle">Question : {r.question_id}{r.handled_by ? ` · traité par ${r.handled_by}` : ""}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {r.status !== "resolved" && <button type="button" className="lexora-secondary" onClick={() => change(r.id, "resolved")}>Marquer résolu</button>}
            {r.status !== "rejected" && <button type="button" className="lexora-secondary" onClick={() => change(r.id, "rejected")}>Rejeter</button>}
            {r.status !== "open" && <button type="button" className="lexora-secondary" onClick={() => change(r.id, "open")}>Rouvrir</button>}
          </div>
        </article>
      ))}
    </section>
  );
}
