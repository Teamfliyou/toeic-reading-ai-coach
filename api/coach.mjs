import { handleCoach } from "../server/coach.mjs";

// Même enveloppe de protection que /api/explain (voir handleAiEndpoint).
export default async function handler(req, res) {
  return handleCoach(req, res);
}
