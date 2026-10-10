export default function handler(_req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ hasDeepSeekKey: Boolean(process.env.DEEPSEEK_API_KEY?.trim()) });
}
