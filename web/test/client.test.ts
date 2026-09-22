import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "../netlify/lib/shotgrid";

beforeAll(() => {
  process.env.SHOTGRID_SITE = "https://sg.example";
  process.env.SHOTGRID_SCRIPT_NAME = "s";
  process.env.SHOTGRID_SCRIPT_KEY = "k";
});
afterEach(() => vi.unstubAllGlobals());

/** ShotGrid stand-in: a token, then the given reply to the real call. */
function reply(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/auth/access_token")
    ? Response.json({ access_token: "t", expires_in: 600 })
    : new Response(body, { status })));
}

describe("Client.request", () => {
  it("treats an empty success reply as no data", async () => {
    // Completing an upload returns 200 with nothing in it.
    reply(200, "");
    await expect(new Client(null).request("/api/v1/entity/versions/1/sg_uploaded_movie/_upload",
      { method: "POST" })).resolves.toBeNull();
  });

  it("still reads JSON replies", async () => {
    reply(200, '{"data":{"id":3}}');
    await expect(new Client(null).request("/api/v1/entity/Version/3")).resolves.toEqual({ data: { id: 3 } });
  });

  it("reports ShotGrid's own error text", async () => {
    reply(400, '{"errors":[{"detail":"bad field"}]}');
    await expect(new Client(null).request("/api/v1/entity/Version/3")).rejects.toThrow("bad field");
  });
});
