import { useCallback, useEffect, useRef, useState } from "react";
import { adminRequest } from "@/lib/bank/api";
import type { Filters, JobPlan, JobReport, JobRow } from "@/lib/bank/types";
import categories from "../../../data/categories.json";
import "./bank.css";

const KINDS: Record<number, [string, string][]> = {
  5: [["grammar", "Grammaire"], ["vocabulary", "Vocabulaire"]],
  6: [["email", "E-mail"], ["memo", "Note interne"], ["article", "Article"], ["notice", "Annonce"], ["letter", "Lettre"]],
  7: [["email", "E-mail"], ["memo", "Note interne"], ["article", "Article"], ["notice", "Annonce"], ["schedule", "Planning"], ["letter", "Lettre"], ["message", "Message"], ["multi", "Documents multiples"]],
};
const PRESETS = [20, 100, 500, 1000, 2000];
const STATUS_LABELS: Record<JobRow["status"], string> = {
  queued: "En file", running: "En cours", paused: "En pause", completed: "Terminé", cancelled: "Annulé", failed: "Échec",
};
const usd = (v: number | string) => `${Number(v).toFixed(4)} $`;

interface TickResponse {
  result: { status: string; message?: string };
  report: JobReport;
}

/** Génération massive : file persistante de lots de 20 questions maximum, suivi et reprise. */
export default function GenerationJobs({ isAdmin, onOpenLibrary }: { isAdmin: boolean; onOpenLibrary: (f: Filters) => void }) {
  const [part, setPart] = useState<5 | 6 | 7>(5);
  const [kind, setKind] = useState("grammar");
  const [difficulty, setDifficulty] = useState<"1" | "2" | "3" | "mixed">("mixed");
  const [total, setTotal] = useState(100);
  const [custom, setCustom] = useState(false);
  const [batchSize, setBatchSize] = useState(10);
  const [theme, setTheme] = useState("");
  const [category, setCategory] = useState("");
  const [verify, setVerify] = useState(true);
  const [plan, setPlan] = useState<{ plan: JobPlan; limits: { maxTotal: number; editorMax: number } } | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<JobReport | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);

  const body = useCallback(() => ({
    part, kind, difficulty: difficulty === "mixed" ? "mixed" : Number(difficulty), total, batchSize,
    ...(theme.trim() ? { theme: theme.trim() } : {}), ...(category ? { category } : {}), verify,
  }), [part, kind, difficulty, total, batchSize, theme, category, verify]);

  // Estimation du coût et du nombre de lots à chaque changement du formulaire.
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      adminRequest<{ plan: JobPlan; limits: { maxTotal: number; editorMax: number } }>("bank-gen-plan", body())
        .then((p) => { if (active) { setPlan(p); setError((e) => (e.startsWith("Requête invalide") || e.includes("limitée") ? "" : e)); } })
        .catch((e) => { if (active) { setPlan(null); setError(e instanceof Error ? e.message : String(e)); } });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [body]);

  const loadJobs = useCallback(async () => {
    try {
      setJobs((await adminRequest<{ jobs: JobRow[] }>("bank-gen-list")).jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const loadReport = useCallback(async (id: string) => {
    try {
      setReport(await adminRequest<JobReport>("bank-gen-get", { jobId: id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { if (selected) void loadReport(selected); else setReport(null); }, [selected, loadReport]);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const res = await adminRequest<{ job: JobRow }>("bank-gen-create", body());
      await loadJobs();
      setSelected(res.job.id);
      setMessage("Génération créée. Cliquez sur « Lancer » pour traiter les lots depuis cette page.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Boucle de traitement pilotée par le navigateur : une requête courte par lot.
  async function run(jobId: string) {
    stop.current = false;
    setRunning(true);
    setError("");
    try {
      for (let guard = 0; guard < 2000 && !stop.current; guard += 1) {
        const res = await adminRequest<TickResponse>("bank-gen-tick", { jobId });
        setReport(res.report);
        const status = res.result.status;
        if (status === "done") { setMessage(`Lot traité (${res.report.job.batches_done}/${res.report.job.batches_total}).`); continue; }
        if (status === "busy") { await new Promise((r) => setTimeout(r, 4000)); continue; }
        if (status === "failed") { setMessage(res.result.message ?? "Un lot a échoué ; nouvel essai automatique."); if (res.report.job.status === "failed") break; await new Promise((r) => setTimeout(r, 2000)); continue; }
        if (status === "idle") { setMessage("Plus aucun lot à traiter."); break; }
        setMessage(res.result.message ?? `Arrêt : ${status}.`);
        break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      void loadJobs();
    }
  }

  async function control(action: "bank-gen-cancel" | "bank-gen-pause" | "bank-gen-resume", jobId: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    stop.current = true;
    setBusy(true);
    setError("");
    try {
      await adminRequest(action, { jobId });
      await Promise.all([loadJobs(), loadReport(jobId)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const job = report?.job;
  const pct = job && job.batches_total ? Math.round(((job.batches_done + job.batches_failed) / job.batches_total) * 100) : 0;
  const maxTotal = plan?.limits.maxTotal ?? 5000;
  const editorLimited = !isAdmin && plan && total > plan.limits.editorMax;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section className="lexora-card" aria-label="Nouvelle génération">
        <h2>Génération massive</h2>
        <p className="lexora-muted">Les questions sont produites par lots de 20 maximum, en file d'attente persistante : vous pouvez fermer la page, reprendre, mettre en pause ou annuler. Rien n'est publié automatiquement : les questions sans alerte passent <strong>en validation</strong>, les suspectes restent en <strong>brouillon à vérifier</strong>.</p>
        <div className="lexora-admin-grid">
          <label>Partie
            <select className="lexora-admin-input" value={part} onChange={(e) => { const p = Number(e.target.value) as 5 | 6 | 7; setPart(p); setKind(KINDS[p][0][0]); setCategory(""); }}>
              <option value={5}>Partie 5 · Phrases à trous</option><option value={6}>Partie 6 · Textes à trous</option><option value={7}>Partie 7 · Compréhension</option>
            </select>
          </label>
          <label>Type de contenu
            <select className="lexora-admin-input" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS[part].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label>Difficulté
            <select className="lexora-admin-input" value={difficulty} onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}>
              <option value="mixed">Mélangée (1, 2, 3)</option><option value="1">Facile</option><option value="2">Intermédiaire</option><option value="3">Avancée</option>
            </select>
          </label>
          <label>Catégorie (optionnel)
            <select className="lexora-admin-input" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Variée (rotation automatique)</option>
              {categories.filter((c) => c.parts.includes(part)).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          <span className="bank-field" id="gen-qty">Nombre de questions{part === 6 ? " (multiple de 4)" : part === 7 ? " (multiple de 3)" : ""}</span>
          <div className="bank-presets" role="group" aria-labelledby="gen-qty">
            {PRESETS.map((n) => (
              <button key={n} type="button" className="lexora-secondary" aria-pressed={!custom && total === n} onClick={() => { setCustom(false); setTotal(n); }}>{n.toLocaleString("fr-FR")}</button>
            ))}
            <button type="button" className="lexora-secondary" aria-pressed={custom} onClick={() => setCustom(true)}>Autre quantité</button>
            {custom && <input className="lexora-admin-input" style={{ width: 120, marginTop: 0 }} type="number" min={1} max={maxTotal} aria-label="Quantité personnalisée" value={total} onChange={(e) => setTotal(Math.max(1, Number(e.target.value) || 1))} />}
          </div>
        </div>

        <div className="lexora-admin-grid" style={{ marginTop: 6 }}>
          <label>Questions par lot (20 maximum)
            <input className="lexora-admin-input" type="number" min={1} max={20} value={batchSize} onChange={(e) => setBatchSize(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
          </label>
          <label>Thème / consigne (optionnel)
            <input className="lexora-admin-input" maxLength={120} value={theme} placeholder="Vide : thèmes professionnels variés" onChange={(e) => setTheme(e.target.value)} />
          </label>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0", fontSize: 13 }}>
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> Relecture automatique par une seconde passe IA (détecte les réponses discutables ; coût en plus)
        </label>

        {plan && (
          <div className="bank-stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", marginBottom: 8 }}>
            <div className="bank-stat"><strong>{plan.plan.total.toLocaleString("fr-FR")}</strong><span>questions demandées</span></div>
            <div className="bank-stat"><strong>{plan.plan.batches}</strong><span>lots de {plan.plan.batchSize} maximum</span></div>
            <div className="bank-stat"><strong>≈ {plan.plan.estimatedUsd.toFixed(2)} $</strong><span>coût estimé (plafond de réservation)</span></div>
          </div>
        )}
        <p className="bank-muted-small">Le coût réel est généralement inférieur à l'estimation ; il est imputé au budget mensuel d'IA partagé avec les explications, et la génération se met en pause si ce budget est atteint.{editorLimited && <strong> Votre rôle est limité à {plan?.limits.editorMax} questions par génération.</strong>}</p>
        <div className="lexora-actions">
          <span />
          <button type="button" className="lexora-primary" disabled={busy || !plan || Boolean(editorLimited)} onClick={create}>Créer la génération →</button>
        </div>
        <div aria-live="polite">
          {error && <p className="lexora-notice" role="alert">{error}</p>}
          {message && !error && <p className="lexora-subtle" role="status">{message}</p>}
        </div>
      </section>

      <section className="lexora-card" aria-label="Générations">
        <h2>Générations ({jobs.length})</h2>
        {jobs.length === 0 ? <p className="lexora-muted">Aucune génération pour le moment.</p> : (
          <div style={{ display: "grid", gap: 8 }}>
            {jobs.map((j) => (
              <button key={j.id} type="button" className="lexora-secondary" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap", textAlign: "left", borderColor: selected === j.id ? "#27456c" : undefined }} aria-pressed={selected === j.id} onClick={() => setSelected(j.id)}>
                <span>Partie {j.part} · {j.kind} · {j.total_requested.toLocaleString("fr-FR")} questions <span className="bank-muted-small">({new Date(j.created_at).toLocaleString("fr-FR")}, {j.created_by})</span></span>
                <span className="bank-badge" data-tone={j.status === "completed" ? "published" : j.status === "failed" || j.status === "cancelled" ? "archived" : "review"}>{STATUS_LABELS[j.status]} · {j.batches_done}/{j.batches_total}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {job && report && (
        <section className="lexora-card" aria-label="Détail de la génération">
          <div className="lexora-actions" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
            <div>
              <h2 style={{ margin: 0 }}>Génération de {job.total_requested.toLocaleString("fr-FR")} questions — {STATUS_LABELS[job.status]}</h2>
              <p className="bank-muted-small" style={{ margin: "4px 0 0" }}>Identifiant {job.id} · Partie {job.part} · {job.kind} · {job.options.mixed ? "difficulté mélangée" : `difficulté ${job.difficulty}`}{job.theme ? ` · thème « ${job.theme} »` : ""}</p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["queued", "running"].includes(job.status) && !running && <button type="button" className="lexora-primary" onClick={() => void run(job.id)}>▶ Lancer / continuer</button>}
              {running && <button type="button" className="lexora-secondary" onClick={() => { stop.current = true; }}>Arrêter la boucle (le job reste en file)</button>}
              {["queued", "running"].includes(job.status) && <button type="button" className="lexora-secondary" disabled={busy} onClick={() => control("bank-gen-pause", job.id)}>Pause</button>}
              {(job.status === "paused" || job.status === "failed" || report.batches.some((b) => b.status === "failed")) && !["cancelled"].includes(job.status) && <button type="button" className="lexora-secondary" disabled={busy} onClick={() => control("bank-gen-resume", job.id)}>Reprendre{report.batches.some((b) => b.status === "failed") ? " les lots en échec" : ""}</button>}
              {["queued", "running", "paused"].includes(job.status) && <button type="button" className="lexora-secondary" disabled={busy} onClick={() => control("bank-gen-cancel", job.id, "Annuler cette génération ? Les lots non traités seront abandonnés ; les questions déjà générées sont conservées.")}>Annuler</button>}
            </div>
          </div>

          <div className="bank-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Avancement des lots"><div style={{ width: `${pct}%` }} /></div>
          <div className="bank-count-row">
            <div><strong>{job.generated_count.toLocaleString("fr-FR")}</strong><span>générées</span></div>
            <div><strong>{job.validated_count.toLocaleString("fr-FR")}</strong><span>en validation (sans alerte)</span></div>
            <div><strong>{job.flagged_count.toLocaleString("fr-FR")}</strong><span>brouillons à vérifier</span></div>
            <div><strong>{job.rejected_count.toLocaleString("fr-FR")}</strong><span>rejetées par les contrôles</span></div>
            <div><strong>{job.duplicate_count.toLocaleString("fr-FR")}</strong><span>doublons écartés</span></div>
          </div>
          <p className="lexora-muted" style={{ margin: "4px 0" }}>Coût réel : <strong>{usd(job.actual_usd)}</strong> · estimé : {usd(job.estimated_usd)} · lots : {job.batches_done} terminés, {job.batches_failed} en échec sur {job.batches_total}.</p>

          <div className="bank-batches" aria-label="État des lots">
            {report.batches.map((b) => <i key={b.idx} data-s={b.status} title={`Lot ${b.idx + 1} : ${b.status}${b.error ? ` — ${b.error}` : ""}`} />)}
          </div>
          <p className="bank-muted-small">Vert : terminé · orange : en cours · rouge : échec · gris : en attente ou annulé.</p>

          {job.errors.length > 0 && (
            <details className="bank-detail" open={job.status === "failed"}>
              <summary>Historique des erreurs ({job.errors.length})</summary>
              <ul style={{ paddingLeft: 18 }}>{[...job.errors].reverse().map((e, i) => <li key={i} className="bank-muted-small">{new Date(e.at).toLocaleString("fr-FR")} · lot {e.batch + 1} (essai {e.attempt}{e.final ? ", définitif" : ""}) — {e.message}</li>)}</ul>
            </details>
          )}
          {Object.keys(report.issue_counts).length > 0 && (
            <details className="bank-detail">
              <summary>Contrôles qualité ({Object.values(report.issue_counts).reduce((a, b) => a + b, 0)})</summary>
              <ul style={{ paddingLeft: 18 }}>{Object.entries(report.issue_counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => <li key={k} className="bank-muted-small">{k.replace(":", " · ")} : {n}</li>)}</ul>
            </details>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button type="button" className="lexora-primary" onClick={() => onOpenLibrary({ job_id: job.id })}>Relire les questions générées</button>
            <button type="button" className="lexora-secondary" onClick={() => onOpenLibrary({ job_id: job.id, needs_review: true })}>Seulement celles à vérifier</button>
            <button type="button" className="lexora-secondary" onClick={() => onOpenLibrary({ job_id: job.id, status: "review" })}>Seulement « en validation »</button>
          </div>
        </section>
      )}
    </div>
  );
}
