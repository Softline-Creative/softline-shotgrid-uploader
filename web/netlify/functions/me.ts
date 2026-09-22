import type { Config } from "@netlify/functions";
import { HttpError, handler, site } from "../lib/shotgrid";
import { readSession } from "../lib/session";

/** Who is signed in, without a round trip to ShotGrid. */
export default handler(async (req) => {
  const session = readSession(req);
  if (!session) throw new HttpError(401, "Not signed in");
  return Response.json({ user: session.user, site: site() });
});

export const config: Config = { path: "/api/me", method: "GET" };
