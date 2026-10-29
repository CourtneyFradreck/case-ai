import { describe, it, expect } from "vitest";
import { prSteps, render } from "../src/render.js";
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

  it("adds a footer line per repo that couldn't be read, even when there are findings", () => {
    const out = render(
      [finding({ severity: "high", summary: "CI failing" })],
      [snap(), snap({ repo: "me/broken", error: "Couldn't access me/broken (401: check the token)" }), snap({ repo: "me/other", error: "Couldn't read branches in other (500)" })],
      W,
    );
    const lines = out.split("\n");
    expect(lines).toContain("<i>Couldn't access me/broken (401: check the token)</i>");
    expect(lines).toContain("<i>Couldn't read branches in other (500)</i>");
    expect(out).not.toContain("Couldn't read:");
  });

  it("puts skipped branches of readable repos on one short line at the end", () => {
    const out = render([], [
      snap({ warnings: ["Skipped branch orphan in 1710 (no common history with main)"] }),
      snap({ repo: "me/other", warnings: ["Skipped branch feature in other (500)"] }),
    ], W);
    expect(out.split("\n").at(-1)).toBe("<i>Skipped branch orphan in 1710 (no common history with main); Skipped branch feature in other (500)</i>");
    expect(render([], [snap()], W)).not.toContain("Skipped");
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

describe("merged PR lines", () => {
  const W: Window = { start: new Date("2026-10-28T22:00:00Z"), end: new Date("2026-10-29T22:00:00Z"), label: "yesterday" };
  const merge = (repo: string, number: number, title: string, commits?: number) => finding({
    id: `${repo}-pr-${number}`, repo, rule: "merged_pr", severity: "info", summary: `Merged PR #${number} "${title}" in ${repo}`,
    activity: { kind: "pr", action: "Merged", number, title, ...(commits ? { commits } : {}) },
    sources: [{ label: "PR", url: `https://github.com/${repo}/pull/${number}` }],
  });
  const phases = [2, 3, 4, 5, 6, 7, 8].map((n) => merge("me/1710", n, `Phase ${n - 4 < 0 ? 0 : n - 4}: build step ${n}`, n));
  const lines = (out: string) => out.split("\n").filter((l) => l.startsWith("• "));

  it("gives each merged PR its commit count", () => {
    const out = render([merge("me/1710", 8, "Phase 4 shell", 6), merge("me/1710", 9, "Fix typo", 1)], [snap()], W, 3800, undefined, { collapsePrs: true });
    expect(lines(out)).toEqual([
      '• Merged PR #8 "Phase 4 shell" (6 commits). [<a href="https://github.com/me/1710/pull/8">PR</a>]',
      '• Merged PR #9 "Fix typo" (1 commit). [<a href="https://github.com/me/1710/pull/9">PR</a>]',
    ]);
  });
  it("keeps three merged PRs as separate lines", () => {
    const out = render(phases.slice(0, 3), [snap()], W, 3800, undefined, { collapsePrs: true });
    expect(lines(out)).toHaveLength(3);
    expect(out).not.toContain("PRs merged (");
  });
  it("sums up more than three merged PRs in a repo on one line linking to the merged PR list", () => {
    const commit = finding({ id: "c", repo: "me/1710", rule: "commits", severity: "info", summary: "A commit on main in me/1710",
      activity: { kind: "commits", count: 1, branch: "main", messages: ["Tidy"] }, sources: [{ label: "commit", url: "https://github.com/me/1710/commit/c" }] });
    const other = merge("me/case-ai", 20, "Header attribution", 3);
    const out = render([...phases, commit, other], [snap()], W, 3800, undefined, { collapsePrs: true });
    expect(lines(out)).toEqual([
      '• A commit on main: Tidy. [<a href="https://github.com/me/1710/commit/c">commit</a>]',
      '• 7 PRs merged (#2–#8), covering Phases 0–4. [<a href="https://github.com/me/1710/pulls?q=is%3Apr+is%3Amerged">PRs</a>]',
      '• Merged PR #20 "Header attribution" (3 commits). [<a href="https://github.com/me/case-ai/pull/20">PR</a>]',
    ]);
  });
  it("lists every merged PR when collapsing is off (CASE_BRIEF_MODE=all)", () => {
    expect(lines(render(phases, [snap()], W, 3800, undefined, { collapsePrs: false }))).toHaveLength(7);
    expect(lines(render(phases, [snap()], W))).toHaveLength(7);
  });
  it("names numbered steps from PR titles", () => {
    expect(prSteps(["Phase 0: shell", "phase 1 assets", "Phase 2", "Phase 3 and polish"])).toBe("Phases 0–3");
    expect(prSteps(["Milestone 1", "Milestone 3", "Milestone 5"])).toBe("Milestones 1, 3 and 5");
    expect(prSteps(["Phase 1", "Phase 1 fixes"])).toBeUndefined();
    expect(prSteps(["Add login", "Fix 2 bugs"])).toBeUndefined();
  });
});
