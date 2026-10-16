import { describe, expect, it } from "vitest";
import { render, renderModelBrief } from "../src/render.js";
import type { ValidBrief } from "../src/llm/schema.js";
import { finding, snap } from "./fixtures.js";
import { DateTime } from "luxon";

const w = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "yesterday" };
const empty = (): ValidBrief => ({ yesterday: [], attention: [], focus: [] });

describe("model rendering", () => {
  it("escapes all model text, including focus reasons and notes", () => {
    const f = finding();
    const ci = finding({ id: "ci", severity: "high", sources: [{ label: "run", url: "https://github.com/me/demo/actions/runs/1" }] });
    const text = renderModelBrief({ yesterday: [{ text: "<script> & progress", sources: [f] }], attention: [], focus: [{ text: "Fix <CI>", reason: "It failed & needs <help>", sources: [ci] }], note: "<CI> still needs attention & a fix.", noteSources: [ci] }, [snap()], w, 3800);
    expect(text).toContain("• &lt;script&gt; &amp; progress");
    expect(text).toContain("🔴 Fix &lt;CI&gt; (It failed &amp; needs &lt;help&gt;)");
    expect(text).toContain("<i>&lt;CI&gt; still needs attention &amp; a fix.</i>");
    expect(text).not.toContain("<script>");
  });
  it("deduplicates stored source URLs and limits links to three per item", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ label: `source-${i}`, url: `https://github.com/me/demo/issues/${i}` }));
    const text = renderModelBrief({ ...empty(), attention: [{ text: "Review issues", sources: [finding({ severity: "medium", sources: [sources[0], sources[0]] }), finding({ id: "second", severity: "medium", sources })] }] }, [], w, 3800);
    expect(text.match(/<a href=/g)).toHaveLength(3);
    expect(text.match(/>source-0<\/a>/g)).toHaveLength(1);
    expect(text).not.toContain("source-3");
  });
  it("skips empty sections, keeps section order, and includes failed repos", () => {
    const item = { text: "Progress", sources: [finding()] };
    const attention = { text: "Fix CI", sources: [finding({ id: "ci", severity: "high", sources: [{ label: "run", url: "https://github.com/me/demo/actions/runs/1" }] })] };
    const text = renderModelBrief({ ...empty(), yesterday: [item], attention: [attention] }, [snap({ error: "GitHub 404" })], w, 3800, { userName: "Courtney", now: DateTime.fromISO("2026-10-14T05:00:00Z") });
    expect(text).toContain("Good morning, Courtney. Here's your morning brief.");
    expect(text.indexOf("Here's what needs your attention")).toBeLessThan(text.indexOf("Here's what you worked on yesterday"));
    expect(text).not.toContain("Today, I'd suggest");
    expect(text).toContain("Couldn't read: me/demo (GitHub 404)");
    expect(renderModelBrief(empty(), [], w, 3800)).not.toContain("Here's what you worked on");
  });
  it("truncates by complete lines with the shared length limit", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ text: "Progress ".repeat(20), sources: [finding({ id: `commit-${i}`, sources: [{ label: "commit", url: `https://github.com/me/demo/commit/${i}` }] })] }));
    const text = renderModelBrief({ ...empty(), yesterday: items }, [], w, 700);
    expect(text.length).toBeLessThanOrEqual(700);
    expect(text).toMatch(/\+\d+ more line\(s\) not shown<\/i>$/);
    expect(text.match(/<a /g)?.length).toBe(text.match(/<\/a>/g)?.length);
  });
  it("adds an escaped fallback footer as the final rule-only line", () => {
    const text = render([], [], w, 3800, "Rule-only brief: model unavailable");
    expect(text).toContain("Nothing new in the past week.");
    expect(text).toMatch(/<i>Rule-only brief: model unavailable<\/i>$/);
    expect(render([], [], w, 3800, "<footer>")).toContain("<i>&lt;footer&gt;</i>");
  });
});
