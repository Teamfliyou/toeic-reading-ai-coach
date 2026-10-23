import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleExplain, handleHealth } from "./server/explain.mjs";
import { handleAdmin } from "./server/admin.mjs";
import { handleCoach } from "./server/coach.mjs";
import { handleReport } from "./server/report.mjs";
import { securityHeaders } from "./server/security-headers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Derrière un reverse proxy, définir TRUST_PROXY=true pour lire l'IP réelle du client.
app.disable("x-powered-by");
app.use(securityHeaders);

app.get("/api/health", handleHealth);
app.all("/api/admin", handleAdmin);
app.post("/api/explain", handleExplain);
app.post("/api/coach", handleCoach);
app.post("/api/report", handleReport);

const distDir = join(__dirname, "dist");
app.use(
  express.static(distDir, {
    // Le service worker doit toujours être revalidé pour que les mises à jour arrivent.
    setHeaders(res, filePath) {
      if (filePath.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
    },
  })
);
app.get("*", (_req, res) => res.sendFile(join(distDir, "index.html")));

if (!process.env.AI_USD_EUR_RATE) {
  console.warn("AI_USD_EUR_RATE non défini : taux USD→EUR fixe de 0,93 utilisé pour le budget. Pensez à le mettre à jour.");
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`TOEIC Reading AI Coach : http://localhost:${port}`);
});
