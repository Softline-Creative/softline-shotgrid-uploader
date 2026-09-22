/**
 * Dropdowns you can click through or type into - the web versions of
 * the desktop app's searchable() combo and MultiSelect. An empty choice
 * shows its prompt in amber, because on these screens an unset field is
 * something still to do.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface PickerOption<T> {
  key: string;
  label: string;
  hint?: string;
  value: T;
}

export interface PickerSection<T> {
  title?: string;
  options: PickerOption<T>[];
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return { open, setOpen, ref };
}

const matches = (label: string, term: string) =>
  !term || label.toLowerCase().includes(term.trim().toLowerCase());

export function Picker<T>({ sections, selected, prompt, onChange, ariaLabel }: {
  sections: PickerSection<T>[];
  selected: string | null;
  prompt: string;
  onChange: (option: PickerOption<T>) => void;
  ariaLabel?: string;
}) {
  const { open, setOpen, ref } = usePopover();
  const [term, setTerm] = useState("");
  const [cursor, setCursor] = useState(0);

  const current = useMemo(() => {
    for (const s of sections) for (const o of s.options) if (o.key === selected) return o;
    return null;
  }, [sections, selected]);

  const visible = sections
    .map((s) => ({ ...s, options: s.options.filter((o) => matches(o.label, term)) }))
    .filter((s) => s.options.length);
  const flat = visible.flatMap((s) => s.options);

  const show = () => { setTerm(""); setCursor(0); setOpen(true); };
  const choose = (o: PickerOption<T>) => { onChange(o); setOpen(false); };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, flat.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); if (flat[cursor]) choose(flat[cursor]); }
  };

  let index = -1;
  return (
    <div className="picker" ref={ref}>
      <button type="button" className={"picker-field" + (current ? "" : " unset")}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}>
        <span className="picker-text">{current ? current.label : prompt}</span>
        {current?.hint && <span className="picker-hint">{current.hint}</span>}
        <span className="caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="popover" onKeyDown={onKey}>
          <input autoFocus className="popover-search" placeholder="Type to search..."
            value={term} onChange={(e) => { setTerm(e.target.value); setCursor(0); }} />
          <div className="popover-list" role="listbox">
            {visible.map((s, si) => (
              <div key={si} className="popover-section">
                {s.title && <div className="popover-title">{s.title}</div>}
                {s.options.map((o) => {
                  index++;
                  const i = index;
                  return (
                    <div key={o.key} role="option" aria-selected={o.key === selected}
                      className={"popover-option" + (i === cursor ? " cursor" : "")
                        + (o.key === selected ? " chosen" : "")}
                      onMouseEnter={() => setCursor(i)}
                      onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
                      <span>{o.label}</span>
                      {o.hint && <span className="picker-hint">{o.hint}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            {!flat.length && <div className="popover-empty">Nothing matches "{term}"</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export function MultiPicker({ options, selected, placeholder, onChange, ariaLabel }: {
  options: { id: number; name: string }[];
  selected: number[];
  placeholder: string;
  onChange: (ids: number[]) => void;
  ariaLabel?: string;
}) {
  const { open, setOpen, ref } = usePopover();
  const [term, setTerm] = useState("");
  const chosen = options.filter((o) => selected.includes(o.id));
  const summary: ReactNode = chosen.length ? chosen.map((o) => o.name).join(", ") : placeholder;

  const toggle = (id: number) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="picker" ref={ref}>
      <button type="button" className={"picker-field" + (chosen.length ? "" : " unset")}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        title={chosen.map((o) => o.name).join("\n")}
        onClick={() => { setTerm(""); setOpen(!open); }}>
        <span className="picker-text">{summary}</span>
        <span className="caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="popover" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <input autoFocus className="popover-search" placeholder="Type to search..."
            value={term} onChange={(e) => setTerm(e.target.value)} />
          <div className="popover-list" role="listbox" aria-multiselectable>
            {options.filter((o) => matches(o.name, term)).map((o) => (
              <label key={o.id} className="popover-option check">
                <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                <span>{o.name}</span>
              </label>
            ))}
            {!options.some((o) => matches(o.name, term)) &&
              <div className="popover-empty">Nothing matches "{term}"</div>}
          </div>
        </div>
      )}
    </div>
  );
}
