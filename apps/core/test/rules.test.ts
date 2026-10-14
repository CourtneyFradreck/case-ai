import { describe, it, expect } from "vitest";
import { idlePrs, staleBranches, failingCi } from "../src/rules/index.js";
import { snap, NOW, daysAgo } from "./fixtures.js";

const cfg = { idlePrDays: 3, staleBranchDays: 7, ignoreBranchPrefixes: ["dependabot/"] };
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
      { workflowId: 1, workflowName: "build", conclusion: "success", url: "u", finishedAt: "" },
      { workflowId: 2, workflowName: "lint", conclusion: "failure", url: "u", finishedAt: "" },
    ]});
    expect(failingCi(s).map((f) => f.summary)).toEqual(["CI failing on me/demo main (lint)"]);
  });
});