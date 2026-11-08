import AuthButton from "@/components/AuthButton";
import SettingsButton from "@/components/SettingsButton";
import { currentStreak } from "@/lib/stats";
import { myAttempts } from "@/lib/tracker";

export type NavId = "home" | "practice" | "exam" | "review" | "lessons" | "vocab" | "stats" | "none";

const ITEMS: { id: NavId; label: string; href: string }[] = [
  { id: "home", label: "Accueil", href: "#/" },
  { id: "practice", label: "S'entraîner", href: "#/adaptive" },
  { id: "exam", label: "Examen blanc", href: "#/exam" },
  { id: "review", label: "Révisions", href: "#/review" },
  { id: "lessons", label: "Leçons", href: "#/lessons" },
  { id: "vocab", label: "Mes mots", href: "#/vocab" },
  { id: "stats", label: "Statistiques", href: "#/stats" },
];

/** Barre de navigation commune à toutes les pages (design Lernoviq). */
export default function TopNav({ active = "none" }: { active?: NavId }) {
  const streak = currentStreak(myAttempts());
  return (
    <header className="lexora-nav">
      <div className="lexora-shell lexora-nav-inner">
        <a href="#/" className="lexora-brand">
          <span className="lexora-mark">L</span>
          <span>Lernoviq</span>
        </a>
        <nav aria-label="Navigation principale" className="lexora-nav-scroll">
          <div className="lexora-nav-pills">
            {ITEMS.map((item) => (
              <a
                key={item.id}
                href={item.href}
                className="lexora-nav-pill"
                aria-current={item.id === active ? "page" : undefined}
              >
                {item.label}
              </a>
            ))}
          </div>
        </nav>
        <div className="lexora-navright">
          <span className="lexora-streak" title="Série en cours">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C5F04A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 2 1.5 3 2.5 3 0-3-1-6 .5-9.5z" /></svg>
            {streak} jour{streak > 1 ? "s" : ""}
          </span>
          <AuthButton />
          <SettingsButton />
        </div>
      </div>
    </header>
  );
}
