// Tâche planifiée facultative : fait avancer les générations en attente sans navigateur ouvert.
// Vercel appelle cette route avec « Authorization: Bearer <CRON_SECRET> » lorsque la variable
// CRON_SECRET est définie. Sans CRON_SECRET, la route répond 404 (désactivée).
// Voir README → « Génération massive » pour ajouter l'entrée `crons` dans vercel.json (plan Pro :
// toutes les minutes ; plan Hobby : une fois par jour seulement — l'interface suffit alors).
import { timingSafeEqual } from "node:crypto";
import { runDue } from "../server/bank/generation.mjs";

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return null;
  const received = String(req.headers.authorization || "");
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const ok = authorized(req);
  if (ok === null) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "Non configuré" }));
  }
  if (!ok) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "Non autorisé" }));
  }
  try {
    const out = await runDue({ budgetMs: Number(process.env.GEN_CRON_BUDGET_MS) || 45_000, worker: "cron" });
    res.statusCode = 200;
    res.end(JSON.stringify(out));
  } catch (error) {
    console.warn("Cron de génération :", error?.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Échec de la tâche planifiée" }));
  }
}
