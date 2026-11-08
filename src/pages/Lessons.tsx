import { lazy, Suspense } from "react";
import TopNav from "@/components/TopNav";
import "./lexora.css";

const WordFormLesson = lazy(() => import("@/components/WordFormLesson"));

export default function Lessons() {
  return <div className="lexora-page">
    <TopNav active="lessons" />
    <main className="lexora-shell lexora-content">
      <p className="lexora-eyebrow">Cours · Partie 5 · Grammaire</p>
      <h1 className="lexora-heading">Nom, verbe, adjectif ou adverbe ?</h1>
      <p className="lexora-muted">Apprenez à choisir la bonne forme d’un mot : le cours, puis des exercices pour vous entraîner.</p>
      <article className="lexora-card lexora-lesson" style={{ marginTop: 28 }}>
        <Suspense fallback={<p className="lexora-muted" role="status">Chargement…</p>}><WordFormLesson /></Suspense>
      </article>
    </main>
  </div>;
}
