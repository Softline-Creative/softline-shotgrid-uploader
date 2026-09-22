import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, passwordGrant, readJson } from "../lib/shotgrid";
import { sessionCookie } from "../lib/session";

/** Sign in with the artist's own ShotGrid login. */
export default handler(async (req) => {
  const { username, password, otp } = await readJson<{
    username?: string; password?: string; otp?: string;
  }>(req);
  if (!username?.trim() || !password) throw new HttpError(400, "Enter your login and password");

  const token = await passwordGrant(username.trim(), password, otp?.trim() || undefined);
  const client = new Client({
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    user: { id: 0, name: "", login: username.trim() },
  });

  // Uploads are credited to this person, as the desktop app does with
  // its stored login. People sign in with either login or email.
  let [user] = await client.find("HumanUser", [["login", "is", username.trim()]], ["id", "name", "login"]);
  if (!user) {
    [user] = await client.find("HumanUser", [["email", "is", username.trim()]], ["id", "name", "login"]);
  }
  if (!user) throw new HttpError(403, "Signed in, but no ShotGrid user matches that login");

  client.session.user = { id: user.id, name: user.name, login: user.login };
  return new Response(JSON.stringify({ user: client.session.user }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(client.session) },
  });
});

export const config: Config = { path: "/api/login", method: "POST" };
