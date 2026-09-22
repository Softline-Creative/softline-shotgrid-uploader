/**
 * Filename parsing, matching and naming - a port of the parts of
 * upload_videos.py the web uploader uses.
 *
 * Keep this in step with the Python. The two apps write to the same
 * ShotGrid site, so a file must parse, match and be named identically
 * whichever one uploads it. test/parity.test.ts checks this against
 * fixtures generated from upload_videos.py itself
 * (scripts/gen_fixtures.py); regenerate them after changing either side.
 */

import { ratio } from "./difflib";

// ---------------------------------------------------------------------------
// Settings - mirror the constants at the top of upload_videos.py
// ---------------------------------------------------------------------------

export const STRICT_STAGES = false;

export const KNOWN_STAGES = [
  "Cut", "RoughCut", "RoughCutColor", "FineCut", "FineCutColor",
  "ColorCut", "FinalCut", "Final", "Publish",
];

export const VIDEO_EXTS = [".mov", ".mp4", ".m4v"];

// PSD is deliberately absent - ShotGrid can't thumbnail it.
export const STILL_EXTS = [".jpg", ".jpeg", ".png", ".tif", ".tiff"];

export const ALL_EXTS = [...VIDEO_EXTS, ...STILL_EXTS];

export const STILL_STAGES = [
  "Select", "Selects", "Proof", "Retouch", "Retouched", "Final",
];

/** "rev" is Pending Review. */
export const NEW_VERSION_STATUS = "rev";

export const FORMATS: Record<string, string[]> = {
  Square: ["square", "sq", "1x1", "1by1"],
};

const FORMAT_LOOKUP: Record<string, string> = Object.fromEntries(
  Object.entries(FORMATS).flatMap(
    ([name, aliases]) => aliases.map((alias) => [alias, name])),
);

export const BRANDS = ["BRIO", "LAGO"];

export const CAMPAIGN_MISMATCH = 0.45;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityLink {
  type: string;
  id: number;
  name?: string;
}

export interface Sequence {
  id: number;
  code: string | null;
  sg_activations?: EntityLink | null;
  sg_product?: EntityLink[] | null;
  sg_deliverable?: EntityLink[] | null;
}

export type Ranked = [number, Sequence][];

export class ParseError extends Error {}

