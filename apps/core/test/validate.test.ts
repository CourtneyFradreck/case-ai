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
    if (!result.ok) expect(result.reason).toContain("reason");
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
    const result = validate(output({ yesterday: [{ ...item, text: "https://evil.test" }], attention: [{ text: "Review https://evil.test now", sources: ["F2"] }], focus: [{ text: "Fix www.evil.test CI", reason: "Because http://evil.test it failed", sources: ["F3"] }], note: "Visit WWW.evil.test please" }), new Map([["F1", f], ["F2", medium], ["F3", high]]), [f, medium, high]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brief.yesterday).toEqual([]);
      expect(result.brief.attention[0].text).toBe("Review  now");
      expect(result.brief.attention[1].text).toBe("Fix  CI (Because  it failed)");
      expect(result.brief.note).toBe("Visit  please");
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
