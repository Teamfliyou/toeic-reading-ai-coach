import { useState } from "react";
import {
  CLUES, EXAMPLE_QUESTION, FAMILY_EXAMPLE, FILL_FAMILIES, MCQ, NATURES, REVIEW, STRATEGY,
  type McqItem, type SuffixTable,
} from "@/lib/wordFormLesson";

const LETTERS = ["A", "B", "C", "D"];

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return <div className="lexora-wf-scroll"><table className="lexora-wf-table">
    <thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead>
    <tbody>{rows.map(r => <tr key={r[0]}>{r.map((c, i) => <td key={i}>{i === 0 ? <strong>{c}</strong> : c}</td>)}</tr>)}</tbody>
  </table></div>;
}

function SuffixTableView({ t }: { t: SuffixTable }) {
  return <Table head={t.head} rows={t.rows} />;
}

function Mcq({ item, n }: { item: McqItem; n: number }) {
  const [choice, setChoice] = useState<string | null>(null);
  return <li className="lexora-wf-item">
    <p className="lexora-wf-prompt"><span className="lexora-wf-num">Question {n}</span> {item.prompt}</p>
    <div className="lexora-wf-options" role="group" aria-label={`Question ${n}`}>
      {item.options.map((o, i) => {
        const state = !choice ? "" : o === item.answer ? " is-right" : o === choice ? " is-wrong" : "";
        return <button key={o} type="button" className={`lexora-wf-opt${state}`} disabled={!!choice} onClick={() => setChoice(o)}>
          ({LETTERS[i]}) {o}
        </button>;
      })}
    </div>
    {choice && <p className="lexora-wf-why" role="status">
      <strong>{choice === item.answer ? "Correct. " : `Correction : ${item.answer}. `}</strong>{item.why}
    </p>}
  </li>;
}

function norm(s: string) { return s.trim().toLowerCase(); }

function FillExercise() {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const keys = FILL_FAMILIES.flatMap((f, fi) => f.items.map((_, ii) => `${fi}-${ii}`));
  const ok = (key: string, answers: string[]) => answers.includes(norm(vals[key] ?? ""));
  const score = FILL_FAMILIES.reduce((n, f, fi) => n + f.items.filter((it, ii) => ok(`${fi}-${ii}`, it.answers)).length, 0);
  return <div>
    <ol className="lexora-wf-list">
      {FILL_FAMILIES.map((f, fi) => <li key={f.word} className="lexora-wf-item">
        <p className="lexora-wf-prompt"><span className="lexora-wf-num">{fi + 1}.</span> {f.word}</p>
        {f.items.map((it, ii) => {
          const key = `${fi}-${ii}`;
          const good = ok(key, it.answers);
          return <div key={key} className="lexora-wf-fill">
            <span>{it.before}</span>
            <input type="text" value={vals[key] ?? ""} disabled={checked} autoCapitalize="off" autoCorrect="off" spellCheck={false}
              aria-label={`${f.word}, phrase ${ii + 1}`}
              className={`lexora-wf-input${checked ? (good ? " is-right" : " is-wrong") : ""}`}
              onChange={e => setVals(v => ({ ...v, [key]: e.target.value }))} />
            {it.after && <span>{it.after}</span>}
            {checked && !good && <span className="lexora-wf-answer">→ {it.answers.join(" / ")}</span>}
          </div>;
        })}
      </li>)}
    </ol>
    <div className="lexora-wf-score">
      {checked && <span>Score : {score} / {keys.length}</span>}
      {!checked
        ? <button type="button" className="lexora-primary" onClick={() => setChecked(true)}>Vérifier mes réponses</button>
        : <button type="button" className="lexora-secondary" onClick={() => { setVals({}); setChecked(false); }}>Recommencer</button>}
    </div>
  </div>;
}

export default function WordFormLesson() {
  const [mcqKey, setMcqKey] = useState(0);
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
      {n.table && <SuffixTableView t={n.table} />}
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
      <FillExercise />
    </section>

    <section className="lexora-wf-quiz">
      <h4>Exercice 2 — Questions à choix multiples</h4>
      <ol className="lexora-wf-list" key={mcqKey}>{MCQ.map((q, i) => <Mcq key={i} item={q} n={i + 1} />)}</ol>
      <div className="lexora-wf-score"><button type="button" className="lexora-secondary" onClick={() => setMcqKey(k => k + 1)}>Recommencer</button></div>
    </section>

    <h3>Fiche de révision rapide</h3>
    <Table head={["Nature", "Rôle", "Suffixes fréquents", "Exemple"]} rows={REVIEW} />
    <p><strong>Méthode à retenir : identifier d'abord la fonction du mot manquant, puis choisir la bonne forme.</strong></p>
  </div>;
}
