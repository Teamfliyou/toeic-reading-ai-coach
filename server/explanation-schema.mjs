// Validation et nettoyage de la réponse JSON de DeepSeek.
//
// Le modèle peut renvoyer du JSON entouré de balises markdown, précédé d'un
// préambule, tronqué (max_tokens) ou de forme inattendue : on ne s'appuie donc
// jamais sur `JSON.parse` brut ni sur des coercions silencieuses.

import { z } from "zod";

const text = (max) =>
  z.string().trim().min(1).transform((value) => value.slice(0, max));
const optionalText = (max) =>
  z.string().trim().transform((value) => value.slice(0, max)).catch("");

export const feedbackSchema = z.object({
  diagnostic: text(700),
  resolution: text(700),
  tip: text(500),
});

const lessonSchema = z.object({
  topic: optionalText(200),
  title: text(200),
  rule: text(2500),
  example: optionalText(1200),
  exercise: text(1200),
  answer: text(1200),
  tip: optionalText(600),
});

/**
 * Isole l'objet JSON d'une réponse : retire les balises ```json, le texte avant
 * et après l'objet. Renvoie `null` si aucune accolade ouvrante n'est trouvée.
 */
export function extractJsonText(raw) {
  let value = String(raw ?? "").trim();
  value = value.replace(/```(?:json)?/gi, "").trim();
  const start = value.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i += 1) {
    const char = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return null; // accolade jamais refermée : réponse tronquée
}

/**
 * Analyse une réponse brute.
 * @returns {{ok:true, explanation:object, lesson:object|null}
 *          |{ok:false, reason:"empty"|"truncated"|"json"|"schema"}}
 */
export function parseExplanation(raw) {
  const jsonText = extractJsonText(raw);
  if (jsonText === null) {
    return { ok: false, reason: String(raw ?? "").trim() ? "truncated" : "empty" };
  }
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "json" };
  }
  const feedback = feedbackSchema.safeParse(data);
  if (!feedback.success) return { ok: false, reason: "schema" };
  const lesson = lessonSchema.safeParse(data?.lesson);
  return {
    ok: true,
    explanation: feedback.data,
    lesson: lesson.success ? lesson.data : null,
  };
}
