/**
 * `npm run dev:mock` - the app plus the real Netlify function handlers,
 * talking to dev/mock-shotgrid.ts instead of a ShotGrid site.
 */
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync } from "node:fs";
import { startMockShotgrid } from "./dev/mock-shotgrid.ts";

const APP_PORT = 5173;
const MOCK_PORT = 4010;

function functions(): Plugin {
  return {
    name: "netlify-functions",
    configureServer(server: ViteDevServer) {
      process.env.SHOTGRID_SITE = `http://localhost:${MOCK_PORT}`;
      process.env.SHOTGRID_PROJECT_ID = "1";
      process.env.SESSION_SECRET = "mock-secret-mock-secret-mock-secret!!";
      const mock = startMockShotgrid(MOCK_PORT, `http://localhost:${APP_PORT}`);
      (globalThis as any).__mockShotgrid = mock;
      server.httpServer?.on("close", () => mock.server.close());

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        const path = req.url.split("?")[0];
        for (const file of readdirSync("netlify/functions")) {
          const mod = await server.ssrLoadModule(`/netlify/functions/${file}`);
          if (mod.config?.path !== path) continue;
          if (mod.config.method && mod.config.method !== req.method) continue;
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const request = new Request(`http://localhost:${APP_PORT}${req.url}`, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks),
          });
          const response: Response = await mod.default(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            if (key !== "set-cookie") res.setHeader(key, value);
          });
          const cookies = response.headers.getSetCookie();
          if (cookies.length) res.setHeader("set-cookie", cookies);
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `no function for ${req.method} ${path}` }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), functions()],
  server: { port: APP_PORT, strictPort: true },
});
