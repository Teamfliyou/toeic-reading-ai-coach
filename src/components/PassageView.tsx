import type { Passage } from "@/lib/types";

const KIND_LABELS: Record<string, string> = {
  email: "E-mail",
  memo: "Note interne",
  article: "Article",
  notice: "Avis",
  schedule: "Programme",
  letter: "Lettre",
  message: "Message",
};

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="chip uppercase tracking-wide">
      {KIND_LABELS[kind] ?? kind}
    </span>
  );
}

export default function PassageView({ passage }: { passage: Passage }) {
  return (
    <div className="flex flex-col gap-4">
      {passage.documents.map((doc) => (
        <article key={doc.id} className="glass animate-fade-up p-5 sm:p-6">
          <div className="mb-3 flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold text-white/90">{doc.title}</h3>
            <KindBadge kind={doc.kind} />
          </div>
          {doc.kind === "schedule" ? (
            <ul className="space-y-2">
              {doc.body.map((line, i) => (
                <li
                  key={i}
                  className="flex items-baseline gap-3 rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-white/80"
                >
                  {line}
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-3 text-[15px] leading-relaxed text-white/85">
              {doc.body.map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
