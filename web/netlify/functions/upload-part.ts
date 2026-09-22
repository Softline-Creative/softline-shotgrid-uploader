import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, isUploadLink, readJson } from "../lib/shotgrid";

/** The next part's upload address, for files sent in several parts. */
export default handler(async (req) => {
  const { link } = await readJson<{ link?: string }>(req);
  if (!link || !isUploadLink(link)) throw new HttpError(400, "Bad upload link");
  const client = Client.from(req);
  const part = await client.request<{ links: { upload: string; get_next_part?: string } }>(link);
  return client.json({ upload: part.links.upload, next: part.links.get_next_part ?? null });
});

export const config: Config = { path: "/api/upload/part", method: "POST" };
