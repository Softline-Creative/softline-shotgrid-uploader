import type { Config } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { authUrl } from "../lib/google";
import { stateCookie } from "../lib/session";

/** Start "Sign in with Google": off to Google's account picker. */
export default async (req: Request): Promise<Response> => {
  try {
    const state = randomBytes(24).toString("base64url");
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl(req, state),
        "Set-Cookie": stateCookie({ state, expires: Date.now() + 600_000 }),
      },
    });
  } catch (err) {
    return Response.redirect(`${new URL(req.url).origin}/?auth_error=${encodeURIComponent((err as Error).message)}`, 302);
  }
};

export const config: Config = { path: "/api/auth/google", method: "GET" };
