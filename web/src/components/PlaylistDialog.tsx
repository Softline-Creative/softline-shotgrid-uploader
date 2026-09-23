/**
 * The last step before uploading: which playlists the new Versions go
 * in. Today's review playlist is suggested - added to if it exists,
 * created if not - but it's only a suggestion. An artist can put a batch
 * in a playlist of their own instead, or as well, or in none.
 */
import { useState } from "react";

export interface PlaylistChoice {
  /** Playlist names to add to (created if missing), in order. */
  codes: string[];
}

interface Known { id: number; code: string }

const norm = (s: string) => s.trim().toLowerCase();

export function PlaylistDialog({ today, recent, count, onCancel, onDone }: {
  today: { code: string; id: number | null };
  recent: Known[];
  count: number;
  onCancel: () => void;
  onDone: (choice: PlaylistChoice) => void;
}) {
  const [useToday, setUseToday] = useState(true);
  const [useOther, setUseOther] = useState(false);
  const [other, setOther] = useState("");

  const others = recent.filter((p) => norm(p.code) !== norm(today.code));
  const typed = other.trim();
  const existing = typed ? recent.find((p) => norm(p.code) === norm(typed)) : undefined;
  const sameAsToday = !!typed && norm(typed) === norm(today.code);
  const otherInvalid = useOther && (!typed || typed.length > 255);

  const codes = [
    ...(useToday ? [today.code] : []),
    ...(useOther && typed && !(useToday && sameAsToday) ? [existing?.code ?? typed] : []),
  ];

  return (
    <div className="modal-back" role="dialog" aria-modal aria-labelledby="pl-title">
      <div className="card modal">
        <h2 id="pl-title">Add to a playlist</h2>
        <p className="hint">Choose where the {count} file{count === 1 ? "" : "s"} being uploaded
          should show up for review.</p>

        <label className="check-row option">
          <input type="checkbox" checked={useToday} onChange={(e) => setUseToday(e.target.checked)} />
          <span>
            <strong>Today's review playlist - {today.code}</strong>
            <span className="dim small block">{today.id
              ? "Already exists - these files will be added to it."
              : "Doesn't exist yet - it will be created."}</span>
          </span>
        </label>

        <label className="check-row option">
          <input type="checkbox" checked={useOther} onChange={(e) => setUseOther(e.target.checked)} />
          <span><strong>{useToday ? "Also add to" : "Add to"} another playlist</strong>
            <span className="dim small block">A playlist of your own, new or one that already exists.</span>
          </span>
        </label>
        {useOther && (
          <div className="indent">
            <input autoFocus list="recent-playlists" className="wide" placeholder="Playlist name"
              aria-label="Other playlist name" value={other} maxLength={255}
              onChange={(e) => setOther(e.target.value)} />
            <datalist id="recent-playlists">
              {others.map((p) => <option key={p.id} value={p.code} />)}
            </datalist>
            <p className={"small " + (typed ? (existing ? "green" : "amber") : "dim")}>
              {!typed ? "Type a name, or pick a recent playlist from the suggestions."
                : sameAsToday ? "That's today's review playlist."
                : existing ? `"${existing.code}" already exists - these files will be added to it.`
                : `"${typed}" is new - it will be created.`}
            </p>
          </div>
        )}

        {!codes.length && !otherInvalid && (
          <p className="warn small">No playlist chosen - the files will upload without being added to one.</p>
        )}

        <div className="modal-buttons">
          <button onClick={onCancel}>Cancel</button>
          <span className="spacer" />
          <button className="primary" disabled={otherInvalid} onClick={() => onDone({ codes })}>
            Upload
          </button>
        </div>
      </div>
    </div>
  );
}
