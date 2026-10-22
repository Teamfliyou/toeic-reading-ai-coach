import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkRateLimit, clientIp } from "./rate-limit.mjs";
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  PROMPT_VERSION,
  computeCost,
  addUsage,
  estimateCostUsd,
} from "./deepseek-config.mjs";
import { parseExplanation } from "./explanation-schema.mjs";
import { storeConfigured, getCachedExplanation, saveExplanation, touchExplanation } from "./store.mjs";
import { quotaConfigured, reserve, finalize, release, currentMonth, budgetLimits } from "./quota.mjs";
import { authConfigured, currentAiUser } from "./auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(
  readFileSync(join(__dirname, "../data/questions.json"), "utf8")
);

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
- Rédige les explications en français, mais tout contenu d'exercice (exemples, mini-question et ses choix A à D) doit être écrit en anglais, jamais en français.
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
    "exercise": "Une mini-question originale rédigée en anglais avec quatre choix A, B, C et D en anglais",
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
    question.context ? `Document à analyser :\n${question.context.slice(0, 4500)}` : "",
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

/** Met en forme les documents d'un passage (un document par bloc, un paragraphe par ligne). */
export function renderDocuments(docs) {
  if (!Array.isArray(docs)) return "";
  return docs
    .map((d) => `${d?.title ?? ""}\n${Array.isArray(d?.body) ? d.body.join("\n") : ""}`)
    .join("\n\n");
}

export async function findQuestion(questionId) {
  // Les IDs du seed Supabase sont des UUID, différents des IDs du JSON local.
  const local = dataset.questions.find((q) => q.id === questionId);
  if (local) {
    const passage = dataset.passages.find(p => p.id === local.passageId);
    return { ...local, context: renderDocuments(passage?.documents) };
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
        context = renderDocuments(passages[0]?.documents);
      }
    } catch { /* Un passage indisponible ne bloque pas la correction. */ }
  }
  return {
    id: row.id, part: row.part, prompt: row.prompt,
    options: row.options, correctKey: row.correct_key, context,
  };
}

