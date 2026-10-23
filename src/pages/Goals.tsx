import { useMemo, useState } from "react";
import { buildPlan, validateGoals, latestExamScore } from "@/lib/goals";
import { readExamHistory, readGoals, saveGoals } from "@/lib/goalsStore";
import { myAttempts } from "@/lib/tracker";
import { computeStats } from "@/lib/stats";
import GoalSummary from "@/components/GoalSummary";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import categories from "../../data/categories.json";
import "./lexora.css";
import "./phase2.css";

const LABELS = new Map((categories as { id: string; label: string }[]).map((c) => [c.id, c.label]));

/** Objectif et plan d'étude : date d'examen, score visé, objectif quotidien. */
export default function Goals() {
  const [saved, setSaved] = useState(() => readGoals());
  const [examDate, setExamDate] = useState(saved.examDate ?? "");
  const [targetScore, setTargetScore] = useState(saved.targetScore?.toString() ?? "");
  const [dailyGoal, setDailyGoal] = useState(saved.dailyGoal.toString());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);

  const weak = useMemo(
    () => computeStats(myAttempts()).byCategory.filter((c) => c.total >= 3 && (c.rate ?? 100) < 80).map((c) => c.category),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` et l'utilisateur déclenchent la relecture du stockage local
    [saved]
  );
  const plan = useMemo(
    () => buildPlan({ goals: saved, lastExamScore: latestExamScore(readExamHistory()), weakCategories: weak }),
    [saved, weak]
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const result = validateGoals({ examDate: examDate || null, targetScore, dailyGoal });
    if (!result.ok) {
      setError(result.error);
      setNotice(false);
      return;
    }
    saveGoals(result.value);
    setSaved(readGoals());
    setError(null);
    setNotice(true);
  };

  return (
    <div className="lexora-page">
      <header className="lexora-nav"><div className="lexora-shell">
        <a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a>
        <div className="lexora-navright"><a className="lexora-smalllink" href="#/">Tableau de bord</a><AuthButton /><SettingsButton withLabel /></div>
      </div></header>
      <main className="lexora-shell lexora-content" style={{ maxWidth: 820 }}>
        <p className="lexora-eyebrow">Mon plan d'étude</p>
        <h1 className="lexora-heading">Mon objectif</h1>
        <p className="lexora-muted">Fixez votre date d'examen, le score que vous visez et un nombre de questions par jour : le tableau de bord suit votre avancement et votre série.</p>

        <form className="lexora-card" onSubmit={submit} style={{ display: "grid", gap: 14, margin: "24px 0" }} noValidate>
          <label>Date de l'examen
            <input className="lexora-admin-input" type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} />
          </label>
          <label>Score Reading visé (5 à 495)
            <input className="lexora-admin-input" type="number" inputMode="numeric" min={5} max={495} step={5} value={targetScore} onChange={(e) => setTargetScore(e.target.value)} placeholder="Ex : 400" />
          </label>
          <label>Objectif quotidien (questions par jour)
            <input className="lexora-admin-input" type="number" inputMode="numeric" min={1} max={200} value={dailyGoal} onChange={(e) => setDailyGoal(e.target.value)} />
          </label>
          {error && <p role="alert" className="lexora-notice" style={{ margin: 0 }}>{error}</p>}
          {notice && <p role="status" className="lexora-subtle" style={{ margin: 0 }}>Objectifs enregistrés ✓</p>}
          <div className="lexora-actions"><span /><button type="submit" className="lexora-primary">Enregistrer</button></div>
        </form>

        <GoalSummary />

        <section className="lexora-card" style={{ marginTop: 22 }} aria-label="Plan d'étude">
          <h2 style={{ fontSize: 19 }}>Plan d'étude</h2>
          <p>{plan.summary}</p>
          {plan.focus.length > 0 && (
            <>
              <p className="lexora-muted" style={{ marginBottom: 6 }}>Pièges à travailler en priorité :</p>
              <ul>{plan.focus.map((c) => <li key={c}>{LABELS.get(c) ?? c}</li>)}</ul>
            </>
          )}
          <p className="lexora-disclaimer">Plan indicatif : il suppose environ deux questions travaillées par point de score à gagner. Il ne garantit aucun résultat à l'examen.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a className="lexora-secondary" href="#/exam">Examen blanc</a>
            <a className="lexora-secondary" href="#/review">À réviser aujourd'hui</a>
          </div>
        </section>
      </main>
    </div>
  );
}
