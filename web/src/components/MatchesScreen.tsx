/**
 * "Sequences found" - the closest match is filled in for each video and
 * the artist confirms or changes it (the desktop MatchesDialog). Nothing
 * is auto-accepted.
 *
 * Choosing "Create a new Sequence" leads on to the Create screen, where
 * the new ones are named. "Skip for now" leaves a video in the queue.
 */
import { useState } from "react";
import type { Sequence } from "../lib/naming";
import { isAmbiguous, isNoneOption, realLinks, scopeSequences } from "../lib/naming";
import type { Destination, Group } from "../queue";
import { Picker, type PickerSection } from "./Picker";

/**
 * What a Sequence is linked to, for telling apart Sequences with the
 * same name: "Product: BRIO 730 ... · Deliverable: End Cards · ID 1234".
 * The "none" placeholders are left out - they say nothing.
 */
export function describeSequence(s: Sequence): string {
  const names = (links: { id: number; name?: string | null }[] | null | undefined, kind: string) =>
    (links ?? []).filter((l) => l.name && !isNoneOption(l, kind)).map((l) => l.name!.trim());
  const parts: string[] = [];
  const act = names(s.sg_activations ? [s.sg_activations] : [], "activation");
  const prods = names(s.sg_product, "product");
  const dels = names(s.sg_deliverable, "deliverable");
  if (act.length) parts.push(`Activation: ${act.join(", ")}`);
  if (prods.length) parts.push(`Product: ${prods.join(", ")}`);
  if (dels.length) parts.push(`Deliverable: ${dels.join(", ")}`);
  parts.push(`ID ${s.id}`);
  return parts.join("  ·  ");
}

const SKIP = "skip";
const CREATE = "create";
const byCode = (a: Sequence, b: Sequence) => {
  const x = (a.code ?? "").toLowerCase(), y = (b.code ?? "").toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

export function MatchesScreen({ groups, sequences, previous, onBack, onDone, onRefresh, refreshing }: {
  groups: Group[];
  sequences: Sequence[];
  previous: Map<string, Destination>;
  onBack: () => void;
  onDone: (chosen: Map<string, Destination>) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [picks, setPicks] = useState(() => new Map(groups.map((g) => {
    const prev = previous.get(g.key);
    if (prev !== undefined) {
      return [g.key, prev.sequence ? String(prev.sequence.id) : prev.newOwner ? CREATE : SKIP] as const;
    }
    return [g.key, g.candidates.length ? String(g.candidates[0][1].id) : CREATE] as const;
  })));

  /** Sequences under the row's real Activation or Products - placeholders don't count. */
  const scopeOf = (g: Group) => {
    const real = realLinks(g.activation, g.products);
    return scopeSequences(sequences, real.activation?.id ?? null, real.products.map((p) => p.id));
  };
  const poolFor = (g: Group) => showAll ? sequences : scopeOf(g);

  const sectionsFor = (g: Group): PickerSection<Sequence | null>[] => {
    const shown = new Set(g.candidates.map(([, s]) => s.id));
    const rest = poolFor(g).filter((s) => !shown.has(s.id)).sort(byCode);
    return [
      { title: g.candidates.length ? "Best matches" : undefined, options: g.candidates.map(([score, s]) => ({
        key: String(s.id), label: s.code ?? "(unnamed)", detail: describeSequence(s),
        hint: `${Math.round(score * 100)}%`, value: s,
      })) },
      { title: showAll ? "Every Sequence" : "Everything else under this scope", options: rest.map((s) => ({
        key: String(s.id), label: s.code ?? "(unnamed)", detail: describeSequence(s), value: s,
      })) },
      { options: [
        { key: CREATE, label: "-- Create a new Sequence --", value: null },
        { key: SKIP, label: "-- Skip for now --", value: null },
      ] },
    ];
  };

  const scoreOf = (g: Group, id: string) => g.candidates.find(([, s]) => String(s.id) === id)?.[0] ?? null;
  const skipped = groups.filter((g) => picks.get(g.key) === SKIP).length;
  const creating = groups.filter((g) => picks.get(g.key) === CREATE).length;

  const done = () => {
    const out = new Map<string, Destination>();
    for (const g of groups) {
      const id = picks.get(g.key)!;
      if (id === CREATE) {
        // Keep who it shares with if this came back from the Create screen.
        out.set(g.key, { sequence: null, score: null, newOwner: previous.get(g.key)?.newOwner ?? g.key });
        continue;
      }
      const sequence = id === SKIP ? null : sequences.find((s) => String(s.id) === id) ?? null;
      out.set(g.key, { sequence, score: sequence ? scoreOf(g, id) : null });
    }
    onDone(out);
  };

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h2>Sequences found</h2>
          <p className="hint">The closest match is filled in for each video. Change any of them.
            A row marked ! has two equally good matches and is worth a look.</p>
          <p className="hint">Nothing fits? Choose Create a new Sequence - you'll name it on the
            next screen.</p>
        </div>
        <button onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh from ShotGrid"}
        </button>
      </header>

      <label className="check-row">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Show every Sequence in the project, not just the ones under the Activation or Product you chose
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Video</th><th>Files</th><th>Searched in</th><th className="w-goes">Goes to</th></tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const scoped = scopeOf(g);
              const names = [g.activation, ...g.products].filter(Boolean).map((x) => x!.name);
              const ambiguous = isAmbiguous(g.candidates);
              return (
                <tr key={g.key}>
                  <td className={ambiguous ? "amber" : ""}
                    title={ambiguous ? "Two Sequences fit this equally well - check the destination before uploading." : ""}>
                    {g.title}{ambiguous && "  !"}
                  </td>
                  <td>{g.items.length}</td>
                  <td className={scoped.length ? "dim" : "amber"}>
                    {names.join(" / ") || "everything"} ({scoped.length})
                  </td>
                  <td>
                    <Picker ariaLabel={`Destination for ${g.title}`} sections={sectionsFor(g)}
                      selected={picks.get(g.key)!} prompt="Choose a Sequence"
                      onChange={(o) => setPicks((m) => new Map(m).set(g.key, o.key))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="screen-foot">
        <button onClick={onBack}>Back</button>
        <span className="warn">{skipped ? `${skipped} video${skipped === 1 ? "" : "s"} will be skipped.` : ""}</span>
        <button className="primary" onClick={done}
          title={creating ? `${creating} new Sequence${creating === 1 ? "" : "s"} to name on the next screen`
            : "Back to the queue, ready to upload"}>
          {creating ? "Next" : "Done"}
        </button>
      </footer>
    </section>
  );
}
