import { describe, expect, it } from "vitest";
import { render, renderModelBrief } from "../src/render.js";
import type { ValidBrief } from "../src/llm/schema.js";
import { finding, snap } from "./fixtures.js";
import { DateTime } from "luxon";

const w = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "Tuesday 13 Oct" };
const empty = (): ValidBrief => ({ yesterday: [], attention: [], focus: [] });

describe("model rendering", () => {
  it("escapes all model text, including focus reasons and notes", () => {
    const f = finding();
    const text = renderModelBrief({ yesterday: [{ text: "<script> & progress", sources: [f] }], attention: [], focus: [{ text: "Fix <CI>", reason: "It failed & needs <help>", sources: [f] }], note: "<hello> & bye" }, [snap()], w, 3800);
    expect(text).toContain("- &lt;script&gt; &amp; progress");
    expect(text).toContain("1. Fix &lt;CI&gt; (It failed &amp; needs &lt;help&gt;)");
    expect(text).toContain("<i>&lt;hello&gt; &amp; bye</i>");
    expect(text).not.toContain("<script>");
  });
  it("deduplicates stored source URLs and limits links to three per item", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ label: `source-${i}`, url: `https://github.com/me/demo/issues/${i}` }));
    const text = renderModelBrief({ ...empty(), attention: [{ text: "Review issues", sources: [finding({ sources: [sources[0], sources[0]] }), finding({ id: "second", sources })] }] }, [], w, 3800);
    expect(text.match(/<a href=/g)).toHaveLength(3);
    expect(text.match(/>source-0<\/a>/g)).toHaveLength(1);
    expect(text).not.toContain("source-3");
  });
  it("skips empty sections, keeps section order, and includes failed repos", () => {
    const item = { text: "Progress", sources: [finding()] };
    const text = renderModelBrief({ ...empty(), yesterday: [item], attention: [item] }, [snap({ error: "GitHub 404" })], w, 3800, { userName: "Courtney", now: DateTime.fromISO("2026-10-14T05:00:00Z") });
    expect(text).toContain("Good morning, Courtney. Here's Tuesday 13 Oct.");
    expect(text.indexOf("Yesterday")).toBeLessThan(text.indexOf("Needs attention"));
    expect(text).not.toContain("Today, I'd suggest");
    expect(text).toContain("Couldn't read: me/demo (GitHub 404)");
    expect(renderModelBrief(empty(), [], w, 3800)).not.toContain("Yesterday");
  });
  it("truncates by complete lines with the shared length limit", () => {
    const items = Array.from({ length: 30 }, () => ({ text: "Progress ".repeat(20), sources: [finding()] }));
    const text = renderModelBrief({ ...empty(), yesterday: items }, [], w, 700);
    expect(text.length).toBeLessThanOrEqual(700);
    expect(text).toMatch(/\+\d+ more line\(s\) not shown<\/i>$/);
    expect(text.match(/<a /g)?.length).toBe(text.match(/<\/a>/g)?.length);
  });
  it("adds an escaped fallback footer as the final rule-only line", () => {
    const text = render([], [], w, 3800, "Rule-only brief: model unavailable");
    expect(text).toContain("Quiet day");
    expect(text).toMatch(/<i>Rule-only brief: model unavailable<\/i>$/);
    expect(render([], [], w, 3800, "<footer>")).toContain("<i>&lt;footer&gt;</i>");
  });
});