export async function explainMistake(questionId, selectedKey, userApiKey, options = {}) {
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
  // Le mode « thinking » est désactivé par défaut : il facture des tokens de
  // raisonnement sans bénéfice pour une explication courte. Mettre
  // DEEPSEEK_THINKING_ENABLED=true pour le réactiver.
  const thinkingEnabled = envFlag("DEEPSEEK_THINKING_ENABLED", false);
  const userPrompt = buildUserPrompt(question, selectedKey);
  const RETRY_NOTE =
    'Ta réponse précédente était invalide ou tronquée. Réponds de nouveau par un objet JSON COMPLET et COMPACT : "diagnostic", "resolution" et "tip" (30 mots maximum chacun) et "lesson": null.';

  let usage = null; // coût cumulé : toute tentative ayant reçu une réponse est facturée
  const fail = (message, extra) => {
    const error = new Error(message);
    Object.assign(error, extra, { usage });
    return error;
  };

  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Number(process.env.DEEPSEEK_TIMEOUT_MS) || 22000
      );
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ];
      if (attempt === 2) messages.push({ role: "user", content: RETRY_NOTE });
      const payload = {
        model: DEEPSEEK_MODEL,
        messages,
        response_format: { type: "json_object" },
        max_tokens: Number(process.env.DEEPSEEK_MAX_TOKENS) || 1024,
        stream: false,
      };
      if (!thinkingEnabled) payload.thinking = { type: "disabled" };
      // `user_id` aide DeepSeek à isoler l'ordonnancement et le cache par défaut.
      if (options.userId) payload.user_id = String(options.userId).slice(0, 512);

      let data;
      try {
        const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          const raw = await res.text().catch(() => "");
          const safe = maskSecret(raw);
          // Conservé pour que l'appelant distingue budget (402), saturation (429)
          // et clé refusée (401).
          throw fail(`DeepSeek a répondu ${res.status}${safe ? ` : ${safe}` : ""}`, {
            statusCode: res.status,
          });
        }
        data = await res.json();
      } finally {
        clearTimeout(timeout);
      }

      usage = addUsage(usage, computeCost(data?.usage));
      const content = data?.choices?.[0]?.message?.content ?? "";
      const parsed = parseExplanation(content);
      if (parsed.ok) {
        return {
          explanation: parsed.explanation,
          lesson: attempt === 1 ? parsed.lesson : null,
          latencyMs: Date.now() - startedAt,
          usage,
        };
      }
    }

    throw fail(
      "Le coach n'a pas pu formuler une explication lisible cette fois. Réessayez dans un instant ; la bonne réponse reste affichée.",
      { statusCode: 502, code: "unparsable" }
    );
  } catch (error) {
    // Une erreur réseau/timeout en 2e tentative ne doit pas faire oublier le
    // coût de la 1re : l'appelant en a besoin pour la réconciliation du budget.
    if (error && typeof error === "object" && !("usage" in error)) error.usage = usage;
    throw error;
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
        // On draine le reste du corps sans l'accumuler, afin de pouvoir
        // renvoyer une réponse 413 propre au lieu de couper la connexion.
        req.resume?.();
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

  // Identité Supabase (facultative) : sert au quota par utilisateur.
  let aiUser = null;
  if (authConfigured()) {
    aiUser = await currentAiUser(req).catch(() => null);
  }

  // Réservation de quota/budget à libérer en cas d'échec.
  let eventId = null;

  try {
    if (!hasUserKey) {
      const requireAuth = envFlag("AI_FREE_REQUIRES_AUTH", false);
      const fallbackAllowed = envFlag("ALLOW_SERVER_KEY_FALLBACK", true);

      if (requireAuth && !aiUser) {
        return sendJson(res, 401, {
          error: "Connexion requise pour l'explication gratuite.",
          code: "auth_required",
        });
      }
      if (!requireAuth && !fallbackAllowed) {
        return sendJson(res, 401, {
          error: "Clé API DeepSeek requise. Ajoutez votre clé dans les Paramètres.",
          code: "key_required",
        });
      }

      // Débit : par utilisateur connecté, sinon par IP. La limite par
      // utilisateur est aussi appliquée de façon atomique en base (réservation).
      const byUser = Boolean(aiUser);
      const limit = byUser
        ? Number(process.env.AI_PER_MINUTE) || 3
        : Number(process.env.EXPLAIN_RATE_LIMIT) || 60;
      const windowMs = byUser
        ? Number(process.env.AI_PER_MINUTE_WINDOW_MS) || 60000
        : Number(process.env.EXPLAIN_RATE_WINDOW_MS) || 600000;
      const rate = checkRateLimit(
        byUser ? `user:${aiUser.id}` : `explain:${clientIp(req)}`,
        { limit, windowMs }
      );
      if (!rate.ok) {
        res.setHeader("Retry-After", String(rate.retryAfterSec));
        return sendJson(res, 429, {
          error:
            "Trop de requêtes vers le coach IA. Merci de patienter quelques instants.",
          code: "rate",
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

    // Cache partagé : une explication identique déjà générée est resservie
    // sans consommer de quota ni appeler DeepSeek.
    if (storeConfigured()) {
      const cached = await getCachedExplanation({
        questionId,
        selectedKey,
        promptVersion: PROMPT_VERSION,
        model: DEEPSEEK_MODEL,
      }).catch(() => null);
      if (cached) {
        touchExplanation(cached.id).catch(() => {});
        return sendJson(res, 200, {
          explanation: cached.payload,
          lesson: cached.lesson ?? null,
          latencyMs: 0,
          cached: true,
        });
      }
    }

    // Réservation atomique du quota et du budget (clé serveur uniquement).
    if (!hasUserKey && quotaConfigured()) {
      const { limitUsd, suspendUsd } = budgetLimits();
      let reservation;
      try {
        reservation = await reserve({
          actor: aiUser ? `user:${aiUser.id}` : `ip:${clientIp(req)}`,
          dailyLimit: aiUser
            ? Number(process.env.AI_DAILY_LIMIT) || 10
            : Number(process.env.AI_ANON_DAILY_LIMIT) || 5,
          perMinute: aiUser
            ? Number(process.env.AI_PER_MINUTE) || 3
            : Number(process.env.AI_ANON_PER_MINUTE) || 2,
          windowSeconds: 60,
          estimatedUsd: estimateCostUsd(),
          limitUsd,
          suspendUsd,
          month: currentMonth(),
        });
      } catch {
        // Échec de la réservation (migration absente, Supabase indisponible) :
        // on refuse l'appel de clé serveur plutôt que de risquer un
        // dépassement de budget non contrôlé. Les exercices restent accessibles.
        return sendJson(res, 503, {
          error:
            "Service d'explications IA temporairement indisponible ; les exercices restent accessibles.",
          code: "unavailable",
        });
      }
      if (!reservation.ok) {
        const reasons = {
          quota:
            "Quota quotidien d'explications IA atteint. Réessayez demain ; les exercices restent accessibles.",
          rate:
            "Trop de requêtes vers le coach IA. Merci de patienter quelques instants.",
          budget:
            "Le budget mensuel d'explications IA est atteint ; les exercices restent accessibles.",
          in_flight: "Une explication est déjà en cours pour ce compte.",
          unavailable: "Service d'explications IA temporairement indisponible.",
        };
        return sendJson(res, 429, {
          error: reasons[reservation.reason] || reasons.unavailable,
          code: reservation.reason,
        });
      }
      eventId = reservation.eventId;
    }

    const result = await explainMistake(questionId, selectedKey, userApiKey, {
      userId: aiUser?.id,
    });

    // Enregistrement de la réponse IA : historique + cache partagé.
    if (storeConfigured()) {
      await saveExplanation({
        questionId,
        selectedKey,
        promptVersion: PROMPT_VERSION,
        model: DEEPSEEK_MODEL,
        payload: result.explanation,
        lesson: result.lesson,
        userId: aiUser?.id ?? null,
        usage: result.usage,
      }).catch(() => {});
    }

    // Réconciliation du budget : la réservation devient le coût réel.
    if (eventId) {
      await finalize(eventId, result.usage?.estimatedUsd ?? 0).catch(() => {});
      eventId = null;
    }

    return sendJson(res, 200, {
      explanation: result.explanation,
      lesson: result.lesson,
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    if (eventId) {
      // Si DeepSeek a répondu (donc facturé) mais que le résultat est inutilisable,
      // le coût réel reste imputé au budget ; sinon la réservation est rendue.
      const billed = error?.usage?.estimatedUsd;
      if (billed > 0) await finalize(eventId, billed).catch(() => {});
      else await release(eventId).catch(() => {});
      eventId = null;
    }

    // 502 : réponse du modèle illisible après nouvelle tentative.
    if (error && error.code === "unparsable") {
      return sendJson(res, 502, { error: error.message, code: "unparsable" });
    }
    // 401 : clé DeepSeek personnelle refusée.
    if (error && error.statusCode === 401) {
      return sendJson(res, 401, {
        error: "Clé API DeepSeek refusée. Vérifiez-la dans les Paramètres.",
        code: "key_invalid",
      });
    }

    // 402 = solde DeepSeek insuffisant ; traité comme budget épuisé.
    if (error && (error.statusCode === 402 || error.statusCode === 429)) {
      const isBudget = error.statusCode === 402;
      return sendJson(res, isBudget ? 503 : 429, {
        error: isBudget
          ? "Le budget d'explications IA est épuisé ; les exercices restent accessibles."
          : "Le service d'explications IA est momentanément saturé. Réessayez dans un instant.",
        code: isBudget ? "budget" : "rate",
      });
    }

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
