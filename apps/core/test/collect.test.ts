import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, daysAgo } from "./fixtures.js";

const gh = vi.hoisted(() => ({
  paginate: vi.fn(),
  repos: { get: vi.fn(), listBranches: vi.fn(), getCommit: vi.fn(), listCommits: vi.fn(), compareCommitsWithBasehead: vi.fn() },
  pulls: { list: vi.fn() },
  issues: { listForRepo: vi.fn(), listCommentsForRepo: vi.fn() },
  users: { getAuthenticated: vi.fn() },
  actions: { listRepoWorkflows: vi.fn(), listWorkflowRunsForRepo: vi.fn() },
}));
vi.mock("@octokit/rest", () => ({ Octokit: class { constructor() { return gh; } } }));
vi.mock("../src/env.js", () => ({ env: { githubToken: "test" } }));
import { collectAll } from "../src/github/collect.js";

describe("workflow collection", () => {
  const states = ["active", "disabled_manually", "disabled_inactivity", "disabled_fork", "deleted"];
  beforeEach(() => {
    vi.resetAllMocks();
    gh.users.getAuthenticated.mockResolvedValue({ data: { login: "me" } });
    gh.repos.get.mockResolvedValue({ data: { default_branch: "main", private: false, open_issues_count: 0 } });
    gh.pulls.list.mockResolvedValue({ data: [] });
    gh.paginate.mockImplementation(async (endpoint) => endpoint === gh.actions.listRepoWorkflows
      ? states.map((state, id) => ({ id, state })) : []);
    gh.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: states.map((_, id) => ({
      workflow_id: id, name: `workflow-${id}`, status: "completed", conclusion: "failure", html_url: "u", updated_at: NOW.toISOString(),
    })) } });
  });
  const collect = () => collectAll(["me/demo"], { start: NOW, end: NOW, label: "test" }, []);

  it("keeps only runs from active workflows, including dropping absent workflows", async () => {
    const response = await gh.actions.listWorkflowRunsForRepo();
    response.data.workflow_runs.push({ ...response.data.workflow_runs[0], workflow_id: 99 });
    const [snapshot] = await collect();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.ciRuns.map((r) => r.workflowId)).toEqual([0]);
    expect(gh.paginate).toHaveBeenCalledWith(gh.actions.listRepoWorkflows, { owner: "me", repo: "demo", per_page: 100 });
  });
  it("keeps CI data when listing workflows fails", async () => {
    gh.paginate.mockImplementation(async (endpoint) => {
      if (endpoint === gh.actions.listRepoWorkflows) throw new Error("unavailable");
      return [];
    });
    const [snapshot] = await collect();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.ciRuns).toHaveLength(5);
  });
  it("drops all runs when no workflows are active", async () => {
    gh.paginate.mockResolvedValue([]);
    expect((await collect())[0].ciRuns).toEqual([]);
  });
});

