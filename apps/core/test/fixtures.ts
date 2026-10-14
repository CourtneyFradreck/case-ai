import type { RepoSnapshot } from "../src/types.js";

export const NOW = new Date("2026-10-14T05:00:00Z"); // 07:00 Harare

export const snap = (over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  repo: "me/demo", private: false, defaultBranch: "main",
  commits: [], openPrs: [], mergedPrs: [], newIssues: [], branches: [], ciRuns: [],
  ...over,
});

export const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();