import { FILL_1, FILL_2, LINK_MCQ, LINK_SECTIONS } from "@/lib/linkingWordsLesson";
import { FillExercise, McqSet, Table } from "./lessonParts";

export default function LinkingWordsLesson() {
  return <div className="lexora-lesson-content lexora-wf">
    <h3>Fiche de cours</h3>
    <p>Les <em>linking words</em> permettent de relier des idées, de préciser une information, d'exprimer un but, une conséquence, une comparaison ou un rapport temporel.</p>
    {LINK_SECTIONS.map(s => <section key={s.title} className="lexora-wf-nature">
      <h4>{s.title}</h4>
      <Table head={["Mot de liaison", "Traduction", "Exemple"]} rows={s.rows} />
    </section>)}

    <h3>Entraînement</h3>
    <section className="lexora-wf-quiz">
      <h4>Exercice 1</h4>
      <p className="lexora-muted">Vous souvenez-vous des exemples ? Complétez avec le mot de liaison qui convient.</p>
      <FillExercise groups={FILL_1.map(it => ({ label: "", items: [it] }))} />
    </section>
    <section className="lexora-wf-quiz">
      <h4>Exercice 2</h4>
      <p className="lexora-muted">Complétez avec un mot de liaison qui convient (plusieurs réponses peuvent être possibles).</p>
      <FillExercise groups={FILL_2.map(it => ({ label: "", items: [it] }))} />
    </section>
    <section className="lexora-wf-quiz">
      <h4>Exercice 3 — Questions à choix multiples</h4>
      <McqSet items={LINK_MCQ} />
    </section>
  </div>;
}
