import { handleReport } from "../server/report.mjs";

export default async function handler(req, res) {
  return handleReport(req, res);
}
