/**
 * A thin client for the ShotGrid REST API. It signs in as a ShotGrid
 * script (SHOTGRID_SCRIPT_NAME / SHOTGRID_SCRIPT_KEY), as the desktop app
 * does, because the site uses Autodesk Identity and won't take a
 * person's password. Who is uploading comes from the Google sign-in;
 * each Version's `user` field credits them.
 */
import { HttpError, env } from "./errors";
import { type Session, readSession } from "./session";

export { HttpError, missingVar } from "./errors";

export const site = () => env("SHOTGRID_SITE").replace(/\/+$/, "");

export function projectId(): number {
  const id = Number(env("SHOTGRID_PROJECT_ID"));
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(500, "SHOTGRID_PROJECT_ID must be a project id number, e.g. 123");
  }
  return id;
}

export const project = () => ({ type: "Project", id: projectId() });

async function errorText(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    const detail = body?.errors?.[0];
    if (detail) return detail.detail || detail.title || text;
  } catch { /* not JSON */ }
  return text || `${res.status} ${res.statusText}`;
}

// One script token per warm function instance, renewed shortly before
// it lapses.
let cached: { token: string; expires: number } | null = null;

async function scriptToken(force = false): Promise<string> {
  if (!force && cached && Date.now() < cached.expires - 60_000) return cached.token;
  const res = await fetch(`${site()}/api/v1/auth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env("SHOTGRID_SCRIPT_NAME"),
      client_secret: env("SHOTGRID_SCRIPT_KEY"),
    }),
  });
  if (!res.ok) {
    cached = null;
    throw new HttpError(502, `ShotGrid refused the script key - check SHOTGRID_SCRIPT_NAME `
      + `and SHOTGRID_SCRIPT_KEY (${await errorText(res)})`);
  }
  const body = await res.json() as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

export class Client {
  /** Null only while signing in, before the artist's user is known. */
  constructor(public session: Session | null) {}

  static from(req: Request): Client {
    const session = readSession(req);
    if (!session) throw new HttpError(401, "Not signed in");
    return new Client(session);
  }

  get user(): Session["user"] {
    if (!this.session) throw new HttpError(401, "Not signed in");
    return this.session.user;
  }

  async request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/api/v1/")) throw new HttpError(400, "Bad ShotGrid path");

    const send = (token: string) => fetch(site() + path, {
      ...init,
      headers: { Accept: "application/json", ...init.headers, Authorization: `Bearer ${token}` },
    });

    let res = await send(await scriptToken());
    if (res.status === 401) res = await send(await scriptToken(true));
    if (!res.ok) throw new HttpError(502, await errorText(res));
    // Some successes have no body at all - completing an upload answers
    // 200 with nothing in it - so an empty reply is "done", not an error.
    const text = await res.text();
    return (text.trim() ? JSON.parse(text) : null) as T;
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
    return Response.json(body, { status });
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
