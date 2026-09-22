/**
 * "Create new Sequences" - name every new Sequence on one screen (the
 * desktop CreateSequencesDialog). The form applies to whichever video is
 * selected in the list, so the whole set stays in view along with what's
 * still outstanding. Nothing is created until Upload.
 */
import { useMemo, useState } from "react";
import type { Option } from "../api";
import { composeSequenceName, findNoneOption, type Defaults } from "../lib/naming";
import type { NewSequence } from "../queue";
import { MultiPicker, Picker, type PickerSection } from "./Picker";

export interface Job {
  key: string;
  title: string;
  /** Fallback name from the filename, used if composing gives nothing. */
  hint: string;
  defaults: Defaults;
}

export interface Form {
  name: string;
  /** Typed by hand, so it no longer follows the links. */
  handEdited: boolean;
  activationId: number | null;
  productIds: number[];
  deliverableIds: number[];
}

export interface CreateResult {
  forms: Map<string, Form>;
  /** key -> key of the video whose new Sequence it shares. */
  shares: Map<string, string>;
}

const NO_ACTIVATION = "none";
const FIELD_NAMES: Record<string, string> = {
  activation_id: "Activation", product_ids: "Product", deliverable_ids: "Deliverable",
};

/** A form filled in from the defaults (the desktop's _seed_all). */
function seed(job: Job, activations: Option[], products: Option[], deliverables: Option[]): Form {
  const d = job.defaults;
  let activationId = activations.find((a) => a.id === d.activation_id)?.id ?? null;
  if (activationId === null && d.activation_id === undefined) {
    activationId = findNoneOption(activations, "activation")?.id ?? null;
  }
  let productIds = d.product_ids?.length ? d.product_ids : [];
  if (!productIds.length) {
    const blank = findNoneOption(products, "product");
    productIds = blank ? [blank.id] : [];
  }
  return {
    name: "",
    handEdited: false,
    activationId,
    productIds: products.filter((p) => productIds.includes(p.id)).map((p) => p.id),
    deliverableIds: deliverables.filter((x) => d.deliverable_ids?.includes(x.id)).map((x) => x.id),
  };
}

/** "Deliverable copied from 3 of 4 Sequences here. Change anything that's wrong." */
function originNote(d: Defaults): string {
  const parts = (d.guessed ?? []).map((field) => {
    const backing = d.support?.[field];
    return backing
      ? `${FIELD_NAMES[field]} copied from ${backing[0]} of ${backing[1]} Sequences here`
      : `${FIELD_NAMES[field]} copied from this campaign`;
  });
  if (d.missing?.includes("deliverable_ids") && !parts.some((p) => p.includes("Deliverable"))) {
    parts.push("nothing to copy for Deliverable - none of the other Sequences in this campaign have one set");
  }
  if (!parts.length) return "";
  const text = parts.join("; ");
  return `${text[0].toUpperCase()}${text.slice(1)}. Change anything that's wrong.`;
}

export function toNewSequence(name: string, form: Form): NewSequence {
  return {
    code: name.trim(),
    activationId: form.activationId,
    productIds: form.productIds,
    deliverableIds: form.deliverableIds,
  };
}

