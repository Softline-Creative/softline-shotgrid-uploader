import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, project, readJson } from "../lib/shotgrid";

const MAX_NAME = 255;

/**
 * A playlist by name, created if it doesn't exist: the daily review
 * playlist or one the artist named. Uploads are added to it.
 */
export default handler(async (req) => {
  const { code: raw } = await readJson<{ code?: string }>(req);
  const code = raw?.trim();
  if (!code) throw new HttpError(400, "A playlist needs a name");
  if (code.length > MAX_NAME) throw new HttpError(400, `Playlist names can be at most ${MAX_NAME} characters`);

  const client = Client.from(req);
  const [existing] = await client.find("Playlist",
    [["project", "is", project()], ["code", "is", code]], ["id", "code"]);
  if (existing) return client.json({ id: existing.id, code: existing.code ?? code, created: false });

  const created = await client.create("Playlist", {
    project: project(),
    code,
    description: `Created by the ShotGrid Uploader (web) for ${client.user.name}`,
  });
  return client.json({ id: created.id, code, created: true });
});

export const config: Config = { path: "/api/playlist", method: "POST" };
