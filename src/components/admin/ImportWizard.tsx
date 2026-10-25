import { useCallback, useEffect, useRef, useState } from "react";
import { adminRequest } from "@/lib/bank/api";
import { analyzeFile, runImport, type Analysis, type BatchInfo, type ImportProgress, type Mapping } from "@/lib/bank/importClient";
import { fingerprintOf, MAX_FILE_BYTES, MAX_ROWS, parseImportBytes, type ParsedFile } from "@/lib/bank/parse";
import { downloadFile, templateCsv, templateXlsx } from "@/lib/bank/template";
import { toCsv } from "@/lib/bank/csv";
import type { Filters, IssueRow } from "@/lib/bank/types";

type Step = "file" | "mapping" | "running" | "report";
const STEPS: { id: Step; label: string }[] = [
  { id: "file", label: "1 · Fichier" },
  { id: "mapping", label: "2 · Colonnes et aperçu" },
  { id: "running", label: "3 · Importation" },
  { id: "report", label: "4 · Rapport" },
];

interface RecentBatch {
  id: string;
  filename: string;
  status: BatchInfo["status"];
  total_rows: number;
  rows_done: number;
  accepted: number;
  rejected: number;
  created_by: string | null;
  created_at: string;
}

const SEVERITY_LABELS = { error: "Rejetée", warning: "À corriger", info: "Info" } as const;

