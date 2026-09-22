/**
 * A thin client for the ShotGrid REST API, acting as the signed-in
 * artist with their own token. Everything is subject to that artist's
 * ShotGrid permissions; there is no shared script key.
 */
import { type Session, readSession, sessionCookie } from "./session";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** What to tell someone whose Netlify variable isn't reaching the functions. */
export const missingVar = (name: string) =>
  `${name} is not set - in Netlify, add it under Site configuration > Environment `
  + "variables with the Functions scope and a Production value, then redeploy";

export function site(): string {
  const url = process.env.SHOTGRID_SITE;
  if (!url) throw new HttpError(500, missingVar("SHOTGRID_SITE"));
  return url.replace(/\/+$/, "");
}

export function projectId(): number {
  const id = Number(process.env.SHOTGRID_PROJECT_ID);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(500, missingVar("SHOTGRID_PROJECT_ID"));
  }
  return id;
}

export const project = () => ({ type: "Project", id: projectId() });

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${site()}/api/v1/auth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new HttpError(res.status === 400 || res.status === 401 ? 401 : 502,
      await errorText(res));
  }
  return res.json() as Promise<TokenResponse>;
}

export async function passwordGrant(username: string, password: string, otp?: string) {
  const params: Record<string, string> = { grant_type: "password", username, password };
  if (otp) params.auth_token = otp;
  return requestToken(params);
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    const detail = body?.errors?.[0];
    if (detail) return detail.detail || detail.title || text;
  } catch { /* not JSON */ }
  return text || `${res.status} ${res.statusText}`;
}

/**
 * One authenticated request. Refreshes the access token when it has
 * expired (or is rejected), and reports whether the session changed so
 * the caller can re-set the cookie.
 */
export class Client {
  changed = false;

  constructor(public session: Session) {}

  static from(req: Request): Client {
    const session = readSession(req);
    if (!session) throw new HttpError(401, "Not signed in");
    return new Client(session);
  }

  private async refresh() {
    const t = await requestToken({
      grant_type: "refresh_token",
      refresh_token: this.session.refresh,
    }).catch((err) => {
      throw new HttpError(401, `Session expired - sign in again (${err.message})`);
    });
    this.session = {
      ...this.session,
      access: t.access_token,
      refresh: t.refresh_token || this.session.refresh,
      expires: Date.now() + t.expires_in * 1000,
    };
    this.changed = true;
  }

  async request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/api/v1/")) throw new HttpError(400, "Bad ShotGrid path");
    if (Date.now() > this.session.expires - 30_000) await this.refresh();

    const send = () => fetch(site() + path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
        Authorization: `Bearer ${this.session.access}`,
      },
    });

    let res = await send();
    if (res.status === 401) {
      await this.refresh();
      res = await send();
    }
    if (!res.ok) throw new HttpError(res.status === 401 ? 401 : 502, await errorText(res));
    return (res.status === 204 ? null : await res.json()) as T;
  }

  /** Every matching record, following pages. Mirrors sg.find(). */
  async find(entity: string, filters: unknown[], fields: string[]): Promise<Record<string, any>[]> {
    const out: Record<string, any>[] = [];
    const size = 500;
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({
        fields: fields.join(","),
        "page[size]": String(size),
        "page[number]": String(page),
      });
      const body = await this.request<{ data: ApiRecord[] }>(
        `/api/v1/entity/${entity}/_search?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/vnd+shotgun.api3_array+json" },
          body: JSON.stringify({ filters }),
        });
      out.push(...body.data.map(flatten));
      if (body.data.length < size) return out;
    }
  }

  async create(entity: string, data: Record<string, unknown>): Promise<Record<string, any>> {
    const body = await this.request<{ data: ApiRecord }>(`/api/v1/entity/${entity}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return flatten(body.data);
  }

  json(body: unknown, status = 200): Response {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.changed) headers.append("Set-Cookie", sessionCookie(this.session));
    return new Response(JSON.stringify(body), { status, headers });
  }
}

interface ApiRecord {
  type: string;
  id: number;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data: unknown }>;
}

/**
 * REST records split plain fields from entity links. Put them back
 * together into the shape the Python API returns, which is what the
 * matching code expects: {id, code, sg_activations: {type,id,name}, ...}.
 */
export function flatten(record: ApiRecord): Record<string, any> {
  const out: Record<string, any> = { type: record.type, id: record.id, ...record.attributes };
  for (const [field, rel] of Object.entries(record.relationships ?? {})) {
    out[field] = rel?.data ?? null;
  }
  return out;
}

/** Wrap a handler so thrown errors become JSON responses. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      // A cross-site page can't set this header without a CORS
      // preflight, which these functions never approve.
      if (req.method !== "GET" && req.headers.get("x-requested-with") !== "uploader") {
        throw new HttpError(403, "Missing request header");
      }
      return await fn(req);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error(err);
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

/** Upload links come back from the browser; only accept ShotGrid's own shape. */
export function isUploadLink(link: string): boolean {
  return /^\/api\/v1\/entity\/[A-Za-z0-9_]+\/\d+\/sg_uploaded_movie\/_upload(\/|\?|$)/.test(link);
}
