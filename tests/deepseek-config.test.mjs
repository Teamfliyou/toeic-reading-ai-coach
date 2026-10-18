import test from "node:test";
import assert from "node:assert/strict";
import {
  DEEPSEEK_MODEL,
  PROMPT_VERSION,
  isPeakUTC,
  computeCost,
  estimateCostUsd,
} from "../server/deepseek-config.mjs";

test("B1 : le modèle par défaut est deepseek-flash (jamais deepseek-chat)", () => {
  assert.equal(DEEPSEEK_MODEL, "deepseek-flash");
  assert.ok(!DEEPSEEK_MODEL.includes("chat"));
});

test("la version de prompt est non vide (invalide le cache)", () => {
  assert.equal(typeof PROMPT_VERSION, "string");
  assert.ok(PROMPT_VERSION.length >= 4);
});

test("isPeakUTC : reconnaît les heures de pointe documentées", () => {
  // Lundi 2026-10-19, 02:00 UTC → pointe.
  assert.equal(isPeakUTC(new Date("2026-10-19T02:00:00Z")), true);
  // Lundi 2026-10-19, 07:00 UTC → pointe.
  assert.equal(isPeakUTC(new Date("2026-10-19T07:00:00Z")), true);
  // Lundi 2026-10-19, 12:00 UTC → hors pointe.
  assert.equal(isPeakUTC(new Date("2026-10-19T12:00:00Z")), false);
  // Samedi 2026-10-17, 02:00 UTC → hors pointe (week-end).
  assert.equal(isPeakUTC(new Date("2026-10-17T02:00:00Z")), false);
});

test("computeCost : facture cache miss, cache hit et sortie", () => {
  const cost = computeCost(
    { prompt_tokens: 1000, completion_tokens: 1000, prompt_cache_hit_tokens: 400 },
    { now: new Date("2026-10-19T12:00:00Z") }
  );
  assert.equal(cost.cacheHitTokens, 400);
  assert.equal(cost.inputTokens, 1000);
  assert.equal(cost.outputTokens, 1000);
  assert.equal(cost.ratePeriod, "off-peak");
  // (600*0.15 + 400*0.003 + 1000*0.60) / 1e6
  assert.equal(cost.estimatedUsd, Number(((600 * 0.15 + 400 * 0.003 + 1000 * 0.6) / 1e6).toFixed(6)));
});

test("computeCost : double le tarif en heures de pointe", () => {
  const off = computeCost({ prompt_tokens: 1000, completion_tokens: 1000 }, { now: new Date("2026-10-19T12:00:00Z") });
  const peak = computeCost({ prompt_tokens: 1000, completion_tokens: 1000 }, { now: new Date("2026-10-19T02:00:00Z") });
  assert.equal(peak.ratePeriod, "peak");
  assert.equal(peak.estimatedUsd, off.estimatedUsd * 2);
});

test("computeCost : tolère un usage absent", () => {
  const cost = computeCost(undefined, { now: new Date("2026-10-19T12:00:00Z") });
  assert.equal(cost.estimatedUsd, 0);
});

test("estimateCostUsd : réservation positive et raisonnable", () => {
  const estimate = estimateCostUsd();
  assert.ok(estimate > 0);
  assert.ok(estimate < 0.05, "la réservation unitaire doit rester faible");
});
