import { useEffect, useState } from "react";
import { PARTS } from "@/lib/parts";
import TopNav from "@/components/TopNav";
import { useSettings } from "@/lib/SettingsContext";
import { readSessions, type Session } from "@/lib/progress";
import { DATA_EVENT, readCards, dueNow, myAttempts } from "@/lib/tracker";
import type { ReviewCard } from "@/lib/srs";
import { readDiagnostic, type DiagnosticResult } from "./Diagnostic";
import "./lexora.css";
import "./phase2.css";
import { readLessons } from "@/lib/lessons";
import GoalSummary from "@/components/GoalSummary";
import { answeredToday, daysUntil, latestExamScore } from "@/lib/goals";
import { readExamHistory, readGoals } from "@/lib/goalsStore";
import { currentStreak } from "@/lib/stats";

const DAY_LABELS = ["L", "M", "M", "J", "V", "S", "D"];

export default function Dashboard() {
  const { hasPersonalKey } = useSettings();
  const [history, setHistory] = useState<Session[]>([]);
  const [cards, setCards] = useState<ReviewCard[]>([]);
  const [dueCount, setDueCount] = useState(0);
  const [diagnostic, setDiagnostic] = useState<DiagnosticResult | null>(null);
  const [hasServerKey, setHasServerKey] = useState<boolean | null>(null);
  useEffect(() => {
    const refresh = () => { setCards(readCards().filter(c => !c.mastered)); setDueCount(dueNow().length); };
    setHistory(readSessions()); refresh(); setDiagnostic(readDiagnostic());
    window.addEventListener(DATA_EVENT, refresh);
    fetch("/api/health").then(r => r.json()).then((d: { hasDeepSeekKey?: boolean }) => setHasServerKey(Boolean(d.hasDeepSeekKey))).catch(() => setHasServerKey(false));
    return () => window.removeEventListener(DATA_EVENT, refresh);
  }, []);
  const lessonCount = readLessons().filter(l => l.status === "ready").length;
  const attempted = history.reduce((total, session) => total + session.total, 0);
  const correct = history.reduce((total, session) => total + session.correct, 0);
  const average = attempted ? Math.round(correct / attempted * 100) : null;

  const goals = readGoals();
  const attempts = myAttempts();
  const daysLeft = daysUntil(goals.examDate);
  const todayCount = answeredToday(attempts);
  const streak = currentStreak(attempts);
  const lastExam = latestExamScore(readExamHistory());
  const target = goals.targetScore;
  const ringLen = lastExam ? Math.round(339 * Math.min(1, lastExam / 495)) : 0;
  const dateLabel = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const todayIdx = (new Date().getDay() + 6) % 7;
  const examLabel = daysLeft === null ? "Fixer ma date d'examen" : daysLeft === 0 ? "Examen aujourd'hui" : daysLeft < 0 ? "Examen passé" : `Examen dans ${daysLeft} jours · J-${daysLeft}`;
  const scoreMessage = lastExam === null
    ? "Passez un examen blanc pour estimer votre score"
    : target
      ? (lastExam >= target ? `Objectif de ${target} atteint !` : `Plus que ${target - lastExam} points pour votre objectif de ${target}`)
      : "Fixez un score visé dans Mon objectif";
  const arrow = <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;

  return <div className="lexora-page">
    <TopNav active="home" />
    <main className="lexora-shell lexora-content">
      <div className="lexora-actions" style={{ alignItems: "flex-end" }}>
        <div>
          <p className="lexora-eyebrow" style={{ textTransform: "capitalize" }}>{dateLabel}</p>
          <h1 className="lexora-heading" style={{ marginBottom: 0 }}>{todayCount >= goals.dailyGoal ? "Objectif du jour atteint, bravo !" : "On garde le rythme ?"}</h1>
        </div>
        <a className="lexora-secondary" href="#/goals">{examLabel}</a>
      </div>

      <section className="lexora-today" aria-label="Séance du jour">
        <div className="lexora-session">
          <span className="lexora-badge">Séance du jour · 15 min</span>
          <h2>{diagnostic ? "Votre coach prépare une séance sur vos points faibles." : "Commencez par un diagnostic pour calibrer votre coach."}</h2>
          <div className="lexora-blocks">
            <div className="lexora-block"><b>1 · Entraînement</b><span>Séance adaptative</span><small>Ciblée sur vos erreurs</small></div>
            <div className="lexora-block"><b style={{ color: "#CBBEFF" }}>2 · Révisions</b><span>Vos erreurs à revoir</span><small>{dueCount} carte{dueCount > 1 ? "s" : ""}</small></div>
            <div className="lexora-block"><b style={{ color: "#fff" }}>3 · Leçons</b><span>Écrites par le coach</span><small>{lessonCount} disponible{lessonCount > 1 ? "s" : ""}</small></div>
          </div>
          <div className="lexora-actions" style={{ justifyContent: "flex-start", gap: 16 }}>
            <a className="lexora-primary" href={diagnostic ? "#/adaptive" : "#/diagnostic"}>{diagnostic ? "Commencer la séance" : "Commencer le diagnostic"} {arrow}</a>
            <a className="lexora-session-link" href="#/practice/part5">Entraînement libre</a>
          </div>
        </div>
        <div className="lexora-side">
          <div className="lexora-card lexora-ring">
            <svg role="img" aria-label={lastExam ? `Score estimé ${lastExam} sur 495` : "Aucun examen blanc passé"} width="128" height="128" viewBox="0 0 128 128" style={{ flexShrink: 0 }}>
              <circle cx="64" cy="64" r="54" fill="none" stroke="#EEECE4" strokeWidth="14" />
              <circle cx="64" cy="64" r="54" fill="none" stroke="#15171C" strokeWidth="14" strokeLinecap="round" strokeDasharray={`${ringLen} 340`} transform="rotate(-90 64 64)" />
              <text x="64" y="64" textAnchor="middle" fontFamily="Space Grotesk, sans-serif" fontSize="30" fontWeight="700" fill="#15171C">{lastExam ?? "—"}</text>
              <text x="64" y="86" textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="12" fill="#5B5F6A">/ 495</text>
            </svg>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="lexora-subtle" style={{ fontWeight: 600 }}>Score Reading estimé</span>
              <span className="lexora-ringnum">{scoreMessage}</span>
              {average !== null && <span className="lexora-chip-lime">{average} % de réussite</span>}
            </div>
          </div>
          <div className="lexora-card" style={{ display: "flex", flexDirection: "column", gap: 16, padding: "24px 28px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontFamily: "Space Grotesk, sans-serif", fontSize: 20, fontWeight: 700 }}>Série de {streak} jour{streak > 1 ? "s" : ""}</span>
              <span className="lexora-subtle">{todayCount} / {goals.dailyGoal} aujourd'hui</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 8 }}>
              {DAY_LABELS.map((label, i) => {
                const done = i < todayIdx ? i >= todayIdx - streak : i === todayIdx && todayCount > 0;
                const isToday = i === todayIdx && !done;
                return <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", background: done ? "#15171C" : isToday ? "transparent" : "#EEECE4", border: isToday ? "2px dashed #15171C" : "none" }}>
                    {done && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C5F04A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
                  </span>
                  <span className="lexora-subtle" style={{ fontWeight: 600 }}>{label}</span>
                </div>;
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="lexora-shortcuts" aria-label="Raccourcis">
        <a href="#/review" className="lexora-shortcut lexora-shortcut--lilac"><span className="k">Répétition espacée</span><span style={{ fontFamily: "Space Grotesk, sans-serif", fontSize: 40, fontWeight: 700, lineHeight: 1 }}>{dueCount}</span><b style={{ fontWeight: 600 }}>{dueCount > 1 ? "erreurs reviennent" : "erreur revient"} aujourd'hui</b><span className="go">Réviser maintenant →</span></a>
        <a href="#/lessons" className="lexora-shortcut"><span className="k">Coach IA</span><b className="t">{lessonCount} leçon{lessonCount > 1 ? "s" : ""} écrite{lessonCount > 1 ? "s" : ""} à partir de vos erreurs</b><span className="go">Lire mes leçons →</span></a>
        <a href="#/exam" className="lexora-shortcut"><span className="k">Conditions réelles</span><b className="t">Examen blanc · 100 questions en 75 min</b><span className="go">Lancer l'examen →</span></a>
      </section>

      <div className="lexora-sectionhead"><h2>Entraînement libre</h2><span className="lexora-subtle">Choisissez une partie du TOEIC</span></div>
      <section className="lexora-grid" aria-label="Exercices disponibles">
        {PARTS.map(part => <a key={part.part} href={`#/practice/${part.slug}`} className="lexora-card lexora-part">
          <div className="lexora-actions"><span className="lexora-partno">{part.part}</span><span className="lexora-subtle">{part.questionCount}</span></div>
          <h3>{part.name}</h3><p className="lexora-muted">{part.description}</p>
          <div className="lexora-arrow">S'entraîner →</div>
        </a>)}
        <a href="#/listening/part2" className="lexora-card lexora-part">
          <div className="lexora-actions"><span className="lexora-partno" style={{ background: "#EEECE4" }}><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#15171C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><rect x="3" y="14" width="4" height="7" rx="1.5" /><rect x="17" y="14" width="4" height="7" rx="1.5" /></svg></span><span className="lexora-badge" style={{ background: "#15171C", color: "#fff", fontSize: 12 }}>Nouveau</span></div>
          <h3>Listening · Partie 2</h3><p className="lexora-muted">Une question, trois réponses à l'oral.</p>
          <div className="lexora-arrow">S'entraîner →</div>
        </a>
      </section>

      <GoalSummary />

      <section className="lexora-card lexora-review"><h2>Réviser mes erreurs</h2><p className="lexora-muted">{cards.length ? `${cards.length} question(s) en cours de révision.` : "Vos erreurs seront enregistrées au fil de vos séances, pour faciliter vos révisions."}</p><div className="lexora-reviewlinks">{([5, 6, 7] as const).map(part => { const count = cards.filter(c => c.part === part).length; return count ? <a key={part} href={`#/review/part${part}`} className="lexora-secondary">Partie {part} · {count} →</a> : null; })}</div></section>
      {hasServerKey === false && !hasPersonalKey && <div className="lexora-notice" role="status">Les explications personnalisées ne sont pas encore activées. Ajoutez une clé DeepSeek dans les paramètres pour les utiliser. Les exercices restent accessibles.</div>}
      <footer className="lexora-subtle" style={{ marginTop: 42, display: "flex", gap: 16, flexWrap: "wrap" }}><span>Lernoviq · Préparation indépendante à l'anglais professionnel. Nom de marque provisoire.</span><a className="lexora-admin-link" href="#/admin">Administration</a></footer>
    </main>
  </div>;
}