/** Bibliothèque → Importer des exercices (CSV, XLSX, JSON). */
export default function ImportWizard({ onOpenLibrary }: { onOpenLibrary: (filters: Filters) => void }) {
  const [step, setStep] = useState<Step>("file");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [filename, setFilename] = useState("");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [defaultPart, setDefaultPart] = useState<5 | 6 | 7 | null>(null);
  const [defaultDifficulty, setDefaultDifficulty] = useState<1 | 2 | 3>(2);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [batch, setBatch] = useState<BatchInfo | null>(null);
  const [recent, setRecent] = useState<RecentBatch[]>([]);
  const [over, setOver] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      setRecent((await adminRequest<{ batches: RecentBatch[] }>("bank-import-list")).batches);
    } catch {
      setRecent([]);
    }
  }, []);
  useEffect(() => { void loadRecent(); }, [loadRecent]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  async function open(file: File) {
    setError("");
    setBusy(true);
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(`Fichier trop volumineux : ${MAX_FILE_BYTES / 1048576} Mo au maximum.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = parseImportBytes(file.name, bytes);
      setParsed(result);
      setFilename(file.name);
      setFingerprint(await fingerprintOf(bytes));
      const defaults = { defaultPart, defaultDifficulty };
      const res = await analyzeFile(result, defaults);
      setAnalysis(res);
      setMapping(res.mapping);
      setStep("mapping");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // Nouvelle analyse (aperçu) quand la correspondance ou les valeurs par défaut changent.
  const reanalyze = useCallback(async (next: Mapping, part: 5 | 6 | 7 | null, difficulty: 1 | 2 | 3) => {
    if (!parsed) return;
    try {
      setAnalysis(await analyzeFile(parsed, { defaultPart: part, defaultDifficulty: difficulty }, next));
    } catch (e) {
      fail(e);
    }
  }, [parsed]);

  const changeMapping = (field: string, header: string) => {
    const next = { ...mapping };
    if (header) next[field] = header;
    else delete next[field];
    setMapping(next);
    void reanalyze(next, defaultPart, defaultDifficulty);
  };

  const missing = analysis ? analysis.fields.filter((f) => f.required && !mapping[f.id]).map((f) => f.label) : [];
  const partMissing = !mapping.part && !defaultPart;
  const previewErrors = analysis?.preview.filter((p) => !p.ok).length ?? 0;

  async function start() {
    if (!parsed || !analysis) return;
    setError("");
    setStep("running");
    setBatch(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const done = await runImport({
        parsed, filename, fingerprint, mapping, defaults: { defaultPart, defaultDifficulty }, signal: controller.signal,
        onProgress: setProgress,
      });
      setBatch(done);
      setStep("report");
    } catch (e) {
      if ((e as Error).name === "AbortError") setError("Importation interrompue. Elle peut être reprise : sélectionnez à nouveau le même fichier, seuls les blocs restants seront envoyés.");
      else fail(e);
      setStep("running");
    } finally {
      abort.current = null;
      void loadRecent();
    }
  }

  async function cancelBatch() {
    if (!progress || !window.confirm("Annuler définitivement cet import ? Les questions déjà enregistrées (brouillons) sont conservées.")) return;
    abort.current?.abort();
    try {
      await adminRequest("bank-import-cancel", { batchId: progress.batchId });
      setError("Import annulé. Les brouillons déjà importés restent dans la bibliothèque.");
    } catch (e) {
      fail(e);
    }
    void loadRecent();
  }

  function reset() {
    setParsed(null);
    setAnalysis(null);
    setMapping({});
    setProgress(null);
    setBatch(null);
    setError("");
    setStep("file");
  }

  return (
    <section className="lexora-card" aria-label="Importer des exercices">
      <h2>Importer des exercices</h2>
      <ol className="bank-steps" aria-label="Étapes">
        {STEPS.map((s, i) => (
          <li key={s.id} aria-current={s.id === step ? "step" : undefined} data-done={STEPS.findIndex((x) => x.id === step) > i}>{s.label}</li>
        ))}
      </ol>
      <div aria-live="polite">{error && <p className="lexora-notice" role="alert">{error}</p>}</div>

      {step === "file" && (
        <div style={{ display: "grid", gap: 18 }}>
          <div
            className="bank-drop"
            data-over={over}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void open(f); }}
          >
            <p style={{ margin: "0 0 10px", fontWeight: 650 }}>Déposez un fichier ici ou choisissez-le</p>
            <label className="lexora-primary" style={{ cursor: "pointer" }}>
              {busy ? "Lecture du fichier…" : "Choisir un fichier .csv, .xlsx ou .json"}
              <input type="file" accept=".csv,.tsv,.txt,.xlsx,.json,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden disabled={busy}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void open(f); }} />
            </label>
            <p className="bank-muted-small" style={{ margin: "12px 0 0" }}>
              Jusqu'à {MAX_ROWS.toLocaleString("fr-FR")} lignes et {MAX_FILE_BYTES / 1048576} Mo par fichier. Le fichier est lu dans votre navigateur puis envoyé par blocs de 200 lignes ; tout est enregistré en <strong>brouillon</strong>.
            </p>
          </div>

          <div>
            <h3 style={{ fontSize: 15 }}>Modèle à remplir</h3>
            <p className="lexora-muted" style={{ margin: "0 0 10px" }}>Exemples valides pour les parties 5, 6 et 7, instructions et liste des catégories.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="lexora-secondary" onClick={() => downloadFile("lernoviq-modele-import.xlsx", templateXlsx() as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}>Télécharger le modèle Excel (.xlsx)</button>
              <button type="button" className="lexora-secondary" onClick={() => downloadFile("lernoviq-modele-import.csv", templateCsv(), "text/csv;charset=utf-8")}>Modèle CSV</button>
            </div>
          </div>

          {recent.length > 0 && (
            <div>
              <h3 style={{ fontSize: 15 }}>Imports récents</h3>
              {recent.slice(0, 8).map((b) => (
                <div key={b.id} className="lexora-admin-question" style={{ padding: "10px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <span><strong>{b.filename}</strong> · {new Date(b.created_at).toLocaleString("fr-FR")} · {b.created_by}</span>
                    <span className="bank-badge" data-tone={b.status === "completed" ? "published" : b.status === "processing" ? "review" : "archived"}>
                      {b.status === "completed" ? "Terminé" : b.status === "processing" ? "Incomplet — à reprendre" : b.status === "cancelled" ? "Annulé" : "Échec"}
                    </span>
                  </div>
                  <div className="bank-muted-small">{b.rows_done}/{b.total_rows} lignes · {b.accepted} acceptées · {b.rejected} rejetées
                    {b.status === "processing" && " · pour reprendre, sélectionnez à nouveau le même fichier"}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button type="button" className="lexora-linkbutton" onClick={() => onOpenLibrary({ batch_id: b.id })}>Voir les brouillons importés</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {step === "mapping" && parsed && analysis && (
        <div style={{ display: "grid", gap: 20 }}>
          <p className="lexora-muted" style={{ margin: 0 }}>
            <strong>{filename}</strong> · {parsed.rows.length.toLocaleString("fr-FR")} ligne(s) · {parsed.headers.length} colonne(s)
            {parsed.skipped > 0 && ` · ${parsed.skipped} ligne(s) vide(s) ignorée(s)`}
            {parsed.truncated > 0 && ` · ${parsed.truncated} cellule(s) tronquée(s) à 6 000 caractères`}
          </p>

          <div>
            <h3 style={{ fontSize: 15 }}>Correspondance des colonnes</h3>
            <p className="bank-muted-small">Les colonnes ont été associées automatiquement. Corrigez si nécessaire.</p>
            <div className="bank-map">
              {analysis.fields.map((f) => (
                <FragmentRow key={f.id} field={f} value={mapping[f.id] ?? ""} headers={parsed.headers} onChange={(h) => changeMapping(f.id, h)} />
              ))}
            </div>
            {analysis.unmapped.length > 0 && <p className="bank-muted-small">Colonnes ignorées : {analysis.unmapped.join(", ")}.</p>}
          </div>

          <div className="bank-editor-grid">
            <label className="bank-field">Partie par défaut {mapping.part ? "(utilisée si la cellule est vide)" : "(obligatoire : aucune colonne « partie »)"}
              <select className="lexora-admin-input" value={defaultPart ?? ""} data-missing={partMissing} onChange={(e) => { const v = e.target.value ? (Number(e.target.value) as 5 | 6 | 7) : null; setDefaultPart(v); void reanalyze(mapping, v, defaultDifficulty); }}>
                <option value="">— choisir —</option><option value="5">Partie 5</option><option value="6">Partie 6</option><option value="7">Partie 7</option>
              </select>
            </label>
            <label className="bank-field">Difficulté par défaut
              <select className="lexora-admin-input" value={defaultDifficulty} onChange={(e) => { const v = Number(e.target.value) as 1 | 2 | 3; setDefaultDifficulty(v); void reanalyze(mapping, defaultPart, v); }}>
                <option value={1}>1 · Facile</option><option value={2}>2 · Intermédiaire</option><option value={3}>3 · Avancé</option>
              </select>
            </label>
          </div>

          <div>
            <h3 style={{ fontSize: 15 }}>Aperçu des {analysis.preview.length} premières lignes</h3>
            {analysis.preview.map((p) => (
              <details key={p.row} className="lexora-admin-question bank-detail" style={{ padding: "10px 0" }}>
                <summary>
                  <span className="bank-badge" data-tone={p.ok ? (p.issues.length ? "review" : "published") : "error"}>{p.ok ? (p.issues.length ? "À corriger" : "Valide") : "Rejetée"}</span>{" "}
                  Ligne {p.row} · {p.question ? `Partie ${p.question.part} · ${p.question.prompt.slice(0, 90)}` : "illisible"}
                </summary>
                {p.question && (
                  <div style={{ padding: "8px 0" }}>
                    <p style={{ margin: "4px 0" }}>{p.question.prompt}</p>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {p.question.options.map((o) => <li key={o.key} style={{ fontWeight: o.key === p.question?.correctKey ? 800 : 400 }}>{o.key}. {o.text}{o.key === p.question?.correctKey ? " ✓" : ""}</li>)}
                    </ul>
                    {p.passage && <p className="bank-muted-small">Document : {p.passage.title} ({p.passage.documents.length} pièce(s))</p>}
                  </div>
                )}
                {p.issues.map((i, k) => <p key={k} className="bank-flag" style={i.severity === "error" ? { color: "#9a3232" } : undefined}>{i.severity === "error" ? "✗" : "⚠"} {i.message}</p>)}
              </details>
            ))}
            {previewErrors > 0 && <p className="lexora-notice">{previewErrors} ligne(s) de l'aperçu seraient rejetées. L'import traitera tout le fichier et vous donnera un rapport complet.</p>}
          </div>

          {(missing.length > 0 || partMissing) && (
            <p className="lexora-notice" role="alert">
              {missing.length > 0 && <>Champs obligatoires non associés : {missing.join(", ")}. </>}
              {partMissing && <>Choisissez une partie par défaut ou associez la colonne « partie ».</>}
            </p>
          )}
          <div className="lexora-actions">
            <button type="button" className="lexora-secondary" onClick={reset}>← Changer de fichier</button>
            <button type="button" className="lexora-primary" disabled={missing.length > 0 || partMissing} onClick={start}>
              Importer {parsed.rows.length.toLocaleString("fr-FR")} ligne(s) en brouillon →
            </button>
          </div>
        </div>
      )}

      {step === "running" && (
        <div>
          {progress ? (
            <>
              <p style={{ margin: 0 }}>
                <strong>{progress.resumed ? "Importation reprise" : "Importation en cours"}</strong> — bloc {Math.min(progress.chunk + (progress.chunk < progress.chunks ? 1 : 0), progress.chunks)} sur {progress.chunks}
              </p>
              <div className="bank-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.totalRows} aria-valuenow={progress.rowsDone}>
                <div style={{ width: `${progress.totalRows ? (progress.rowsDone / progress.totalRows) * 100 : 0}%` }} />
              </div>
              <Counts accepted={progress.accepted} duplicates={progress.duplicates} rejected={progress.rejected} flagged={progress.flagged} rows={progress.rowsDone} />
              <p className="bank-muted-small">Ne fermez pas cet onglet. Si la connexion est coupée, relancez simplement l'import avec le même fichier : il reprendra là où il s'est arrêté, sans doublon.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {abort.current ? (
                  <button type="button" className="lexora-secondary" onClick={() => abort.current?.abort()}>Interrompre (reprise possible)</button>
                ) : (
                  <button type="button" className="lexora-primary" onClick={() => void start()}>Reprendre l'import</button>
                )}
                <button type="button" className="lexora-secondary" onClick={cancelBatch}>Annuler définitivement</button>
                {!abort.current && <button type="button" className="lexora-linkbutton" onClick={reset}>Retour</button>}
              </div>
            </>
          ) : <p className="lexora-muted">Démarrage de l'importation…</p>}
        </div>
      )}

      {step === "report" && batch && (
        <ImportReport batch={batch} onOpenLibrary={onOpenLibrary} onRestart={() => { reset(); void loadRecent(); }} />
      )}
    </section>
  );
}

function FragmentRow({ field, value, headers, onChange }: { field: { id: string; label: string; required: boolean }; value: string; headers: string[]; onChange: (h: string) => void }) {
  const id = `map-${field.id}`;
  return (
    <>
      <label htmlFor={id}>{field.label}{field.required ? " *" : ""}</label>
      <select id={id} className="lexora-admin-input" style={{ marginTop: 0 }} value={value} data-missing={field.required && !value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.required ? "— à associer —" : "(aucune)"}</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </>
  );
}

function Counts({ accepted, duplicates, rejected, flagged, rows }: { accepted: number; duplicates: number; rejected: number; flagged: number; rows: number }) {
  return (
    <div className="bank-count-row">
      <div><strong>{rows.toLocaleString("fr-FR")}</strong><span>lignes traitées</span></div>
      <div><strong>{accepted.toLocaleString("fr-FR")}</strong><span>acceptées (brouillons)</span></div>
      <div><strong>{flagged.toLocaleString("fr-FR")}</strong><span>à corriger / vérifier</span></div>
      <div><strong>{rejected.toLocaleString("fr-FR")}</strong><span>rejetées</span></div>
      <div><strong>{duplicates.toLocaleString("fr-FR")}</strong><span>doublons exacts</span></div>
    </div>
  );
}

function ImportReport({ batch, onOpenLibrary, onRestart }: { batch: BatchInfo; onOpenLibrary: (f: Filters) => void; onRestart: () => void }) {
  const [severity, setSeverity] = useState<"error" | "warning">("error");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; issues: IssueRow[] } | null>(null);
  const [error, setError] = useState("");
  const LIMIT = 50;

  useEffect(() => {
    let active = true;
    adminRequest<{ total: number; issues: IssueRow[] }>("bank-import-issues", { batchId: batch.id, severity, offset, limit: LIMIT })
      .then((r) => active && setData(r))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => { active = false; };
  }, [batch.id, severity, offset]);

  async function download() {
    const lines: (string | number)[][] = [["ligne", "gravité", "code", "message"]];
    for (const sev of ["error", "warning"] as const) {
      for (let off = 0; off < 5000; off += 200) {
        const page = await adminRequest<{ total: number; issues: IssueRow[] }>("bank-import-issues", { batchId: batch.id, severity: sev, offset: off, limit: 200 });
        for (const i of page.issues) lines.push([i.ref ?? "", SEVERITY_LABELS[i.severity], i.code, i.message]);
        if (off + 200 >= page.total) break;
      }
    }
    downloadFile(`rapport-import-${batch.id.slice(0, 8)}.csv`, "﻿" + toCsv(lines), "text/csv;charset=utf-8");
  }

  return (
    <div>
      <p style={{ margin: 0 }}><strong>{batch.status === "completed" ? "Importation terminée" : "Importation arrêtée"}</strong> — {batch.filename}</p>
      <Counts accepted={batch.accepted} duplicates={batch.duplicates} rejected={batch.rejected} flagged={batch.flagged} rows={batch.rows_done} />
      <p className="lexora-muted">Les {batch.accepted.toLocaleString("fr-FR")} questions acceptées sont des <strong>brouillons</strong> : relisez-les dans la bibliothèque puis publiez-les. Celles marquées « à vérifier » exigent une confirmation explicite avant publication.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <button type="button" className="lexora-primary" onClick={() => onOpenLibrary({ batch_id: batch.id })}>Ouvrir les brouillons importés</button>
        {batch.flagged > 0 && <button type="button" className="lexora-secondary" onClick={() => onOpenLibrary({ batch_id: batch.id, needs_review: true })}>Voir celles à vérifier</button>}
        <button type="button" className="lexora-secondary" onClick={() => void download()}>Télécharger le rapport (CSV)</button>
        <button type="button" className="lexora-secondary" onClick={onRestart}>Nouvel import</button>
      </div>

      <div role="tablist" style={{ display: "flex", gap: 8, margin: "14px 0" }}>
        {(["error", "warning"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={severity === s} className={severity === s ? "lexora-primary" : "lexora-secondary"} onClick={() => { setSeverity(s); setOffset(0); setData(null); }}>
            {s === "error" ? `Rejetées (${batch.rejected + batch.duplicates})` : `À corriger (${batch.flagged})`}
          </button>
        ))}
      </div>
      {error && <p className="lexora-notice" role="alert">{error}</p>}
      {data === null ? <p className="lexora-muted">Chargement du rapport…</p> : data.issues.length === 0 ? <p className="lexora-subtle">Aucune ligne dans cette catégorie.</p> : (
        <>
          {data.issues.map((i) => (
            <div className="bank-issue" key={i.id}>
              <span>Ligne {i.ref}</span><span className="bank-badge" data-tone={i.severity === "error" ? "error" : "review"}>{i.code}</span><span>{i.message}</span>
            </div>
          ))}
          <nav className="bank-pager" aria-label="Pagination du rapport">
            <span className="bank-muted-small">{offset + 1}–{Math.min(offset + LIMIT, data.total)} sur {data.total}</span>
            <span style={{ display: "flex", gap: 8 }}>
              <button type="button" className="lexora-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>← Précédent</button>
              <button type="button" className="lexora-secondary" disabled={offset + LIMIT >= data.total} onClick={() => setOffset(offset + LIMIT)}>Suivant →</button>
            </span>
          </nav>
        </>
      )}
    </div>
  );
}
