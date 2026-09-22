/**
 * "Where does this belong?" - one row per video, pick its Activation
 * and/or Products (the desktop AssignDialog). Rows can be ticked and
 * set together.
 */
import { useMemo, useState } from "react";
import type { Option } from "../api";
import type { Assignment, Video } from "../queue";
import { MultiPicker, Picker, type PickerSection } from "./Picker";

export function AssignScreen({ videos, activations, products, initial, onBack, onDone, onRefresh, refreshing }: {
  videos: Video[];
  activations: Option[];
  products: Option[];
  initial: Map<string, Assignment>;
  onBack: () => void;
  onDone: (chosen: Map<string, Assignment>) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [chosen, setChosen] = useState(() => new Map(videos.map((v) => [
    v.key, initial.get(v.key) ?? { activation: null, products: [] },
  ])));
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [bulkAct, setBulkAct] = useState<Option | null>(null);
  const [bulkProds, setBulkProds] = useState<number[]>([]);

  const actSections: PickerSection<Option>[] = useMemo(() => [{
    options: activations.map((a) => ({ key: String(a.id), label: a.name, value: a })),
  }], [activations]);

  // After a refresh, keep choices that still exist.
  const live = (a: Assignment): Assignment => ({
    activation: a.activation && activations.find((x) => x.id === a.activation!.id) || null,
    products: products.filter((p) => a.products.some((x) => x.id === p.id)),
  });

  const set = (key: string, a: Assignment) => setChosen((m) => new Map(m).set(key, a));
  const missing = videos.filter((v) => {
    const a = live(chosen.get(v.key)!);
    return !a.activation && !a.products.length;
  }).length;

  const applyBulk = () => {
    const rows = ticked.size ? [...ticked] : videos.map((v) => v.key);
    setChosen((m) => {
      const next = new Map(m);
      for (const key of rows) {
        const prev = next.get(key)!;
        next.set(key, {
          activation: bulkAct ?? prev.activation,
          products: products.filter((p) => bulkProds.includes(p.id)),
        });
      }
      return next;
    });
  };

  const allTicked = ticked.size === videos.length;

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h2>Where does this belong?</h2>
          <p className="hint">Each video is searched for among the Sequences under its Activation
            or Product. Every video needs at least one of the two.</p>
          <p className="warn">If your Activation or Product isn't listed, please contact Richard Kim.</p>
        </div>
        <button onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh from ShotGrid"}
        </button>
      </header>

      <div className="card bulk">
        <span>Set {ticked.size ? "ticked" : "all"} rows to</span>
        <Picker ariaLabel="Bulk Activation" sections={actSections}
          selected={bulkAct ? String(bulkAct.id) : null} prompt="Select Activation"
          onChange={(o) => setBulkAct(o.value)} />
        <MultiPicker ariaLabel="Bulk Product" options={products} selected={bulkProds}
          placeholder="Select Product" onChange={setBulkProds} />
        <button onClick={applyBulk}>Apply</button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="tick"><input type="checkbox" aria-label="Tick all" checked={allTicked}
                onChange={() => setTicked(allTicked ? new Set() : new Set(videos.map((v) => v.key)))} /></th>
              <th>Video</th><th>Files</th><th className="w-picker">Activation</th><th className="w-picker">Product</th>
            </tr>
          </thead>
          <tbody>
            {videos.map((v) => {
              const a = live(chosen.get(v.key)!);
              return (
                <tr key={v.key}>
                  <td className="tick"><input type="checkbox" aria-label={`Tick ${v.title}`}
                    checked={ticked.has(v.key)} onChange={() => setTicked((t) => {
                      const n = new Set(t);
                      if (!n.delete(v.key)) n.add(v.key);
                      return n;
                    })} /></td>
                  <td>{v.title}</td>
                  <td>{v.count}</td>
                  <td><Picker ariaLabel={`Activation for ${v.title}`} sections={actSections}
                    selected={a.activation ? String(a.activation.id) : null} prompt="Select Activation"
                    onChange={(o) => set(v.key, { ...a, activation: o.value })} /></td>
                  <td><MultiPicker ariaLabel={`Product for ${v.title}`} options={products}
                    selected={a.products.map((p) => p.id)} placeholder="Select Product"
                    onChange={(ids) => set(v.key, { ...a, products: products.filter((p) => ids.includes(p.id)) })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="screen-foot">
        <button onClick={onBack}>Back</button>
        <span className="warn">{missing
          ? `Every video needs an Activation or a Product - ${missing} still to go.` : ""}</span>
        <button className="primary" disabled={missing > 0}
          onClick={() => onDone(new Map([...chosen].map(([k, a]) => [k, live(a)])))}>
          Find Sequences
        </button>
      </footer>
    </section>
  );
}
