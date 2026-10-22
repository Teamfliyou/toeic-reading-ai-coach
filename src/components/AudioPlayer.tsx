import { useEffect, useRef, useState } from "react";
import { speechScript, type ListeningItem } from "@/lib/listening";
import { canSpeak, speakSequence } from "@/lib/speech";

type Phase = "ready" | "playing" | "done" | "error";

/**
 * Lecteur à écoute unique : comme à l'examen, l'enregistrement ne se rejoue pas.
 * Utilise le fichier `item.audio` s'il existe, sinon la synthèse vocale du navigateur.
 * `onUnavailable` est appelé si aucun son ne peut être produit (l'élève peut alors
 * passer en mode lecture).
 */
export default function AudioPlayer({
  item,
  onHeard,
  onUnavailable,
}: {
  item: ListeningItem;
  onHeard: () => void;
  onUnavailable: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const supported = Boolean(item.audio) || canSpeak();

  // Arrêt du son quand on quitte la question ou la page.
  useEffect(
    () => () => {
      stopRef.current?.();
      audioRef.current?.pause();
    },
    []
  );

  const fail = () => {
    setPhase("error");
    onUnavailable();
  };
  const finished = () => {
    setPhase("done");
    onHeard();
  };

  const play = () => {
    if (phase !== "ready") return;
    setPhase("playing");
    if (item.audio) {
      const el = audioRef.current;
      if (!el) return fail();
      el.play().catch(fail);
    } else {
      stopRef.current = speakSequence(speechScript(item), finished, fail);
    }
  };

  if (!supported) {
    return (
      <div className="lexora-player" role="alert">
        <span>Aucun son disponible dans ce navigateur.</span>
        <button type="button" className="lexora-secondary" onClick={onUnavailable}>Passer en mode lecture</button>
      </div>
    );
  }

  return (
    <div className="lexora-player">
      <button type="button" className="lexora-primary" onClick={play} disabled={phase !== "ready"}>
        {phase === "ready" ? "▶ Écouter (une seule lecture)" : phase === "playing" ? "Lecture en cours…" : phase === "done" ? "Écoute terminée" : "Lecture impossible"}
      </button>
      <span className="lexora-subtle" role="status" aria-live="polite">
        {phase === "ready" && "Comme à l'examen, l'audio ne peut pas être rejoué."}
        {phase === "playing" && "Écoutez l'énoncé puis les trois réponses A, B, C."}
        {phase === "done" && "Choisissez la réponse la plus adaptée."}
        {phase === "error" && "Le son n'a pas pu démarrer."}
      </span>
      {item.audio && <audio ref={audioRef} src={item.audio} preload="auto" onEnded={finished} onError={fail} />}
    </div>
  );
}
