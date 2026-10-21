import { describe, expect, it } from "vitest";
import { collapseRepeats, countStreaks, lastScheduledRun, shortLabel, type PastRun } from "../src/streaks.js";
import { render, renderModelBrief } from "../src/render.js";
import { finding } from "./fixtures.js";

let nextId = 100;
const run = (findingIds: string[], over: Partial<PastRun> = {}): PastRun => ({
  id: nextId--, source: "schedule", status: "ok", windowEnd: new Date(), findingIds, attentionIds: [], ...over,
});

describe("finding streaks", () => {
  it("counts consecutive previous scheduled runs containing each id", () => {
    nextId = 100;
    const runs = [run(["a", "b"]), run(["a", "b"]), run(["a"]), run(["c"])];
    expect(countStreaks(["a", "b", "c", "new"], runs)).toEqual(new Map([["a", 3], ["b", 2], ["c", 0], ["new", 0]]));
  });
  it("stops at a gap", () => {
    nextId = 100;
    expect(countStreaks(["a"], [run(["a"]), run([]), run(["a"]), run(["a"])]).get("a")).toBe(1);
    expect(countStreaks(["a"], [run([]), run(["a"])]).get("a")).toBe(0);
  });
  it("skips command, failed and unfinished runs without breaking the streak", () => {
    nextId = 100;
    const runs = [
      run([], { source: "command" }), run(["a"]), run(["a"], { source: "command" }), run([], { status: "failed" }),
      run(["a"], { status: "partial" }), run([], { status: "running" }), run(["a"]), run([]),
    ];
    expect(countStreaks(["a"], runs).get("a")).toBe(3);
  });
  it("orders runs by id, whatever order they arrive in", () => {
    nextId = 100;
    const runs = [run(["a"]), run([]), run(["a"])].reverse();
    expect(countStreaks(["a"], runs).get("a")).toBe(1);
  });
  it("returns zero for every id with no history", () => {
    expect(countStreaks(["a"], [])).toEqual(new Map([["a", 0]]));
  });
  it("finds the last completed scheduled run", () => {
    nextId = 100;
    const runs = [run([], { source: "command" }), run([], { status: "failed" }), run(["x"]), run(["y"])];
    expect(lastScheduledRun(runs)?.findingIds).toEqual(["x"]);
    expect(lastScheduledRun([run([], { source: "command" })])).toBeUndefined();
  });
});

describe("collapsing repeats", () => {
  const pr = finding({ id: "pr", rule: "idle_pr", severity: "medium", repo: "me/attachcv", summary: 'PR #14 "Fix <PR #99> parsing" in me/attachcv: no activity for 5 days', sources: [{ label: "PR", url: "https://github.com/me/attachcv/pull/14" }] });
  const branch = finding({ id: "br", rule: "stale_branch", severity: "medium", summary: "Branch feat/x in me/demo: 2 unmerged commits, untouched for 9 days", sources: [{ label: "branch", url: "https://github.com/me/demo/tree/feat/x" }] });
  const issues = finding({ id: "oi", rule: "open_issues", severity: "low", summary: "14 open issues in me/demo", sources: [{ label: "issues", url: "https://github.com/me/demo/issues" }] });
  const ci = finding({ id: "ci", rule: "failing_ci", severity: "high", summary: "CI failing on me/demo main (build), 4 days ago", sources: [{ label: "run", url: "https://github.com/me/demo/actions/runs/1" }] });
  const fresh = finding({ id: "fresh", rule: "idle_pr", severity: "medium", summary: 'PR #2 "New" in me/demo: no activity for 3 days', sources: [{ label: "PR", url: "https://github.com/me/demo/pull/2" }] });
  const recap = finding({ id: "commits" });
  const streaks = new Map([["pr", 3], ["br", 5], ["oi", 4], ["ci", 3], ["fresh", 2], ["commits", 9]]);

  it("moves medium and low findings at or above the threshold out, and tags high ones with the day", () => {
    const result = collapseRepeats([ci, pr, fresh, branch, issues, recap], streaks, 3);
    expect(result.kept).toEqual([ci, fresh, recap]);
    expect(result.collapsed).toEqual([pr, branch, issues]);
    expect(result.days).toEqual(new Map([["ci", 4]]));
    expect(collapseRepeats([ci, pr], new Map([["ci", 2], ["pr", 2]]), 3)).toEqual({ kept: [ci, pr], collapsed: [], days: new Map() });
  });
  it("names collapsed findings briefly from the start of their summaries", () => {
    expect([pr, branch, issues].map(shortLabel)).toEqual(["idle PR #14 in attachcv", "stale branch feat/x in demo", "open issues in demo"]);
    expect(shortLabel(finding({ rule: "issue_comments", repo: "me/demo", summary: '2 new comments on issue #8 "Retry" in me/demo (from tendai)' }))).toBe("comments on issue #8 in demo");
    expect(shortLabel(finding({ rule: "old_branches", summary: "3 old unmerged branches across demo (oldest 90 days)" }))).toBe("old branches");
    expect(shortLabel(finding({ rule: "unknown", summary: "x".repeat(80) }))).toHaveLength(60);
  });
  it("renders one linked, escaped collapsed line at the end of attention and day N on high lines, on both paths", () => {
    const w = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "yesterday" };
    const { kept, collapsed, days } = collapseRepeats([ci, pr, fresh, branch, issues, recap], streaks, 3);
    const still = '⚪ Still open, unchanged: 3 items (<a href="https://github.com/me/attachcv/pull/14">idle PR #14 in attachcv</a>, <a href="https://github.com/me/demo/tree/feat/x">stale branch feat/x in demo</a>, <a href="https://github.com/me/demo/issues">open issues in demo</a>)';
    const rules = render(kept, [], w, 3800, undefined, { collapsed, days });
    expect(rules).toContain(`🔴 CI failing on me/demo main (build), 4 days ago (day 4) [<a href="https://github.com/me/demo/actions/runs/1">run</a>]`);
    expect(rules).toContain(`${still}\n\n<b>Here's what you worked on yesterday</b>`);
    expect(rules).not.toContain("no activity for 5 days");
    const model = renderModelBrief({ yesterday: [], attention: [{ text: "CI is failing on main", sources: [ci] }], focus: [] }, [], w, 3800, { collapsed, days });
    expect(model).toContain("🔴 CI is failing on main (day 4) [");
    expect(model).toContain(`[<a href="https://github.com/me/demo/actions/runs/1">run</a>]\n${still}`);
  });
  it("lists at most five names", () => {
    const many = Array.from({ length: 7 }, (_, i) => finding({ id: `p${i}`, rule: "idle_pr", severity: "medium", repo: "me/demo", summary: `PR #${i} "T" in me/demo: no activity for 9 days` }));
    const w = { start: new Date(), end: new Date(), label: "" };
    expect(render([], [], w, 3800, undefined, { collapsed: many })).toContain("Still open, unchanged: 7 items (");
    expect(render([], [], w, 3800, undefined, { collapsed: many })).toMatch(/idle PR #4 in demo<\/a>, and 2 more\)/);
  });
  it("leaves the brief unchanged when nothing collapses", () => {
    const w = { start: new Date(), end: new Date(), label: "yesterday" };
    expect(render([ci, recap], [], w, 3800, undefined, { collapsed: [], days: new Map() })).toBe(render([ci, recap], [], w, 3800));
  });
});
