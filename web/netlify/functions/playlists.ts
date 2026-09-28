import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, project } from "../lib/shotgrid";

const RECENT = 100;

/**
 * What the playlist step needs to suggest: whether today's review
 * playlist exists yet, and the project's most recent playlists to pick
 * from. "Today" is the artist's local date, sent by the browser, matching
 * the desktop app's PLAYLIST_NAME_FORMAT of %Y%m%d_Review.
 * With ?all=1 it lists every playlist, newest first, for the download
 * tool.
 */
export default handler(async (req) => {
  const params = new URL(req.url).searchParams;
  const date = params.get("date") ?? "";
  if (!/^\d{8}$/.test(date)) throw new HttpError(400, "Expected date as YYYYMMDD");
  const today = `${date}_Review`;
  // The download tool wants every playlist, not just the recent ones.
  const limit = params.get("all") ? Infinity : RECENT;

  const client = Client.from(req);
  const rows = await client.find("Playlist", [["project", "is", project()]], ["id", "code", "created_at"]);
  const recent = rows
    .filter((r) => r.code)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || b.id - a.id)
    .slice(0, limit)
    .map((r) => ({ id: r.id as number, code: r.code as string }));
  const match = rows.find((r) => (r.code ?? "").trim().toLowerCase() === today.toLowerCase());

  return client.json({ today: { code: today, id: match?.id ?? null }, recent });
});

export const config: Config = { path: "/api/playlists", method: "GET" };
