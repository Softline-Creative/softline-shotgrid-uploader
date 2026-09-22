/**
 * "Sign in with Google", limited to one Workspace domain. Standard OAuth
 * authorization-code flow: this site redirects to Google, Google
 * redirects back to /api/auth/callback with a code, and the code is
 * exchanged server-side (with the client secret) for an ID token.
 */
import { HttpError, env } from "./errors";

// Overridable so `npm run dev:mock` can stand in for Google.
const AUTH_URL = () => process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";

export const allowedDomain = () => (process.env.ALLOWED_DOMAIN || "softlinesolutions.com").trim().toLowerCase();

/** The callback address, which must also be registered with Google. */
export const redirectUri = (req: Request) => `${new URL(req.url).origin}/api/auth/callback`;

export function authUrl(req: Request, state: string): string {
  const query = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    hd: allowedDomain(),          // a hint for the account picker only
    prompt: "select_account",
  });
  return `${AUTH_URL()}?${query}`;
}

export interface Claims {
  iss: string;
  aud: string;
  exp: number;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
}

/**
 * The ID token came straight from Google's token endpoint over TLS, so
 * its signature needn't be checked (Google's OpenID Connect guidance);
 * the claims still must be.
 */
export async function exchangeCode(req: Request, code: string): Promise<Claims> {
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) {
    throw new HttpError(401, `Google sign-in failed (${body.error_description || body.error || res.status})`);
  }
  return decodeIdToken(body.id_token);
}

export function decodeIdToken(token: string): Claims {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new HttpError(401, "Google returned an unreadable sign-in token");
  }
}

/** The signed-in email, once the claims prove it's a verified work account. */
export function checkClaims(claims: Claims, clientId: string, domain: string, now = Date.now()): string {
  if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss)) {
    throw new HttpError(401, "Sign-in token wasn't issued by Google");
  }
  if (claims.aud !== clientId) throw new HttpError(401, "Sign-in token is for a different app");
  if (claims.exp * 1000 < now) throw new HttpError(401, "Sign-in token has expired - try again");
  const email = (claims.email ?? "").toLowerCase();
  if (!claims.email_verified || !email) throw new HttpError(403, "Google account has no verified email");
  // hd is set only for Workspace accounts, and is Google's word on which
  // organisation the account belongs to - unlike the email text.
  if ((claims.hd ?? "").toLowerCase() !== domain || !email.endsWith(`@${domain}`)) {
    throw new HttpError(403, `Sign in with your @${domain} Google account`);
  }
  return email;
}
