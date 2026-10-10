import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(
  readFileSync(join(__dirname, "../data/questions.json"), "utf8")
);

const BASE_URL = "https://api.deepseek.com";
const MODEL = "deepseek-chat";

const SYSTEM_PROMPT = `Tu es un professeur d'anglais expert du TOEIC, pédagogue, précis et bienveillant. Tu expliques les erreurs de grammaire et de vocabulaire de la partie Reading (compréhension écrite) du nouveau TOEIC.

Règles strictes :
- Réponds TOUJOURS en français.
- Sois concis : chaque champ fait au maximum 40 mots.
- Ne répète pas la question, va droit au but.
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans bloc de code.

Le format JSON attendu est exactement :
{
  "diagnostic": "Pourquoi la réponse choisie par l'utilisateur est fausse",
  "resolution": "Pourquoi la bonne réponse est correcte",
  "tip": "Une astuce courte pour repérer ce piège récurrent au TOEIC"
}`;

function buildUserPrompt(question, selectedKey) {
  const optionsText = question.options
    .map((o) => `${o.key}. ${o.text}`)
    .join("\n");

  return [
    `Partie ${question.part} du TOEIC.`,
    "",
    `Énoncé : ${question.prompt}`,
    "",
    "Choix proposés :",
    optionsText,
    "",
    `Réponse choisie par l'élève : ${selectedKey}`,
    `Bonne réponse : ${question.correctKey}`,
    "",
    "Explique l'erreur dans le format JSON demandé.",
  ].join("\n");
}

function parseExplanation(raw) {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      diagnostic: String(parsed.diagnostic ?? "").trim(),
      resolution: String(parsed.resolution ?? "").trim(),
      tip: String(parsed.tip ?? "").trim(),
    };
  } catch {
    return { diagnostic: "", resolution: "", tip: "" };
  }
}

export function findQuestion(questionId) {
  return dataset.questions.find((q) => q.id === questionId) ?? null;
}

export async function explainMistake(questionId, selectedKey, userApiKey) {
  const apiKey =
    (userApiKey && typeof userApiKey === "string" && userApiKey.trim()) ||
    process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Aucune clé API DeepSeek. Ajoutez votre clé dans les Paramètres ou définissez DEEPSEEK_API_KEY dans .env."
    );
  }

  const question = findQuestion(questionId);
  if (!question) {
    throw new Error("Question introuvable.");
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: buildUserPrompt(question, selectedKey),
          },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`DeepSeek a répondu ${res.status} : ${body.replace(/(Bearer\s+|sk-)[a-zA-Z0-9_-]{8,}/g, "[clé masquée]").slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const explanation = parseExplanation(content);

    if (!explanation.diagnostic && !explanation.resolution && !explanation.tip) {
      throw new Error("Réponse DeepSeek non parsable en JSON.");
    }

    return { explanation, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export async function handleExplain(req, res) {
  try {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return sendJson(res, 400, { error: "JSON invalide." });
    }

    const { questionId, selectedKey } = body;
    if (!questionId || !selectedKey) {
      return sendJson(res, 400, {
        error: "Champs `questionId` et `selectedKey` requis.",
      });
    }
    if (!["A", "B", "C", "D"].includes(selectedKey)) {
      return sendJson(res, 400, { error: "`selectedKey` invalide." });
    }

    const rawHeader = req.headers["x-deepseek-api-key"];
    const userApiKey = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    const result = await explainMistake(questionId, selectedKey, userApiKey);
    return sendJson(res, 200, result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur inconnue du serveur.";
    return sendJson(res, 500, { error: message });
  }
}

export function handleHealth(req, res) {
  sendJson(res, 200, {
    hasDeepSeekKey: Boolean(process.env.DEEPSEEK_API_KEY),
  });
}
