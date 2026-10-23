/** Enregistre le service worker (production uniquement : il gênerait le rechargement à chaud). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* L'application fonctionne sans service worker (pas de mode hors ligne). */
    });
  });
}
