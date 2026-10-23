import { useEffect, useMemo, useState } from "react";
import { answeredToday, daysUntil } from "@/lib/goals";
import { DATA_EVENT, myAttempts } from "@/lib/tracker";
import { readExamHistory, readGoals } from "@/lib/goalsStore";
import { currentStreak } from "@/lib/stats";
import { latestExamScore } from "@/lib/goals";
import { useAuth } from "@/lib/AuthContext";
import "@/pages/phase2.css";

/** Résumé de l'objectif : jours restants, avancement du jour, série, score visé. */
export default function GoalSummary() {
  const { user } = useAuth();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    window.addEventListener(DATA_EVENT, refresh);
    return () => window.removeEventListener(DATA_EVENT, refresh);
  }, []);

  const data = useMemo(() => {
    const attempts = myAttempts();
    const goals = readGoals();
    return {
      goals,
      today: answeredToday(attempts),
      streak: currentStreak(attempts),
      daysLeft: daysUntil(goals.examDate),
      last: latestExamScore(readExamHistory()),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` et l'utilisateur déclenchent la relecture du stockage local
  }, [version, user?.id]);

  const { goals, today, streak, daysLeft, last } = data;
  const pct = Math.min(100, Math.round((today / goals.dailyGoal) * 100));
  const reached = today >= goals.dailyGoal;

  return (
    <section className="lexora-card" aria-label="Mon objectif" style={{ marginTop: 22 }}>
      <div className="lexora-actions" style={{ alignItems: "flex-start" }}>
        <div>
          <p className="lexora-eyebrow">Mon objectif</p>
          <h2 style={{ fontSize: 20, margin: "0 0 6px" }}>
            {daysLeft === null ? "Fixez votre date d'examen" : daysLeft === 0 ? "C'est aujourd'hui !" : daysLeft < 0 ? "Examen passé" : `J-${daysLeft} avant l'examen`}
          </h2>
          <p className="lexora-muted" style={{ margin: 0 }}>
            {goals.targetScore ? `Score visé : ${goals.targetScore}/495` : "Aucun score visé"}
            {last !== null && ` · dernier examen blanc estimé : ${last}`}
          </p>
        </div>
        <a className="lexora-secondary" href="#/goals">{goals.updatedAt.startsWith("1970") ? "Définir mon objectif" : "Modifier"}</a>
      </div>
      <div style={{ marginTop: 16 }}>
        <div className="lexora-actions">
          <span>{reached ? "Objectif du jour atteint ✓" : "Aujourd'hui"}</span>
          <strong>{today} / {goals.dailyGoal} questions</strong>
        </div>
        <div className="lexora-progressline" role="progressbar" aria-valuemin={0} aria-valuemax={goals.dailyGoal} aria-valuenow={Math.min(today, goals.dailyGoal)} aria-label="Objectif quotidien" style={{ margin: "8px 0" }}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="lexora-subtle">Série : {streak} jour{streak > 1 ? "s" : ""} consécutif{streak > 1 ? "s" : ""}</span>
      </div>
    </section>
  );
}
