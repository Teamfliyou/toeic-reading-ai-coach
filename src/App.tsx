import { useEffect, useState } from "react";
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
import { initSync } from "@/lib/sync";
import { migrateLegacyMistakes } from "@/lib/tracker";

let started = false;
function startTracking() {
  if (started) return;
  started = true;
  migrateLegacyMistakes();
  initSync();
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
  useEffect(startTracking, []);
  const match = hash.match(/^#\/practice\/(part[567])$/);
  const reviewMatch = hash.match(/^#\/review\/(part[567])$/);
  const content = hash === "#/lessons" ? (
    <Lessons />
  ) : hash === "#/exam" ? (
    <Exam />
  ) : hash === "#/stats" ? (
    <Stats />
  ) : hash === "#/listening/part2" ? (
    <Listening />
  ) : hash === "#/vocab" ? (
    <Vocab />
  ) : hash === "#/review" ? (
    <Review />
  ) : hash === "#/admin" ? (
    <Admin />
  ) : hash === "#/diagnostic" ? (
    <Diagnostic />
  ) : reviewMatch ? (
    <Practice part={Number(reviewMatch[1].replace("part", "")) as Part} reviewMode />
  ) : match && match[1] ? (
    <Practice part={Number(match[1].replace("part", "")) as Part} />
  ) : (
    <Dashboard />
  );
  return (
    <SettingsProvider>
      <AuthProvider>
        {content}
        <SettingsModal />
        <AuthModal />
      </AuthProvider>
    </SettingsProvider>
  );
}
