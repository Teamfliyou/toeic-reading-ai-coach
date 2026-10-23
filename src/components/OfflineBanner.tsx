import "@/pages/phase2.css";
import { useOnline } from "@/lib/online";

/** Bandeau affiché hors connexion : les exercices restent accessibles, pas le coach IA. */
export default function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="lexora-offline" role="status" aria-live="polite">
      <strong>Hors connexion.</strong> Les exercices restent disponibles ; les explications du coach IA reprendront dès le retour du réseau.
    </div>
  );
}
