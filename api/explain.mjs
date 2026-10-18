import { handleExplain } from "../server/explain.mjs";

// Délègue au gestionnaire partagé afin d'appliquer exactement les mêmes
// protections (limite de débit, plafond de corps, contrôle d'origine) que le
// serveur Express.
export default async function handler(req, res) {
  return handleExplain(req, res);
}
