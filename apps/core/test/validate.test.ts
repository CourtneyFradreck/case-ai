import { describe, expect, it } from "vitest";
import { validate } from "../src/llm/validate.js";
import { briefJsonSchema } from "../src/llm/schema.js";
import { finding } from "./fixtures.js";

describe("brief validation", () => {
  const f = finding();
  const aliases = new Map([["F1", f]]);
  const item = { text: "You made progress.", sources: ["F1"] };
  const output = (over = {}) => JSON.stringify({ yesterday: [item], attention: [], focus: [], ...over });
  it("resolves valid aliases to stored findings", () => {
    expect(validate(output(), aliases, [f])).toEqual({ ok: true, brief: { yesterday: [{ ...item, sources: [f] }], attention: [], focus: [] }, dropped: [], addedBack: [] });
    expect(briefJsonSchema).not.toHaveProperty("$schema");
  });
  it("rejects invalid JSON", () => expect(validate("not json", aliases, [f]).ok).toBe(false));
  it("reports schema violations", () => {
    const result = validate(output({ focus: [{ ...item, reason: "" }] }), aliases, [f]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_schema");
      expect(result.detail).toContain("reason");
    }
  });
  it("removes unknown aliases and drops items with no known sources", () => {
    const result = validate(output({ yesterday: [{ ...item, sources: ["missing", "F1"] }, { ...item, sources: ["missing"] }] }), aliases, [f]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brief.yesterday).toEqual([{ ...item, sources: [f] }]);
      expect(result.dropped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "no_sources" })]));
    }
  });
  it("strips URLs from text, reasons and the note, and drops text emptied by stripping", () => {
    const medium = finding({ id: "review", severity: "medium" });
    const high = finding({ id: "ci", severity: "high" });
    const result = validate(output({ yesterday: [{ ...item, text: "https://evil.test" }], attention: [{ text: "Review https://evil.test now", sources: ["F2"] }], focus: [{ text: "Fix www.evil.test CI", reason: "Because http://evil.test it failed", sources: ["F3"] }], note: "CI needs attention https://evil.test", noteSources: ["F3"] }), new Map([["F1", f], ["F2", medium], ["F3", high]]), [f, medium, high]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brief.yesterday).toEqual([]);
      expect(result.brief.attention[0].text).toBe("Review  now");
      expect(result.brief.attention[1].text).toBe("Fix  CI (Because  it failed)");
      expect(result.brief.note).toBe("CI needs attention");
      expect(result.brief.noteSources).toEqual([high]);
    }
  });
  it("adds uncited high findings after dropping invalid items", () => {
    const high = finding({ id: "high", severity: "high", summary: "CI is failing" });
    const result = validate(output({ yesterday: [], attention: [], focus: [] }), new Map([["F1", high]]), [high]);
    expect(result).toMatchObject({ ok: true, brief: { attention: [{ text: high.summary, sources: [high] }] }, addedBack: [high.id] });
  });
  it("folds a focus citation into attention without repeating it", () => {
    const high = finding({ severity: "high" });
    const result = validate(output({ yesterday: [], focus: [{ ...item, reason: "It failed" }] }), new Map([["F1", high]]), [high]);
    expect(result).toMatchObject({ ok: true, addedBack: [], brief: { attention: [{ text: "You made progress. (It failed)", sources: [high] }], focus: [] } });
  });
  it("adds an uncited medium finding as a plain attention line and records its ID", () => {
    const medium = finding({ id: "medium", severity: "medium", summary: "New comment from tendai" });
    const result = validate(output({ yesterday: [] }), new Map([["F1", medium]]), [medium]);
    expect(result).toEqual({ ok: true, brief: { yesterday: [], attention: [{ text: medium.summary, sources: [medium] }], focus: [] }, dropped: [], addedBack: [medium.id] });
  });
  it("keeps cited medium findings without adding them again", () => {
    const medium = finding({ severity: "medium" });
    const result = validate(output({ yesterday: [], attention: [item] }), new Map([["F1", medium]]), [medium]);
    expect(result).toMatchObject({ ok: true, brief: { attention: [{ text: item.text, sources: [medium] }] }, addedBack: [] });
  });
  it("adds excluded private findings as plain lines in their matching sections", () => {
    const privateInfo = finding({ id: "private-info", repo: "me/secret", sources: [{ label: "commit", url: "https://github.com/me/secret/commit/abc" }] });
    const privateHigh = finding({ id: "private-high", repo: "me/secret", severity: "high", sources: [{ label: "run", url: "https://github.com/me/secret/actions/runs/1" }] });
    expect(validate(output(), aliases, [f, privateInfo, privateHigh])).toMatchObject({ ok: true, brief: {
      yesterday: [{ text: item.text, sources: [f] }, { text: privateInfo.summary, sources: [privateInfo] }],
      attention: [{ text: privateHigh.summary, sources: [privateHigh] }],
    } });
  });
  it("rejects all-empty output if findings exist, even if there is a note", () => {
    expect(validate(output({ yesterday: [], note: "Hello" }), aliases, [f])).toEqual({ ok: false, reason: "empty_brief" });
  });
});