export interface Parsed {
  kind: "video" | "still";
  title: string;
  stage: string;
  format: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Small Python equivalents
// ---------------------------------------------------------------------------

/** os.path.splitext on a bare filename. */
export function splitext(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  // Leading dots belong to the stem, as in Python (".mov" has no ext).
  let lead = 0;
  while (lead < name.length && name[lead] === ".") lead++;
  if (dot < lead) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

const isDigits = (s: string) => /^[0-9]+$/.test(s);

const CAMEL_BREAKS =
  /(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/g;

function byScoreThenCode(x: [number, Sequence], y: [number, Sequence]) {
  if (x[0] !== y[0]) return y[0] - x[0];
  const a = x[1].code ?? "", b = y[1].code ?? "";
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Strip everything but letters and digits, uppercase. */
export function normalise(text: string | null | undefined): string {
  return (text ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** 'PremiumIcePartner' -> ['premium', 'ice', 'partner'] */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const spaced = text.replace(CAMEL_BREAKS, " ");
  return spaced.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p.toLowerCase());
}

/** How well two token lists overlap, 0 to 1, tolerating near misses. */
export function tokenScore(query: string[], candidate: string[]): number {
  if (!query.length || !candidate.length) return 0.0;

  const remaining = [...candidate];
  let matched = 0.0;
  for (const word of query) {
    const at = remaining.indexOf(word);
    if (at >= 0) {
      remaining.splice(at, 1);
      matched += 1.0;
      continue;
    }
    let best: number | null = null, bestScore = 0.0;
    remaining.forEach((other, idx) => {
      const r = ratio(word, other);
      if (r > bestScore) { best = idx; bestScore = r; }
    });
    if (best !== null && bestScore >= 0.8) {
      remaining.splice(best, 1);
      matched += bestScore;
    }
  }

  const precision = matched / query.length;
  const recall = matched / candidate.length;
  if (precision + recall === 0) return 0.0;
  return (2 * precision * recall) / (precision + recall);
}

/** Drop a known phrase (a Deliverable) from the end of a token list. */
export function stripTrailingPhrase(tokens: string[], phrases: string[]): string[] {
  let best = tokens;
  for (const phrase of phrases ?? []) {
    const words = tokenize(phrase);
    if (!words.length || tokens.length <= words.length) continue;
    const tail = tokens.slice(-words.length);
    if (tail.every((w, i) => w === words[i])) {
      const candidate = tokens.slice(0, -words.length);
      if (candidate.length < best.length) best = candidate;
    }
  }
  return best;
}

function splitDash(code: string): [string, string] {
  const at = code.indexOf(" - ");
  return at >= 0 ? [code.slice(0, at), code.slice(at + 3)] : [code, ""];
}

/** Score a filename's title against a Sequence, 0 to 1. */
export function matchScore(
  title: string, sequence: Sequence, deliverableNames: string[] = [],
  campaign = "",
): number {
  const code = sequence.code ?? "";
  const [namePart, suffix] = splitDash(code);

  const query = tokenize(title);
  if (!query.length) return 0.0;

  const fullTokens = tokenize(namePart);
  const coreTokens = stripTrailingPhrase(fullTokens, deliverableNames);

  const tokens = Math.max(
    tokenScore(query, fullTokens),
    tokenScore(query, coreTokens) * 0.98,
    tokenScore(query, tokenize(code)),
  );

  const coreText = coreTokens.join(" ");
  const chars = Math.max(
    ratio(normalise(title), normalise(namePart)),
    ratio(normalise(title), normalise(coreText)),
  );

  let score = 0.65 * tokens + 0.35 * chars;
  if (normalise(title) === normalise(namePart)) score = 1.0;
  else if (normalise(title) === normalise(coreText)) score = 0.98;

  if (campaign && suffix && normalise(campaign) !== normalise(suffix)) {
    score *= CAMPAIGN_MISMATCH;
  }
  return score;
}

/**
 * Narrow the pool to an Activation and/or Products - the union, not the
 * intersection. Returns the same array when there's nothing to scope by.
 */
export function scopeSequences(
  sequences: Sequence[], activationId?: number | null, productIds?: number[] | null,
): Sequence[] {
  const wanted = new Set(productIds ?? []);
  if (!activationId && !wanted.size) return sequences;

  return sequences.filter((seq) => {
    if (activationId && seq.sg_activations?.id === activationId) return true;
    return wanted.size > 0
      && (seq.sg_product ?? []).some((p) => wanted.has(p.id));
  });
}

/** True when the top two candidates are too close to call apart. */
export function isAmbiguous(ranked: Ranked, margin = 0.03): boolean {
  return ranked.length >= 2 && ranked[0][0] - ranked[1][0] < margin;
}

/** Rank Sequences against a filename title, best first. */
export function rankByTitle(
  sequences: Sequence[], title: string,
  activationId: number | null = null, productIds: number[] | null = null,
  deliverableNames: string[] = [], campaign = "", limit = 8, threshold = 0.45,
): Ranked {
  // No silent widening: nothing under the chosen scope means no match.
  const pool = scopeSequences(sequences, activationId, productIds);
  const scored: Ranked = pool
    .map((s): [number, Sequence] => [matchScore(title, s, deliverableNames, campaign), s])
    .filter(([score]) => score >= threshold);
  scored.sort(byScoreThenCode);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Parsing and naming
// ---------------------------------------------------------------------------

export function isKnownStage(stage: string | null | undefined, kind = "video"): boolean {
  const stages = kind === "still" ? STILL_STAGES : KNOWN_STAGES;
  const s = (stage ?? "").toLowerCase();
  return stages.some((x) => x.toLowerCase() === s);
}

/**
 * Parse a filename that may or may not carry brand and campaign.
 *
 *   required, from the right:  TITLE _ STAGE _ vNNN   (or N_N_N for stills)
 *   optional, on the left:     BRAND _ CAMPAIGN _
 *
 * `folder` stands in for os.path.dirname: a still named with nothing but
 * numbers takes its title from the folder it came from.
 */
export function parseLoose(filename: string, campaign = "", folder = ""): Parsed {
  const [stem, rawExt] = splitext(filename);
  const ext = rawExt.toLowerCase();
  let parts = stem.split("_");

  if (parts.length < 3 && stem.includes(" ")) {
    throw new ParseError(
      "use underscores, not spaces - this should be " + stem.replaceAll(" ", "_"));
  }

  let rest: string[], stages: string[], kind: "video" | "still", label: string;
  if (STILL_EXTS.includes(ext)) {
    if (parts.length < 3) throw new ParseError("expected at least N_N_N");
    const triplet = parts.slice(-3);
    if (!triplet.every(isDigits)) {
      throw new ParseError(
        `last three segments should be numbers, got "${triplet.join("_")}"`);
    }
    rest = parts.slice(0, -3);
    stages = STILL_STAGES; kind = "still"; label = triplet.join(".");
  } else {
    if (parts.length < 3) throw new ParseError("expected TITLE_STAGE_vNNN");
    const versionPart = parts[parts.length - 1];
    rest = parts.slice(0, -1);
    if (!versionPart.toLowerCase().startsWith("v") || !isDigits(versionPart.slice(1))) {
      throw new ParseError(`last segment "${versionPart}" is not a version like v001`);
    }
    stages = KNOWN_STAGES; kind = "video";
    label = "v" + String(parseInt(versionPart.slice(1), 10)).padStart(3, "0");
  }

  // An aspect-ratio marker may sit on either side of the stage.
  let fmt = "";
  for (let i = rest.length - 1; i >= 0; i--) {
    const found = FORMAT_LOOKUP[rest[i].toLowerCase()];
    if (found) {
      fmt = found;
      rest = [...rest.slice(0, i), ...rest.slice(i + 1)];
      break;
    }
  }

  if (kind === "still") {
    if (!rest.length) {
      const title = folder.replace(/[^A-Za-z0-9]/g, "");
      return { kind, title: title || "Stills", stage: "", format: "", label };
    }
    if (rest.length === 1) {
      return { kind, title: rest[0], stage: "", format: "", label };
    }
  } else if (!rest.length) {
    throw new ParseError("nothing left but a stage - expected a title too");
  }

  const stagePart = rest[rest.length - 1];
  let titleParts = rest.slice(0, -1);

  const canonical = stages.find((s) => s.toLowerCase() === stagePart.toLowerCase());
  let stage: string;
  if (canonical) {
    stage = canonical;
  } else if (STRICT_STAGES) {
    throw new ParseError(
      `unknown stage "${stagePart}" - expected one of: ${stages.join(", ")}`);
  } else if (!stagePart || isDigits(stagePart)) {
    throw new ParseError(`"${stagePart}" is not a usable stage`);
  } else {
    stage = stagePart;
  }

  if (titleParts.length && BRANDS.some((b) => b.toUpperCase() === titleParts[0].toUpperCase())) {
    titleParts = titleParts.slice(1);
  }
  if (titleParts.length > 1 && campaign && normalise(titleParts[0]) === normalise(campaign)) {
    titleParts = titleParts.slice(1);
  }

  if (!titleParts.length) {
    throw new ParseError("no title left after the brand and campaign");
  }

  return { kind, title: titleParts.join("_"), stage, format: fmt, label };
}

/**
 * The title used for grouping, matching and naming (flow_uploader.py).
 * The format is folded in, so a square cut is its own video.
 */
export function searchTitle(title: string, fmt: string): string {
  return fmt ? `${title}_${fmt}` : title;
}

/** An internal grouping id - never written to ShotGrid. */
export function buildKey(campaign: string, title: string): string {
  const c = normalise(campaign), t = normalise(title);
  return c ? `${c}_${t}` : t;
}

/** 'FineCutColor Square v002' */
export function versionLabel(stage: string, fmt: string, label: string): string {
  return [stage, fmt, label].filter(Boolean).join(" ");
}

const camel = (text: string) => (text ?? "").replace(/[^A-Za-z0-9]/g, "");

/**
 * The Version name, rebuilt to the full convention from the chosen brand
 * and the matched Sequence, not from the filename.
 *
 *   BRIO_UFC331_PremiumIceGiveaway_Square_FinalCut_v004
 */
export function canonicalName(
  brand: string, sequenceCode: string | null, stage: string, fmt: string, label: string,
): string {
  const [title, campaign] = splitDash(sequenceCode ?? "");
  const parts = [brand, camel(campaign), camel(title)].filter(Boolean);
  if (fmt) parts.push(fmt);
  if (stage) parts.push(stage);
  parts.push((label ?? "").replaceAll(".", "_"));
  return parts.filter(Boolean).join("_");
}

// ---------------------------------------------------------------------------
// New Sequences
// ---------------------------------------------------------------------------

export interface Named { id: number; type?: string; name?: string | null }

export const NONE_NAMES: Record<string, Set<string>> = {
  activation: new Set(["noactivation", "nonactivation", "none", "na", "n/a"]),
  product: new Set(["noproduct", "nonproduct", "none", "na", "n/a"]),
  deliverable: new Set(["nodeliverable", "nondeliverable", "none", "na", "n/a"]),
};

/** True when an entity is the site's 'not applicable' placeholder. */
export function isNoneOption(option: Named | null | undefined, kind: string): boolean {
  if (!option) return true;
  const slug = (option.name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return NONE_NAMES[kind]?.has(slug) ?? false;
}

/** The entity the site uses to mean 'not applicable', if it exists. */
export function findNoneOption<T extends Named>(options: T[], kind: string): T | null {
  return (options ?? []).find((o) => isNoneOption(o, kind)) ?? null;
}

/** 'BrioBro_Partner' -> 'Brio Bro Partner'. Dashes are dropped. */
export function spacedWords(text: string | null | undefined): string {
  const t = (text ?? "").replaceAll("-", " ").replaceAll("_", " ").replace(CAMEL_BREAKS, " ");
  return t.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * A Sequence name from the filename title and its links:
 *
 *   Brio Bro Partner End Cards - UFC 331
 *
 * The Product stands in after the dash when the Activation is the 'none'
 * placeholder; with neither there is no dash.
 */
export function composeSequenceName(
  title: string, deliverables: Named[] = [], activation: Named | null = null, products: Named[] = [],
): string {
  const parts = [spacedWords(title)];
  for (const d of deliverables ?? []) {
    if (!isNoneOption(d, "deliverable")) parts.push((d.name ?? "").trim());
  }
  let suffix = "";
  if (activation && !isNoneOption(activation, "activation")) {
    suffix = (activation.name ?? "").trim();
  } else {
    const product = (products ?? []).find((p) => !isNoneOption(p, "product"));
    if (product) suffix = (product.name ?? "").trim();
  }
  const name = parts.filter(Boolean).join(" ");
  return suffix ? `${name} - ${suffix}` : name;
}

/** A fallback name from the filename: "Chewable Everyday - Tarzann". */
export function suggestSequenceName(filename: string): string {
  let parts = splitext(filename)[0].split("_").slice(0, -2);
  if (parts.length > 1) parts = parts.slice(1);          // drop the brand
  if (parts.length < 2) return "";
  const spaced = (t: string) => t.replace(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)/g, " ").trim();
  return `${spaced(parts.slice(1).join(" "))} - ${spaced(parts[0])}`;
}

export interface Defaults {
  activation_id?: number;
  product_ids?: number[];
  deliverable_ids?: number[];
  support?: Record<string, [number, number]>;
  missing?: string[];
  based_on?: number;
  guessed?: string[];
}

/** Most common value, the first seen winning ties (Counter.most_common). */
function mostCommon<K>(values: K[], keyOf: (v: K) => string): [K, number, number] | null {
  const counts = new Map<string, { value: K; n: number }>();
  for (const v of values) {
    const k = keyOf(v);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { value: v, n: 1 });
  }
  let best: { value: K; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? [best.value, best.n, values.length] : null;
}

/**
 * Guess Activation / Product / Deliverable from sibling Sequences in the
 * same campaign or product: whatever they most commonly use, with how
 * many back it. A majority, not unanimity - see CLAUDE.md.
 */
export function campaignDefaults(
  sequences: Sequence[], activationId: number | null = null, productIds: number[] | null = null,
): Defaults {
  const siblings = scopeSequences(sequences, activationId, productIds);
  if (!siblings.length || siblings === sequences) return {};

  const out: Defaults = { support: {} };
  const acts = mostCommon(siblings.filter((s) => s.sg_activations).map((s) => s.sg_activations!.id), String);
  if (acts) {
    out.activation_id = acts[0];
    out.support!.activation_id = [acts[1], acts[2]];
  }
  for (const [field, key] of [["sg_product", "product_ids"], ["sg_deliverable", "deliverable_ids"]] as const) {
    const combos = siblings
      .filter((s) => (s[field] ?? []).length)
      .map((s) => (s[field] ?? []).map((e) => e.id).sort((a, b) => a - b));
    const found = mostCommon(combos, (ids) => ids.join(","));
    if (found) {
      out[key] = found[0];
      out.support![key] = [found[1], found[2]];
    } else {
      (out.missing ??= []).push(key);
    }
  }
  out.based_on = siblings.length;
  out.guessed = (["activation_id", "product_ids", "deliverable_ids"] as const).filter((k) => k in out);
  return out;
}
