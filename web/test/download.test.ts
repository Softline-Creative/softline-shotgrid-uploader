import { expect, it } from "vitest";
import { uniqueNames } from "../src/download";

it("makes names safe to save and unique within a batch", () => {
  expect(uniqueNames(["a.mov", "A.mov", "a.mov", "b/c:d.mov", "", "noext", "noext"])).toEqual([
    "a.mov", "A (2).mov", "a (3).mov", "b_c_d.mov", "untitled", "noext", "noext (2)",
  ]);
});
