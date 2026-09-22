import type { Config } from "@netlify/functions";
import { env, HttpError } from "../lib/errors";
import { allowedDomain, checkClaims, exchangeCode } from "../lib/google";
import { clearState, newSession, readState, sessionCookie } from "../lib/session";
import { Client } from "../lib/shotgrid";

/**
 * Google sends the artist back here. Check the round trip wasn't forged,
 * prove the account is a verified work account, then find the matching
 * active ShotGrid user - uploads are credited to them.
 */
export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const back = (headers: Record<string, string>) => {
    const h = new Headers({ Location: `${url.origin}/`, ...headers });
    h.append("Set-Cookie", clearState());
    return new Response(null, { status: 302, headers: h });
  };

  try {
    if (url.searchParams.get("error")) {
      throw new HttpError(401, url.searchParams.get("error") === "access_denied"
        ? "Google sign-in was cancelled" : `Google sign-in failed (${url.searchParams.get("error")})`);
    }
    const saved = readState(req);
    const code = url.searchParams.get("code");
    if (!saved || !code || url.searchParams.get("state") !== saved.state) {
      throw new HttpError(400, "Sign-in expired or came from somewhere else - try again");
    }

    const claims = await exchangeCode(req, code);
    const email = checkClaims(claims, env("GOOGLE_CLIENT_ID"), allowedDomain());

    const [user] = await new Client(null).find("HumanUser",
      [["email", "is", email], ["sg_status_list", "is", "act"]], ["id", "name", "login", "email"]);
    if (!user) {
      throw new HttpError(403, `No active ShotGrid user has the email ${email} - ask a ShotGrid admin to check your account`);
    }

    const session = newSession({ id: user.id, name: user.name, login: user.login, email });
    const h = new Headers({ Location: `${url.origin}/` });
    h.append("Set-Cookie", clearState());
    h.append("Set-Cookie", sessionCookie(session));
    return new Response(null, { status: 302, headers: h });
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) console.error(err);
    return back({ Location: `${url.origin}/?auth_error=${encodeURIComponent((err as Error).message)}` });
  }
};

export const config: Config = { path: "/api/auth/callback", method: "GET" };
