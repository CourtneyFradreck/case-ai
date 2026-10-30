import { describe, expect, it } from "vitest";
import { codeFilenames, render, renderModelBrief } from "../src/render.js";
import type { ValidBrief } from "../src/llm/schema.js";
import { finding, snap } from "./fixtures.js";
import { DateTime } from "luxon";

const w = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "yesterday" };
const empty = (): ValidBrief => ({ yesterday: [], attention: [], focus: [] });

describe("model rendering", () => {
  it("escapes all model text and notes, and never shows focus reasons", () => {
    const f = finding();
    const ci = finding({ id: "ci", severity: "high", sources: [{ label: "run", url: "https://github.com/me/demo/actions/runs/1" }] });
    const text = renderModelBrief({ yesterday: [{ text: "<script> & progress", sources: [f] }], attention: [], focus: [{ text: "Fix <CI>", reason: "It failed & needs <help>", sources: [ci] }], note: "<CI> still needs attention & a fix.", noteSources: [ci] }, [snap()], w, 3800);
    expect(text).toContain("• &lt;script&gt; &amp; progress");
    expect(text).toContain("🔴 Fix &lt;CI&gt; [");
    expect(text).not.toContain("help");
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
    const text = renderModelBrief({ ...empty(), yesterday: [item], attention: [attention] }, [snap({ error: "Couldn't access me/demo (404: not found, or the token can't see it)" })], w, 3800, { userName: "Courtney", now: DateTime.fromISO("2026-10-14T05:00:00Z") });
    expect(text).toContain("<b>Good morning, Courtney.</b>");
    expect(text.indexOf("Needs attention")).toBeLessThan(text.indexOf("<b>Yesterday</b>"));
    expect(text).not.toContain("Today, I'd suggest");
    expect(text).toContain("<i>Couldn't access me/demo (404: not found, or the token can't see it)</i>");
    expect(renderModelBrief(empty(), [], w, 3800)).not.toMatch(/<b>(?:Yesterday|Over the weekend|On \w+)<\/b>/);
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
  describe("focus suggestions", () => {
    const ci = finding({ id: "ci", severity: "high", summary: "CI failing", sources: [{ label: "run", url: "https://github.com/me/demo/actions/runs/1" }] });
    const next = finding({ id: "next_a", rule: "next_item", summary: "Next in me/demo: Ship <it>", sources: [{ label: "NEXT.md", url: "https://github.com/me/demo/blob/main/NEXT.md#L3" }] });
    const focus = [
      { text: "Fix CI", reason: "CI is failing", sources: [ci] },
      { text: "Ship <it>", reason: "Open in NEXT.md & active", sources: [next] },
    ];
    const pr = finding({ id: "pr", severity: "medium", summary: "PR #4 waiting", sources: [{ label: "PR", url: "https://github.com/me/demo/pull/4" }] });
    it("renders numbered, escaped suggestions between attention and the recap in the rule-only brief, without reasons", () => {
      const text = render([ci, pr, finding()], [], w, 3800, undefined, {}, focus);
      expect(text).toContain([
        "<b>Today, I'd suggest</b>",
        '1. Fix CI [<a href="https://github.com/me/demo/actions/runs/1">run</a>]',
        '2. Ship &lt;it&gt; [<a href="https://github.com/me/demo/blob/main/NEXT.md#L3">NEXT.md</a>]',
      ].join("\n"));
      expect(text).not.toContain("CI is failing");
      expect(text).not.toContain("active");
      expect(text.indexOf("Needs attention")).toBeLessThan(text.indexOf("Today, I'd suggest"));
      expect(text.indexOf("Today, I'd suggest")).toBeLessThan(text.indexOf("<b>Yesterday</b>"));
      expect(render([ci, finding()], [], w, 3800, undefined, {}, [])).toBe(render([ci, finding()], [], w, 3800));
    });
    it("shows a suggested finding in the suggestion only, not again in attention", () => {
      const text = render([ci, pr, finding()], [], w, 3800, undefined, {}, focus);
      expect(text).not.toContain("CI failing");
      expect(text).toContain("🟡 PR #4 waiting");
    });
    it("never repeats a fact in brackets on the same line", () => {
      const repeat = [{ text: "Branch feat/x in me/demo: untouched for 8 days (Untouched for 8 days)", reason: "Untouched", sources: [pr] }];
      expect(render([finding()], [], w, 3800, undefined, {}, repeat)).toContain("1. Branch feat/x in me/demo: untouched for 8 days [");
      const twice = [{ text: "Merge or close feat/x (idle 8 days) (Unmerged and untouched for 8 days)", reason: "Untouched", sources: [pr] }];
      expect(renderModelBrief({ ...empty(), focus: twice }, [], w, 3800, { focus: true })).toContain("1. Merge or close feat/x (idle 8 days) [");
    });
    it("renders the model's suggestions only with the focus option on", () => {
      const brief = { ...empty(), attention: [{ text: "CI failing", sources: [ci] }], focus };
      const on = renderModelBrief(brief, [], w, 3800, { focus: true });
      expect(on).toContain("<b>Today, I'd suggest</b>\n1. Fix CI [");
      expect(on).toContain("2. Ship &lt;it&gt; [");
      expect(on).not.toContain("CI failing");
      expect(on).not.toContain("CI is failing");
      const off = renderModelBrief(brief, [], w, 3800);
      expect(off).not.toContain("Today, I'd suggest");
      expect(off).not.toContain("Ship");
    });
  });
});

describe(".md filenames", () => {
  const stale = finding({ id: "stale", rule: "next_stale", severity: "low", summary: "NEXT.md in me/demo hasn't changed in 20 days; see README.md & docs/setup.md", sources: [{ label: "NEXT.md", url: "https://github.com/me/demo/blob/main/NEXT.md" }] });
  it("wraps them in code in the rule-only brief, but not inside links", () => {
    const text = render([stale], [], w, 3800);
    expect(text).toContain('⚪ <code>NEXT.md</code> in me/demo hasn\'t changed in 20 days; see <code>README.md</code> &amp; <code>docs/setup.md</code> [<a href="https://github.com/me/demo/blob/main/NEXT.md">NEXT.md</a>]');
  });
  it("wraps them in model text, focus suggestions and the footer", () => {
    const text = renderModelBrief({ ...empty(), attention: [{ text: "Update NEXT.md, it's stale", sources: [stale] }], focus: [{ text: "Rewrite readme.MD", reason: "Open in NEXT.md", sources: [finding({ id: "next_r", rule: "next_item" })] }] }, [], w, 3800, { focus: true });
    expect(text).toContain("⚪ Update <code>NEXT.md</code>, it's stale [");
    expect(text).toContain("1. Rewrite <code>readme.MD</code> [");
    expect(text).toContain('<a href="https://github.com/me/demo/blob/main/NEXT.md">NEXT.md</a>');
    expect(render([], [], w, 3800, "See NEXT.md")).toContain("<i>See <code>NEXT.md</code></i>");
  });
  it("leaves other words, links, existing code and longer extensions alone", () => {
    expect(codeFilenames('a.mdx, NEXT.md.bak, x.mdown, .md, <a href="https://x/NEXT.md">NEXT.md</a> <code>README.md</code> <b>x</b>'))
      .toBe('a.mdx, NEXT.md.bak, x.mdown, .md, <a href="https://x/NEXT.md">NEXT.md</a> <code>README.md</code> <b>x</b>');
    expect(codeFilenames("me/case-ai/docs/NEXT.md")).toBe("<code>me/case-ai/docs/NEXT.md</code>");
    expect(codeFilenames("Done: NEXT.md.")).toBe("Done: <code>NEXT.md</code>.");
  });
});

