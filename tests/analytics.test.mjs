import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLAUSIBLE_SRC, resolveAnalytics } from "../src/lib/analytics.ts";

test("désactivée par défaut : sans domaine, aucune mesure", () => {
  assert.equal(resolveAnalytics({}), null);
  assert.equal(resolveAnalytics({ domain: "" }), null);
  assert.equal(resolveAnalytics({ domain: "   " }), null);
});

test("activée uniquement avec un domaine valide ; script par défaut compatible routage par #", () => {
  assert.deepEqual(resolveAnalytics({ domain: "Lernoviq.example.com" }), {
    domain: "lernoviq.example.com",
    src: DEFAULT_PLAUSIBLE_SRC,
  });
  assert.match(DEFAULT_PLAUSIBLE_SRC, /script\.hash\.js$/);
});

test("« Do Not Track » désactive la mesure", () => {
  assert.equal(resolveAnalytics({ domain: "example.com" }, true), null);
});

test("refuse un domaine douteux (schéma, chemin, guillemets) et un script non https", () => {
  for (const domain of ["https://example.com", "example.com/path", 'ex"ample.com', "localhost", "a b.com", "<script>.com"]) {
    assert.equal(resolveAnalytics({ domain }), null, domain);
  }
  assert.equal(resolveAnalytics({ domain: "example.com", src: "http://stats.example.com/js/script.js" }), null);
  assert.equal(resolveAnalytics({ domain: "example.com", src: "javascript:alert(1)" }), null);
  assert.equal(resolveAnalytics({ domain: "example.com", src: "pas une url" }), null);
  assert.equal(resolveAnalytics({ domain: "example.com", src: "https://stats.example.com/js/script.js" }).src, "https://stats.example.com/js/script.js");
});
