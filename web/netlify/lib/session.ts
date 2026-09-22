/**
 * Who is signed in, kept in an encrypted, httpOnly cookie. Nothing is
 * stored server-side, so any function instance can serve any request.
 *
 * The cookie holds identity only - the artist's ShotGrid user, found by
 * their Google email. ShotGrid itself is reached with the script key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { HttpError, missingVar } from "./errors";

export const COOKIE = "sgu_session";
export const STATE_COOKIE = "sgu_oauth";

/** A working day and then some; artists sign in again after this. */
const SESSION_HOURS = 12;

export interface Session {
  user: { id: number; name: string; login: string; email: string };
  /** Epoch ms. */
  expires: number;
}

/** The OAuth round trip's anti-forgery value, alive for a few minutes. */
export interface OAuthState {
  state: string;
  expires: number;
}

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(500, missingVar("SESSION_SECRET") + " (needs 32+ characters)");
  }
  return createHash("sha256").update(secret).digest();
}

export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(value: string): T | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function readCookie<T extends { expires: number }>(req: Request, name: string): T | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [cookie, ...rest] = part.trim().split("=");
    if (cookie !== name) continue;
    const value = unseal<T>(rest.join("="));
    return value && value.expires > Date.now() ? value : null;
  }
  return null;
}

export const readSession = (req: Request) => readCookie<Session>(req, COOKIE);
export const readState = (req: Request) => readCookie<OAuthState>(req, STATE_COOKIE);

export function newSession(user: Session["user"]): Session {
  return { user, expires: Date.now() + SESSION_HOURS * 3600_000 };
}

export function sessionCookie(session: Session): string {
  const maxAge = Math.max(0, Math.floor((session.expires - Date.now()) / 1000));
  return `${COOKIE}=${seal(session)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/**
 * Lax, not Strict: it has to come back on Google's redirect to the
 * callback, which is a cross-site navigation.
 */
export function stateCookie(state: OAuthState): string {
  return `${STATE_COOKIE}=${seal(state)}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export const clearState = () => `${STATE_COOKIE}=; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
