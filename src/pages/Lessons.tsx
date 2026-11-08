import { lazy, Suspense, useState } from "react";
import TopNav from "@/components/TopNav";
import "./lexora.css";

const WordFormLesson = lazy(() => import("@/components/WordFormLesson"));
const LinkingWordsLesson = lazy(() => import("@/components/LinkingWordsLesson"));

const LESSONS = [
  { id: "word-families", tag: "Cours · Grammaire", title: "Word families — Les familles de mots",
    intro: "Choisir la bonne forme d’un mot (nom, adjectif, verbe, adverbe) : le cours, puis des exercices pour vous entraîner.", Component: WordFormLesson },
  { id: "linking-words", tag: "Cours · Vocabulaire", title: "Linking words — Les mots de liaison",
    intro: "Relier les idées : précision, but, résultat, exemple, temps, comparaison, degré. Le cours, puis des exercices pour vous entraîner.", Component: LinkingWordsLesson },
];

export default function Lessons() {
  const [current, setCurrent] = useState(0);
  const lesson = LESSONS[current];
  const Lesson = lesson.Component;
  return <div className="lexora-page">
    <TopNav active="lessons" />
    <main className="lexora-shell lexora-content">
      <p className="lexora-eyebrow">{lesson.tag}</p>
      <h1 className="lexora-heading">{lesson.title}</h1>
      <p className="lexora-muted">{lesson.intro}</p>
      <div className="lexora-wf-options" role="tablist" aria-label="Choisir une leçon" style={{ marginTop: 20 }}>
        {LESSONS.map((l, i) => <button key={l.id} type="button" role="tab" aria-selected={i === current}
          className={`lexora-wf-opt${i === current ? " is-right" : ""}`} onClick={() => setCurrent(i)}>{l.title.split(" — ")[0]}</button>)}
      </div>
      <article className="lexora-card lexora-lesson" style={{ marginTop: 20 }}>
        <Suspense fallback={<p className="lexora-muted" role="status">Chargement…</p>}><Lesson key={lesson.id} /></Suspense>
      </article>
    </main>
  </div>;
}
