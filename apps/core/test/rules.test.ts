import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { idlePrs, staleBranches, failingCi, oldBranches, runRules, recapCommits, closedIssues, issueComments, openIssues } from "../src/rules/index.js";
import { snap, NOW, daysAgo } from "./fixtures.js";

const cfg = { idlePrDays: 3, staleBranchDays: 7, oldBranchDays: 60, ciMaxAgeDays: 30, activeRepoDays: 7, ignoreBranchPrefixes: ["dependabot/", "copilot/"] };
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
    expect(recapCommits(snap({ commits }))[0].summary).toBe(`${count} ${count === 1 ? "commit" : "commits"} on main in me/demo`);
  });
});

describe("issue activity rules", () => {
  const url = "https://github.com/me/demo/issues/8";
  const comment = (id: number, author: string, mine = false, issueNumber = 8, isPr = false) => ({ id, author, mine, issueNumber, isPr, issueTitle: "title", url: `${url}#issuecomment-${id}`, createdAt: daysAgo(1) });
  const closed = { number: 8, title: "title", url, closedAt: daysAgo(1) };
  it("reports closed issues as info with issue sources and stable IDs", () => {
    const s = snap({ closedIssues: [closed] });
    expect(closedIssues(s)).toEqual([expect.objectContaining({ rule: "issue_closed", severity: "info", repo: "me/demo", summary: 'Closed issue #8 "title" in me/demo', sources: [{ label: "issue", url }] })]);
    expect(closedIssues(s)[0].id).toBe(closedIssues(snap({ closedIssues: [{ ...closed, closedAt: daysAgo(2) }] }))[0].id);
  });
  it("groups others' comments per issue with unique logins in first-seen order", () => {
    const s = snap({ comments: [comment(1, "tendai"), comment(2, "rufaro"), comment(3, "tendai"), comment(4, "alex", false, 9, true)] });
    expect(issueComments(s)).toEqual([
      expect.objectContaining({ id: createHash("sha1").update("issue_comments|me/demo|8|others").digest("hex").slice(0, 10), severity: "medium", summary: '3 new comments on issue #8 "title" in me/demo (from tendai, rufaro)', sources: [{ label: "comment", url: `${url}#issuecomment-1` }] }),
      expect.objectContaining({ severity: "medium", summary: '1 new comment on PR #9 "title" in me/demo (from alex)' }),
    ]);
  });
  it("splits my comments into info with a count only for multiple comments", () => {
    const s = snap({ comments: [comment(1, "tendai"), ...[2, 3, 4].map((id) => ({ ...comment(id, "me", true), createdAt: daysAgo(1.1) })), comment(5, "me", true, 9, true)] });
    const mine = issueComments(s).filter((f) => f.severity === "info");
    expect(mine).toEqual([
      expect.objectContaining({ id: createHash("sha1").update("issue_comments|me/demo|8|mine").digest("hex").slice(0, 10), summary: 'You commented on issue #8 "title" in me/demo (3 comments)', sources: [{ label: "comment", url: `${url}#issuecomment-2` }] }),
      expect.objectContaining({ summary: 'You commented on PR #9 "title" in me/demo' }),
    ]);
  });
  it.each(["opened", "closed"])("suppresses only my comments on an issue %s yesterday", (state) => {
    const s = snap({ comments: [comment(1, "me", true), comment(2, "tendai")], ...(state === "opened" ? { newIssues: [{ number: 8, title: "title", url, createdAt: daysAgo(1) }] } : { closedIssues: [closed] }) });
    expect(issueComments(s)).toEqual([expect.objectContaining({ severity: "medium" })]);
  });
  it.each([1, 14])("counts %s open issues at the seven-day boundary", (count) => {
    expect(openIssues(snap({ branches: [br("main", 0, 7)], openIssueCount: count }), NOW, cfg)).toEqual([expect.objectContaining({ severity: "low", summary: `me/demo has ${count} open ${count === 1 ? "issue" : "issues"}`, sources: [{ label: "issues", url: "https://github.com/me/demo/issues" }] })]);
  });
  it.each([[8, 14], [null, 14], [1, 0]])("omits inactive or empty issue counts (%s, %s)", (age, openIssueCount) => {
    expect(openIssues(snap({ branches: age === null ? [] : [br("main", 0, age)], openIssueCount }), NOW, cfg)).toEqual([]);
  });
  it.each(["dependabot/", "copilot/"])("ignores recent %s branches when counting activity", (prefix) => {
    for (const branches of [[br(`${prefix}x`, 1, 1)], [br("main", 0, 8), br(`${prefix}x`, 1, 1)]]) {
      expect(openIssues(snap({ branches, openIssueCount: 14 }), NOW, cfg)).toEqual([]);
    }
  });
  it("uses the newest eligible branch regardless of branch order or open PRs", () => {
    const branches = [br("main", 0, 20), br("feature", 1, 2), br("dependabot/x", 1, 0)];
    const s = snap({ branches, openIssueCount: 14, openPrs: [{ ...pr(1, daysAgo(1)), headRef: "feature" }] });
    expect(openIssues(s, NOW, cfg)).toHaveLength(1);
    expect(openIssues({ ...s, branches: [...branches].reverse() }, NOW, cfg)).toEqual(openIssues(s, NOW, cfg));
  });
  it.each([false, true])("reports an answered conversation as one info finding (PR: %s)", (isPr) => {
    const reply = { ...comment(2, "me", true, 8, isPr), createdAt: daysAgo(0.5) };
    const original = comment(1, "tendai", false, 8, isPr);
    const comments = [reply, original];
    const s = snap({ comments });
    expect(issueComments(s)).toEqual([expect.objectContaining({
      id: createHash("sha1").update("issue_comments|me/demo|8|others").digest("hex").slice(0, 10),
      severity: "info", summary: `tendai commented on ${isPr ? "PR" : "issue"} #8 "title" in me/demo, you replied`,
      sources: [{ label: "comment", url: original.url }],
    })]);
    expect(s.comments).toEqual([reply, original]);
  });
  it("keeps medium when the latest comment is someone else's, regardless of input order", () => {
    const latest = { ...comment(3, "rufaro"), createdAt: daysAgo(0.5) };
    const mine = { ...comment(2, "me", true), createdAt: daysAgo(0.75) };
    const original = comment(1, "tendai");
    expect(issueComments(snap({ comments: [latest, mine, original] }))).toEqual([
      expect.objectContaining({ severity: "medium", summary: '2 new comments on issue #8 "title" in me/demo (from tendai, rufaro)', sources: [{ label: "comment", url: original.url }] }),
      expect.objectContaining({ severity: "info", summary: 'You commented on issue #8 "title" in me/demo' }),
    ]);
  });
  it("lists unique authors chronologically in an answered conversation", () => {
    const comments = [
      { ...comment(4, "me", true), createdAt: daysAgo(0.5) },
      { ...comment(3, "tendai"), createdAt: daysAgo(0.6) },
      { ...comment(2, "rufaro"), createdAt: daysAgo(0.7) },
      comment(1, "tendai"),
    ];
    expect(issueComments(snap({ comments }))).toEqual([expect.objectContaining({ severity: "info", summary: 'tendai, rufaro commented on issue #8 "title" in me/demo, you replied' })]);
  });
  it("integrates the three rules and excludes errored snapshots", () => {
    const s = snap({ closedIssues: [closed], comments: [comment(1, "tendai")], branches: [br("main", 0, 1)], openIssueCount: 14 });
    expect(runRules([s], NOW, cfg)).toEqual([...issueComments(s), ...openIssues(s, NOW, cfg)]);
    expect(runRules([{ ...s, error: "unavailable" }], NOW, cfg)).toEqual([]);
    expect(issueComments(snap())).toEqual([]);
  });
});