describe("NEXT.md items in validation (focusButtons)", () => {
  const commits = finding();
  const next = finding({ id: "next_abc", rule: "next_item", summary: "Next in me/demo: Ship the parser", sources: [{ label: "NEXT.md", url: "https://github.com/me/demo/blob/main/NEXT.md#L3" }] });
  const aliases = new Map([["F1", commits], ["F2", next]]);
  const output = (over = {}) => JSON.stringify({ yesterday: [{ text: "Made progress.", sources: ["F1"] }], attention: [], focus: [], ...over });
  it("keeps a focus suggestion that cites a next_item finding", () => {
    const result = validate(output({ focus: [{ text: "Ship the parser", reason: "It's next in NEXT.md", sources: ["F2"] }] }), aliases, [commits, next], true);
    expect(result).toMatchObject({ ok: true, brief: { focus: [{ text: "Ship the parser", reason: "It's next in NEXT.md", sources: [next] }] } });
  });
  it("never lets a next_item finding into the recap or attention", () => {
    const result = validate(output({ yesterday: [{ text: "Made progress.", sources: ["F1"] }, { text: "Ship the parser", sources: ["F2"] }], attention: [{ text: "Ship it", sources: ["F2"] }] }), aliases, [commits, next], true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brief.yesterday).toEqual([{ text: "Made progress.", sources: [commits] }]);
      expect(result.brief.attention).toEqual([]);
    }
  });
  it("doesn't add an uncited or private next_item finding back as a recap line", () => {
    const privateNext = { ...next, id: "next_private", repo: "me/secret" };
    const result = validate(output(), aliases, [commits, next, privateNext], true);
    expect(result).toMatchObject({ ok: true, brief: { yesterday: [{ sources: [commits] }], attention: [], focus: [] }, addedBack: [] });
  });
  it("treats a brief citing only next_item findings outside focus as empty", () => {
    expect(validate(output({ yesterday: [{ text: "Ship the parser", sources: ["F2"] }] }), aliases, [commits, next], true)).toMatchObject({ ok: false, reason: "empty_brief" });
  });
  it("still lists a high finding in attention when it is cited only in focus", () => {
    const high = finding({ id: "ci", severity: "high", summary: "CI failing" });
    const result = validate(output({ focus: [{ text: "Fix CI", reason: "CI is failing", sources: ["F3"] }] }), new Map([...aliases, ["F3", high]]), [commits, high, next], true);
    expect(result).toMatchObject({ ok: true, brief: { attention: [{ text: "CI failing", sources: [high] }], focus: [{ text: "Fix CI", sources: [high] }] }, addedBack: ["ci"] });
  });
  it("drops focus suggestions with no valid source, no reason left, or only already-suggested findings", () => {
    const high = finding({ id: "ci", severity: "high", summary: "CI failing" });
    const all = new Map([...aliases, ["F3", high]]);
    const fix = { text: "Fix CI", reason: "CI is failing", sources: ["F3"] };
    const first = validate(output({ focus: [fix,
      { text: "Invented work", reason: "Seems important", sources: ["F9"] },
      { text: "Read this", reason: "https://evil.test", sources: ["F2"] },
    ] }), all, [commits, high, next], true);
    expect(first).toMatchObject({ ok: true, brief: { focus: [{ text: "Fix CI", sources: [high] }] } });
    if (first.ok) expect(first.dropped).toEqual([
      { section: "focus", index: 1, reason: "no_sources", aliases: ["F9"] },
      { section: "focus", index: 2, reason: "empty_reason" },
    ]);
    const second = validate(output({ focus: [fix,
      { text: "Fix CI again", reason: "Still failing", sources: ["F3"] },
      { text: "Ship the parser", reason: "Open in NEXT.md", sources: ["F2", "F9"] },
    ] }), all, [commits, high, next], true);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.brief.focus.map((i) => i.text)).toEqual(["Fix CI", "Ship the parser"]);
      expect(second.brief.focus[1].sources).toEqual([next]);
      expect(second.dropped).toEqual([
        { section: "focus", index: 1, reason: "duplicate_focus" },
        { section: "focus", index: 2, reason: "unknown_aliases", aliases: ["F9"] },
      ]);
    }
  });
});

