import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, readJson } from "../lib/shotgrid";

/**
 * Version names already on these Sequences, so a clash can be caught
 * before uploading (the desktop app's _check_versions).
 */
export default handler(async (req) => {
  const { sequenceIds } = await readJson<{ sequenceIds?: number[] }>(req);
  if (!Array.isArray(sequenceIds) || !sequenceIds.every(Number.isInteger)) {
    throw new HttpError(400, "Expected sequenceIds");
  }
  const client = Client.from(req);
  if (!sequenceIds.length) return client.json({ versions: [] });

  const rows = await client.find("Version",
    [["entity", "in", sequenceIds.map((id) => ({ type: "Sequence", id }))]],
    ["code", "entity"]);
  return client.json({
    versions: rows.map((r) => ({ sequenceId: r.entity?.id ?? null, code: r.code ?? "" })),
  });
});

export const config: Config = { path: "/api/versions/check", method: "POST" };
