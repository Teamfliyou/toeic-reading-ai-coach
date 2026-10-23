import { useEffect, useState } from "react";
import { PARTS } from "@/lib/parts";
import SettingsButton from "@/components/SettingsButton";
import AuthButton from "@/components/AuthButton";
import { useSettings } from "@/lib/SettingsContext";
import { readSessions, type Session } from "@/lib/progress";
import { DATA_EVENT, readCards, dueNow } from "@/lib/tracker";
import type { ReviewCard } from "@/lib/srs";
import { readDiagnostic, type DiagnosticResult } from "./Diagnostic";
import "./lexora.css";
import "./phase2.css";
import { readLessons } from "@/lib/lessons";

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
  return <div className="lexora-page">
    <header className="lexora-nav"><div className="lexora-shell"><a href="#/" className="lexora-brand"><span className="lexora-mark">N</span> Lernoviq</a><div className="lexora-navright"><a className="lexora-smalllink" href="#/vocab">Mes mots</a><a className="lexora-smalllink" href="#/stats">Statistiques</a><a className="lexora-smalllink" href="#/lessons">Mes leçons</a><a className="lexora-smalllink" href="#/diagnostic">Diagnostic</a><a className="lexora-admin-link" href="#/admin">Administration</a><AuthButton /><SettingsButton withLabel /></div></div></header>
    <main className="lexora-shell lexora-content">
      <p className="lexora-eyebrow">Mon espace d'apprentissage</p>
      <h1 className="lexora-heading">Votre anglais, à votre rythme.</h1>
      <p className="lexora-muted">Un espace clair pour vous entraîner, comprendre vos erreurs et mesurer vos progrès.</p>
      <section className="lexora-stats" aria-label="Votre progression">
        <div className="lexora-card"><p className="lexora-statlabel">Sessions terminées</p><p className="lexora-statvalue">{history.length}</p><span className="lexora-subtle">Entraînements réalisés</span></div>
        <div className="lexora-card"><p className="lexora-statlabel">Taux de réussite</p><p className="lexora-statvalue">{average === null ? "—" : `${average} %`}</p><span className="lexora-subtle">{attempted ? `${correct} réponses correctes sur ${attempted}` : "À découvrir après votre séance"}</span></div>
        <div className="lexora-card"><p className="lexora-statlabel">Diagnostic initial</p><p className="lexora-statvalue">{diagnostic ? `${Math.round(diagnostic.correct / diagnostic.total * 100)} %` : "—"}</p><span className="lexora-subtle">{diagnostic ? `${diagnostic.correct} bonnes réponses sur ${diagnostic.total}` : "Pas encore réalisé"}</span></div>
      </section>
      <section className="lexora-hero"><div><p className="lexora-eyebrow">Votre prochaine étape</p><h2>{diagnostic ? "Continuez à progresser" : "Découvrez vos points forts"}</h2><p className="lexora-muted">{diagnostic ? "Entraînez-vous sur les questions de grammaire, les textes à trous et la compréhension écrite." : "Commencez par un diagnostic de 15 questions maximum pour faire un premier point sur votre grammaire et votre vocabulaire."}</p></div><a className="lexora-primary" href={diagnostic ? "#/practice/part5" : "#/diagnostic"}>{diagnostic ? "Reprendre une séance" : "Commencer le diagnostic"} <span aria-hidden="true">→</span></a></section>
      <section className="lexora-hero lexora-lesson-hero"><div><p className="lexora-eyebrow">Votre coach personnel</p><h2>Mes leçons personnalisées</h2><p className="lexora-muted">Chaque mauvaise réponse est analysée par thème pour vous expliquer la règle et proposer un exercice ciblé. {lessonCount} leçon(s) disponible(s).</p></div><a className="lexora-primary" href="#/lessons">Voir mes leçons →</a></section>
      <section className="lexora-hero lexora-lesson-hero"><div><p className="lexora-eyebrow">Conditions réelles</p><h2>Examen blanc Reading</h2><p className="lexora-muted">Parties 5, 6 et 7 en 75 minutes, avec navigation libre, marquage « à revoir » et score estimé sur 495.</p></div><a className="lexora-primary" href="#/exam">Passer l'examen →</a></section>
      <section className="lexora-hero" style={{marginTop:22}}><div><p className="lexora-eyebrow">Répétition espacée</p><h2>À réviser aujourd'hui</h2><p className="lexora-muted">{dueCount ? `${dueCount} question(s) à revoir maintenant, selon un rythme qui s'espace à chaque réussite.` : "Aucune révision en attente. Vos erreurs reviennent ici automatiquement au bon moment."}</p></div><a className="lexora-primary" href="#/review">{dueCount ? "Commencer la révision →" : "Voir mes révisions →"}</a></section>
      <section className="lexora-hero lexora-lesson-hero" style={{marginTop:22}}><div><p className="lexora-eyebrow">Nouveau · Listening</p><h2>Partie 2 · Question-réponse</h2><p className="lexora-muted">Écoutez une question, choisissez la meilleure réponse parmi trois. Un seul jeu de lecture, transcription après chaque réponse.</p></div><a className="lexora-primary" href="#/listening/part2">S'entraîner à l'oral →</a></section>
      <div className="lexora-sectionhead"><h2>Choisir un entraînement</h2><span className="lexora-subtle">Compréhension écrite</span></div>
      <section className="lexora-grid" aria-label="Exercices disponibles">{PARTS.map(part => <a key={part.part} href={`#/practice/${part.slug}`} className="lexora-card lexora-part"><span className="lexora-partno">Partie {part.part}</span><h3>{part.name}</h3><p className="lexora-muted">{part.description}</p><div className="lexora-arrow">S'entraîner <span aria-hidden="true">↗</span></div></a>)}</section>
      <section className="lexora-card lexora-review"><h2>Réviser mes erreurs</h2><p className="lexora-muted">{cards.length ? `${cards.length} question(s) en cours de révision.` : "Vos erreurs seront enregistrées au fil de vos séances, pour faciliter vos révisions."}</p><div className="lexora-reviewlinks">{([5,6,7] as const).map(part => { const count=cards.filter(c => c.part===part).length; return count ? <a key={part} href={`#/review/part${part}`} className="lexora-secondary">Partie {part} · {count} →</a> : null; })}</div></section>
      {hasServerKey === false && !hasPersonalKey && <div className="lexora-notice" role="status">Les explications personnalisées ne sont pas encore activées. Ajoutez une clé DeepSeek dans les paramètres pour les utiliser. Les exercices restent accessibles.</div>}
      <footer className="lexora-subtle" style={{marginTop:42}}>Lernoviq · Préparation indépendante à l'anglais professionnel. Nom de marque provisoire.</footer>
    </main>
  </div>;
}
