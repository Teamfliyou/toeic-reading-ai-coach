import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleExplain, handleHealth } from "./server/explain.mjs";
import { handleAdmin } from "./server/admin.mjs";
import { securityHeaders } from "./server/security-headers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Derrière un reverse proxy, définir TRUST_PROXY=true pour lire l'IP réelle du client.
app.disable("x-powered-by");
app.use(securityHeaders);

app.get("/api/health", handleHealth);
app.all("/api/admin", handleAdmin);
app.post("/api/explain", handleExplain);

const distDir = join(__dirname, "dist");
app.use(express.static(distDir));
app.get("*", (_req, res) => res.sendFile(join(distDir, "index.html")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`TOEIC Reading AI Coach : http://localhost:${port}`);
});
