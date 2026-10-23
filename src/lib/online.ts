import { useEffect, useState } from "react";

/** État de la connexion réseau du navigateur, mis à jour en direct. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export const OFFLINE_AI_MESSAGE =
  "Les explications du coach IA sont indisponibles hors connexion. Vos exercices restent accessibles.";
