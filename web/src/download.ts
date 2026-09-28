/**
 * Saving a Version's original file. Two ways, depending on the browser:
 *
 * - Chrome and Edge can write into a folder the artist picks, file by
 *   file with progress. Nothing lands until a file is complete (the
 *   browser writes to a temporary file and swaps it in), so a file
 *   already in the folder is a finished one and is skipped.
 * - Elsewhere each file is fetched and handed to the browser's own
 *   download, into the Downloads folder.
 */

export const canPickFolder = () => typeof (window as any).showDirectoryPicker === "function";

export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as any).showDirectoryPicker({ mode: "readwrite", id: "playlist-downloads" });
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;   // they closed the picker
    throw err;
  }
}

/** Names safe to save under: no path characters, and unique in the batch. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const clean = raw.replace(/[\\/:*?"<>|]+/g, "_").trim() || "untitled";
    const key = clean.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (!n) return clean;
    const dot = clean.lastIndexOf(".");
    return dot > 0 ? `${clean.slice(0, dot)} (${n + 1})${clean.slice(dot)}` : `${clean} (${n + 1})`;
  });
}

async function fetchFile(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("couldn't reach ShotGrid's storage from this page");
  }
  if (!res.ok) throw new Error(`storage refused the download (${res.status})`);
  return res;
}

/** True when the folder already holds a finished file of this name. */
export async function alreadySaved(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return file.size > 0;
  } catch {
    return false;
  }
}

export async function saveToFolder(
  dir: FileSystemDirectoryHandle, name: string, url: string, onProgress: (f: number) => void,
): Promise<void> {
  const res = await fetchFile(url);
  const total = Number(res.headers.get("content-length")) || 0;
  const handle = await dir.getFileHandle(name, { create: true });
  const out = await handle.createWritable();
  try {
    const reader = res.body!.getReader();
    let done = 0;
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      await out.write(value);
      done += value.length;
      if (total) onProgress(Math.min(done / total, 1));
    }
    await out.close();
  } catch (err) {
    await out.abort().catch(() => {});
    throw err;
  }
  onProgress(1);
}

/** Hand a file to the browser's own download. */
export async function saveToDownloads(name: string, url: string, onProgress: (f: number) => void): Promise<void> {
  const res = await fetchFile(url);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body!.getReader();
  const parts: BlobPart[] = [];
  let done = 0;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    parts.push(value);
    done += value.length;
    if (total) onProgress(Math.min(done / total, 1));
  }
  const href = URL.createObjectURL(new Blob(parts));
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  onProgress(1);
}
