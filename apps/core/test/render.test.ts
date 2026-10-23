import { describe, it, expect } from "vitest";
import { render } from "../src/render.js";
import type { Window } from "../src/time.js";
import type { Finding } from "../src/types.js";
import { snap } from "./fixtures.js";
import { DateTime } from "luxon";

const W: Window = {
  start: new Date("2026-10-12T22:00:00Z"),
  end: new Date("2026-10-13T22:00:00Z"),
  label: "yesterday",
};

let n = 0;
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: `f${++n}`,
  rule: "test",
  severity: "info",
  repo: "me/demo",
  summary: "Something happened",
  sources: [{ label: "commit", url: `https://github.com/me/demo/commit/${n}` }],
  ...over,
});

describe("render", () => {
  it("uses today's date in the greeting header", () => {
    expect(render([], [snap()], W, 3800, undefined, { userName: "Courtney", now: DateTime.fromISO("2026-10-16T05:00:00Z") })).toContain("<b>Good morning, Courtney.</b>\nFriday, 16 Oct 2026");
  });

  it("reports a quiet day without section headers when there are no findings or failures", () => {
    const out = render([], [snap()], W);
    expect(out).toContain("Nothing new in the past week.");
    expect(out).not.toContain("Needs attention");
    expect(out).not.toMatch(/<b>(?:Yesterday|Over the weekend|On \w+)<\/b>/);
  });

  it("escapes HTML in finding summaries", () => {
    const out = render([finding({ summary: `PR #1 "<script>alert(1)</script> & co"` })], [snap()], W);
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&amp; co");
    expect(out).not.toContain("<script>");
  });

  it("escapes HTML in detail lines such as commit messages", () => {
    const out = render([finding({ details: [`fix <script>alert(1)</script> & co`] })], [snap()], W);
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&amp; co");
    expect(out).not.toContain("<script>");
  });

  it("encodes double quotes in source URLs as &quot; inside href", () => {
    const out = render(
      [finding({ sources: [{ label: "PR", url: `https://example.com/?q="x"` }] })],
      [snap()], W,
    );
    expect(out).toContain(`<a href="https://example.com/?q=&quot;x&quot;">PR</a>`);
  });

  it("renders every source as an anchor with its label", () => {
    const sources = [
      { label: "PR #1", url: "https://github.com/me/demo/pull/1" },
      { label: "CI run", url: "https://github.com/me/demo/actions/runs/2" },
    ];
    const out = render([finding({ sources })], [snap()], W);
    for (const s of sources) expect(out).toContain(`<a href="${s.url}">${s.label}</a>`);
  });

  it("puts attention findings before yesterday's, with high before medium", () => {
    // Deliberately out of order so render's own ordering is what's tested
    const out = render(
      [
        finding({ severity: "info", summary: "INFO-ITEM" }),
        finding({ severity: "medium", summary: "MEDIUM-ITEM" }),
        finding({ severity: "high", summary: "HIGH-ITEM" }),
      ],
      [snap()], W,
    );
    const attention = out.indexOf("Needs attention");
    const yesterday = out.indexOf("Yesterday");
    expect(attention).toBeGreaterThan(-1);
    expect(yesterday).toBeGreaterThan(attention);
    expect(out.indexOf("🔴 HIGH-ITEM")).toBeGreaterThan(attention);
    expect(out.indexOf("🔴 HIGH-ITEM")).toBeLessThan(out.indexOf("🟡 MEDIUM-ITEM"));
    expect(out.indexOf("🟡 MEDIUM-ITEM")).toBeLessThan(yesterday);
    expect(out.indexOf("INFO-ITEM")).toBeGreaterThan(yesterday);
  });

  it("adds a footer naming repos that couldn't be read, even when there are findings", () => {
    const out = render(
      [finding({ severity: "high", summary: "CI failing" })],
      [snap(), snap({ repo: "me/broken", error: "GitHub 404" })],
      W,
    );
    const footer = out.split("\n").find((l) => l.includes("Couldn't read"));
    expect(footer).toBeDefined();
    expect(footer).toContain("me/broken");
  });

  it("truncates long briefs to maxChars and says how many lines were cut", () => {
    const findings = Array.from({ length: 300 }, (_, i) =>
      finding({ summary: `Commit ${String(i).padStart(3, "0")} `.padEnd(60, "x") }),
    );
    const out = render(findings, [snap()], W, 3800);
    expect(out.length).toBeLessThanOrEqual(3800);
    expect(out.length).toBeLessThan(4096);
    // The note may be wrapped in italics, so allow a closing tag after it
    const m = out.match(/\+(\d+) more line\(s\) not shown(<\/i>)?$/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  it("never truncates a short brief", () => {
    const out = render([finding(), finding(), finding()], [snap()], W);
    expect(out).not.toContain("more line(s)");
  });
});
