import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkRateLimit, clientIp } from "./rate-limit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(
  readFileSync(join(__dirname, "../data/questions.json"), "utf8")
);

const BASE_URL = "https://api.deepseek.com";
const MODEL = "deepseek-chat";

/** Masque toute clé API présente dans un message et borne sa longueur. */
export function maskSecret(text) {
  return String(text ?? "")
    .replace(/(Bearer\s+|sk-)[A-Za-z0-9_-]{8,}/g, "[clé masquée]")
    .slice(0, 200);
}

// Taille maximale acceptée pour le corps d'une requête d'explication (16 Ko).
const MAX_BODY_BYTES = 16 * 1024;

/** Lit un booléen d'environnement ; `fallback` si la variable est absente. */
function envFlag(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return String(value).toLowerCase() !== "false";
}

/**
 * Refuse une requête navigateur provenant d'une autre origine (proxy ouvert).
 * Les clients sans en-tête `Origin` (curl, serveur à serveur) restent acceptés.
 */
function isAllowedOrigin(req) {
  if (!envFlag("EXPLAIN_RESTRICT_ORIGIN", true)) return true;
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = `Tu es un professeur d'anglais expert du TOEIC, pédagogue, précis et bienveillant. Tu expliques les erreurs de grammaire et de vocabulaire de la partie Reading (compréhension écrite) du nouveau TOEIC.

Règles strictes :
- Réponds TOUJOURS en français.
- Les champs diagnostic, resolution et tip font chacun au maximum 50 mots. Le cours est plus détaillé.\n- Analyse le thème précis de la question (temps, prépositions, vocabulaire, connecteurs, compréhension...).\n- Explique une règle correcte, adapte-la à la faute précise et propose une mini-question inédite.
- Ne répète pas la question, va droit au but.
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans bloc de code.

Le format JSON attendu est exactement :
{
  "diagnostic": "Pourquoi la réponse choisie par l'utilisateur est fausse",
  "resolution": "Pourquoi la bonne réponse est correcte",
  "tip": "Une astuce courte pour repérer ce piège récurrent au TOEIC",
  "lesson": {
    "topic": "Thème grammatical ou compétence précise, en français",
    "title": "Titre clair du cours",
    "rule": "Règle pédagogique en français, détaillée en 80 à 130 mots",
    "example": "Un nouvel exemple anglais avec son explication française",
    "exercise": "Une mini-question originale avec quatre choix A, B, C et D",
    "answer": "Bonne lettre, réponse et justification pédagogique",
    "tip": "Méthode concrète pour éviter cette erreur au TOEIC"
  }
}`;

function buildUserPrompt(question, selectedKey) {
  const optionsText = question.options
    .map((o) => `${o.key}. ${o.text}`)
    .join("\n");

  return [
    `Partie ${question.part} du TOEIC.`,
    question.context ? `Document à analyser :\\n${question.context.slice(0, 4500)}` : "",
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
    const lesson = parsed.lesson && typeof parsed.lesson === "object" ? parsed.lesson : {};
    const safe = (s) => typeof s === "string" ? s.trim() : "";
    return {
      lesson: {
        topic: safe(lesson.topic), title: safe(lesson.title),
        rule: safe(lesson.rule), example: safe(lesson.example),
        exercise: safe(lesson.exercise), answer: safe(lesson.answer),
        tip: safe(lesson.tip),
      },
      diagnostic: String(parsed.diagnostic ?? "").trim(),
      resolution: String(parsed.resolution ?? "").trim(),
      tip: String(parsed.tip ?? "").trim(),
    };
  } catch {
    return { diagnostic: "", resolution: "", tip: "", lesson: null };
  }
}

export async function findQuestion(questionId) {
  // Les IDs du seed Supabase sont des UUID, différents des IDs du JSON local.
  const local = dataset.questions.find((q) => q.id === questionId);
  if (local) {
    const passage = dataset.passages.find(p => p.id === local.passageId);
    return { ...local, context: passage?.documents?.map(d => `${d.title}\\n${d.body.join("\\n")}`).join("\\n\\n") ?? "" };
  }

  const baseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const apiKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!baseUrl || !apiKey) return null;

  const url = new URL("/rest/v1/questions", baseUrl);
  url.searchParams.set("id", "eq." + questionId);
  url.searchParams.set("select", "id,part,prompt,options,correct_key,passage_id");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: { apikey: apiKey },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Impossible de récupérer la question Supabase.");
  const rows = await response.json();
  const row = rows[0];
  if (!row) return null;
  let context = "";
  if (row.passage_id) {
    const passageUrl = new URL("/rest/v1/passages", baseUrl);
    passageUrl.searchParams.set("id", "eq." + row.passage_id);
    passageUrl.searchParams.set("select", "documents");
    passageUrl.searchParams.set("limit", "1");
    try {
      const passageResponse = await fetch(passageUrl, {
        headers: { apikey: apiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (passageResponse.ok) {
        const passages = await passageResponse.json();
        const docs = passages[0]?.documents ?? [];
        context = Array.isArray(docs) ? docs.map(d =>
          `${d.title ?? ""}\\n${Array.isArray(d.body) ? d.body.join("\\n") : ""}`
        ).join("\\n\\n") : "";
      }
    } catch { /* Un passage indisponible ne bloque pas la correction. */ }
  }
  return {
    id: row.id, part: row.part, prompt: row.prompt,
    options: row.options, correctKey: row.correct_key, context,
  };
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

  const question = await findQuestion(questionId);
  if (!question) {
    throw new Error("Question introuvable.");
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22000);

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
      const raw = await res.text().catch(() => "");
      const safe = maskSecret(raw);
      throw new Error(
        `DeepSeek a répondu ${res.status}${safe ? ` : ${safe}` : ""}`
      );
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const explanation = parseExplanation(content);

    if (!explanation.diagnostic || !explanation.resolution || !explanation.tip) {
      throw new Error("Réponse DeepSeek non parsable en JSON.");
    }

    const { lesson, ...feedback } = explanation;
    return { explanation: feedback, lesson: lesson?.title && lesson?.rule && lesson?.exercise && lesson?.answer ? lesson : null, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
  }
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  // Certains runtimes (ex. serverless) fournissent déjà le corps analysé.
  if (req.body !== undefined && req.body !== null && typeof req.body !== "function") {
    const text = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (text.length > maxBytes) {
      const error = new Error("Requête trop volumineuse.");
      error.statusCode = 413;
      return Promise.reject(error);
    }
    return Promise.resolve(text);
  }

  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      data += chunk;
      if (data.length > maxBytes) {
        const error = new Error("Requête trop volumineuse.");
        error.statusCode = 413;
        fail(error);
        req.destroy?.();
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(data);
    });
    req.on("error", fail);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export async function handleExplain(req, res) {
  if (req.method && req.method !== "POST") {
    return sendJson(res, 405, { error: "Méthode non autorisée." });
  }

  if (!isAllowedOrigin(req)) {
    return sendJson(res, 403, { error: "Origine non autorisée." });
  }

  const rawHeader = req.headers?.["x-deepseek-api-key"];
  const userApiKey = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const hasUserKey =
    typeof userApiKey === "string" && userApiKey.trim().length > 0;

  try {
    // Anti-abus : on ne limite que l'usage de la clé du serveur. Un utilisateur
    // qui fournit sa propre clé consomme ses propres crédits DeepSeek.
    if (!hasUserKey) {
      if (!envFlag("ALLOW_SERVER_KEY_FALLBACK", true)) {
        return sendJson(res, 401, {
          error:
            "Clé API DeepSeek requise. Ajoutez votre clé dans les Paramètres.",
        });
      }
      const limit = Number(process.env.EXPLAIN_RATE_LIMIT) || 60;
      const windowMs = Number(process.env.EXPLAIN_RATE_WINDOW_MS) || 600000;
      const rate = checkRateLimit(`explain:${clientIp(req)}`, {
        limit,
        windowMs,
      });
      if (!rate.ok) {
        res.setHeader("Retry-After", String(rate.retryAfterSec));
        return sendJson(res, 429, {
          error:
            "Trop de requêtes vers le coach IA. Merci de patienter quelques instants.",
        });
      }
    }

    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error && error.statusCode === 413) {
        return sendJson(res, 413, { error: "Requête trop volumineuse." });
      }
      throw error;
    }

    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return sendJson(res, 400, { error: "JSON invalide." });
    }

    const { questionId, selectedKey } = body;
    if (
      typeof questionId !== "string" ||
      !questionId.trim() ||
      questionId.length > 200
    ) {
      return sendJson(res, 400, {
        error: "Champ `questionId` requis (chaîne de 200 caractères maximum).",
      });
    }
    if (!["A", "B", "C", "D"].includes(selectedKey)) {
      return sendJson(res, 400, { error: "`selectedKey` invalide." });
    }

    const result = await explainMistake(questionId, selectedKey, userApiKey);
    return sendJson(res, 200, result);
  } catch (error) {
    const message = maskSecret(
      error instanceof Error ? error.message : "Erreur inconnue du serveur."
    );
    return sendJson(res, 500, { error: message });
  }
}

export function handleHealth(req, res) {
  sendJson(res, 200, {
    hasDeepSeekKey: Boolean(process.env.DEEPSEEK_API_KEY),
  });
}
