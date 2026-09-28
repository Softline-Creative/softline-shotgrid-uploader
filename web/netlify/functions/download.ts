import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, site } from "../lib/shotgrid";

/**
 * A fresh, short-lived address for one Version's original uploaded file.
 * The browser downloads from it directly - files never pass through
 * Netlify, whose functions cap responses at 6 MB.
 *
 * ShotGrid's own attachment address (/file_serve/...) only works for
 * someone signed in to ShotGrid, so where possible this asks ShotGrid to
 * redirect to the storage address instead and hands that over.
 */
export default handler(async (req) => {
  const id = Number(new URL(req.url).searchParams.get("versionId"));
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Expected versionId");
  const client = Client.from(req);

  const [version] = await client.find("Version", [["id", "is", id]], ["code", "sg_uploaded_movie"]);
  const movie = version?.sg_uploaded_movie;
  if (!movie) throw new HttpError(404, "This Version has no uploaded movie");
  const name = (movie.name as string) || `${version.code}`;
  const listed = typeof movie.url === "string" ? movie.url as string : "";

  // Already a storage address (not ShotGrid's own site)? Use it.
  if (listed && !listed.startsWith(site())) return client.json({ url: listed, name, signedIn: false });

  const res = await client.raw(`/api/v1/entity/Version/${id}/sg_uploaded_movie?alt=original`, {
    redirect: "manual",
  });
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    return client.json({ url: new URL(location, site()).toString(), name, signedIn: false });
  }
  if (res.ok) {
    const body = await res.json().catch(() => null);
    const url = body?.data?.url ?? body?.url;
    if (typeof url === "string" && !url.startsWith(site())) return client.json({ url, name, signedIn: false });
  }
  // Last resort: ShotGrid's own address, which needs a ShotGrid sign-in
  // in the same browser.
  if (listed) return client.json({ url: listed, name, signedIn: true });
  throw new HttpError(502, `ShotGrid didn't give a download address (${res.status})`);
});

export const config: Config = { path: "/api/download", method: "GET" };
