import { useState } from "react";
import type { FillItem, McqItem } from "@/lib/wordFormLesson";

export type FillGroup = { label: string; items: FillItem[] };

const LETTERS = ["A", "B", "C", "D"];

export function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return <div className="lexora-wf-scroll"><table className="lexora-wf-table">
    <thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead>
    <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, i) => <td key={i}>{i === 0 ? <strong>{c}</strong> : c}</td>)}</tr>)}</tbody>
  </table></div>;
}

export function Mcq({ item, n }: { item: McqItem; n: number }) {
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

export function McqSet({ items }: { items: McqItem[] }) {
  const [round, setRound] = useState(0);
  return <>
    <ol className="lexora-wf-list" key={round}>{items.map((q, i) => <Mcq key={i} item={q} n={i + 1} />)}</ol>
    <div className="lexora-wf-score"><button type="button" className="lexora-secondary" onClick={() => setRound(k => k + 1)}>Recommencer</button></div>
  </>;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");

export function FillExercise({ groups }: { groups: FillGroup[] }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const ok = (key: string, answers: string[]) => answers.map(norm).includes(norm(vals[key] ?? ""));
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const score = groups.reduce((n, g, gi) => n + g.items.filter((it, ii) => ok(`${gi}-${ii}`, it.answers)).length, 0);
  return <div>
    <ol className="lexora-wf-list">
      {groups.map((g, gi) => <li key={gi} className="lexora-wf-item">
        <p className="lexora-wf-prompt"><span className="lexora-wf-num">{gi + 1}.</span> {g.label}</p>
        {g.items.map((it, ii) => {
          const key = `${gi}-${ii}`;
          const good = ok(key, it.answers);
          return <div key={key} className="lexora-wf-fill">
            {it.before && <span>{it.before}</span>}
            <input type="text" value={vals[key] ?? ""} disabled={checked} autoCapitalize="off" autoCorrect="off" spellCheck={false}
              aria-label={`Phrase ${gi + 1}${g.items.length > 1 ? `.${ii + 1}` : ""}`}
              className={`lexora-wf-input${checked ? (good ? " is-right" : " is-wrong") : ""}`}
              onChange={e => setVals(v => ({ ...v, [key]: e.target.value }))} />
            {it.after && <span>{it.after}</span>}
            {checked && !good && <span className="lexora-wf-answer">→ {it.answers.join(" / ")}</span>}
          </div>;
        })}
      </li>)}
    </ol>
    <div className="lexora-wf-score">
      {checked && <span>Score : {score} / {total}</span>}
      {!checked
        ? <button type="button" className="lexora-primary" onClick={() => setChecked(true)}>Vérifier mes réponses</button>
        : <button type="button" className="lexora-secondary" onClick={() => { setVals({}); setChecked(false); }}>Recommencer</button>}
    </div>
  </div>;
}
