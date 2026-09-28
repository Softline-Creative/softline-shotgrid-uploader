import type { Config } from "@netlify/functions";
import { Client, HttpError, handler } from "../lib/shotgrid";

/**
 * The Versions in one playlist, in playlist order, with the name of each
 * one's original uploaded file. Download addresses expire, so they're
 * fetched one at a time by /api/download when each file is due.
 */
export default handler(async (req) => {
  const id = Number(new URL(req.url).searchParams.get("playlistId"));
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Expected playlistId");
  const client = Client.from(req);
  const playlist = { type: "Playlist", id };

  const [versions, order] = await Promise.all([
    client.find("Version", [["playlists", "is", playlist]], ["code", "entity", "sg_uploaded_movie"]),
    // The playlist's own running order lives on these connection records.
    client.find("PlaylistVersionConnection", [["playlist", "is", playlist]], ["version", "sg_sort_order"])
      .catch(() => []),
  ]);
  const rank = new Map(order.map((c) => [c.version?.id, Number(c.sg_sort_order ?? 0)]));

  return client.json({
    versions: versions
      .map((v) => ({
        id: v.id as number,
        code: (v.code as string) ?? `Version ${v.id}`,
        sequence: (v.entity?.name as string) ?? "",
        file: v.sg_uploaded_movie ? { name: (v.sg_uploaded_movie.name as string) || "" } : null,
      }))
      .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) || (a.code < b.code ? -1 : 1)),
  });
});

export const config: Config = { path: "/api/playlist-versions", method: "GET" };
