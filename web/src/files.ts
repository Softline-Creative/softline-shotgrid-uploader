/**
 * Collecting files from a drop or a picker. A dropped folder contributes
 * the media files directly inside it, as the desktop app does - not
 * files in subfolders.
 */
export interface Picked { file: File; path: string }

function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(out);
      else { out.push(...batch); next(); }
    }, reject);
    next();
  });
}

const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

export async function fromDrop(data: DataTransfer): Promise<Picked[]> {
  const entries = [...data.items]
    .map((i) => (i.kind === "file" ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...data.files].map((file) => ({ file, path: file.name }));

  const out: Picked[] = [];
  for (const entry of entries) {
    if (entry.isFile) {
      out.push({ file: await fileOf(entry as FileSystemFileEntry), path: entry.name });
    } else if (entry.isDirectory) {
      const children = await readAll(entry as FileSystemDirectoryEntry);
      children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const child of children) {
        if (child.isFile) {
          out.push({ file: await fileOf(child as FileSystemFileEntry), path: `${entry.name}/${child.name}` });
        }
      }
    }
  }
  return out;
}

export function fromInput(list: FileList | null): Picked[] {
  return [...(list ?? [])]
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
    // A chosen folder: only files directly inside it.
    .filter(({ path }) => path.split("/").length <= 2);
}
