/**
 * The upload queue: parsing, grouping and matching. This is the domain
 * half of flow_uploader.py's MainWindow (add_paths, _preview_done,
 * _recompute, _check_versions), kept free of UI so it can be tested.
 */
import type { Catalog, Option } from "./api";
import {
  ALL_EXTS, ParseError, buildKey, campaignDefaults, canonicalName, parseLoose, rankByTitle,
  searchTitle, splitext, type Defaults, type Parsed, type Ranked, type Sequence,
} from "./lib/naming";

export type UploadState = "waiting" | "uploading" | "done" | "failed";

export interface Item {
  id: string;
  file: File;
  /** Path as the browser reports it: "Folder/name.mov" or just "name.mov". */
  path: string;
  folder: string;
  parsed: Parsed | null;
  searchTitle: string;
  key: string;
  error: string | null;
  activation: Option | null;
  products: Option[];
  upload?: { state: UploadState; progress: number; message?: string };
}

export interface Destination {
  sequence: Sequence | null;   // null: skipped, or a new Sequence (below)
  score: number | null;
  /** Goes to a new Sequence; the key of the group whose form names it. */
  newOwner?: string;
}

/** A Sequence to create on Upload, as named on the Create screen. */
export interface NewSequence {
  code: string;
  activationId: number | null;
  productIds: number[];
  deliverableIds: number[];
}

export const isMedia = (name: string) =>
  !name.startsWith(".") && ALL_EXTS.includes(splitext(name)[1].toLowerCase());

export const isUploaded = (item: Item) => item.upload?.state === "done";
export const isReady = (item: Item) => !item.error && !isUploaded(item);

function parse(item: Item, campaign: string): Item {
  try {
    const parsed = parseLoose(item.file.name, campaign, item.folder);
    const st = searchTitle(parsed.title, parsed.format);
    return { ...item, parsed, searchTitle: st, key: buildKey(campaign, st), error: null };
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    return { ...item, parsed: null, searchTitle: "", key: "", error: err.message };
  }
}

let counter = 0;

/** New queue entries, skipping anything already queued. */
export function addFiles(existing: Item[], files: { file: File; path: string }[]): Item[] {
  const known = new Set(existing.map((i) => i.path + "|" + i.file.size + "|" + i.file.lastModified));
  const added: Item[] = [];
  for (const { file, path } of files) {
    const sig = path + "|" + file.size + "|" + file.lastModified;
    if (known.has(sig) || !isMedia(file.name)) continue;
    known.add(sig);
    const segments = path.split("/");
    const folder = segments.length > 1 ? segments[segments.length - 2] : "";
    added.push(parse({
      id: `f${++counter}`, file, path, folder, parsed: null, searchTitle: "", key: "",
      error: null, activation: null, products: [],
    }, ""));
  }
  return added;
}

export interface Video { key: string; title: string; count: number }

/** One entry per video, before any campaign is known (_preview_done). */
export function videosToAssign(items: Item[]): Video[] {
  const videos = new Map<string, Video>();
  for (const item of items) {
    if (!isReady(item)) continue;
    const key = buildKey("", item.searchTitle);
    const v = videos.get(key);
    if (v) v.count++;
    else videos.set(key, { key, title: item.searchTitle, count: 1 });
  }
  return [...videos.values()];
}

export interface Assignment { activation: Option | null; products: Option[] }

/** Apply the assignment screen's choices; keys are from videosToAssign. */
export function applyAssignments(items: Item[], chosen: Map<string, Assignment>): Item[] {
  return items.map((item) => {
    if (!isReady(item)) return item;
    const a = chosen.get(buildKey("", item.searchTitle));
    return a ? { ...item, activation: a.activation, products: a.products } : item;
  });
}

export interface Group {
  key: string;
  title: string;
  items: Item[];
  activation: Option | null;
  products: Option[];
  candidates: Ranked;
}

/**
 * Re-parse with each file's campaign, group by video and rank Sequences
 * for each group (_recompute). The best match is only a proposal.
 */
export function recompute(items: Item[], catalog: Catalog): { items: Item[]; groups: Group[] } {
  const reparsed = items.map((item) => {
    if (isUploaded(item)) return item;
    const campaign = (item.activation ?? item.products[0])?.name ?? "";
    return parse(item, campaign);
  });

  const byKey = new Map<string, Item[]>();
  for (const item of reparsed) {
    if (!isReady(item)) continue;
    const list = byKey.get(item.key);
    if (list) list.push(item);
    else byKey.set(item.key, [item]);
  }

  const deliverableNames = catalog.deliverables.map((d) => d.name);
  const groups = [...byKey].map(([key, members]): Group => {
    const first = members[0];
    return {
      key,
      title: first.searchTitle,
      items: members,
      activation: first.activation,
      products: first.products,
      candidates: rankByTitle(
        catalog.sequences, first.searchTitle,
        first.activation?.id ?? null, first.products.map((p) => p.id),
        deliverableNames, first.activation?.name ?? ""),
    };
  });
  groups.sort((a, b) => {
    const x = a.title.toLowerCase(), y = b.title.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { items: reparsed, groups };
}

/**
 * Starting values for a new Sequence (the desktop's _defaults_for):
 * guessed from sibling Sequences, except that whatever was chosen on the
 * assignment screen wins, and whatever was left blank there stays blank.
 * A guess must not quietly overrule a decision already made.
 */
export function defaultsFor(group: Group, sequences: Sequence[]): Defaults {
  const found = campaignDefaults(sequences, group.activation?.id ?? null, group.products.map((p) => p.id));
  const guessed = new Set(found.guessed ?? []);
  const support = found.support ?? {};

  if (group.activation) found.activation_id = group.activation.id;
  else delete found.activation_id;
  guessed.delete("activation_id");

  if (group.products.length) found.product_ids = group.products.map((p) => p.id);
  else delete found.product_ids;
  guessed.delete("product_ids");

  found.guessed = [...guessed].sort();
  found.support = Object.fromEntries(Object.entries(support).filter(([k]) => guessed.has(k)));
  return found;
}

/** The Version name an item will get on its Sequence. */
export function versionName(brand: string, item: Item, sequence: Sequence): string {
  // The format is part of the Sequence, so it isn't repeated here.
  return canonicalName(brand, sequence.code, item.parsed!.stage, "", item.parsed!.label);
}

/** Items whose Version name already exists on the target Sequence. */
export function findClashes(
  queue: { item: Item; sequence: Sequence }[], brand: string,
  existing: { sequenceId: number | null; code: string }[],
): { item: Item; name: string }[] {
  const taken = new Map<number, Set<string>>();
  for (const v of existing) {
    if (v.sequenceId == null) continue;
    if (!taken.has(v.sequenceId)) taken.set(v.sequenceId, new Set());
    taken.get(v.sequenceId)!.add(v.code.trim().toLowerCase());
  }
  return queue
    .map(({ item, sequence }) => ({ item, name: versionName(brand, item, sequence), id: sequence.id }))
    .filter(({ name, id }) => taken.get(id)?.has(name.trim().toLowerCase()))
    .map(({ item, name }) => ({ item, name }));
}

/** Local date as YYYYMMDD, for the daily playlist. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}
