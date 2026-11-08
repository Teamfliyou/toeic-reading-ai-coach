import {
  CLUES, EXAMPLE_QUESTION, FAMILY_EXAMPLE, FILL_FAMILIES, MCQ, NATURES, REVIEW, STRATEGY,
} from "@/lib/wordFormLesson";
import { FillExercise, Mcq, McqSet, Table } from "./lessonParts";

export default function WordFormLesson() {
  return <div className="lexora-lesson-content lexora-wf">
    <h3>1. Présentation</h3>
    <p>En anglais, un même radical peut donner des mots de <strong>natures grammaticales différentes</strong>. Dans les questions de <em>word families</em>, il faut choisir la forme qui convient à la phrase.</p>
    <Table head={["Nature", "Exemple"]} rows={FAMILY_EXAMPLE} />

    <h4>Exemple de question</h4>
    <ol className="lexora-wf-list"><Mcq item={EXAMPLE_QUESTION} n={1} /></ol>
    <p className="lexora-wf-trap"><strong>Astuce :</strong> on peut souvent déterminer la réponse en repérant la nature grammaticale du mot manquant, même sans comprendre toute la phrase.</p>

    <h3>2. Les quatre natures grammaticales</h3>
    {NATURES.map(n => <section key={n.id} className="lexora-wf-nature">
      <h4>{n.title}</h4>
      <p>{n.definition} <strong>Exemples :</strong> <em>{n.examples}</em>.</p>
      {n.table && <Table head={n.table.head} rows={n.table.rows} />}
      {n.notes.map(t => <p key={t} className="lexora-wf-trap">{t}</p>)}
    </section>)}

    <h3>3. Stratégie pour réussir</h3>
    <ol>{STRATEGY.map(s => <li key={s}>{s}</li>)}</ol>
    <h4>Repères pratiques</h4>
    <Table head={["Indice dans la phrase", "Forme souvent attendue"]} rows={CLUES} />
    <p className="lexora-wf-trap">Ces repères sont des <strong>indices</strong>, pas des règles absolues.</p>

    <h3>Entraînement</h3>
    <section className="lexora-wf-quiz">
      <h4>Exercice 1 — Compléter avec la bonne forme du mot</h4>
      <p className="lexora-muted">Pour chaque famille, complétez les deux phrases avec la forme qui convient (en anglais).</p>
      <FillExercise groups={FILL_FAMILIES.map(f => ({ label: f.word, items: f.items }))} />
    </section>

    <section className="lexora-wf-quiz">
      <h4>Exercice 2 — Questions à choix multiples</h4>
      <McqSet items={MCQ} />
    </section>

    <h3>Fiche de révision rapide</h3>
    <Table head={["Nature", "Rôle", "Suffixes fréquents", "Exemple"]} rows={REVIEW} />
    <p><strong>Méthode à retenir : identifier d'abord la fonction du mot manquant, puis choisir la bonne forme.</strong></p>
  </div>;
}
