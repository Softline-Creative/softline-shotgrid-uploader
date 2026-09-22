/**
 * A stand-in for a ShotGrid site, for working on the web uploader
 * without one: `npm run dev:mock`. It speaks just enough of the REST API
 * for the functions in netlify/functions, and plays the part of the
 * storage bucket too (a browser PUT with CORS, returning an ETag).
 *
 * Sign in as artist / artist. Data resets on restart.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Rec = Record<string, any>;

const ent = (type: string, id: number, name: string) => ({ type, id, name });
const UFC = ent("CustomEntity01", 10, "UFC 331");
const RAF12 = ent("CustomEntity01", 12, "RAF 12");
const ICE = ent("CustomEntity02", 21, "Premium Ice");

export function seed() {
  return {
    HumanUser: [{ id: 42, name: "Test Artist", login: "artist", email: "artist@example.com" }],
    Sequence: [
      { id: 1, code: "Premium Ice Giveaway - UFC 331", sg_activations: UFC, sg_product: [ICE], sg_deliverable: [] },
      { id: 2, code: "Premium Ice Giveaway End Cards - UFC 331", sg_activations: UFC, sg_product: [], sg_deliverable: [] },
      { id: 3, code: "Press Conference - RAF 12", sg_activations: RAF12, sg_product: [], sg_deliverable: [] },
      { id: 6, code: "Premium Ice Giveaway Square - UFC 331", sg_activations: UFC, sg_product: [], sg_deliverable: [] },
      { id: 7, code: "Event Photography - RAF 12", sg_activations: RAF12, sg_product: [], sg_deliverable: [] },
    ] as Rec[],
    CustomEntity01: [{ id: 10, code: "UFC 331" }, { id: 12, code: "RAF 12" }, { id: 14, code: "Non-Activation" }],
    CustomEntity02: [{ id: 21, code: "Premium Ice" }, { id: 22, code: "No Product" }],
    CustomEntity03: [{ id: 31, code: "End Cards" }, { id: 32, code: "Social Cutdowns" }],
    Playlist: [] as Rec[],
    Version: [{ id: 500, code: "BRIO_UFC331_PremiumIceGiveaway_FinalCut_v003", entity: { type: "Sequence", id: 1, name: "x" } }] as Rec[],
  };
}

const LINK_FIELDS = new Set(["sg_activations", "sg_product", "sg_deliverable", "entity", "project", "user", "playlists"]);

function matches(row: Rec, filter: any[]): boolean {
  const [field, op, value] = filter;
  const v = row[field];
  const id = (x: any) => (x && typeof x === "object" ? x.id : x);
  if (op === "is") return field === "project" ? true : id(v) === id(value);
  if (op === "in") return (value as any[]).some((x) => id(x) === id(v));
  throw new Error(`mock: unsupported filter ${op}`);
}

function record(type: string, row: Rec, fields: string[]) {
  const attributes: Rec = {}, relationships: Rec = {};
  for (const f of fields) {
    if (f === "id") continue;
    if (LINK_FIELDS.has(f)) relationships[f] = { data: row[f] ?? null };
    else attributes[f] = row[f] ?? null;
  }
  return { type, id: row.id, attributes, relationships };
}

export function startMockShotgrid(port: number, appOrigin: string) {
  const db = seed();
  let nextId = 1000;
  const tokens = new Set<string>();
  const uploads = new Map<string, { version: number; bytes: number }>();
  const log: string[] = [];

  const read = (req: IncomingMessage) => new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Rec = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);
    const body = await read(req);

    // --- the "storage bucket" -------------------------------------------
    if (url.pathname.startsWith("/storage/")) {
      const cors = { "Access-Control-Allow-Origin": appOrigin, "Access-Control-Allow-Methods": "PUT",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Expose-Headers": "ETag" };
      if (req.method === "OPTIONS") return send(res, 204, undefined, cors);
      const key = url.pathname.slice("/storage/".length);
      const u = uploads.get(key);
      if (!u || req.method !== "PUT") return send(res, 403, { error: "bad upload" }, cors);
      u.bytes += body.length;
      log.push(`PUT ${key} ${body.length}`);
      return send(res, 200, undefined, { ...cors, ETag: `"etag-${key}"` });
    }

    // --- auth -------------------------------------------------------------
    if (url.pathname === "/api/v1/auth/access_token") {
      const p = new URLSearchParams(body.toString());
      const ok = (p.get("grant_type") === "password" && p.get("username") === "artist" && p.get("password") === "artist")
        || (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "refresh-1");
      if (!ok) return send(res, 400, { errors: [{ status: 400, title: "Can't authenticate user", detail: "Invalid login or password" }] });
      const token = `access-${nextId++}`;
      tokens.add(token);
      return send(res, 200, { token_type: "Bearer", access_token: token, refresh_token: "refresh-1", expires_in: 600 });
    }

    const auth = (req.headers.authorization ?? "").replace("Bearer ", "");
    if (!tokens.has(auth)) return send(res, 401, { errors: [{ status: 401, title: "Unauthorized" }] });

    // --- entities ---------------------------------------------------------
    let m = url.pathname.match(/^\/api\/v1\/entity\/(\w+)\/_search$/);
    if (m && req.method === "POST") {
      const rows = (db as Rec)[m[1]] as Rec[] | undefined;
      if (!rows) return send(res, 400, { errors: [{ detail: `unknown entity ${m[1]}` }] });
      const { filters } = JSON.parse(body.toString());
      const fields = (url.searchParams.get("fields") ?? "id").split(",");
      const size = Number(url.searchParams.get("page[size]") ?? 500);
      const page = Number(url.searchParams.get("page[number]") ?? 1);
      const hits = rows.filter((r) => filters.every((f: any[]) => matches(r, f)));
      return send(res, 200, { data: hits.slice((page - 1) * size, page * size).map((r) => record(m![1], r, fields)) });
    }

    m = url.pathname.match(/^\/api\/v1\/entity\/(\w+)$/);
    if (m && req.method === "POST") {
      const data = JSON.parse(body.toString());
      const row = { id: nextId++, ...data };
      ((db as Rec)[m[1]] as Rec[]).push(row);
      log.push(`create ${m[1]} ${row.code}`);
      return send(res, 201, { data: record(m[1], row, Object.keys(row)) });
    }

    m = url.pathname.match(/^\/api\/v1\/entity\/Version\/(\d+)\/sg_uploaded_movie\/_upload$/);
    if (m && req.method === "GET") {
      const key = `u${nextId++}`;
      uploads.set(key, { version: Number(m[1]), bytes: 0 });
      const link = `/api/v1/entity/versions/${m[1]}/sg_uploaded_movie/_upload`;
      return send(res, 200, {
        data: { timestamp: "t", upload_type: "Attachment", upload_id: key, storage_service: "s3",
          original_filename: url.searchParams.get("filename"), multipart_upload: false },
        links: { upload: `http://localhost:${port}/storage/${key}`, complete_upload: link },
      });
    }
    m = url.pathname.match(/^\/api\/v1\/entity\/versions\/(\d+)\/sg_uploaded_movie\/_upload$/);
    if (m && req.method === "POST") {
      const { upload_info } = JSON.parse(body.toString());
      const u = uploads.get(upload_info.upload_id);
      if (!u || !u.bytes) return send(res, 400, { errors: [{ detail: "nothing uploaded" }] });
      const version = db.Version.find((v) => v.id === Number(m![1]));
      if (version) version.sg_uploaded_movie = upload_info.original_filename;
      log.push(`complete ${m[1]}`);
      return send(res, 200, { data: {} });
    }

    send(res, 404, { errors: [{ detail: `mock: no route for ${req.method} ${url.pathname}` }] });
  });

  server.listen(port);
  return { server, db, log };
}
