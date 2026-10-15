import type { RepoSnapshot, Finding } from "../src/types.js";

export const NOW = new Date("2026-10-14T05:00:00Z"); // 07:00 Harare

export const snap = (over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  repo: "me/demo", private: false, defaultBranch: "main",
  commits: [], openPrs: [], mergedPrs: [], newIssues: [], branches: [], ciRuns: [],
  closedIssues: [], comments: [], openIssueCount: 0,
  ...over,
});

export const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

export const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "a123456789", rule: "commits", severity: "info", repo: "me/demo",
  summary: "me/demo: 3 commits on main",
  sources: [{ label: "commit", url: "https://github.com/me/demo/commit/abc" }],
  ...over,
});
