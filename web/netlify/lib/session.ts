/**
 * The signed-in artist's ShotGrid tokens, kept in an encrypted,
 * httpOnly cookie. The browser never sees a token, and nothing is
 * stored server-side, so any function instance can serve any request.
 */
import { HttpError, missingVar } from "./shotgrid";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const COOKIE = "sgu_session";

/** Refresh tokens are the long-lived part; the cookie follows them. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export interface Session {
  access: string;
  refresh: string;
  /** Access token expiry, epoch ms. */
  expires: number;
  user: { id: number; name: string; login: string };
}

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(500, missingVar("SESSION_SECRET") + " (needs 32+ characters)");
  }
  return createHash("sha256").update(secret).digest();
}

export function seal(session: Session): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal(value: string): Session | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(text) as Session;
  } catch {
    return null;
  }
}

export function readSession(req: Request): Session | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return unseal(rest.join("="));
  }
  return null;
}

export function sessionCookie(session: Session): string {
  return `${COOKIE}=${seal(session)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
