// En-têtes de sécurité HTTP, partagés entre Express (server.mjs) et Vercel
// (vercel.json, qui doit rester identique : voir tests/security-headers.test.mjs).
//
// La CSP limite l'impact d'une éventuelle XSS (la clé DeepSeek et les jetons
// Supabase sont lisibles par tout script exécuté dans la page) : scripts de la
// même origine uniquement, aucune connexion sortante hors Supabase.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Plausible (mesure d'audience facultative, sans cookie) : voir README. Retirer les deux
  // occurrences de plausible.io si la mesure n'est pas utilisée.
  "script-src 'self' https://plausible.io",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' https://*.supabase.co",
  "connect-src 'self' https://*.supabase.co https://plausible.io",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** Middleware Express : pose les en-têtes sur toutes les réponses. */
export function securityHeaders(_req, res, next) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}
