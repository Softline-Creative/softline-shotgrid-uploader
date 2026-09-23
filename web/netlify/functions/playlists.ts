import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, project } from "../lib/shotgrid";

const RECENT = 100;

/**
 * What the playlist step needs to suggest: whether today's review
 * playlist exists yet, and the project's most recent playlists to pick
 * from. "Today" is the artist's local date, sent by the browser, matching
 * the desktop app's PLAYLIST_NAME_FORMAT of %Y%m%d_Review.
 */
export default handler(async (req) => {
  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!/^\d{8}$/.test(date)) throw new HttpError(400, "Expected date as YYYYMMDD");
  const today = `${date}_Review`;

  const client = Client.from(req);
  const rows = await client.find("Playlist", [["project", "is", project()]], ["id", "code", "created_at"]);
  const recent = rows
    .filter((r) => r.code)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || b.id - a.id)
    .slice(0, RECENT)
    .map((r) => ({ id: r.id as number, code: r.code as string }));
  const match = rows.find((r) => (r.code ?? "").trim().toLowerCase() === today.toLowerCase());

  return client.json({ today: { code: today, id: match?.id ?? null }, recent });
});

export const config: Config = { path: "/api/playlists", method: "GET" };
