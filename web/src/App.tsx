/**
 * The queue window. Flow, as in the desktop app:
 *
 *   drop files -> Next -> Where does this belong? -> Sequences found
 *   -> back to the queue -> Upload
 *
 * Nothing is written to ShotGrid until Upload.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, signedOut, type Catalog, type User } from "./api";
import { fromDrop, fromInput, type Picked } from "./files";
import { BRANDS, isKnownStage, splitext, suggestSequenceName, versionLabel, type Sequence } from "./lib/naming";
import {
  addFiles, applyAssignments, defaultsFor, findClashes, isMedia, isReady, recompute, today,
  versionName, videosToAssign, type Assignment, type Destination, type Group, type Item, type NewSequence,
} from "./queue";
import { uploadFile } from "./upload";
import { AssignScreen } from "./components/AssignScreen";
import { Login } from "./components/Login";
import { MatchesScreen } from "./components/MatchesScreen";
import { CreateScreen, toNewSequence, type CreateResult, type Job } from "./components/CreateScreen";
import { PlaylistDialog, type PlaylistChoice } from "./components/PlaylistDialog";

type Step = "queue" | "assign" | "matches" | "create";

interface Clash { item: Item; name: string }

function loadBrand(): string {
  try {
    const saved = localStorage.getItem("brand");
    if (saved && BRANDS.includes(saved)) return saved;
  } catch { /* storage unavailable */ }
  return BRANDS[0];
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then((r) => setUser(r.user), () => setUser(null));
    const out = () => setUser(null);
    signedOut.addEventListener("signedout", out);
    return () => signedOut.removeEventListener("signedout", out);
  }, []);

  if (user === undefined) return <main className="login"><p className="hint">Loading...</p></main>;
  if (!user) return <Login />;
  return <Uploader user={user} onSignOut={() => api.logout().finally(() => setUser(null))} />;
}

