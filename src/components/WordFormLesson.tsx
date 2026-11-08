import { useMemo, useState } from "react";
import { RECIPE, SERIES, WORD_CLASSES, type QuizSeries } from "@/lib/wordFormLesson";

function Quiz({ series }: { series: QuizSeries }) {
  const [picked, setPicked] = useState<Record<number, string>>({});
  // On fait tourner les options pour que la bonne réponse ne soit pas toujours à la même place.
  const rows = useMemo(() => series.items.map((it, i) => {
    if (!series.id.startsWith("form")) return it;
    const r = i % it.options.length;
    return { ...it, options: [...it.options.slice(r), ...it.options.slice(0, r)] };
  }), [series]);
  const answered = Object.keys(picked).length;
  const score = rows.reduce((n, it, i) => n + (picked[i] === it.answer ? 1 : 0), 0);
  const done = answered === rows.length;
  return <section className="lexora-wf-quiz" aria-label={series.title}>
    <h3>{series.title}</h3>
    <p className="lexora-muted">{series.intro}</p>
    <ol className="lexora-wf-list">
      {rows.map((it, i) => {
        const choice = picked[i];
        return <li key={i} className="lexora-wf-item">
          <p className="lexora-wf-prompt">{it.prompt}</p>
          <div className="lexora-wf-options" role="group" aria-label={`Question ${i + 1}`}>
            {it.options.map(o => {
              const state = !choice ? "" : o === it.answer ? " is-right" : o === choice ? " is-wrong" : "";
              return <button key={o} type="button" className={`lexora-wf-opt${state}`} disabled={!!choice}
                onClick={() => setPicked(p => ({ ...p, [i]: o }))}>{o}</button>;
            })}
          </div>
          {choice && <p className="lexora-wf-why" role="status">
            <strong>{choice === it.answer ? "Correct. " : `Réponse : ${it.answer}. `}</strong>{it.why}
          </p>}
        </li>;
      })}
    </ol>
    <div className="lexora-wf-score">
      <span>{done ? `Score : ${score} / ${rows.length}` : `${answered} / ${rows.length} répondues`}</span>
      {answered > 0 && <button type="button" className="lexora-secondary" onClick={() => setPicked({})}>Recommencer</button>}
    </div>
  </section>;
}

export default function WordFormLesson() {
  return <div className="lexora-lesson-content lexora-wf">
    <p>Au TOEIC (partie 5), beaucoup de phrases proposent <strong>quatre formes du même mot</strong> (ex. <em>decide, decision, decisive, decisively</em>). Il ne faut pas traduire : il faut trouver la <strong>nature</strong> du mot attendu grâce à sa place dans la phrase.</p>

    <h3>La méthode en 3 étapes</h3>
    <ol>
      <li>Repérez le mot juste avant et juste après le trou.</li>
      <li>Déduisez la nature attendue (nom, verbe, adjectif ou adverbe).</li>
      <li>Choisissez la forme qui a la bonne terminaison.</li>
    </ol>

    <h3>Les 4 natures : structures et terminaisons</h3>
    <div className="lexora-wf-grid">
      {WORD_CLASSES.map(c => <article key={c.id} className={`lexora-wf-card wf-${c.id}`}>
        <h4>{c.label}</h4>
        <p className="lexora-wf-role">{c.role}</p>
        <p className="lexora-wf-sub">Terminaisons typiques</p>
        <ul>{c.suffixes.map(s => <li key={s.suffix}><code>{s.suffix}</code> {s.examples}</li>)}</ul>
        <p className="lexora-wf-sub">Où le trouve-t-on ?</p>
        <ul>{c.positions.map(p => <li key={p}>{p}</li>)}</ul>
        {c.trap && <p className="lexora-wf-trap"><strong>Piège.</strong> {c.trap}</p>}
      </article>)}
    </div>

    <h3>Aide-mémoire : la place du trou</h3>
    <table className="lexora-wf-table">
      <thead><tr><th>Structure</th><th>Nature attendue</th></tr></thead>
      <tbody>{RECIPE.map(r => <tr key={r.clue}><td>{r.clue}</td><td><strong>{r.answer}</strong></td></tr>)}</tbody>
    </table>

    <h3>Exemple pas à pas</h3>
    <p>« The ___ of the new building will take two years. » (construct / construction / constructive / constructively)<br />
      Avant le trou : <em>The</em> (article). Après : <em>of</em> (préposition). Il faut un <strong>nom</strong> → <strong>construction</strong> (terminaison -tion).</p>

    {SERIES.map(s => <Quiz key={s.id} series={s} />)}
  </div>;
}
