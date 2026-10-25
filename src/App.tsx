import "@/pages/phase2.css";
import { useEffect, useRef, useState } from "react";
import type { Part } from "@/lib/types";
import { SettingsProvider } from "@/lib/SettingsContext";
import { AuthProvider } from "@/lib/AuthContext";
import SettingsModal from "@/components/SettingsModal";
import AuthModal from "@/components/AuthModal";
import Dashboard from "@/pages/Dashboard";
import Practice from "@/pages/Practice";
import Diagnostic from "@/pages/Diagnostic";
import Admin from "@/pages/Admin";
import Lessons from "@/pages/Lessons";
import Exam from "@/pages/Exam";
import Stats from "@/pages/Stats";
import Review from "@/pages/Review";
import Listening from "@/pages/Listening";
import Vocab from "@/pages/Vocab";
import Goals from "@/pages/Goals";
import Adaptive from "@/pages/Adaptive";
import { initSync } from "@/lib/sync";
import OfflineBanner from "@/components/OfflineBanner";
import { migrateLegacyMistakes } from "@/lib/tracker";

let started = false;
function startTracking() {
  if (started) return;
  started = true;
  migrateLegacyMistakes();
  initSync();
}

const TITLES: [RegExp, string][] = [
  [/^#\/practice\//, "Entraînement"],
  [/^#\/review/, "Révision"],
  [/^#\/adaptive/, "Entraînement adaptatif"],
  [/^#\/exam/, "Examen blanc"],
  [/^#\/stats/, "Statistiques"],
  [/^#\/vocab/, "Mes mots"],
  [/^#\/goals/, "Mon objectif"],
  [/^#\/lessons/, "Mes leçons"],
  [/^#\/diagnostic/, "Diagnostic"],
  [/^#\/listening/, "Listening · Partie 2"],
  [/^#\/admin/, "Administration"],
];

/** Titre de page et focus du contenu à chaque changement de page (lecteurs d'écran, clavier). */
function useRouteAnnouncements(hash: string, firstRender: { current: boolean }) {
  useEffect(() => {
    const title = TITLES.find(([pattern]) => pattern.test(hash))?.[1];
    document.title = title ? `${title} — Lernoviq` : "Lernoviq — Coach TOEIC";
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const main = document.querySelector<HTMLElement>("main");
    main?.setAttribute("tabindex", "-1");
    main?.focus({ preventScroll: false });
  }, [hash, firstRender]);
}

function SkipLink() {
  return (
    <a
      href="#contenu"
      className="lexora-skip"
      onClick={(event) => {
        event.preventDefault();
        const main = document.querySelector<HTMLElement>("main");
        main?.setAttribute("tabindex", "-1");
        main?.focus();
      }}
    >
      Aller au contenu
    </a>
  );
}

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const firstRender = useRef(true);
  useEffect(startTracking, []);
  useRouteAnnouncements(hash, firstRender);
  const match = hash.match(/^#\/practice\/(part[567])(\?.*)?$/);
  const reviewMatch = hash.match(/^#\/review\/(part[567])$/);
  const content = hash === "#/lessons" ? (
    <Lessons />
  ) : hash === "#/exam" ? (
    <Exam />
  ) : hash === "#/stats" ? (
    <Stats />
  ) : hash === "#/listening/part2" ? (
    <Listening />
  ) : hash === "#/goals" ? (
    <Goals />
  ) : hash === "#/vocab" ? (
    <Vocab />
  ) : hash === "#/review" ? (
    <Review />
  ) : hash === "#/adaptive" ? (
    <Adaptive />
  ) : hash === "#/admin" ? (
    <Admin />
  ) : hash === "#/diagnostic" ? (
    <Diagnostic />
  ) : reviewMatch ? (
    <Practice part={Number(reviewMatch[1].replace("part", "")) as Part} reviewMode />
  ) : match && match[1] ? (
    <Practice part={Number(match[1].replace("part", "")) as Part} search={match[2] ?? ""} />
  ) : (
    <Dashboard />
  );
  return (
    <SettingsProvider>
      <AuthProvider>
        <SkipLink />
        {content}
        <OfflineBanner />
        <SettingsModal />
        <AuthModal />
      </AuthProvider>
    </SettingsProvider>
  );
}
