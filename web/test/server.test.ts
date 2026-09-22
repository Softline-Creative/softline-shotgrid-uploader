import { beforeAll, describe, expect, it } from "vitest";
import { readSession, seal, sessionCookie, unseal, type Session } from "../netlify/lib/session";
import { flatten, isUploadLink } from "../netlify/lib/shotgrid";

beforeAll(() => { process.env.SESSION_SECRET = "x".repeat(40); });

const session: Session = { access: "a", refresh: "r", expires: 1, user: { id: 1, name: "N", login: "n" } };

describe("session cookie", () => {
  it("round-trips and rejects tampering", () => {
    const sealed = seal(session);
    expect(unseal(sealed)).toEqual(session);
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
    expect(unseal(flipped)).toBeNull();
  });

  it("is read back from a request", () => {
    const value = sessionCookie(session).split(";")[0];
    const req = new Request("https://x/", { headers: { cookie: `other=1; ${value}` } });
    expect(readSession(req)).toEqual(session);
    expect(sessionCookie(session)).toMatch(/HttpOnly; Secure; SameSite=Strict/);
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
