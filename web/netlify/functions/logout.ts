import type { Config } from "@netlify/functions";
import { handler } from "../lib/shotgrid";
import { clearCookie } from "../lib/session";

export default handler(async () => new Response(null, {
  status: 204,
  headers: { "Set-Cookie": clearCookie() },
}));

export const config: Config = { path: "/api/logout", method: "POST" };
