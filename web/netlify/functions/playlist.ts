import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, project, readJson } from "../lib/shotgrid";

/**
 * Today's review playlist, created if it doesn't exist. "Today" is the
 * artist's local date, sent by the browser, matching the desktop app's
 * PLAYLIST_NAME_FORMAT of %Y%m%d_Review.
 */
export default handler(async (req) => {
  const { date } = await readJson<{ date?: string }>(req);
  if (!date || !/^\d{8}$/.test(date)) throw new HttpError(400, "Expected date as YYYYMMDD");
  const code = `${date}_Review`;

  const client = Client.from(req);
  const [existing] = await client.find("Playlist",
    [["project", "is", project()], ["code", "is", code]], ["id", "code"]);
  if (existing) return client.json({ id: existing.id, code, created: false });

  const created = await client.create("Playlist", {
    project: project(),
    code,
    description: "Auto-created by the ShotGrid Uploader (web)",
  });
  return client.json({ id: created.id, code, created: true });
});

export const config: Config = { path: "/api/playlist", method: "POST" };
