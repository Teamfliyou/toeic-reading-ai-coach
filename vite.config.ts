import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "toeic-api-proxy",
      configureServer(server) {
        server.middlewares.use("/api/explain", async (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method Not Allowed");
            return;
          }
          const { handleExplain } = await import("./server/explain.mjs");
          await handleExplain(req, res);
        });
        server.middlewares.use("/api/health", async (_req, res) => {
          const { handleHealth } = await import("./server/explain.mjs");
          handleHealth(_req, res);
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
