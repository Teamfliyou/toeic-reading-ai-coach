import { useState } from "react";
import { readLessons } from "@/lib/lessons";
import SettingsButton from "@/components/SettingsButton";
import "./lexora.css";

export default function Lessons() {
  const [lessons] = useState(() => readLessons());
  const [expanded, setExpanded] = useState<string | null>(lessons[0]?.id ?? null);
  const ready = lessons.filter(l => l.status === "ready");
  return <div className="lexora-page">
    <header className="lexora-nav"><div className="lexora-shell">
      <a className="lexora-brand" href="#/"><span className="lexora-mark">N</span> Lernoviq</a>
      <div className="lexora-navright"><a className="lexora-smalllink" href="#/">Tableau de bord</a><SettingsButton withLabel /></div>
    </div></header>
    <main className="lexora-shell lexora-content">
      <p className="lexora-eyebrow">Mon parcours personnalisé</p>
      <h1 className="lexora-heading">Mes leçons</h1>
      <p className="lexora-muted">Chaque erreur peut devenir une leçon ciblée : règle, exemple, exercice et astuce pour progresser.</p>
      <section className="lexora-stats" aria-label="Statistiques des leçons">
        <div className="lexora-card"><p className="lexora-statlabel">Leçons disponibles</p><p className="lexora-statvalue">{ready.length}</p></div>
        <div className="lexora-card"><p className="lexora-statlabel">Erreurs enregistrées</p><p className="lexora-statvalue">{lessons.length}</p></div>
        <div className="lexora-card"><p className="lexora-statlabel">À générer</p><p className="lexora-statvalue">{lessons.length-ready.length}</p></div>
      </section>
      {lessons.length === 0 ? <section className="lexora-hero"><div><h2>Votre première leçon vous attend</h2><p className="lexora-muted">Lors d’un entraînement, le coach analysera vos erreurs et préparera une fiche adaptée.</p></div><a className="lexora-primary" href="#/practice/part5">Commencer un exercice →</a></section> :
        <section className="lexora-lesson-list" aria-label="Leçons personnalisées">
          {lessons.map(l => <article key={l.id} className="lexora-card lexora-lesson">
            <button type="button" className="lexora-lesson-toggle" aria-expanded={expanded === l.id} onClick={() => setExpanded(expanded === l.id ? null : l.id)}>
              <span><span className="lexora-partno">Partie {l.part} · {l.topic}</span><strong>{l.title}</strong></span><span aria-hidden="true">{expanded === l.id ? "−" : "+"}</span>
            </button>
            {expanded === l.id && (l.status === "ready" ? <div className="lexora-lesson-content">
              <h3>La règle à retenir</h3><p>{l.rule}</p>
              <h3>Exemple expliqué</h3><p>{l.example}</p>
              <h3>À vous de jouer</h3><p>{l.exercise}</p>
              <details><summary>Voir la correction</summary><p>{l.answer}</p></details>
              <h3>Astuce du coach</h3><p>{l.tip}</p>
              <a className="lexora-secondary" href={`#/review/part${l.part}`}>Réviser mes erreurs →</a>
            </div> : <p className="lexora-muted">{l.status === "pending" ? "Génération en cours : revenez ici après l'explication du coach." : "Le coach n’a pas pu générer cette leçon. Vérifiez la configuration de la clé DeepSeek puis reprenez cette question en révision."}</p>)}
          </article>)}
        </section>}
    </main>
  </div>;
}
