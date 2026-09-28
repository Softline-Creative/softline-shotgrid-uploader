/**
 * "Download playlist" - fetch the original uploaded file of every Version
 * in a playlist. The files come straight from ShotGrid's storage.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type PlaylistVersion } from "../api";
import { alreadySaved, canPickFolder, pickFolder, saveToDownloads, saveToFolder, uniqueNames } from "../download";
import { today } from "../queue";
import { Picker, type PickerSection } from "./Picker";

type RowState = { state: "waiting" | "saving" | "done" | "skipped" | "failed"; progress: number; message?: string };

export function DownloadScreen() {
  const [playlists, setPlaylists] = useState<{ id: number; code: string }[] | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [versions, setVersions] = useState<PlaylistVersion[] | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<Map<number, RowState>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const folderMode = canPickFolder();

  useEffect(() => {
    api.allPlaylists(today()).then((r) => setPlaylists(r.recent), (e) => setError(e.message));
  }, []);

  // Leaving mid-download would abandon it.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const choose = async (id: number) => {
    setChosen(id);
    setVersions(null);
    setRows(new Map());
    setSummary("");
    setError("");
    try {
      const { versions } = await api.playlistVersions(id);
      setVersions(versions);
      setTicked(new Set(versions.filter((v) => v.file).map((v) => v.id)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sections: PickerSection<number>[] = useMemo(() => [{
    options: (playlists ?? []).map((p) => ({ key: String(p.id), label: p.code, value: p.id })),
  }], [playlists]);

  const withFiles = versions?.filter((v) => v.file) ?? [];
  const selected = withFiles.filter((v) => ticked.has(v.id));
  const names = useMemo(() => {
    const list = versions?.filter((v) => v.file) ?? [];
    const unique = uniqueNames(list.map((v) => v.file!.name || v.code));
    return new Map(list.map((v, i) => [v.id, unique[i]]));
  }, [versions]);

  const set = (id: number, row: RowState) => setRows((m) => new Map(m).set(id, row));

  const download = async () => {
    setError("");
    setSummary("");
    let dir: FileSystemDirectoryHandle | null = null;
    if (folderMode) {
      dir = await pickFolder().catch((e) => { setError((e as Error).message); return null; });
      if (!dir) return;
    }
    setBusy(true);
    const counts = { done: 0, skipped: 0, failed: 0 };
    for (const v of selected) set(v.id, { state: "waiting", progress: 0 });
    for (const v of selected) {
      const name = names.get(v.id)!;
      try {
        if (dir && await alreadySaved(dir, name)) {
          set(v.id, { state: "skipped", progress: 1, message: "already in the folder" });
          counts.skipped++;
          continue;
        }
        set(v.id, { state: "saving", progress: 0 });
        const target = await api.downloadUrl(v.id);
        const progress = (p: number) => set(v.id, { state: "saving", progress: p });
        if (target.signedIn) {
          // Only ShotGrid's own address was offered; it works in a tab
          // for someone signed in to ShotGrid in this browser.
          window.open(target.url, "_blank", "noopener");
          set(v.id, { state: "done", progress: 1, message: "opened in a new tab" });
        } else if (dir) {
          await saveToFolder(dir, name, target.url, progress);
          set(v.id, { state: "done", progress: 1 });
        } else {
          await saveToDownloads(name, target.url, progress);
          set(v.id, { state: "done", progress: 1 });
        }
        counts.done++;
      } catch (e) {
        set(v.id, { state: "failed", progress: 0, message: (e as Error).message });
        counts.failed++;
      }
    }
    setBusy(false);
    setSummary(`${counts.done} downloaded`
      + (counts.skipped ? `, ${counts.skipped} already in the folder` : "")
      + (counts.failed ? `, ${counts.failed} failed` : "") + ".");
  };

  const statusOf = (v: PlaylistVersion): [string, string] => {
    if (!v.file) return ["No uploaded movie", "dim"];
    const r = rows.get(v.id);
    if (!r) return [ticked.has(v.id) ? "Ready" : "Not selected", "dim"];
    if (r.state === "waiting") return ["Waiting", "dim"];
    if (r.state === "saving") return [`Downloading ${Math.round(r.progress * 100)}%`, "accent"];
    if (r.state === "done") return [r.message ? `Done - ${r.message}` : "Done", "green"];
    if (r.state === "skipped") return [`Skipped - ${r.message}`, "green"];
    return [`Failed: ${r.message}`, "red"];
  };

  const allTicked = withFiles.length > 0 && selected.length === withFiles.length;

  return (
    <section className="screen embedded">
      <header className="screen-head">
        <div>
          <h2>Download a playlist</h2>
          <p className="hint">Downloads the original file each artist uploaded (the Uploaded Movie),
            not ShotGrid's review copy.</p>
          <p className="hint">{folderMode
            ? "You'll choose a folder to save into. Files already in that folder are skipped, so you can run it again to pick up anything added since."
            : "Each file goes to your Downloads folder, and your browser may ask to allow several downloads. For large playlists, Chrome or Edge is better: they save straight into a folder you choose."}</p>
        </div>
      </header>

      <div className="card bulk">
        <span>Playlist</span>
        <Picker ariaLabel="Playlist" sections={sections} selected={chosen ? String(chosen) : null}
          prompt={playlists ? "Choose a playlist" : "Loading playlists..."}
          onChange={(o) => !busy && choose(o.value)} />
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {chosen && !versions && !error && <p className="hint">Loading Versions...</p>}

      {versions && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="tick"><input type="checkbox" aria-label="Tick all" checked={allTicked} disabled={busy}
                  onChange={() => setTicked(allTicked ? new Set() : new Set(withFiles.map((v) => v.id)))} /></th>
                <th>Version</th><th>Sequence</th><th>Saves as</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => {
                const [status, colour] = statusOf(v);
                return (
                  <tr key={v.id}>
                    <td className="tick"><input type="checkbox" aria-label={`Tick ${v.code}`}
                      disabled={!v.file || busy} checked={ticked.has(v.id)}
                      onChange={() => setTicked((t) => { const n = new Set(t); if (!n.delete(v.id)) n.add(v.id); return n; })} /></td>
                    <td>{v.code}</td>
                    <td className="dim">{v.sequence || "-"}</td>
                    <td>{v.file ? names.get(v.id) : "-"}</td>
                    <td className={colour}>{status}</td>
                  </tr>
                );
              })}
              {!versions.length && <tr><td colSpan={5} className="empty">This playlist has no Versions.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {versions && (
        <footer className="screen-foot">
          <span className="green">{summary}</span>
          <button className="primary" disabled={busy || !selected.length} onClick={download}>
            {busy ? "Downloading..." : folderMode
              ? `Choose folder and download ${selected.length} file${selected.length === 1 ? "" : "s"}`
              : `Download ${selected.length} file${selected.length === 1 ? "" : "s"}`}
          </button>
        </footer>
      )}
    </section>
  );
}
