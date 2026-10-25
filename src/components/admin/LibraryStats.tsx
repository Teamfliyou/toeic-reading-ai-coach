import { useCallback, useEffect, useState } from "react";
import { adminRequest } from "@/lib/bank/api";
import type { DuplicateGroup, QStatus, StatsResult } from "@/lib/bank/types";
import { DIFFICULTY_LABELS, SOURCE_LABELS, STATUS_LABELS } from "@/lib/bank/types";
import categories from "../../../data/categories.json";

function Bars({ title, data, labels }: { title: string; data: Record<string, number>; labels?: (k: string) => string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 14);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <div>
      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>{title}</h3>
      {entries.length === 0 ? <p className="bank-muted-small">Aucune donnée.</p> : (
        <div className="bank-bars">
          {entries.map(([k, n]) => (
            <div className="bank-bar" key={k}><span>{labels ? labels(k) : k}</span><div><i style={{ width: `${(n / max) * 100}%` }} /></div><span>{n.toLocaleString("fr-FR")}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Statistiques du catalogue et détection des doublons. */
export default function LibraryStats() {
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [dups, setDups] = useState<{ total: number; groups: DuplicateGroup[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [s, d] = await Promise.all([adminRequest<StatsResult>("bank-stats"), adminRequest<{ total: number; groups: DuplicateGroup[] }>("bank-duplicates", { limit: 20 })]);
      setStats(s);
      setDups(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function archive(id: string) {
    setBusy(true);
    try {
      await adminRequest("bank-status", { ids: [id], status: "archived" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="lexora-notice" role="alert">{error}</p>;
  if (!stats) return <section className="lexora-card">Chargement des statistiques…</section>;

  const published = stats.by_status.published ?? 0;
  const byPart = (part: number) => Object.entries(stats.by_part_status).filter(([k]) => k.startsWith(`${part}:`)).reduce((n, [, v]) => n + v, 0);
  const diff = Object.fromEntries(Object.entries(stats.by_difficulty).map(([k, v]) => { const [p, d] = k.split(":"); return [`Partie ${p} · ${DIFFICULTY_LABELS[Number(d)]}`, v]; }));

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="bank-stat-grid">
        <div className="bank-stat"><strong>{stats.total.toLocaleString("fr-FR")}</strong><span>questions au total</span></div>
        <div className="bank-stat"><strong>{published.toLocaleString("fr-FR")}</strong><span>publiées (visibles par les élèves)</span></div>
        <div className="bank-stat"><strong>{stats.needs_review.toLocaleString("fr-FR")}</strong><span>à vérifier par un humain</span></div>
        <div className="bank-stat"><strong>{stats.passages.toLocaleString("fr-FR")}</strong><span>documents (parties 6 et 7)</span></div>
      </div>

      <section className="lexora-card" aria-label="Statistiques du catalogue" style={{ display: "grid", gap: 26, gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
        <Bars title="Par statut" data={stats.by_status} labels={(k) => STATUS_LABELS[k as QStatus] ?? k} />
        <Bars title="Par partie (toutes questions)" data={{ "Partie 5": byPart(5), "Partie 6": byPart(6), "Partie 7": byPart(7) }} />
        <Bars title="Publiées par difficulté" data={diff} />
        <Bars title="Par catégorie" data={stats.by_category} labels={(k) => categories.find((c) => c.id === k)?.label ?? k} />
        <Bars title="Par origine" data={stats.by_source} labels={(k) => SOURCE_LABELS[k as keyof typeof SOURCE_LABELS] ?? k} />
        <div>
          <Bars title="Bonnes réponses des questions publiées" data={stats.answers_published} />
          <p className="bank-muted-small">Un catalogue équilibré compte environ 25 % de chaque lettre.</p>
        </div>
      </section>

      <section className="lexora-card" aria-label="Doublons">
        <h2>Doublons exacts ({dups?.total ?? 0})</h2>
        <p className="lexora-muted">Un index unique empêche d'ajouter deux questions identiques. Les groupes ci-dessous n'existent que si des doublons étaient déjà présents avant la migration.</p>
        {dups && dups.groups.length === 0 ? <p className="lexora-subtle">Aucun doublon actif.</p> : dups?.groups.map((g) => (
          <article key={g.hash} className="lexora-admin-question">
            <strong>{g.count} exemplaires</strong>
            {g.items.map((item, i) => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <span>{item.slug} · {STATUS_LABELS[item.status]} — {item.prompt.slice(0, 100)}</span>
                {i > 0 && <button type="button" className="lexora-secondary" disabled={busy} onClick={() => archive(item.id)}>Archiver ce doublon</button>}
              </div>
            ))}
          </article>
        ))}
      </section>
    </div>
  );
}
