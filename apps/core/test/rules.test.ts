import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { idlePrs, staleBranches, failingCi, oldBranches, runRules, yesterdaysCommits } from "../src/rules/index.js";
import { snap, NOW, daysAgo } from "./fixtures.js";

const cfg = { idlePrDays: 3, staleBranchDays: 7, oldBranchDays: 60, ciMaxAgeDays: 30, ignoreBranchPrefixes: ["dependabot/", "copilot/"] };
const br = (name: string, ahead: number, age: number) =>
  ({ name, sha: "x", lastCommitAt: daysAgo(age), aheadBy: ahead, url: "u" });
const pr = (n: number, updated: string, draft = false) =>
  ({ number: n, title: "t", url: "u", draft, headRef: `b${n}`, updatedAt: updated });

describe("idlePrs", () => {
  it("ignores PRs under the threshold", () => {
    expect(idlePrs(snap({ openPrs: [pr(1, daysAgo(2))] }), NOW, cfg)).toHaveLength(0);
  });
  it("flags PRs at the threshold", () => {
    expect(idlePrs(snap({ openPrs: [pr(1, daysAgo(3))] }), NOW, cfg)).toHaveLength(1);
  });
  it("skips drafts", () => {
    expect(idlePrs(snap({ openPrs: [pr(1, daysAgo(10), true)] }), NOW, cfg)).toHaveLength(0);
  });
  it("keeps the same ID across days", () => {
    const a = idlePrs(snap({ openPrs: [pr(1, daysAgo(4))] }), NOW, cfg)[0].id;
    const b = idlePrs(snap({ openPrs: [pr(1, daysAgo(5))] }), NOW, cfg)[0].id;
    expect(a).toBe(b);
  });
});

describe("staleBranches", () => {
  const br = (name: string, ahead: number, age: number) =>
    ({ name, sha: "x", lastCommitAt: daysAgo(age), aheadBy: ahead, url: "u" });
  it("skips merged branches, branches with open PRs and ignored prefixes", () => {
    const s = snap({
      branches: [br("merged", 0, 30), br("b1", 2, 30), br("dependabot/x", 1, 30)],
      openPrs: [pr(1, daysAgo(1))],
    });
    expect(staleBranches(s, NOW, cfg)).toHaveLength(0);
  });
});

describe("failingCi", () => {
  it("only flags failed conclusions", () => {
    const s = snap({ ciRuns: [
      { workflowId: 1, workflowName: "build", conclusion: "success", url: "u", finishedAt: daysAgo(2) },
      { workflowId: 2, workflowName: "lint", conclusion: "failure", url: "u", finishedAt: daysAgo(2) },
    ]});
    expect(failingCi(s, NOW, cfg).map((f) => f.summary)).toEqual(["CI failing on me/demo main (lint), 2 days ago"]);
  });
  it.each([[0, "high", "today"], [1, "high", "1 day ago"], [2, "high", "2 days ago"], [30, "high", "30 days ago"], [45, "low", "45 days ago"]])("ages a %s-day failure", (age, severity, wording) => {
    const s = snap({ ciRuns: [{ workflowId: 1, workflowName: "build", conclusion: "failure", url: "u", finishedAt: daysAgo(Number(age)) }] });
    expect(failingCi(s, NOW, cfg)).toEqual([expect.objectContaining({ severity, ageDays: age, summary: `CI failing on me/demo main (build), ${wording}` })]);
    expect(runRules([s], NOW, cfg)).toEqual(failingCi(s, NOW, cfg));
  });
  it("ignores successful runs", () => {
    expect(failingCi(snap({ ciRuns: [{ workflowId: 1, workflowName: "build", conclusion: "success", url: "u", finishedAt: daysAgo(2) }] }), NOW, cfg)).toEqual([]);
  });
});

describe("branch ages", () => {
  it.each([10, 59])("keeps a %s-day branch as an individual medium finding", (age) => {
    expect(staleBranches(snap({ branches: [br("feature", 3, age)] }), NOW, cfg)).toEqual([
      expect.objectContaining({ severity: "medium", ageDays: age, summary: `Branch feature in me/demo: 3 unmerged commits, untouched for ${age} days` }),
    ]);
  });
  it("groups branches at 60 days across repos with stable IDs and one source per repo", () => {
    const snaps = [snap({ branches: [br("a", 1, 60), br("b", 2, 90)] }), snap({ repo: "you/other", branches: [br("c", 1, 70)] })];
    expect(staleBranches(snaps[0], NOW, cfg)).toEqual([]);
    const findings = oldBranches(snaps, NOW, cfg);
    expect(findings).toEqual([expect.objectContaining({
      id: createHash("sha1").update("old_branches|me/demo:a|me/demo:b|you/other:c").digest("hex").slice(0, 10),
      rule: "old_branches", severity: "low", ageDays: 90,
      summary: "3 old unmerged branches across demo, other (oldest 90 days)",
      sources: [{ label: "demo", url: "https://github.com/me/demo/branches/stale" }, { label: "other", url: "https://github.com/you/other/branches/stale" }],
    })]);
    expect(oldBranches([...snaps].reverse(), new Date(NOW.getTime() + 86400000), cfg)[0].id).toBe(findings[0].id);
    expect(runRules(snaps, NOW, cfg)).toEqual(findings);
  });
  it("applies all exclusions to both age groups", () => {
    for (const age of [10, 60]) {
      const s = snap({ branches: [br("main", 1, age), br("merged", 0, age), br("b1", 1, age), br("dependabot/x", 1, age), br("copilot/x", 1, age)], openPrs: [pr(1, daysAgo(1))] });
      expect(staleBranches(s, NOW, cfg)).toEqual([]);
      expect(oldBranches([s], NOW, cfg)).toEqual([]);
    }
    expect(oldBranches([], NOW, cfg)).toEqual([]);
  });
  it("excludes failed snapshots from the grouped finding", () => {
    expect(runRules([snap({ error: "GitHub 403", branches: [br("a", 1, 90)] })], NOW, cfg)).toEqual([]);
  });
  it("uses singular for one unmerged commit", () => {
    expect(staleBranches(snap({ branches: [br("a", 1, 10)] }), NOW, cfg)[0].summary).toContain("1 unmerged commit,");
  });
});

describe("commit counts", () => {
  it.each([1, 3])("pluralizes %s commits", (count) => {
    const commits = Array.from({ length: count }, (_, i) => ({ sha: String(i), message: "fix", url: "u", author: "me", date: daysAgo(1), branch: "main" }));
    expect(yesterdaysCommits(snap({ commits }))[0].summary).toBe(`me/demo: ${count} ${count === 1 ? "commit" : "commits"} on main`);
  });
});
