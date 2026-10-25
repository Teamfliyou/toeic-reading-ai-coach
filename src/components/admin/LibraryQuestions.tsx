import { useCallback, useEffect, useMemo, useState } from "react";
import { adminRequest } from "@/lib/bank/api";
import type { Filters, ListResult, QStatus, QuestionRow } from "@/lib/bank/types";
import { DIFFICULTY_LABELS, SOURCE_LABELS, STATUS_LABELS } from "@/lib/bank/types";
import categories from "../../../data/categories.json";
import QuestionEditor from "./QuestionEditor";

const PAGE_SIZE = 25;

interface Props {
  isAdmin: boolean;
  /** Filtre imposé depuis un autre écran (rapport d'import, génération). */
  initialFilters?: Filters;
}

const preview = (q: QuestionRow) => (q.prompt.length > 150 ? `${q.prompt.slice(0, 150)}…` : q.prompt);

/** Liste paginée de la banque : filtres, sélection multiple, actions groupées, édition. */
export default function LibraryQuestions({ isAdmin, initialFilters }: Props) {
  const [filters, setFilters] = useState<Filters>(initialFilters ?? {});
  const [text, setText] = useState(initialFilters?.q ?? "");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<ListResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // Recherche différée : pas d'appel à chaque frappe.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((f) => (f.q === (text || undefined) ? f : { ...f, q: text || undefined }));
      setOffset(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [text]);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await adminRequest<ListResult>("bank-list", { filters, limit: PAGE_SIZE, offset });
      setResult(res);
    } catch (e) {
      setResult({ total: 0, limit: PAGE_SIZE, offset, rows: [] });
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [filters, offset]);
  useEffect(() => { void load(); }, [load]);

  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setOffset(0);
    setSelected(new Set());
  };
  const rows = result?.rows ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)));
  const partCategories = useMemo(() => categories.filter((c) => !filters.part || c.parts.includes(filters.part)), [filters.part]);

  async function bulk(status: QStatus) {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let res = await adminRequest<{ changed: number; skipped: { id: string; reason: string }[] }>("bank-status", { ids, status });
      const flagged = res.skipped.filter((s) => s.reason === "needs_review").map((s) => s.id);
      let extra = 0;
      if (flagged.length && window.confirm(`${flagged.length} question(s) portent des alertes de qualité. Confirmez-vous les avoir relues et vouloir les publier ?`)) {
        const second = await adminRequest<{ changed: number; skipped: { id: string; reason: string }[] }>("bank-status", { ids: flagged, status, ack: true });
        extra = second.changed;
        res = { changed: res.changed, skipped: res.skipped.filter((s) => s.reason !== "needs_review").concat(second.skipped) };
      }
      const skipped = res.skipped.length;
      setNotice(`${res.changed + extra} question(s) → ${STATUS_LABELS[status]}${skipped ? ` · ${skipped} ignorée(s) (${[...new Set(res.skipped.map((s) => s.reason))].join(", ")})` : ""}.`);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ids = [...selected];
    if (!ids.length || !window.confirm(`Supprimer ${ids.length} question(s) ? Seules les questions jamais publiées seront supprimées ; les autres doivent être archivées.`)) return;
    setBusy(true);
    setError("");
    try {
      const res = await adminRequest<{ deleted: number; skipped: unknown[] }>("bank-delete", { ids });
      setNotice(`${res.deleted} supprimée(s)${res.skipped.length ? ` · ${res.skipped.length} conservée(s) car déjà publiées (archivez-les)` : ""}.`);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const total = result?.total ?? 0;
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      {editing && (
        <QuestionEditor key={editing} id={editing} isAdmin={isAdmin} onClose={() => setEditing(null)} onChanged={() => void load()} onOpen={setEditing} />
      )}

      <section className="lexora-card" aria-label="Questions de la banque">
        <div className="lexora-actions" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Questions <span className="bank-muted-small">({total.toLocaleString("fr-FR")})</span></h2>
          {(filters.job_id || filters.batch_id) && <button type="button" className="lexora-secondary" onClick={() => update({ job_id: undefined, batch_id: undefined })}>Retirer le filtre « génération / import »</button>}
        </div>

        <div className="bank-toolbar" role="search">
          <label>Recherche
            <input className="lexora-admin-input" type="search" value={text} placeholder="Texte de l'énoncé ou identifiant" onChange={(e) => setText(e.target.value)} />
          </label>
          <label>Partie
            <select className="lexora-admin-input" value={filters.part ?? ""} onChange={(e) => update({ part: e.target.value ? Number(e.target.value) : undefined, category: undefined })}>
              <option value="">Toutes</option><option value="5">5</option><option value="6">6</option><option value="7">7</option>
            </select>
          </label>
          <label>Difficulté
            <select className="lexora-admin-input" value={filters.difficulty ?? ""} onChange={(e) => update({ difficulty: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">Toutes</option>{[1, 2, 3].map((d) => <option key={d} value={d}>{DIFFICULTY_LABELS[d]}</option>)}
            </select>
          </label>
          <label>Catégorie
            <select className="lexora-admin-input" value={filters.category ?? ""} onChange={(e) => update({ category: e.target.value || undefined })}>
              <option value="">Toutes</option>{partCategories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label>Statut
            <select className="lexora-admin-input" value={filters.status ?? ""} onChange={(e) => update({ status: (e.target.value || undefined) as QStatus | undefined })}>
              <option value="">Tous</option>{(Object.keys(STATUS_LABELS) as QStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label>Origine / contrôle
            <select className="lexora-admin-input" value={filters.needs_review ? "review" : filters.source ?? ""} onChange={(e) => {
              const v = e.target.value;
              update(v === "review" ? { needs_review: true, source: undefined } : { needs_review: undefined, source: (v || undefined) as Filters["source"] });
            }}>
              <option value="">Toutes</option><option value="review">À vérifier ⚠</option>
              {Object.entries(SOURCE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
        </div>

        {selected.size > 0 && (
          <div className="bank-bulk" role="group" aria-label="Actions sur la sélection">
            <strong>{selected.size} sélectionnée(s)</strong>
            <button type="button" className="lexora-primary" disabled={busy} onClick={() => bulk("published")}>Publier</button>
            <button type="button" className="lexora-secondary" disabled={busy} onClick={() => bulk("review")}>Mettre en validation</button>
            <button type="button" className="lexora-secondary" disabled={busy} onClick={() => bulk("draft")}>Remettre en brouillon</button>
            <button type="button" className="lexora-secondary" disabled={busy} onClick={() => bulk("archived")}>Archiver</button>
            {isAdmin && <button type="button" className="lexora-secondary" disabled={busy} onClick={remove}>Supprimer…</button>}
            <button type="button" className="lexora-linkbutton" onClick={() => setSelected(new Set())}>Tout désélectionner</button>
          </div>
        )}

        <div aria-live="polite">
          {error && <p className="lexora-notice" role="alert">{error}</p>}
          {notice && <p className="lexora-notice" role="status" style={{ borderColor: "#bfe3d0", background: "#ecf9f3", color: "#176443" }}>{notice}</p>}
        </div>

        {result === null ? <p className="lexora-muted">Chargement…</p> : rows.length === 0 ? (
          <p className="lexora-muted">Aucune question ne correspond à ces filtres.</p>
        ) : (
          <>
            <table className="bank-table">
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Sélectionner toute la page" checked={allOnPage} onChange={toggleAll} /></th>
                  <th>Énoncé</th><th>Partie</th><th>Niveau</th><th>Catégorie</th><th>Statut</th><th>Origine</th><th>Contrôle</th><th>Modifiée</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={q.id} data-selected={selected.has(q.id)}>
                    <td><input type="checkbox" aria-label={`Sélectionner ${q.slug}`} checked={selected.has(q.id)} onChange={() => toggle(q.id)} /></td>
                    <td>
                      <button type="button" className="bank-prompt" onClick={() => setEditing(q.id)}>{preview(q)}</button>
                      <div className="bank-muted-small">{q.slug}{q.passage_title ? ` · ${q.passage_title}` : ""}</div>
                    </td>
                    <td>{q.part}</td>
                    <td>{DIFFICULTY_LABELS[q.difficulty]}</td>
                    <td>{categories.find((c) => c.id === q.category)?.label ?? "—"}</td>
                    <td><span className="bank-badge" data-tone={q.status}>{STATUS_LABELS[q.status]}</span></td>
                    <td>{SOURCE_LABELS[q.source]}</td>
                    <td>
                      {q.needs_review && <span className="bank-badge" data-tone="warn" title={q.review_flags.map((f) => f.message).join("\n")}>À vérifier</span>}{" "}
                      {(q.open_reports ?? 0) > 0 && <span className="bank-badge" data-tone="error">{q.open_reports} signalement(s)</span>}
                    </td>
                    <td className="bank-muted-small">{new Date(q.updated_at).toLocaleDateString("fr-FR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="bank-cards">
              {rows.map((q) => (
                <article className="bank-card" key={q.id}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" checked={selected.has(q.id)} onChange={() => toggle(q.id)} /> <span className="bank-muted-small">{q.slug}</span>
                  </label>
                  <button type="button" className="bank-prompt" onClick={() => setEditing(q.id)}>{preview(q)}</button>
                  <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span className="bank-badge">Partie {q.part}</span>
                    <span className="bank-badge" data-tone={q.status}>{STATUS_LABELS[q.status]}</span>
                    <span className="bank-badge">{DIFFICULTY_LABELS[q.difficulty]}</span>
                    {q.needs_review && <span className="bank-badge" data-tone="warn">À vérifier</span>}
                    {(q.open_reports ?? 0) > 0 && <span className="bank-badge" data-tone="error">{q.open_reports} signalement(s)</span>}
                  </div>
                </article>
              ))}
            </div>

            <nav className="bank-pager" aria-label="Pagination">
              <span className="bank-muted-small">{from.toLocaleString("fr-FR")}–{to.toLocaleString("fr-FR")} sur {total.toLocaleString("fr-FR")}</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" className="lexora-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Précédent</button>
                <button type="button" className="lexora-secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Suivant →</button>
              </span>
            </nav>
          </>
        )}
      </section>
    </div>
  );
}