function Uploader({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [assignments, setAssignments] = useState(new Map<string, Assignment>());
  const [destinations, setDestinations] = useState(new Map<string, Destination>());
  // New Sequences to create on Upload, by the key of the group naming each.
  const [newSequences, setNewSequences] = useState(new Map<string, NewSequence>());
  const [createState, setCreateState] = useState<CreateResult>({ forms: new Map(), shares: new Map() });
  const [previewed, setPreviewed] = useState(false);
  const [destinationsSet, setDestinationsSet] = useState(false);
  const [step, setStep] = useState<Step>("queue");
  const [matchesVersion, setMatchesVersion] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [brand, setBrand] = useState(loadBrand);
  const [busy, setBusy] = useState<"" | "loading" | "refreshing" | "uploading">("");
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [hot, setHot] = useState(false);
  const [run, setRun] = useState<string[]>([]);
  const [playlistAsk, setPlaylistAsk] = useState<{
    today: { code: string; id: number | null }; recent: { id: number; code: string }[];
    count: number; resolve: (c: PlaylistChoice | null) => void;
  } | null>(null);
  const [clashes, setClashes] = useState<{ list: Clash[]; resolve: (c: "skip" | "anyway" | "cancel") => void } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const say = useCallback((line = "") => setLog((l) => [...l, line]), []);

  useEffect(() => {
    try { localStorage.setItem("brand", brand); } catch { /* storage unavailable */ }
  }, [brand]);

  // Leaving mid-upload would abandon the transfer.
  useEffect(() => {
    if (busy !== "uploading") return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const resetMatching = () => {
    setPreviewed(false);
    setDestinationsSet(false);
    setGroups([]);
    setDestinations(new Map());
    setNewSequences(new Map());
  };

  const add = (picked: Picked[]) => {
    if (busy === "uploading") return;
    for (const p of picked) {
      if (!isMedia(p.file.name) && !p.file.name.startsWith(".")) {
        say(`Ignored (not a video or still): ${p.file.name}`);
      }
    }
    const added = addFiles(items, picked);
    if (!added.length) return;
    setItems([...items, ...added]);
    resetMatching();
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setHot(false);
    add(await fromDrop(e.dataTransfer));
  };

  const fetchCatalog = async () => {
    const c = await api.catalog();
    setCatalog(c);
    say(`${c.sequences.length} Sequences, ${c.activations.length} Activations, `
      + `${c.products.length} Products, ${c.deliverables.length} Deliverables.`);
    return c;
  };

  const fail = (err: unknown) => {
    say(`ERROR: ${(err as Error).message}`);
    setShowLog(true);
  };

  /** Re-read everything from ShotGrid without losing the queue. */
  const refresh = async () => {
    setBusy("refreshing");
    try {
      const c = await fetchCatalog();
      // On the Create screen a refresh only brings in new Activations,
      // Products and Deliverables; the choices made so far stand.
      if (previewed && step !== "create") {
        const r = recompute(items, c);
        setItems(r.items);
        setGroups(r.groups);
        // Re-propose the best matches; a Sequence that appeared just
        // now is the likely reason for refreshing.
        setDestinations(new Map());
        setDestinationsSet(false);
        setMatchesVersion((v) => v + 1);
      }
    } catch (err) { fail(err); } finally { setBusy(""); }
  };

  const onNext = async () => {
    if (!previewed) {
      setBusy("loading");
      try {
        if (!catalog) await fetchCatalog();
        if (!videosToAssign(items).length) {
          say("Nothing uploadable - fix the filenames above.");
          return;
        }
        setStep("assign");
      } catch (err) { fail(err); } finally { setBusy(""); }
    } else if (!destinationsSet) {
      setStep("matches");
    } else {
      await upload();
    }
  };

  const onAssigned = (chosen: Map<string, Assignment>) => {
    setAssignments(chosen);
    const r = recompute(applyAssignments(items, chosen), catalog!);
    setItems(r.items);
    setGroups(r.groups);
    setDestinations(new Map());
    setPreviewed(true);
    setDestinationsSet(false);
    const odd = [...new Set(r.items.filter((i) => isReady(i) && i.parsed!.stage
      && !isKnownStage(i.parsed!.stage, i.parsed!.kind)).map((i) => i.parsed!.stage))];
    if (odd.length) say(`Unfamiliar stage(s): ${odd.join(", ")} - used as typed, check for typos.`);
    setMatchesVersion((v) => v + 1);
    setStep("matches");
  };

  const finishMatching = (chosen: Map<string, Destination>, created: Map<string, NewSequence>) => {
    setDestinations(chosen);
    setNewSequences(created);
    setDestinationsSet(true);
    setStep("queue");
    const skipped = [...chosen.values()].filter((d) => !d.sequence && !d.newOwner).length;
    say(`Destinations chosen for ${chosen.size} video(s)`
      + (created.size ? ` - ${created.size} new Sequence(s) to create` : "")
      + (skipped ? ` - ${skipped} skipped` : "") + ". Check the list, then click Upload.");
  };

  const onMatched = (chosen: Map<string, Destination>) => {
    // Kept even when a Create screen follows, so Back returns to these picks.
    setDestinations(chosen);
    if ([...chosen.values()].some((d) => d.newOwner)) setStep("create");
    else finishMatching(chosen, new Map());
  };

  const createJobs = (): Job[] => groups
    .filter((g) => destinations.get(g.key)?.newOwner)
    .map((g) => ({
      key: g.key,
      title: g.title,
      hint: suggestSequenceName(g.items[0].file.name),
      defaults: defaultsFor(g, catalog!.sequences),
    }));

  const onCreated = (result: CreateResult, names: Map<string, string>) => {
    setCreateState(result);
    const chosen = new Map(destinations);
    const created = new Map<string, NewSequence>();
    for (const [key, d] of destinations) {
      if (!d.newOwner) continue;
      const owner = result.shares.get(key) ?? key;
      chosen.set(key, { sequence: null, score: null, newOwner: owner });
      if (!created.has(owner)) created.set(owner, toNewSequence(names.get(owner)!, result.forms.get(owner)!));
    }
    finishMatching(chosen, created);
  };

  const upload = async () => {
    let pending = items.filter((i) => isReady(i) && destinations.get(i.key)
      && (destinations.get(i.key)!.sequence || destinations.get(i.key)!.newOwner));
    if (!pending.length) { say("Nothing left to upload."); return; }

    setBusy("uploading");
    try {
      // Where the Versions go for review, asked before anything is
      // written so that Cancel really does leave ShotGrid untouched.
      const lists = await api.playlists(today());
      const choice = await new Promise<PlaylistChoice | null>(
        (resolve) => setPlaylistAsk({ ...lists, count: pending.length, resolve }));
      setPlaylistAsk(null);
      if (!choice) { say("Upload cancelled."); return; }

      // New Sequences first, as the desktop app does. One that can't be
      // made takes its files out of this run; the rest carry on.
      const made = new Map<string, Sequence>();
      const owners = [...new Set(pending.map((i) => destinations.get(i.key)!.newOwner).filter(Boolean))] as string[];
      for (const owner of owners) {
        const data = newSequences.get(owner)!;
        try {
          made.set(owner, await api.createSequence(data));
          say(`Created Sequence: ${data.code}`);
        } catch (err) {
          say(`Couldn't create ${data.code}: ${(err as Error).message}`);
          setShowLog(true);
        }
      }
      if (made.size) {
        setCatalog((c) => c && { ...c, sequences: [...c.sequences, ...made.values()] });
        setNewSequences((m) => { const n = new Map(m); for (const k of made.keys()) n.delete(k); return n; });
        setDestinations((m) => {
          const n = new Map(m);
          for (const [key, d] of m) {
            if (d.newOwner && made.has(d.newOwner)) n.set(key, { sequence: made.get(d.newOwner)!, score: null });
          }
          return n;
        });
      }
      const sequenceOf = (item: Item): Sequence | null => {
        const d = destinations.get(item.key)!;
        return d.sequence ?? (d.newOwner ? made.get(d.newOwner) ?? null : null);
      };
      let queue = pending.filter((i) => sequenceOf(i)).map((item) => ({ item, sequence: sequenceOf(item)! }));
      if (!queue.length) { say("Nothing left to upload."); return; }

      // Catch a Version name that's already on its Sequence - usually an
      // export that wants a higher version number.
      const { versions } = await api.existingVersions([...new Set(queue.map((q) => q.sequence.id))]);
      const found = findClashes(queue, brand, versions);
      if (found.length) {
        const choice = await new Promise<"skip" | "anyway" | "cancel">(
          (resolve) => setClashes({ list: found, resolve }));
        setClashes(null);
        if (choice === "cancel") { say("Upload cancelled."); return; }
        if (choice === "skip") {
          const dropped = new Set(found.map((c) => c.item.id));
          for (const c of found) say(`Skipped ${c.item.file.name} - ${c.name} already exists.`);
          queue = queue.filter((q) => !dropped.has(q.item.id));
        } else {
          say(`Uploading ${found.length} duplicate version(s) anyway.`);
        }
      }
      if (!queue.length) { say("Nothing left to upload."); return; }

      const playlistIds: number[] = [];
      for (const code of choice.codes) {
        const playlist = await api.playlist(code);
        playlistIds.push(playlist.id);
        say(`Playlist: ${playlist.code}${playlist.created ? " (created)" : ""}`);
      }
      if (!playlistIds.length) say("Not adding these to a playlist.");

      const results = new Map<string, Item["upload"]>();
      const patch = (id: string, upload: Item["upload"]) => {
        results.set(id, upload);
        setItems((list) => list.map((i) => (i.id === id ? { ...i, upload } : i)));
      };
      setRun(queue.map((q) => q.item.id));

      let done = 0;
      const failed: string[] = [];
      for (const { item, sequence } of queue) {
        say("");
        say(`${item.file.name} -> ${sequence.code}`);
        say(`    uploading ${Math.round(item.file.size / (1024 * 1024))} MB...`);
        patch(item.id, { state: "uploading", progress: 0 });
        try {
          await uploadFile({
            file: item.file, path: item.path, sequenceId: sequence.id,
            code: versionName(brand, item, sequence), playlistIds,
          }, (progress) => patch(item.id, { state: "uploading", progress }));
          patch(item.id, { state: "done", progress: 1 });
          say("    done");
          done++;
        } catch (err) {
          const message = (err as Error).message;
          patch(item.id, { state: "failed", progress: 0, message });
          say(`    FAILED: ${message}`);
          failed.push(item.file.name);
        }
      }

      say("");
      say(`${done} uploaded, ${failed.length} failed`);
      for (const name of failed) say(`  ${name}`);
      say("Transcoding runs on the server - give it a minute.");
      if (failed.length) setShowLog(true);

      // Anything left over (skipped or failed) goes round again from
      // choosing destinations, matched afresh without the uploaded files.
      const after = items.map((i) => (results.has(i.id) ? { ...i, upload: results.get(i.id) } : i));
      const left = after.filter((i) => isReady(i));
      if (left.length) {
        const r = recompute(after, catalog!);
        setItems(r.items);
        setGroups(r.groups);
        setDestinationsSet(false);
        say(`${left.length} file(s) still to go.`);
      } else {
        say("Everything in the queue is uploaded. Drop more files to carry on, "
          + "or use Remove selected to clear them.");
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy("");
    }
  };

  const removeSelected = () => {
    if (!selected.size) return;
    setItems(items.filter((i) => !selected.has(i.id)));
    setSelected(new Set());
    resetMatching();
  };

  const clearMatches = () => {
    if (!items.length) return;
    setItems(items.map((i) => ({ ...i, activation: null, products: [] })));
    setAssignments(new Map());
    setCreateState({ forms: new Map(), shares: new Map() });
    resetMatching();
    say("Cleared destinations. Click Next to match again.");
  };

  const statusOf = (item: Item): [string, string] => {
    if (item.error) return ["Bad filename", "red"];
    if (item.upload?.state === "done") return ["Uploaded", "green"];
    if (item.upload?.state === "uploading") return [`Uploading ${Math.round(item.upload.progress * 100)}%`, "accent"];
    if (item.upload?.state === "failed") return [`Failed: ${item.upload.message}`, "red"];
    if (!previewed) return ["Not checked", "dim"];
    if (destinationsSet) {
      const d = destinations.get(item.key);
      if (d?.sequence) {
        const pct = d.score != null ? `  (${Math.round(d.score * 100)}%)` : "";
        return [`${d.sequence.code}${pct}`, "green"];
      }
      if (d?.newOwner) return [`NEW: ${newSequences.get(d.newOwner)?.code ?? "?"}`, "amber"];
      return ["Skipped - no Sequence yet", "amber"];
    }
    const best = groups.find((g) => g.key === item.key)?.candidates[0];
    if (best) return [`${best[1].code}  (${Math.round(best[0] * 100)}%)`, best[0] >= 0.85 ? "green" : "amber"];
    return ["No Sequence yet", "amber"];
  };

  const good = items.filter((i) => !i.error).length;
  const bad = items.length - good;
  const canNext = items.some(isReady) && !busy;
  const nextLabel = !previewed ? "Next" : !destinationsSet ? "Choose destinations" : "Upload";
  const note = !previewed ? "Nothing is written until you upload."
    : !destinationsSet ? "Pick where each video goes."
    : "Check the Goes to column. Wrong match? Use Change destinations.";
  const inRun = items.filter((i) => run.includes(i.id));
  const overall = inRun.reduce((sum, i) => sum + (i.upload?.progress ?? 0), 0) / Math.max(inRun.length, 1);

  if (step === "assign" && catalog) {
    return <AssignScreen videos={videosToAssign(items)} activations={catalog.activations}
      products={catalog.products} initial={assignments} onBack={() => setStep("queue")}
      onDone={onAssigned} onRefresh={refresh} refreshing={busy === "refreshing"} />;
  }
  if (step === "create" && catalog) {
    const jobs = createJobs();
    if (jobs.length) {
      return <CreateScreen jobs={jobs} activations={catalog.activations} products={catalog.products}
        deliverables={catalog.deliverables} existingNames={catalog.sequences.map((s) => s.code ?? "")}
        initial={createState} onBack={() => setStep("matches")} onDone={onCreated}
        onRefresh={refresh} refreshing={busy === "refreshing"} />;
    }
  }
  if ((step === "matches" || step === "create") && catalog) {
    return <MatchesScreen key={matchesVersion} groups={groups} sequences={catalog.sequences}
      previous={destinations} onBack={() => setStep("queue")} onDone={onMatched}
      onRefresh={refresh} refreshing={busy === "refreshing"} />;
  }

  return (
    <main className="app" onDragOver={(e) => { e.preventDefault(); setHot(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setHot(false); }} onDrop={onDrop}>
      <header className="top">
        <h1>ShotGrid Uploader</h1>
        <div className="top-right">
          <button onClick={refresh} disabled={!!busy}
            title="Re-read Sequences, Activations, Products and Deliverables. Use this after adding any of them in ShotGrid.">
            {busy === "refreshing" ? "Refreshing..." : "Refresh from ShotGrid"}
          </button>
          <label className="inline">Brand
            <select value={brand} onChange={(e) => setBrand(e.target.value)} disabled={busy === "uploading"}>
              {BRANDS.map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
          <span className="hint">{user.name}</span>
          <button className="link" onClick={onSignOut} disabled={busy === "uploading"}>Sign out</button>
        </div>
      </header>

      <div className={"dropzone" + (hot ? " hot" : "")} onClick={() => fileInput.current?.click()}
        role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}>
        Drag your videos or stills here, or click to choose
      </div>
      <input ref={fileInput} type="file" multiple hidden accept={".mov,.mp4,.m4v,.jpg,.jpeg,.png,.tif,.tiff"}
        onChange={(e) => { add(fromInput(e.target.files)); e.target.value = ""; }} />
      <input ref={folderInput} type="file" hidden {...{ webkitdirectory: "" }}
        onChange={(e) => { add(fromInput(e.target.files)); e.target.value = ""; }} />

      <div className="bar">
        <button onClick={() => fileInput.current?.click()} disabled={busy === "uploading"}>Add files...</button>
        <button onClick={() => folderInput.current?.click()} disabled={busy === "uploading"}>Add folder...</button>
        <button onClick={removeSelected} disabled={!selected.size || busy === "uploading"}>Remove selected</button>
        <button onClick={clearMatches} disabled={!!busy}>Clear matches</button>
        <button onClick={() => setStep("matches")} disabled={!previewed || !!busy}>Change destinations...</button>
        <span className="spacer" />
        <span className="hint">{items.length} file{items.length === 1 ? "" : "s"}{bad ? `, ${bad} with bad names` : ""}</span>
      </div>

      <div className="table-wrap grow">
        <table className="queue">
          <thead>
            <tr>
              <th className="tick"><input type="checkbox" aria-label="Select all"
                checked={!!items.length && selected.size === items.length}
                onChange={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((i) => i.id)))} /></th>
              <th>File</th><th>Title</th><th>Stage</th><th>Type</th><th>Version</th><th>Goes to</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const [status, colour] = statusOf(item);
              const p = item.parsed;
              const oddStage = !!p?.stage && !isKnownStage(p.stage, p.kind);
              return (
                <tr key={item.id} className={selected.has(item.id) ? "selected" : ""}>
                  <td className="tick"><input type="checkbox" aria-label={`Select ${item.file.name}`}
                    checked={selected.has(item.id)} onChange={() => setSelected((s) => {
                      const n = new Set(s);
                      if (!n.delete(item.id)) n.add(item.id);
                      return n;
                    })} /></td>
                  <td title={item.error ?? item.path}>{item.file.name}
                    {item.error && <div className="row-error">{item.error}</div>}</td>
                  <td>{p?.title || "-"}</td>
                  <td className={oddStage ? "amber" : ""}
                    title={oddStage ? "Not a stage the tool recognises. It'll be used as typed - check it isn't a typo." : ""}>
                    {p?.stage || "-"}</td>
                  <td>{splitext(item.file.name)[1].slice(1).toUpperCase() || "-"}</td>
                  <td>{p ? versionLabel("", p.format, p.label) || "-" : "-"}</td>
                  <td className={colour}>{status}</td>
                </tr>
              );
            })}
            {!items.length && <tr><td colSpan={7} className="empty">No files yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="actions">
        <button className="primary" onClick={onNext} disabled={!canNext}>
          {busy === "loading" ? "Loading..." : busy === "uploading" ? "Uploading..." : nextLabel}
        </button>
        <span className="hint">{note}</span>
        <span className="spacer" />
        <button onClick={() => setShowLog(!showLog)}>{showLog ? "Hide log" : "Show log"}</button>
      </div>

      {busy === "uploading" && (
        <progress className="overall" max={1} value={overall} aria-label="Upload progress" />
      )}
      {showLog && <pre className="log" aria-live="polite">{log.join("\n")}</pre>}

      {playlistAsk && (
        <PlaylistDialog today={playlistAsk.today} recent={playlistAsk.recent} count={playlistAsk.count}
          onCancel={() => playlistAsk.resolve(null)} onDone={(c) => playlistAsk.resolve(c)} />
      )}
      {clashes && (
        <div className="modal-back" role="dialog" aria-modal aria-labelledby="clash-title">
          <div className="card modal">
            <h2 id="clash-title">Version already exists</h2>
            <p>{clashes.list.length} file{clashes.list.length === 1 ? "" : "s"} would create a Version that
              already exists on its Sequence:</p>
            <ul className="clash-list">
              {clashes.list.map((c) => (
                <li key={c.item.id}>{c.item.file.name}<br /><span className="dim">would become {c.name}</span></li>
              ))}
            </ul>
            <p className="hint">Usually this means the export needs a higher version number.</p>
            <div className="modal-buttons">
              <button onClick={() => clashes.resolve("cancel")}>Cancel</button>
              <span className="spacer" />
              <button className="danger" onClick={() => clashes.resolve("anyway")}>Upload anyway</button>
              <button className="primary" onClick={() => clashes.resolve("skip")}>Skip these</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
