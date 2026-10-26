import { describe, expect, it } from "vitest";
import { followRelinks, levenshtein, relink, similarity } from "../src/intent/relink.js";

const item = (id: string, text: string) => ({ id, text });

describe("similarity", () => {
  it("is a Levenshtein ratio over the longer string", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(similarity("abcd", "abcx")).toBe(0.75);
    expect(similarity("", "")).toBe(1);
    expect(similarity("same", "same")).toBe(1);
  });
});

describe("relink", () => {
  it("re-links a typo fix", () => {
    expect(relink([item("a", "Ship the parsre")], [item("b", "Ship the parser")])).toEqual([{ from: "a", to: "b" }]);
  });
  it("compares normalised text, so case and trailing punctuation don't count against a match", () => {
    expect(relink([item("a", "Handle CRLF line endngs.")], [item("b", "handle crlf line endings")])).toEqual([{ from: "a", to: "b" }]);
  });
  it("doesn't re-link a rewrite", () => {
    expect(relink([item("a", "Ship the parser")], [item("b", "Write the parser docs")])).toEqual([]);
  });
  it("doesn't re-link when two new items are equally close", () => {
    const gone = [item("a", "Fix the parser bug")];
    expect(relink(gone, [item("b", "Fix the parser bugs"), item("c", "Fix the parser bug!")])).toEqual([]);
  });
  it("doesn't re-link when two gone items are equally close to one new item", () => {
    const added = [item("c", "Fix the parser bug")];
    expect(relink([item("a", "Fix the parser bugs"), item("b", "Fix the parser bug!")], added)).toEqual([]);
  });
  it("pairs each side with its mutual best match", () => {
    const gone = [item("a", "Write the deploy guide"), item("b", "Add retries to delivery")];
    const added = [item("c", "Add retries to deliveries"), item("d", "Write the deploy guides")];
    expect(relink(gone, added)).toEqual([{ from: "a", to: "d" }, { from: "b", to: "c" }]);
  });
  it("skips a pair when the gone item's best match prefers another gone item", () => {
    const gone = [item("a", "Fix the parser bug"), item("b", "Fix the parser bugs")];
    expect(relink(gone, [item("c", "Fix the parser bugs!")])).toEqual([{ from: "b", to: "c" }]);
  });
  it("does nothing with an empty side", () => {
    expect(relink([], [item("a", "New")])).toEqual([]);
    expect(relink([item("a", "Old")], [])).toEqual([]);
  });
});

describe("followRelinks", () => {
  it("maps an ID to the current item that lists it in previousIds", () => {
    expect(followRelinks(["a", "b", "x"], [{ id: "c", previousIds: ["z", "a"] }, { id: "b", previousIds: [] }]))
      .toEqual(new Set(["c", "b", "x"]));
  });
  it("keeps an ID that is still present even if another item once replaced it", () => {
    expect(followRelinks(["a"], [{ id: "a", previousIds: [] }, { id: "c", previousIds: ["a"] }])).toEqual(new Set(["a"]));
  });
});
