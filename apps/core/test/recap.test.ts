import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { selectRecap } from "../src/recap.js";
import { pastWeekWindow } from "../src/time.js";
import { runRules } from "../src/rules/index.js";
import { render, renderModelBrief } from "../src/render.js";
import { snap } from "./fixtures.js";
import type { RepoSnapshot } from "../src/types.js";

const cfg = { idlePrDays: 3, staleBranchDays: 7, oldBranchDays: 60, ciMaxAgeDays: 30, activeRepoDays: 7, ignoreBranchPrefixes: [] };
const friday = DateTime.fromISO("2026-10-16T05:00:00Z");
const monday = DateTime.fromISO("2026-10-19T05:00:00Z");
const commit = (date: string, sha = date) => ({ date, sha, message: `Work ${sha}`, author: "me", branch: "feature", url: `https://github.com/me/demo/commit/${sha}` });
const brief = (snaps: RepoSnapshot[], now = friday) => {
  const { snapshots, window } = selectRecap(snaps, now);
  const findings = runRules(snapshots, now.toJSDate(), cfg, window);
  return { window, snapshots, findings, text: render(findings, snaps, window, 3800, undefined, { userName: "Courtney", now }) };
};

describe("most recent active period", () => {
  it("collects exactly seven completed Harare days, including near UTC midnight", () => {
    const w = pastWeekWindow(DateTime.fromISO("2026-10-15T23:55:00Z"));
    expect(w.start.toISOString()).toBe("2026-10-08T22:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-15T22:00:00.000Z");
  });
  it("recaps yesterday across repos and excludes older and current-day commits", () => {
    const result = brief([snap({ commits: [commit("2026-10-14T10:00Z", "old"), commit("2026-10-15T21:59Z", "yesterday"), commit("2026-10-15T22:00Z", "today")] }), snap({ repo: "me/other", commits: [commit("2026-10-15T10:00Z", "other")] })]);
    expect(result.window.label).toBe("yesterday");
    expect(result.snapshots.flatMap((s) => s.commits.map((c) => c.sha))).toEqual(["yesterday", "other"]);
    expect(result.text).toContain("Here's what you worked on yesterday");
    expect(result.text).not.toContain("Here's what needs your attention");
  });
  it.each([
    ["2026-10-17T10:00Z"], ["2026-10-18T10:00Z"], ["2026-10-17T10:00Z", "2026-10-18T10:00Z"],
  ])("recaps both weekend days on Monday for activity at %j", (...dates) => {
    const result = brief([snap({ commits: [...dates.map((at) => commit(at)), commit("2026-10-16T10:00Z", "friday")] })], monday);
    expect(result.window.label).toBe("over the weekend");
    expect(result.window.start.toISOString()).toBe("2026-10-16T22:00:00.000Z");
    expect(result.window.end.toISOString()).toBe("2026-10-18T22:00:00.000Z");
    expect(result.snapshots[0].commits.map((c) => c.date)).toEqual(dates);
    expect(result.text).toContain("Here's what you worked on over the weekend");
  });
  it("returns to Friday when Monday has no weekend activity", () => {
    const result = brief([snap({ commits: [commit("2026-10-16T12:00Z"), commit("2026-10-15T12:00Z", "older")] })], monday);
    expect(result.window.label).toBe("on Friday");
    expect(result.snapshots[0].commits).toHaveLength(1);
    expect(result.text).toContain("Here's what you worked on Friday");
  });
  it("uses Harare day boundaries to select the last active weekday", () => {
    const result = brief([snap({ commits: [commit("2026-10-13T22:10Z")] })]);
    expect(result.window.label).toBe("on Wednesday");
    expect(result.text).toContain("Here's what you worked on Wednesday");
  });
  it("includes activity exactly seven days ago but excludes earlier activity", () => {
    expect(brief([snap({ commits: [commit("2026-10-08T22:00Z")] })]).window.label).toBe("on Friday");
    const result = brief([snap({ commits: [commit("2026-10-08T21:59:59Z")] })]);
    expect(result.window.label).toBe("");
    expect(result.text.split("\n").slice(2).filter(Boolean)).toEqual(["Nothing new in the past week."]);
  });
  it.each(["openedPrs", "mergedPrs", "newIssues", "closedIssues"] as const)("counts %s as activity even with no commits", (field) => {
    const date = "2026-10-14T10:00Z";
    const item = { number: 1, title: "Work", url: "https://github.com/me/demo/issues/1", draft: false, headRef: "feature", createdAt: date, updatedAt: date, mergedAt: date, closedAt: date };
    const result = brief([snap({ [field]: [item] })]);
    expect(result.window.label).toBe("on Wednesday");
    expect(result.findings).toHaveLength(1);
  });
  it("does not treat branch heads, open PR updates, CI or comments as recap activity", () => {
    const result = brief([snap({
      branches: [{ name: "main", sha: "x", lastCommitAt: "2026-10-15T10:00Z", aheadBy: 0, url: "branch" }],
      openPrs: [{ number: 1, title: "Old", url: "pr", draft: false, headRef: "feature", updatedAt: "2026-10-15T10:00Z" }],
      comments: [{ id: 1, issueNumber: 1, issueTitle: "Old", isPr: false, author: "me", mine: true, createdAt: "2026-10-15T10:00Z", url: "comment" }],
      ciRuns: [{ workflowId: 1, workflowName: "build", conclusion: "success", url: "run", finishedAt: "2026-10-15T10:00Z" }],
    })]);
    expect(result.window.label).toBe("");
    expect(result.text).toContain("Nothing new in the past week.");
    expect(result.text).not.toContain("Here's what you worked on");
  });
  it("ignores failed repos when choosing a day", () => {
    expect(brief([snap({ error: "unavailable", commits: [commit("2026-10-15T10:00Z")] })]).window.label).toBe("");
  });
});