export function CreateScreen({
  jobs, activations, products, deliverables, existingNames, initial, onBack, onDone, onRefresh, refreshing,
}: {
  jobs: Job[];
  activations: Option[];
  products: Option[];
  deliverables: Option[];
  existingNames: string[];
  initial: CreateResult;
  onBack: () => void;
  onDone: (result: CreateResult, names: Map<string, string>) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [forms, setForms] = useState(() => new Map(jobs.map((j) => [
    j.key, initial.forms.get(j.key) ?? seed(j, activations, products, deliverables),
  ])));
  const [shares, setShares] = useState(() => new Map(
    [...initial.shares].filter(([k, owner]) => jobs.some((j) => j.key === k) && jobs.some((j) => j.key === owner)),
  ));
  const [current, setCurrent] = useState(jobs[0].key);
  const [sharing, setSharing] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);

  const existing = useMemo(() => new Set(existingNames.map((n) => (n ?? "").trim().toLowerCase())), [existingNames]);
  const job = (key: string) => jobs.find((j) => j.key === key)!;

  /** The name as it stands: typed by hand, or built from the links. */
  const nameOf = (key: string): string => {
    const f = forms.get(key)!;
    if (f.handEdited) return f.name;
    const activation = activations.find((a) => a.id === f.activationId) ?? null;
    return composeSequenceName(job(key).title,
      deliverables.filter((d) => f.deliverableIds.includes(d.id)), activation,
      products.filter((p) => f.productIds.includes(p.id))) || job(key).hint;
  };
  const complete = (key: string) => !!nameOf(key).trim() && forms.get(key)!.deliverableIds.length > 0;

  const update = (key: string, patch: Partial<Form>) =>
    setForms((m) => new Map(m).set(key, { ...m.get(key)!, ...patch }));

  const owner = shares.get(current);
  const form = forms.get(current)!;
  const ready = jobs.filter((j) => complete(shares.get(j.key) ?? j.key)).length;

  const actSections: PickerSection<number | null>[] = [
    { options: [{ key: NO_ACTIVATION, label: "No Activation", value: null }] },
    { options: activations.map((a) => ({ key: String(a.id), label: a.name, value: a.id })) },
  ];

  const onName = (value: string) => {
    // Typing takes the name off auto; clearing it puts it back.
    update(current, value.trim() ? { name: value, handEdited: true } : { name: "", handEdited: false });
  };

  const shareCandidates = jobs.filter((j) => j.key !== current && shares.get(j.key) !== current
    && ![...shares.values()].includes(j.key));

  const startShare = () => {
    if (!nameOf(current).trim()) return;
    setSharing([]);
  };

  const applyShare = () => {
    setShares((m) => {
      const next = new Map(m);
      for (const k of sharing ?? []) next.set(k, current);
      return next;
    });
    setSharing(null);
  };

  const unlink = () => {
    setShares((m) => { const n = new Map(m); n.delete(current); return n; });
    update(current, seed(job(current), activations, products, deliverables));
  };

  const finish = (checked: boolean) => {
    const names = new Map(jobs.filter((j) => !shares.has(j.key)).map((j) => [j.key, nameOf(j.key).trim()]));
    if (!checked) {
      // A name already in ShotGrid, or used twice here, is usually a
      // Sequence that should have been linked to rather than remade.
      const clashes: string[] = [];
      const seen = new Map<string, string>();
      for (const [key, name] of names) {
        const slug = name.toLowerCase();
        if (existing.has(slug)) clashes.push(`${job(key).title} -> ${name} (already in ShotGrid)`);
        else if (seen.has(slug)) clashes.push(`${job(key).title} -> ${name} (same as ${seen.get(slug)})`);
        seen.set(slug, job(key).title);
      }
      if (clashes.length) { setConfirm(clashes); return; }
    }
    onDone({ forms, shares }, names);
  };

  const statusOf = (key: string): [string, string] => {
    const o = shares.get(key);
    if (o) return [`-> ${nameOf(o) || "?"} (shared)`, "accent"];
    const name = nameOf(key).trim();
    if (!name) return ["(not named yet)", "amber"];
    if (!forms.get(key)!.deliverableIds.length) return [`-> ${name} (needs a Deliverable)`, "amber"];
    if (existing.has(name.toLowerCase())) return [`-> ${name} (name already in ShotGrid)`, "amber"];
    return [`-> ${name}`, "green"];
  };

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h2>Create new Sequences</h2>
          <p className="hint">These videos didn't match anything, so each needs a new Sequence. Every
            one needs a name and at least one Deliverable - the list shows what's still outstanding.
            Nothing is created until you upload.</p>
        </div>
        <button onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh from ShotGrid"}
        </button>
      </header>

      <div className="create-layout">
        <div className="card job-list" role="listbox" aria-label="Videos needing a new Sequence">
          <div className="popover-title">Videos needing a new Sequence</div>
          {jobs.map((j) => {
            const [status, colour] = statusOf(j.key);
            return (
              <button key={j.key} role="option" aria-selected={j.key === current}
                className={"job" + (j.key === current ? " current" : "")}
                onClick={() => { setCurrent(j.key); setSharing(null); }}>
                <span>{j.title}</span>
                <span className={colour}>{status}</span>
              </button>
            );
          })}
          <div className="hint job-progress">{ready} of {jobs.length} ready</div>
        </div>

        <div className="card create-form">
          {owner ? (
            <>
              <p className="subject">{job(current).title} shares the Sequence being made
                for {job(owner).title}</p>
              <p className="hint">It'll go to <strong>{nameOf(owner) || "(not named yet)"}</strong>.</p>
              <button onClick={unlink}>Give this its own Sequence</button>
            </>
          ) : (
            <>
              <p className="subject">Naming the Sequence for: {job(current).title}</p>

              <label className="field">Sequence name
                <input value={nameOf(current)} onChange={(e) => onName(e.target.value)} />
              </label>
              <p className={form.handEdited ? "amber small" : "dim small"}>{form.handEdited
                ? "You've named this one yourself, so it won't follow the Deliverable or Activation any "
                  + "more - though those still get set on the Sequence. Clear the field to go back to "
                  + "building it automatically."
                : "Built from the title, Deliverable and Activation, and updates as you change them. "
                  + "Type over it to name this one yourself."}</p>

              <div className="field">Activation
                <Picker ariaLabel="Activation" sections={actSections}
                  selected={form.activationId == null ? NO_ACTIVATION : String(form.activationId)}
                  prompt="No Activation" onChange={(o) => update(current, { activationId: o.value })} />
              </div>
              <div className="field">Product
                <MultiPicker ariaLabel="Product" options={products} selected={form.productIds}
                  placeholder="No Product" onChange={(ids) => update(current, { productIds: ids })} />
              </div>
              <div className="field">Deliverable
                <MultiPicker ariaLabel="Deliverable" options={deliverables} selected={form.deliverableIds}
                  placeholder="Select Deliverable" onChange={(ids) => update(current, { deliverableIds: ids })} />
              </div>
              <p className="hint small">Click to open, tick as many as apply.</p>
              {originNote(job(current).defaults) &&
                <p className="amber small">{originNote(job(current).defaults)}</p>}
              <p className="warn small">If your Product or Deliverable isn't listed, please contact Richard Kim.</p>

              {sharing === null ? (
                <button onClick={startShare} disabled={!nameOf(current).trim() || !shareCandidates.length}
                  title="Point other videos at the Sequence you're naming here, instead of creating a second one for them.">
                  Also use this Sequence for...
                </button>
              ) : (
                <div className="share-panel">
                  <p>Also use <strong>{nameOf(current)}</strong> for:</p>
                  {shareCandidates.map((j) => (
                    <label key={j.key} className="check-row">
                      <input type="checkbox" checked={sharing.includes(j.key)}
                        onChange={() => setSharing((s) => s!.includes(j.key)
                          ? s!.filter((k) => k !== j.key) : [...s!, j.key])} />
                      {j.title}
                    </label>
                  ))}
                  <div className="modal-buttons">
                    <button onClick={() => setSharing(null)}>Cancel</button>
                    <button className="primary" onClick={applyShare} disabled={!sharing.length}>Use it for these</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="screen-foot">
        <button onClick={onBack}>Back</button>
        <span className="warn">{ready < jobs.length
          ? `${jobs.length - ready} still need${jobs.length - ready === 1 ? "s" : ""} a name and a Deliverable.` : ""}</span>
        <button className="primary" disabled={ready < jobs.length} onClick={() => finish(false)}>Done</button>
      </footer>

      {confirm && (
        <div className="modal-back" role="dialog" aria-modal aria-labelledby="dup-title">
          <div className="card modal">
            <h2 id="dup-title">Sequence name already exists</h2>
            <p>These names are already taken:</p>
            <ul className="clash-list">{confirm.map((c) => <li key={c}>{c}</li>)}</ul>
            <p className="hint">If one of these is the same video, go back and link to the existing
              Sequence instead.</p>
            <div className="modal-buttons">
              <button onClick={() => setConfirm(null)}>Go back</button>
              <span className="spacer" />
              <button className="primary" onClick={() => { setConfirm(null); finish(true); }}>Create them anyway</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
