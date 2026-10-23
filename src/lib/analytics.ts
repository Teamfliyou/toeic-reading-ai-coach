// Mesure d'audience respectueuse de la vie privée (Plausible), facultative.
//
// Désactivée tant que VITE_PLAUSIBLE_DOMAIN n'est pas défini. Plausible n'utilise
// ni cookie ni identifiant personnel ; le script « hash » suit les changements de
// page de notre routage par #. Le signal « Do Not Track » du navigateur est respecté.
// Aucune donnée personnelle (e-mail, réponses, clé API) n'est jamais transmise.

export interface AnalyticsConfig {
  domain: string;
  src: string;
}

export const DEFAULT_PLAUSIBLE_SRC = "https://plausible.io/js/script.hash.js";

/** Détermine la configuration à partir de l'environnement ; `null` si la mesure est désactivée. */
export function resolveAnalytics(
  env: { domain?: string; src?: string },
  doNotTrack = false
): AnalyticsConfig | null {
  const domain = (env.domain ?? "").trim().toLowerCase();
  if (!domain || doNotTrack) return null;
  // Nom de domaine simple, sans schéma ni chemin (évite toute injection dans l'attribut).
  if (!/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return null;
  const src = (env.src ?? "").trim() || DEFAULT_PLAUSIBLE_SRC;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { domain, src };
}

/** Ajoute le script Plausible à la page si la mesure est activée. */
export function initAnalytics() {
  const dnt = navigator.doNotTrack === "1" || (window as { doNotTrack?: string }).doNotTrack === "1";
  const config = resolveAnalytics(
    {
      domain: import.meta.env.VITE_PLAUSIBLE_DOMAIN as string | undefined,
      src: import.meta.env.VITE_PLAUSIBLE_SRC as string | undefined,
    },
    dnt
  );
  if (!config || document.querySelector("script[data-plausible]")) return;
  const script = document.createElement("script");
  script.defer = true;
  script.src = config.src;
  script.dataset.domain = config.domain;
  script.dataset.plausible = "true";
  document.head.appendChild(script);
}