describe("section ownership", () => {
  const url = "https://github.com/me/demo/issues/1";
  const issue = { number: 1, title: "Plan the next release", url, createdAt: "2026-10-15T10:00Z", state: "open" };
  const branch = { name: "main", sha: "x", lastCommitAt: "2026-10-15T10:00Z", aheadBy: 0, url: "branch" };
  it("mentions a new open issue exactly once, in the recap", () => {
    const result = brief([snap({ newIssues: [issue], openIssueCount: 1, branches: [branch] })]);
    expect(result.text.match(/issue #1/g)).toHaveLength(1);
    expect(result.text).toContain("Opened issue #1");
    expect(result.text).not.toContain("Here's what needs your attention");
    // Even a model that repeats the issue under attention is corrected.
    const item = { text: "Opened issue #1", sources: result.findings };
    const model = renderModelBrief({ yesterday: [item], attention: [item], focus: [] }, [], result.window);
    expect(model.match(/issue #1/g)).toHaveLength(1);
    expect(model).not.toContain("Here's what needs your attention");
  });
  it("counts only other open issues under attention", () => {
    const result = brief([snap({ newIssues: [issue], openIssueCount: 3, branches: [branch] })]);
    expect(result.text).toContain("2 other open issues");
    expect(result.text.match(/issue #1/g)).toHaveLength(1);
  });
  it("does not subtract a new issue that is already closed from the open count", () => {
    const result = brief([snap({ newIssues: [{ ...issue, state: "closed" }], openIssueCount: 1, branches: [branch] })]);
    expect(result.text).toContain("1 open issue");
  });
  it("keeps a concrete comment request under attention and drops the opened issue recap", () => {
    const result = brief([snap({ newIssues: [issue], openIssueCount: 1, branches: [branch], comments: [{ id: 1, issueNumber: 1, issueTitle: issue.title, isPr: false, author: "alex", mine: false, createdAt: "2026-10-15T11:00Z", url: `${url}#issuecomment-1` }] })]);
    expect(result.text.match(/issue #1/g)).toHaveLength(1);
    expect(result.text).toContain("Here's what needs your attention");
    expect(result.text).not.toContain("Opened issue #1");
    expect(result.text).not.toContain("Nothing new in the past week.");
  });
  it("keeps a stale newly opened PR only under attention", () => {
    const pr = { number: 2, title: "Feature", url: "https://github.com/me/demo/pull/2", draft: false, headRef: "feature", createdAt: "2026-10-12T10:00Z", updatedAt: "2026-10-12T10:00Z" };
    const result = brief([snap({ openedPrs: [pr], openPrs: [pr] })]);
    expect(result.text.match(/PR #2/g)).toHaveLength(1);
    expect(result.text).toContain("no activity for 3 days");
    expect(result.text).not.toContain("Opened PR");
  });
  it("shows a PR opened and merged in the same period once, as merged", () => {
    const pr = { number: 2, title: "Feature", url: "https://github.com/me/demo/pull/2", draft: false, headRef: "feature", createdAt: "2026-10-15T10:00Z", updatedAt: "2026-10-15T11:00Z", mergedAt: "2026-10-15T11:00Z" };
    const result = brief([snap({ openedPrs: [pr], mergedPrs: [pr] })]);
    expect(result.text.match(/PR #2/g)).toHaveLength(1);
    expect(result.text).toContain("Merged PR #2");
  });
  it("links repo names inline without repeating them in either renderer", () => {
    const snaps = ["attachcv", "crc-app", "case-ai", "portfolio"].map((repo) => snap({ repo: `me/${repo}`, branches: [{ ...branch, name: "old", aheadBy: 1, lastCommitAt: "2026-01-01T10:00Z" }] }));
    const result = brief(snaps);
    const model = renderModelBrief({ yesterday: [], attention: result.findings.map((f) => ({ text: f.summary, sources: [f] })), focus: [] }, [], result.window);
    for (const text of [result.text, model]) {
      const line = text.split("\n").find((l) => l.includes("old unmerged branches"))!;
      for (const repo of ["attachcv", "crc-app", "case-ai", "portfolio"]) {
        expect(line.match(new RegExp(`>${repo}</a>`, "g"))).toHaveLength(1);
        expect(line.replace(/<[^>]+>/g, "").match(new RegExp(repo, "g"))).toHaveLength(1);
      }
      expect(line).not.toContain("[");
    }
  });
});