describe("issue activity collection", () => {
  const w = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "yesterday" };
  const yesterday = "2026-10-13T10:00:00Z";
  const issue = (number: number, isPr = false) => ({ number, title: `Title ${number}`, html_url: `https://github.com/me/demo/issues/${number}`, created_at: daysAgo(100), closed_at: null, ...(isPr ? { pull_request: {} } : {}) });
  const comment = (id: number, author = "tendai", number = 8) => ({ id, user: { login: author, type: "User" }, issue_url: `https://api.github.com/repos/me/demo/issues/${number}`, html_url: `https://github.com/me/demo/issues/${number}#issuecomment-${id}`, created_at: yesterday, updated_at: yesterday });
  let issues: ReturnType<typeof issue>[];
  let comments: ReturnType<typeof comment>[];
  let openPrs: object[];
  let branches: { name: string; commit: { sha: string } }[];
  const collect = (ignoreAuthors: string[] = [], repos = ["me/demo"]) => collectAll(repos, w, ignoreAuthors);
  beforeEach(() => {
    vi.resetAllMocks();
    issues = [issue(8), issue(9, true)];
    comments = [comment(1)];
    openPrs = [];
    branches = [];
    gh.users.getAuthenticated.mockResolvedValue({ data: { login: "me" } });
    gh.repos.get.mockResolvedValue({ data: { default_branch: "main", private: true, open_issues_count: 14 } });
    gh.pulls.list.mockResolvedValue({ data: [] });
    gh.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [] } });
    gh.paginate.mockImplementation(async (endpoint) => {
      if (endpoint === gh.issues.listForRepo) return issues;
      if (endpoint === gh.issues.listCommentsForRepo) return comments;
      if (endpoint === gh.pulls.list) return openPrs;
      if (endpoint === gh.repos.listBranches) return branches;
      return [];
    });
  });
  it("keeps comments created yesterday even on old issues, and sets ownership and PR metadata", async () => {
    comments = [comment(1), comment(2, "me"), comment(3, "rufaro", 9)];
    const [s] = await collect();
    expect(s.error).toBeUndefined();
    expect(s.newIssues).toEqual([]);
    expect(s.comments).toEqual(comments.map((c) => ({
      id: c.id, issueNumber: c.id === 3 ? 9 : 8, issueTitle: c.id === 3 ? "Title 9" : "Title 8", isPr: c.id === 3,
      author: c.user.login, url: c.html_url, createdAt: yesterday, mine: c.user.login === "me",
    })));
    expect(gh.paginate).toHaveBeenCalledWith(gh.issues.listCommentsForRepo, { owner: "me", repo: "demo", since: w.start.toISOString(), per_page: 100 });
  });
  it("drops edits to older comments, bots, ignored authors, unknown issues and comments at the window end", async () => {
    comments = [comment(1), { ...comment(2), created_at: daysAgo(100) }, { ...comment(3), user: { login: "robot", type: "Bot" } }, comment(4, "ignored"), comment(5, "tendai", 999), { ...comment(6), created_at: w.end.toISOString() }];
    expect((await collect(["ignored"]))[0].comments.map((c) => c.id)).toEqual([1]);
  });
  it("fetches my login once across repos and treats all comments as mine if lookup fails", async () => {
    gh.users.getAuthenticated.mockRejectedValue(new Error("unavailable"));
    comments = [comment(1), comment(2, "me")];
    const snaps = await collect([], ["me/demo", "me/other"]);
    expect(gh.users.getAuthenticated).toHaveBeenCalledTimes(1);
    for (const s of snaps) {
      expect(s.error).toBeUndefined();
      expect(s.comments.map((c) => c.mine)).toEqual([true, true]);
    }
  });
  it("collects only issues closed in the window, excluding PRs", async () => {
    issues = [{ ...issue(8), closed_at: yesterday }, { ...issue(9, true), closed_at: yesterday }, { ...issue(10), closed_at: daysAgo(100) }, issue(11)] as typeof issues;
    expect((await collect())[0].closedIssues).toEqual([{ number: 8, title: "Title 8", url: issues[0].html_url, closedAt: yesterday }]);
  });
  it.each([[14, 2, 12], [1, 2, 0]])("subtracts %s total items minus %s open PRs to get %s issues", async (total, prs, expected) => {
    gh.repos.get.mockResolvedValue({ data: { default_branch: "main", private: false, open_issues_count: total } });
    openPrs = Array.from({ length: prs }, (_, i) => ({ number: i, title: "PR", html_url: "u", head: { ref: "feature" }, updated_at: yesterday }));
    expect((await collect())[0].openIssueCount).toBe(expected);
  });
  it("retains the snapshot if comments are unavailable", async () => {
    const paginate = gh.paginate.getMockImplementation()!;
    gh.paginate.mockImplementation(async (endpoint, params) => {
      if (endpoint === gh.issues.listCommentsForRepo) throw new Error("unavailable");
      return paginate(endpoint, params);
    });
    const [s] = await collect();
    expect(s).toMatchObject({ private: true, comments: [], openIssueCount: 14, error: undefined });
  });
  it("uses the newest branch head as lastCommitAt, or null without branches", async () => {
    expect((await collect())[0].lastCommitAt).toBeNull();
    branches = [{ name: "main", commit: { sha: "old" } }, { name: "feature", commit: { sha: "new" } }];
    gh.repos.getCommit.mockImplementation(async ({ ref }) => ({ data: { commit: { committer: { date: ref === "new" ? daysAgo(2) : daysAgo(10) } } } }));
    gh.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { ahead_by: 1 } });
    expect((await collect())[0].lastCommitAt).toBe(daysAgo(2));
  });
  it("keeps safe defaults for a failed repo", async () => {
    gh.repos.get.mockRejectedValue(new Error("unavailable"));
    expect((await collect())[0]).toMatchObject({ closedIssues: [], comments: [], openIssueCount: 0, lastCommitAt: null, error: "unavailable" });
  });
});
