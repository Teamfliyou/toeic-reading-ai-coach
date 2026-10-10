import { useEffect, useState } from "react";
import type { Part } from "@/lib/types";
import { SettingsProvider } from "@/lib/SettingsContext";
import SettingsModal from "@/components/SettingsModal";
import Dashboard from "@/pages/Dashboard";
import Practice from "@/pages/Practice";

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

  const match = hash.match(/^#\/practice\/(part[567])$/);
  const reviewMatch = hash.match(/^#\\/review\\/(part[567])$/);
  const content =
    reviewMatch ? (
      <Practice part={Number(reviewMatch[1].replace("part", "")) as Part} reviewMode />
    ) : match && match[1] ? (
      <Practice part={Number(match[1].replace("part", "")) as Part} />
    ) : (
      <Dashboard />
    );

  return (
    <SettingsProvider>
      {content}
      <SettingsModal />
    </SettingsProvider>
  );
}
