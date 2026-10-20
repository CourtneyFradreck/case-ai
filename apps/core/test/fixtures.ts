import type { RepoSnapshot, Finding } from "../src/types.js";

export const NOW = new Date("2026-10-14T05:00:00Z"); // 07:00 Harare

export const snap = (over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  repo: "me/demo", private: false, defaultBranch: "main", createdAt: "2025-01-01T00:00:00Z",
  commits: [], openPrs: [], openedPrs: [], mergedPrs: [], newIssues: [], branches: [], ciRuns: [],
  closedIssues: [], comments: [], openIssueCount: 0,
  next: { status: "missing" },
  ...over,
});

export const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

export const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "a123456789", rule: "commits", severity: "info", repo: "me/demo",
  summary: "me/demo: 3 commits on main",
  sources: [{ label: "commit", url: "https://github.com/me/demo/commit/abc" }],
  ...over,
});

// Synthetic data for a real-model preview; never reads GitHub or a database.
export const previewSnapshots: RepoSnapshot[] = [
  snap({
    repo: "CourtneyFradreck/case-ai", openIssueCount: 14,
    branches: [{ name: "main", sha: "abc3", lastCommitAt: daysAgo(1), aheadBy: 0, url: "https://github.com/CourtneyFradreck/case-ai/tree/main" }],
    ciRuns: [{ workflowId: 1, workflowName: "build", conclusion: "failure", finishedAt: daysAgo(1), url: "https://github.com/CourtneyFradreck/case-ai/actions/runs/1001" }],
    comments: [{ id: 100, issueNumber: 8, issueTitle: "Retry failed brief deliveries", isPr: false, author: "tendai", mine: false, createdAt: daysAgo(1), url: "https://github.com/CourtneyFradreck/case-ai/issues/8#issuecomment-100" }],
    commits: ["Add delivery retries", "Improve error reporting", "Document the brief endpoint"].map((message, i) => ({
      sha: `abc${i + 1}`, parentSha: i ? `abc${i}` : "abc0", message, branch: "main", author: "CourtneyFradreck", date: daysAgo(1 - i / 100), url: `https://github.com/CourtneyFradreck/case-ai/commit/abc${i + 1}`,
    })),
    closedIssues: [{ number: 12, title: "Quiet answered conversations", closedAt: daysAgo(1), url: "https://github.com/CourtneyFradreck/case-ai/issues/12" }],
  }),
  snap({
    repo: "CourtneyFradreck/portfolio",
    commits: [{ sha: "def1", parentSha: "def0", message: "Refresh project descriptions", branch: "main", author: "CourtneyFradreck", date: daysAgo(1), url: "https://github.com/CourtneyFradreck/portfolio/commit/def1" }],
  }),
  snap({
    repo: "CourtneyFradreck/private-notes", private: true,
    newIssues: [{ number: 3, title: "Plan the next release", createdAt: daysAgo(1), url: "https://github.com/CourtneyFradreck/private-notes/issues/3" }],
  }),
];
