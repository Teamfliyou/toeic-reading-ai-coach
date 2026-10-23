import { useEffect, useMemo, useState } from "react";
import { computeStats, currentStreak, type Rate } from "@/lib/stats";
import { DATA_EVENT, myAttempts, readCards } from "@/lib/tracker";
import { boxCounts, INTERVAL_DAYS } from "@/lib/srs";
import { getPartInfo } from "@/lib/parts";
import { useAuth } from "@/lib/AuthContext";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import categories from "../../data/categories.json";
import "./lexora.css";
import "./phase2.css";

const CATEGORY_LABELS = new Map((categories as { id: string; label: string }[]).map((c) => [c.id, c.label]));
const tone = (pct: number | null) => (pct === null ? undefined : pct >= 75 ? "high" : pct >= 50 ? "mid" : "low");

function RateRow({ label, rate }: { label: string; rate: Rate }) {
  return (
    <div className="lexora-row">
      <span>{label}</span>
      <div className="lexora-bar" data-tone={tone(rate.rate)} role="img" aria-label={rate.rate === null ? "Aucune donnée" : `${rate.rate} % de réussite`}>
        <div style={{ width: `${rate.rate ?? 0}%` }} />
      </div>
      <span>{rate.rate === null ? "—" : `${rate.rate} %`} <span className="lexora-subtle">({rate.correct}/{rate.total})</span></span>
    </div>
  );
}

/** Courbe du taux de réussite par jour (SVG, sans bibliothèque). */
function ProgressChart({ points }: { points: { day: string; rate: number | null; total: number }[] }) {
  const W = 640, H = 220, PAD = 34;
  if (points.length < 2) {
    return <p className="lexora-muted">La courbe apparaîtra dès que vous aurez des réponses sur au moins deux jours différents.</p>;
  }
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / (points.length - 1);
  const y = (pct: number) => H - PAD - (pct / 100) * (H - PAD * 2);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.rate ?? 0).toFixed(1)}`).join(" ");
  return (
    <>
      <svg className="lexora-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Courbe de progression : ${points.map((p) => `${p.day} ${p.rate} %`).join(", ")}`}>
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line x1={PAD} x2={W - PAD} y1={y(g)} y2={y(g)} stroke="#e5eaf1" />
            <text x={PAD - 6} y={y(g) + 4} textAnchor="end" fontSize="11" fill="#566377">{g} %</text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#27456c" strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((p, i) => <circle key={p.day} cx={x(i)} cy={y(p.rate ?? 0)} r="4" fill="#27456c"><title>{`${p.day} : ${p.rate} % (${p.total} réponses)`}</title></circle>)}
        <text x={PAD} y={H - 8} fontSize="11" fill="#566377">{points[0].day}</text>
        <text x={W - PAD} y={H - 8} textAnchor="end" fontSize="11" fill="#566377">{points[points.length - 1].day}</text>
      </svg>
    </>
  );
}

export default function Stats() {
  const { user } = useAuth();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    window.addEventListener(DATA_EVENT, refresh);
    return () => window.removeEventListener(DATA_EVENT, refresh);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` et l'utilisateur déclenchent la relecture du stockage local
  const attempts = useMemo(() => myAttempts(), [version, user?.id]);
  const stats = useMemo(() => computeStats(attempts), [attempts]);
  const streak = useMemo(() => currentStreak(attempts), [attempts]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` et l'utilisateur déclenchent la relecture du stockage local
  const counts = useMemo(() => boxCounts(readCards()), [version, user?.id]);
  const seconds = stats.avgTimeMs === null ? null : Math.round(stats.avgTimeMs / 1000);

  return (
    <div className="lexora-page">
      <header className="lexora-nav"><div className="lexora-shell">
        <a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a>
        <div className="lexora-navright"><a className="lexora-smalllink" href="#/">Tableau de bord</a><AuthButton /><SettingsButton withLabel /></div>
      </div></header>
      <main className="lexora-shell lexora-content">
        <p className="lexora-eyebrow">Mon suivi</p>
        <h1 className="lexora-heading">Mes statistiques</h1>
        <p className="lexora-muted">{user ? "Vos résultats sont enregistrés sur votre compte et synchronisés entre vos appareils." : "Vos résultats sont enregistrés sur cet appareil. Connectez-vous pour les retrouver partout."}</p>

        {attempts.length === 0 ? (
          <section className="lexora-hero" style={{ marginTop: 28 }}>
            <div><h2>Pas encore de données</h2><p className="lexora-muted">Chaque réponse donnée en entraînement, en révision ou en examen blanc alimente ces statistiques.</p></div>
            <a className="lexora-primary" href="#/practice/part5">Commencer un exercice →</a>
          </section>
        ) : (
          <>
            <section className="lexora-stats" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))" }} aria-label="Chiffres clés">
              <div className="lexora-card"><p className="lexora-statlabel">Réponses</p><p className="lexora-statvalue">{stats.overall.total}</p></div>
              <div className="lexora-card"><p className="lexora-statlabel">Taux de réussite</p><p className="lexora-statvalue">{stats.overall.rate} %</p></div>
              <div className="lexora-card"><p className="lexora-statlabel">Temps moyen / question</p><p className="lexora-statvalue">{seconds === null ? "—" : `${seconds} s`}</p></div>
              <div className="lexora-card"><p className="lexora-statlabel">Série en cours</p><p className="lexora-statvalue">{streak} j</p></div>
            </section>

            <section className="lexora-card" style={{ marginBottom: 18 }}>
              <h2 style={{ fontSize: 19 }}>Réussite par partie</h2>
              <div className="lexora-rows">
                {[2, 5, 6, 7].filter((p) => stats.byPart[p]).map((p) => (
                  <RateRow key={p} label={p === 2 ? "Listening · Partie 2" : `Partie ${p} · ${getPartInfo(p).name}`} rate={stats.byPart[p]} />
                ))}
              </div>
            </section>

            <section className="lexora-card" style={{ marginBottom: 18 }}>
              <h2 style={{ fontSize: 19 }}>Réussite par type de piège</h2>
              <p className="lexora-muted">Du point le plus fragile au plus solide : commencez par le haut de la liste.</p>
              {stats.byCategory.length === 0 ? <p className="lexora-subtle">Les catégories apparaîtront avec vos prochaines réponses.</p> : (
                <div className="lexora-rows">
                  {stats.byCategory.map((c) => <RateRow key={c.category} label={CATEGORY_LABELS.get(c.category) ?? c.category} rate={c} />)}
                </div>
              )}
            </section>

            <section className="lexora-card" style={{ marginBottom: 18 }}>
              <h2 style={{ fontSize: 19 }}>Progression (taux de réussite par jour)</h2>
              <ProgressChart points={stats.progression} />
              <details style={{ marginTop: 10 }}>
                <summary>Voir les valeurs</summary>
                <ul>{stats.progression.map((p) => <li key={p.day}>{p.day} : {p.rate} % ({p.correct}/{p.total})</li>)}</ul>
              </details>
            </section>
          </>
        )}

        <section className="lexora-card">
          <h2 style={{ fontSize: 19 }}>Mes révisions espacées</h2>
          <div className="lexora-boxes" role="list">
            {counts.boxes.map((n, i) => (
              <div key={i} role="listitem"><strong>{n}</strong><span>Boîte {i + 1}<br />revue tous les {INTERVAL_DAYS[i]} j</span></div>
            ))}
            <div role="listitem"><strong>{counts.mastered}</strong><span>Maîtrisées</span></div>
          </div>
          <a className="lexora-secondary" href="#/review">À réviser aujourd'hui →</a>
        </section>
      </main>
    </div>
  );
}
