import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({
  api: {
    uploadStart: vi.fn(),
    uploadPart: vi.fn(),
    uploadComplete: vi.fn(),
  },
}));

import { api } from "../src/api";
import { MULTIPART_THRESHOLD, PART_SIZE, uploadFile } from "../src/upload";

/** Records every PUT and answers with an ETag (or not). */
function fakeXhr(etag: string | null) {
  const puts: { url: string; size: number }[] = [];
  class Xhr {
    status = 200;
    responseText = "";
    upload = { onprogress: null as null | ((e: { loaded: number }) => void) };
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    private url = "";
    open(_m: string, url: string) { this.url = url; }
    setRequestHeader() {}
    getResponseHeader(name: string) { return name === "ETag" ? etag : null; }
    send(body: Blob) {
      puts.push({ url: this.url, size: body.size });
      this.upload.onprogress?.({ loaded: body.size });
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("XMLHttpRequest", Xhr);
  return puts;
}

/** A File-like object reporting a large size without allocating it. */
function bigFile(size: number): File {
  return {
    name: "Big_Cut_v1.mov", size, type: "video/quicktime",
    slice: (start: number, end: number) => ({ size: Math.min(end, size) - start }) as Blob,
  } as unknown as File;
}

const job = (file: File) => ({ file, path: file.name, sequenceId: 1, code: "X", playlistId: 2 });

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("uploadFile", () => {
  it("sends a small file in one PUT and completes it", async () => {
    const puts = fakeXhr('"e1"');
    vi.mocked(api.uploadStart).mockResolvedValue({
      versionId: 7, info: { upload_id: "u" }, upload: "https://s3/one", next: null, complete: "/c",
    });
    const file = new File([new Uint8Array(100)], "Small_Cut_v1.mov");
    const progress: number[] = [];
    await expect(uploadFile(job(file), (p) => progress.push(p))).resolves.toBe(7);
    expect(vi.mocked(api.uploadStart).mock.calls[0][0].multipart).toBe(false);
    expect(puts).toEqual([{ url: "https://s3/one", size: 100 }]);
    expect(api.uploadComplete).toHaveBeenCalledWith({ link: "/c", info: { upload_id: "u" }, etags: undefined, filename: "Small_Cut_v1.mov" });
    expect(progress.at(-1)).toBe(1);
  });

  it("sends a large file in parts, collecting ETags", async () => {
    const puts = fakeXhr('"etag"');
    const size = MULTIPART_THRESHOLD + 5;   // just over 500 MiB: 27 parts
    vi.mocked(api.uploadStart).mockResolvedValue({
      versionId: 8, info: { upload_id: "m" }, upload: "https://s3/p1", next: "/next/2", complete: "/c",
    });
    let n = 2;
    vi.mocked(api.uploadPart).mockImplementation(async () => ({ upload: `https://s3/p${n}`, next: `/next/${++n}` }));
    await uploadFile(job(bigFile(size)), () => {});
    expect(vi.mocked(api.uploadStart).mock.calls[0][0].multipart).toBe(true);
    expect(puts).toHaveLength(27);
    expect(puts[0]).toEqual({ url: "https://s3/p1", size: PART_SIZE });
    expect(puts[26]).toEqual({ url: "https://s3/p27", size: size - PART_SIZE * 26 });
    expect(vi.mocked(api.uploadComplete).mock.calls[0][0].etags).toHaveLength(27);
  });

  it("stops with a clear error when part ETags aren't readable", async () => {
    fakeXhr(null);
    vi.mocked(api.uploadStart).mockResolvedValue({
      versionId: 9, info: {}, upload: "https://s3/p1", next: "/next/2", complete: "/c",
    });
    await expect(uploadFile(job(bigFile(PART_SIZE * 30)), () => {})).rejects.toThrow(/ETag/);
    expect(api.uploadComplete).not.toHaveBeenCalled();
  });
});
