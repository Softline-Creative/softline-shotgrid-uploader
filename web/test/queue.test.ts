import { describe, expect, it } from "vitest";
import type { Catalog, Option } from "../src/api";
import {
  addFiles, applyAssignments, findClashes, recompute, today, versionName, videosToAssign,
} from "../src/queue";

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { lastModified: 1 });
const UFC: Option = { type: "CustomEntity01", id: 10, name: "UFC 331" };

const catalog: Catalog = {
  sequences: [
    { id: 1, code: "Premium Ice Giveaway - UFC 331", sg_activations: UFC, sg_product: [], sg_deliverable: [] },
    { id: 6, code: "Premium Ice Giveaway Square - UFC 331", sg_activations: UFC, sg_product: [], sg_deliverable: [] },
    { id: 9, code: "Somewhere Else", sg_activations: null, sg_product: [], sg_deliverable: [] },
  ],
  activations: [UFC], products: [], deliverables: [],
};

describe("addFiles", () => {
  it("skips non-media, hidden files and duplicates", () => {
    const first = addFiles([], [
      { file: file("A_Cut_v1.mov"), path: "A_Cut_v1.mov" },
      { file: file("notes.txt"), path: "notes.txt" },
      { file: file(".A_Cut_v1.mov"), path: ".A_Cut_v1.mov" },
    ]);
    expect(first.map((i) => i.file.name)).toEqual(["A_Cut_v1.mov"]);
    expect(addFiles(first, [{ file: file("A_Cut_v1.mov"), path: "A_Cut_v1.mov" }])).toEqual([]);
  });

  it("takes a numbers-only still's title from its folder", () => {
    const [item] = addFiles([], [{ file: file("2_9_1.jpg"), path: "Night 2/2_9_1.jpg" }]);
    expect(item.parsed?.title).toBe("Night2");
  });

  it("records a parse error instead of throwing", () => {
    const [item] = addFiles([], [{ file: file("Bad Name v1.mov"), path: "Bad Name v1.mov" }]);
    expect(item.error).toMatch(/underscores/);
  });
});

describe("grouping and matching", () => {
  const items = addFiles([], [
    { file: file("BRIO_UFC331_PremiumIceGiveaway_FinalCut_v3.mov"), path: "a" },
    { file: file("PremiumIceGiveaway_FinalCut_v4.mov"), path: "b" },
    { file: file("PremiumIceGiveaway_Square_Cut_v1.mov"), path: "c" },
  ]);

  it("asks once per video, with the square cut as its own video", () => {
    expect(videosToAssign(items).map((v) => [v.title, v.count])).toEqual([
      ["UFC331_PremiumIceGiveaway", 1], ["PremiumIceGiveaway", 1], ["PremiumIceGiveaway_Square", 1],
    ]);
  });

  it("strips the campaign once it is known, merging the groups", () => {
    const chosen = new Map(videosToAssign(items).map((v) => [v.key, { activation: UFC, products: [] }]));
    const { groups } = recompute(applyAssignments(items, chosen), catalog);
    expect(groups.map((g) => [g.title, g.items.length, g.candidates[0][1].id])).toEqual([
      ["PremiumIceGiveaway", 2, 1],
      ["PremiumIceGiveaway_Square", 1, 6],
    ]);
  });
});

describe("findClashes", () => {
  it("matches Version names case-insensitively per Sequence", () => {
    const [item] = addFiles([], [{ file: file("PremiumIceGiveaway_FinalCut_v4.mov"), path: "x" }]);
    const seq = catalog.sequences[0];
    expect(versionName("BRIO", item, seq)).toBe("BRIO_UFC331_PremiumIceGiveaway_FinalCut_v004");
    const queue = [{ item, sequence: seq }];
    expect(findClashes(queue, "BRIO", [{ sequenceId: 1, code: "brio_ufc331_premiumicegiveaway_finalcut_v004 " }])).toHaveLength(1);
    expect(findClashes(queue, "BRIO", [{ sequenceId: 9, code: "BRIO_UFC331_PremiumIceGiveaway_FinalCut_v004" }])).toHaveLength(0);
  });
});

it("formats the playlist date locally", () => {
  expect(today(new Date(2026, 0, 5, 23, 30))).toBe("20260105");
});
