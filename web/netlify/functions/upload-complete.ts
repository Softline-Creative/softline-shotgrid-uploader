import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, isUploadLink, readJson } from "../lib/shotgrid";

/** Tell ShotGrid the file has landed, which attaches it and starts transcoding. */
export default handler(async (req) => {
  const { link, info, etags, filename } = await readJson<{
    link?: string; info?: Record<string, unknown>; etags?: string[]; filename?: string;
  }>(req);
  if (!link || !isUploadLink(link) || !info) throw new HttpError(400, "Bad completion request");

  const client = Client.from(req);
  await client.request(link, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      upload_info: etags?.length ? { ...info, etags } : info,
      upload_data: filename ? { display_name: filename } : {},
    }),
  });
  return client.json({ ok: true });
});

export const config: Config = { path: "/api/upload/complete", method: "POST" };
