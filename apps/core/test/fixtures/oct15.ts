import type { RepoSnapshot } from "../../src/types.js";

// Reproduces issue #1 Day 2: an alphabetical feature branch contains nine
// unique commits plus the five PR commits and merge commit shared with main.
// Main also has a direct README commit absent from the feature branch.
export const OCT15_NOW = new Date("2026-10-16T05:00:00Z");
export const OCT15_WINDOW = { start: new Date("2026-10-14T22:00:00Z"), end: new Date("2026-10-15T22:00:00Z"), label: "yesterday" };
const repo = "CourtneyFradreck/case-ai";
const feature = "feat/m2-model-brief";
const url = `https://github.com/${repo}`;
const at = "2026-10-15T18:00:00Z";
export const OCT15_CREATED_AT = "2026-10-01T09:00:00Z";
const createdAt = OCT15_CREATED_AT;
const apiCommit = (sha: string, message: string, parents: string[], date = at) => ({
  sha, html_url: `${url}/commit/${sha}`, author: { login: "CourtneyFradreck" },
  commit: { message, committer: { date }, author: { name: "CourtneyFradreck", date } },
  parents: parents.map((sha) => ({ sha })),
});

export function oct15Fixture() {
  const prCommits = [
    ["279e2d2", "feat: update .env.example with default values for configuration variables"],
    ["5751052", "docs: update license section to link to LICENSE file"],
    ["af3cd33", "feat: enhance CI and branch management rules with new configurations and tests"],
    ["c033525", "feat: issue comments, closed issues and active-repo issue counts"],
    ["71736a4", "fix: filter repo activity and quiet answered conversations"],
  ].map(([sha, message], i, list) => apiCommit(sha, message, [i ? list[i - 1][0] : "a5b0a7f"]));
  const merge = apiCommit("c82da15", "Merge pull request #2", ["a5b0a7f", "71736a4"]);
  const featureCommits = [
    ["a82e99e", "feat: add GEMINI API configuration options to .env.example"],
    ["f2f1b50", "feat: add Gemini brief provider and model configuration"],
    ["9af868d", "feat: validate model briefs against aliased rule findings"],
    ["5053488", "feat: render validated model briefs with stored source links"],
    ["be5a8ad", "feat: generate model briefs with retries and rule-only fallback"],
    ["15722f5", "feat: add standalone live model brief preview"],
    ["5e66cc8", "fix: fall back on invalid model settings and restore medium findings"],
    ["322fad5", "feat: personalize brief greetings by Harare time"],
    ["a44bb4d", "feat: include finding details in model brief input"],
  ].map(([sha, message], i, list) => apiCommit(sha, message, [i ? list[i - 1][0] : merge.sha], `2026-10-15T18:${String(i + 1).padStart(2, "0")}:00Z`));
  const direct = apiCommit("ee875b5", "feat: update README.md", [merge.sha], "2026-10-15T19:00:00Z");
  const mergedPr = {
    number: 2, title: "feat: GitHub morning brief pipeline and activity rules", html_url: `${url}/pull/2`,
    head: { ref: "feat/m1-ruleonly-brief" }, draft: false,
    created_at: at, updated_at: at, merged_at: at,
  };
  const issue = { number: 1, title: "M1 verification: five-morning trial", html_url: `${url}/issues/1`, created_at: at, closed_at: null, state: "open", user: { login: "CourtneyFradreck" } };
  const branches = [{ name: feature, commit: { sha: featureCommits.at(-1)!.sha } }, { name: "main", commit: { sha: direct.sha } }];
  const branchCommits = { [feature]: [...featureCommits].reverse().concat(merge, ...[...prCommits].reverse()), main: [direct, merge, ...[...prCommits].reverse()] };
  const collectedCommit = (c: ReturnType<typeof apiCommit>, branch: string) => ({
    sha: c.sha, message: c.commit.message, url: c.html_url, author: c.author.login, date: c.commit.committer.date, branch, parentSha: c.parents[0].sha,
  });
  // The preview uses this snapshot, and the regression test verifies it against
  // the real collector driven by the API fixtures above.
  const expected: RepoSnapshot = {
    repo, private: false, defaultBranch: "main", createdAt,
    commits: [collectedCommit(direct, "main"), ...[...featureCommits].reverse().map((c) => collectedCommit(c, feature))],
    openPrs: [], openedPrs: [{ number: 2, title: mergedPr.title, url: mergedPr.html_url, draft: false, headRef: mergedPr.head.ref, createdAt: at, updatedAt: at }],
    mergedPrs: [{ number: 2, title: mergedPr.title, url: mergedPr.html_url, draft: false, headRef: mergedPr.head.ref, updatedAt: at, mergedAt: at, commits: prCommits.length }],
    recentlyMerged: [{ number: 2, title: mergedPr.title, url: mergedPr.html_url, draft: false, headRef: mergedPr.head.ref, updatedAt: at, mergedAt: at }],
    newIssues: [{ number: 1, title: issue.title, url: issue.html_url, createdAt: at, state: "open", mine: true }],
    // Issue #1 is your own trial checklist, so it isn't counted as an open issue needing attention.
    closedIssues: [], comments: [], openIssueCount: 0,
    branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha, lastCommitAt: b.name === "main" ? direct.commit.committer.date : featureCommits.at(-1)!.commit.committer.date, aheadBy: b.name === "main" ? 0 : 9, url: `${url}/tree/${b.name}` })),
    ciRuns: [],
    next: { status: "missing" },
  };
  return { repo, feature, branches, branchCommits, prCommits, mergedPr, merge, direct, featureCommits, issue, expected };
}
