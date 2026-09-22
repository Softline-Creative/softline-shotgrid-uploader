import { beforeAll, describe, expect, it } from "vitest";
import { newSession, readSession, seal, sessionCookie, unseal, type Session } from "../netlify/lib/session";
import { checkClaims, decodeIdToken, type Claims } from "../netlify/lib/google";
import { flatten, isUploadLink } from "../netlify/lib/shotgrid";

beforeAll(() => { process.env.SESSION_SECRET = "x".repeat(40); });

const user = { id: 1, name: "N", login: "n", email: "n@softlinesolutions.com" };

describe("session cookie", () => {
  it("round-trips and rejects tampering", () => {
    const session = newSession(user);
    const sealed = seal(session);
    expect(unseal(sealed)).toEqual(session);
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
    expect(unseal(flipped)).toBeNull();
  });

  it("is read back from a request, until it expires", () => {
    const session = newSession(user);
    const cookie = (s: Session) => sessionCookie(s).split(";")[0];
    const req = (s: Session) => new Request("https://x/", { headers: { cookie: `other=1; ${cookie(s)}` } });
    expect(readSession(req(session))).toEqual(session);
    expect(readSession(req({ ...session, expires: Date.now() - 1 }))).toBeNull();
    expect(sessionCookie(session)).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  });
});

describe("Google ID token claims", () => {
  const good: Claims = {
    iss: "https://accounts.google.com", aud: "client", exp: Date.now() / 1000 + 300,
    email: "RKim@softlinesolutions.com", email_verified: true, hd: "softlinesolutions.com",
  };
  const check = (c: Partial<Claims>) => checkClaims({ ...good, ...c }, "client", "softlinesolutions.com");

  it("accepts a verified work account, lowercasing the email", () => {
    expect(check({})).toBe("rkim@softlinesolutions.com");
  });
  it.each<[string, Partial<Claims>, RegExp]>([
    ["another issuer", { iss: "https://evil.example" }, /issued by Google/],
    ["another app", { aud: "other" }, /different app/],
    ["an expired token", { exp: 1 }, /expired/],
    ["an unverified email", { email_verified: false }, /verified/],
    ["a personal Gmail", { email: "someone@gmail.com", hd: undefined }, /@softlinesolutions.com/],
    ["a work-looking email without the Workspace claim", { hd: undefined }, /@softlinesolutions.com/],
    ["another Workspace", { hd: "other.com", email: "a@other.com" }, /@softlinesolutions.com/],
  ])("rejects %s", (_name, c, message) => {
    expect(() => check(c)).toThrow(message);
  });
  it("decodes the token payload", () => {
    const token = ["h", Buffer.from(JSON.stringify(good)).toString("base64url"), "s"].join(".");
    expect(decodeIdToken(token)).toEqual(good);
  });
});

it("flattens REST records into the Python API's shape", () => {
  expect(flatten({
    type: "Sequence", id: 3,
    attributes: { code: "A - B" },
    relationships: { sg_activations: { data: { type: "CustomEntity01", id: 1, name: "B" } }, sg_product: { data: [] } },
  })).toEqual({
    type: "Sequence", id: 3, code: "A - B",
    sg_activations: { type: "CustomEntity01", id: 1, name: "B" }, sg_product: [],
  });
});

it("only accepts ShotGrid upload links", () => {
  expect(isUploadLink("/api/v1/entity/versions/12/sg_uploaded_movie/_upload")).toBe(true);
  expect(isUploadLink("/api/v1/entity/versions/12/sg_uploaded_movie/_upload/multipart?part_number=2")).toBe(true);
  expect(isUploadLink("/api/v1/entity/versions/12")).toBe(false);
  expect(isUploadLink("https://evil/api/v1/entity/versions/12/sg_uploaded_movie/_upload")).toBe(false);
});
