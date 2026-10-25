import { useEffect, useMemo, useState } from "react";
import { buildAdaptivePlan, type Recommendation } from "@/lib/adaptive";
import { answeredToday, latestExamScore } from "@/lib/goals";
import { readExamHistory, readGoals } from "@/lib/goalsStore";
import { DATA_EVENT, dueNow, myAttempts } from "@/lib/tracker";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import categories from "../../data/categories.json";
import "./lexora.css";
import "./phase2.css";

const LABELS = Object.fromEntries(categories.map((c) => [c.id, c.label]));
const KIND_LABELS: Record<Recommendation["kind"], string> = {
  review: "Révision espacée", targeted: "Exercice ciblé", mixed: "Séance mixte", unseen: "Jamais vues", progressive: "Difficulté progressive", exam: "Examen blanc",
};

/** Séances recommandées d'après vos réponses, votre vitesse, vos erreurs répétées et votre objectif. */
export default function Adaptive() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick((n) => n + 1);
    window.addEventListener(DATA_EVENT, refresh);
    return () => window.removeEventListener(DATA_EVENT, refresh);
  }, []);

  const plan = useMemo(() => {
    const attempts = myAttempts();
    const goals = readGoals();
    return {
      attempts,
      goals,
      today: answeredToday(attempts),
      plan: buildAdaptivePlan({ attempts, dueCount: dueNow().length, goals, lastExamScore: latestExamScore(readExamHistory()), labels: LABELS }),
    };
    // tick force le recalcul quand l'historique change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const { plan: p, goals, today } = plan;
  const dailyPct = Math.min(100, Math.round((today / Math.max(goals.dailyGoal, 1)) * 100));

  return (
    <div className="lexora-page lexora-exercises">
      <header className="lexora-nav">
        <div className="lexora-shell">
          <a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a>
          <div className="lexora-navright"><a className="lexora-smalllink" href="#/stats">Statistiques</a><AuthButton /><SettingsButton withLabel /></div>
        </div>
      </header>
      <main className="lexora-shell lexora-content" style={{ maxWidth: 900 }}>
        <p className="lexora-eyebrow">Entraînement adaptatif</p>
        <h1 className="lexora-heading">Votre séance du jour.</h1>
        <p className="lexora-muted">{p.summary}</p>

        <section className="lexora-card" style={{ margin: "22px 0" }} aria-label="Objectif du jour">
          <p className="lexora-statlabel">Objectif du jour</p>
          <p className="lexora-statvalue">{today} / {goals.dailyGoal} questions</p>
          <div className="lexora-bar" role="img" aria-label={`${dailyPct} % de l'objectif du jour`}><div style={{ width: `${dailyPct}%` }} /></div>
        </section>

        <h2 style={{ fontSize: 20 }}>Recommandé pour vous</h2>
        <div className="lexora-stack" style={{ margin: "14px 0 30px" }}>
          {p.recommendations.map((r, i) => (
            <a key={`${r.kind}-${i}`} href={r.href} className="lexora-card lexora-part" style={{ padding: 20 }}>
              <span className="lexora-pill" style={{ alignSelf: "flex-start" }}>{KIND_LABELS[r.kind]}</span>
              <h3 style={{ margin: "10px 0 6px", fontSize: 18 }}>{r.title}</h3>
              <p className="lexora-muted" style={{ margin: 0, fontSize: 14 }}>{r.reason}</p>
              <div className="lexora-arrow" style={{ marginTop: 12 }}>Commencer <span aria-hidden="true">↗</span></div>
            </a>
          ))}
        </div>

        <h2 style={{ fontSize: 20 }}>Vos compétences</h2>
        {p.skills.length === 0 ? (
          <p className="lexora-muted">Vos compétences apparaîtront après quelques réponses.</p>
        ) : (
          <div className="lexora-card" style={{ marginTop: 12 }}>
            <div className="lexora-rows">
              {p.skills.slice(0, 12).map((s) => {
                const pct = Math.round(s.accuracy * 100);
                return (
                  <div className="lexora-row" key={`${s.part}-${s.category}`} style={{ gridTemplateColumns: "1fr 160px 150px" }}>
                    <span>{LABELS[s.category] ?? s.category} <span className="lexora-subtle">· partie {s.part}</span></span>
                    <div className="lexora-bar" data-tone={pct >= 75 ? "high" : pct >= 50 ? "mid" : "low"} role="img" aria-label={`${pct} % de réussite`}><div style={{ width: `${pct}%` }} /></div>
                    <span className="lexora-subtle">
                      {pct} % · {s.attempts} rép.
                      {s.avgTimeMs !== null ? ` · ${Math.round(s.avgTimeMs / 1000)} s` : ""}
                      {s.trend !== null ? (s.trend > 0.1 ? " ↗" : s.trend < -0.1 ? " ↘" : " →") : ""}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="lexora-disclaimer">La précision est pondérée par l'ancienneté des réponses (demi-vie de 14 jours) et prudente sur les petits échantillons. Les recommandations sont des suggestions : vous restez libre de votre parcours.</p>
          </div>
        )}
        <div className="lexora-actions" style={{ marginTop: 26 }}>
          <a className="lexora-secondary" href="#/">Tableau de bord</a>
          <a className="lexora-secondary" href="#/stats">Mes statistiques</a>
        </div>
      </main>
    </div>
  );
}
