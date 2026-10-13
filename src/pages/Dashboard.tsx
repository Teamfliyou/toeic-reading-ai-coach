import { useEffect, useState } from "react";
import { PARTS } from "@/lib/parts";
import SettingsButton from "@/components/SettingsButton";
import { useSettings } from "@/lib/SettingsContext";
import { readSessions, readMistakes, type Session, type Mistake } from "@/lib/progress";
import { readDiagnostic, type DiagnosticResult } from "./Diagnostic";
import "./lexora.css";

export default function Dashboard() {
  const { hasPersonalKey } = useSettings();
  const [history, setHistory] = useState<Session[]>([]);
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [diagnostic, setDiagnostic] = useState<DiagnosticResult | null>(null);
  const [hasServerKey, setHasServerKey] = useState<boolean | null>(null);
  useEffect(() => {
    setHistory(readSessions()); setMistakes(readMistakes()); setDiagnostic(readDiagnostic());
    fetch("/api/health").then(r => r.json()).then((d: { hasDeepSeekKey?: boolean }) => setHasServerKey(Boolean(d.hasDeepSeekKey))).catch(() => setHasServerKey(false));
  }, []);
  const attempted = history.reduce((total, session) => total + session.total, 0);
  const correct = history.reduce((total, session) => total + session.correct, 0);
  const average = attempted ? Math.round(correct / attempted * 100) : null;
  return <div className="lexora-page">
    <header className="lexora-nav"><div className="lexora-shell"><a href="#/" className="lexora-brand"><span className="lexora-mark">L</span> Lexora</a><div className="lexora-navright"><a className="lexora-smalllink" href="#/diagnostic">Diagnostic</a><a className="lexora-smalllink" href="#/admin">Administration</a><SettingsButton withLabel /></div></div></header>
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
      <div className="lexora-sectionhead"><h2>Choisir un entraînement</h2><span className="lexora-subtle">Compréhension écrite</span></div>
      <section className="lexora-grid" aria-label="Exercices disponibles">{PARTS.map(part => <a key={part.part} href={`#/practice/${part.slug}`} className="lexora-card lexora-part"><span className="lexora-partno">Partie {part.part}</span><h3>{part.name}</h3><p className="lexora-muted">{part.description}</p><div className="lexora-arrow">S'entraîner <span aria-hidden="true">↗</span></div></a>)}</section>
      <section className="lexora-card lexora-review"><h2>Réviser mes erreurs</h2><p className="lexora-muted">{mistakes.length ? `${mistakes.length} question(s) à retravailler.` : "Vos erreurs seront enregistrées au fil de vos séances, pour faciliter vos révisions."}</p><div className="lexora-reviewlinks">{([5,6,7] as const).map(part => { const count=mistakes.filter(m => m.part===part).length; return count ? <a key={part} href={`#/review/part${part}`} className="lexora-secondary">Partie {part} · {count} →</a> : null; })}</div></section>
      {hasServerKey === false && !hasPersonalKey && <div className="lexora-notice" role="status">Les explications personnalisées ne sont pas encore activées. Ajoutez une clé DeepSeek dans les paramètres pour les utiliser. Les exercices restent accessibles.</div>}
      <footer className="lexora-subtle" style={{marginTop:42}}>Lexora · Préparation indépendante à l'anglais professionnel. Nom de marque provisoire.</footer>
    </main>
  </div>;
}
