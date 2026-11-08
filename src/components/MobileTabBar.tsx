import { useEffect, useState } from "react";
import { DATA_EVENT, dueNow } from "@/lib/tracker";
import "@/pages/mobile.css";

type TabId = "home" | "lessons" | "review" | "vocab" | "stats";

const TABS: { id: TabId; label: string; href: string; icon: JSX.Element }[] = [
  { id: "home", label: "Accueil", href: "#/", icon: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /> },
  { id: "lessons", label: "Leçons", href: "#/lessons", icon: <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 21V5M19 19v2H6" /></> },
  { id: "review", label: "Révisions", href: "#/review", icon: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 8v4l3 2" /></> },
  { id: "vocab", label: "Mes mots", href: "#/vocab", icon: <><rect x="3" y="5" width="14" height="16" rx="2" /><path d="M7 3h12a2 2 0 0 1 2 2v12" /></> },
  { id: "stats", label: "Progrès", href: "#/stats", icon: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /> },
];

/** Onglet actif selon l'adresse, ou null si la page est en « mode focus » (barre masquée). */
export function tabForHash(hash: string): TabId | null {
  if (hash === "" || hash === "#" || hash === "#/") return "home";
  if (/^#\/(practice|adaptive|exam|diagnostic|listening|admin)/.test(hash)) return null;
  if (hash.startsWith("#/lessons")) return "lessons";
  if (hash.startsWith("#/review")) return "review";
  if (hash.startsWith("#/vocab")) return "vocab";
  if (hash.startsWith("#/stats")) return "stats";
  if (hash.startsWith("#/goals")) return "home";
  return "home";
}

/**
 * Barre d'onglets du bas pour téléphone (≤ 700 px, voir mobile.css).
 * Masquée pendant les exercices, l'examen et le diagnostic pour ne pas distraire.
 */
export default function MobileTabBar({ hash }: { hash: string }) {
  const [due, setDue] = useState(0);
  const active = tabForHash(hash);

  useEffect(() => {
    const refresh = () => setDue(dueNow().length);
    refresh();
    window.addEventListener(DATA_EVENT, refresh);
    return () => window.removeEventListener(DATA_EVENT, refresh);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("has-tabbar", active !== null);
    return () => document.body.classList.remove("has-tabbar");
  }, [active]);

  if (active === null) return null;
  return (
    <nav className="lexora-tabbar" aria-label="Navigation principale (téléphone)">
      {TABS.map((tab) => (
        <a key={tab.id} href={tab.href} className="lexora-tab" aria-current={tab.id === active ? "page" : undefined}>
          <span className="lexora-tab-icon">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{tab.icon}</svg>
            {tab.id === "review" && due > 0 && <span className="lexora-tab-badge" aria-label={`${due} à réviser`}>{due > 99 ? "99+" : due}</span>}
          </span>
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
