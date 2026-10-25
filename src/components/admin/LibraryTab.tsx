import { useEffect, useState } from "react";
import type { Filters } from "@/lib/bank/types";
import ImportWizard from "./ImportWizard";
import LibraryQuestions from "./LibraryQuestions";
import LibraryStats from "./LibraryStats";
import "./bank.css";

type View = "questions" | "import" | "stats";
const VIEWS: { id: View; label: string }[] = [
  { id: "questions", label: "Questions" },
  { id: "import", label: "Importer des exercices" },
  { id: "stats", label: "Statistiques et doublons" },
];

/** Bibliothèque : questions, importation massive, statistiques du catalogue. */
export default function LibraryTab({ isAdmin, initialFilters, nonce }: { isAdmin: boolean; initialFilters?: Filters; nonce: number }) {
  const [view, setView] = useState<View>(initialFilters ? "questions" : "questions");
  const [filters, setFilters] = useState<Filters | undefined>(initialFilters);
  const [version, setVersion] = useState(nonce);

  // Une demande venant d'un autre onglet (rapport d'import, génération) rouvre la liste filtrée.
  useEffect(() => {
    setFilters(initialFilters);
    setVersion(nonce);
    if (initialFilters) setView("questions");
  }, [initialFilters, nonce]);

  const openLibrary = (next: Filters) => {
    setFilters(next);
    setVersion((v) => v + 1);
    setView("questions");
  };

  return (
    <div>
      <nav className="bank-tabs" aria-label="Bibliothèque">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" className="lexora-secondary" aria-current={view === v.id ? "page" : undefined} onClick={() => setView(v.id)}>{v.label}</button>
        ))}
      </nav>
      {view === "questions" && <LibraryQuestions key={version} isAdmin={isAdmin} initialFilters={filters} />}
      {view === "import" && <ImportWizard onOpenLibrary={openLibrary} />}
      {view === "stats" && <LibraryStats />}
    </div>
  );
}
