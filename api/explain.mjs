import { explainMistake, maskSecret } from "../server/explain.mjs";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { questionId, selectedKey } = body;
    if (typeof questionId !== "string" || !["A","B","C","D"].includes(selectedKey))
      return res.status(400).json({ error: "Question ou réponse invalide." });
    const rawKey = req.headers["x-deepseek-api-key"];
    const userKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const result = await explainMistake(questionId, selectedKey, userKey);
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur du serveur.";
    return res.status(500).json({ error: maskSecret(message) });
  }
}
