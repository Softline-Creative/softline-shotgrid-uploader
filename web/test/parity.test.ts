/**
 * The TypeScript port must agree with upload_videos.py exactly. Every
 * expectation here comes from fixtures.json, which scripts/gen_fixtures.py
 * writes by calling the Python functions directly.
 */
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures.json";
import { ratio } from "../src/lib/difflib";
import {
  ParseError, buildKey, canonicalName, isAmbiguous, matchScore, parseLoose,
  rankByTitle, tokenize, type Sequence,
  campaignDefaults, composeSequenceName, isNoneOption, suggestSequenceName,
} from "../src/lib/naming";

const sequences = fixtures.sequences as Sequence[];
const byId = new Map(sequences.map((s) => [s.id, s]));
const close = (actual: number, expected: number) =>
  expect(actual).toBeCloseTo(expected, 12);

describe("difflib ratio", () => {
  it.each(fixtures.ratio as [string, string, number][])("%j vs %j", (a, b, want) => {
    close(ratio(a, b), want);
  });
});

describe("tokenize", () => {
  it.each(fixtures.tokenize as [string, string[]][])("%j", (text, want) => {
    expect(tokenize(text)).toEqual(want);
  });
});

describe("parseLoose", () => {
  type Case = [string, string, string, { ok?: string[]; error?: string }];
  it.each(fixtures.parse as Case[])("%s (campaign %j, folder %j)", (name, campaign, folder, want) => {
    if (want.error) {
      expect(() => parseLoose(name, campaign, folder)).toThrow(ParseError);
      expect(() => parseLoose(name, campaign, folder)).toThrow(want.error);
    } else {
      const p = parseLoose(name, campaign, folder);
      expect([p.kind, p.title, p.stage, p.format, p.label]).toEqual(want.ok);
    }
  });
});

describe("matchScore", () => {
  it.each(fixtures.match as [string, number, string, number][])(
    "%j vs sequence %i (campaign %j)", (title, id, campaign, want) => {
      close(matchScore(title, byId.get(id)!, fixtures.deliverables, campaign), want);
    });
});

describe("rankByTitle", () => {
  type Case = [string, number | null, number[] | null, string, [number, number][], boolean];
  it.each(fixtures.rank as Case[])("%j act=%j prods=%j campaign=%j",
    (title, act, prods, campaign, want, ambiguous) => {
      const ranked = rankByTitle(sequences, title, act, prods, fixtures.deliverables, campaign);
      expect(ranked.map(([, s]) => s.id)).toEqual(want.map(([, id]) => id));
      ranked.forEach(([score], i) => close(score, want[i][0]));
      expect(isAmbiguous(ranked)).toBe(ambiguous);
    });
});

describe("canonicalName", () => {
  it.each(fixtures.canonical as [string, string, string, string, string, string][])(
    "%j %j %j %j %j", (brand, code, stage, fmt, label, want) => {
      expect(canonicalName(brand, code, stage, fmt, label)).toBe(want);
    });
});

describe("buildKey", () => {
  it.each(fixtures.key as [string, string, string][])("%j %j", (c, t, want) => {
    expect(buildKey(c, t)).toBe(want);
  });
});

describe("new Sequence naming and defaults", () => {
  type E = { type: string; id: number; name: string };
  it.each(fixtures.compose as [string, E[], E | null, E[], string][])(
    "compose %j dels=%j act=%j prods=%j", (title, dels, act, prods, want) => {
      expect(composeSequenceName(title, dels, act, prods)).toBe(want);
    });
  it.each(fixtures.none as [string, string, boolean][])("isNoneOption %j %j", (name, kind, want) => {
    expect(isNoneOption({ id: 1, name }, kind)).toBe(want);
  });
  it.each(fixtures.suggest as [string, string][])("suggest %j", (name, want) => {
    expect(suggestSequenceName(name)).toBe(want);
  });
  it.each(fixtures.defaults as [number | null, number[] | null, object][])(
    "campaignDefaults act=%j prods=%j", (act, prods, want) => {
      expect(campaignDefaults(fixtures.defaults_sequences as Sequence[], act, prods)).toEqual(want);
    });
});
