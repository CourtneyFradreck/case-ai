import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, daysAgo } from "./fixtures.js";
import { oct15Fixture, OCT15_NOW, OCT15_WINDOW, OCT15_CREATED_AT } from "./fixtures/oct15.js";
import { runRules } from "../src/rules/index.js";
import { render, renderModelBrief } from "../src/render.js";
import { DateTime } from "luxon";

const gh = vi.hoisted(() => ({
  paginate: vi.fn(),
  repos: { get: vi.fn(), getContent: vi.fn(), listBranches: vi.fn(), getCommit: vi.fn(), listCommits: vi.fn(), compareCommitsWithBasehead: vi.fn() },
  pulls: { list: vi.fn(), listCommits: vi.fn() },
  issues: { listForRepo: vi.fn(), listCommentsForRepo: vi.fn() },
  users: { getAuthenticated: vi.fn() },
  actions: { listRepoWorkflows: vi.fn(), listWorkflowRunsForRepo: vi.fn() },
}));
vi.mock("@octokit/rest", () => ({ Octokit: class { constructor() { return gh; } } }));
vi.mock("../src/env.js", () => ({ env: { githubToken: "test", branchExclude: ["pr-assets/*"] } }));
import { collectAll, forgetNoCommonHistory, matchesGlob } from "../src/github/collect.js";

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

describe("15 Oct commit attribution regression", () => {
  let fixture: ReturnType<typeof oct15Fixture>;
  beforeEach(() => {
    vi.resetAllMocks();
    fixture = oct15Fixture();
    gh.users.getAuthenticated.mockResolvedValue({ data: { login: "CourtneyFradreck" } });
    gh.repos.get.mockResolvedValue({ data: { default_branch: "main", private: false, open_issues_count: 1, created_at: OCT15_CREATED_AT } });
    gh.repos.getContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    gh.repos.getCommit.mockImplementation(async ({ ref }) => ({ data: [fixture.direct, ...fixture.featureCommits].find((c) => c.sha === ref) }));
    gh.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { ahead_by: 9 } });
    gh.pulls.list.mockResolvedValue({ data: [fixture.mergedPr] });
    gh.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [] } });
    gh.paginate.mockImplementation(async (endpoint, params) => {
      if (endpoint === gh.repos.listBranches) return fixture.branches;
      if (endpoint === gh.repos.listCommits) return fixture.branchCommits[params.sha as keyof typeof fixture.branchCommits];
      if (endpoint === gh.pulls.listCommits) return fixture.prCommits;
      if (endpoint === gh.issues.listForRepo) return [fixture.issue];
      return [];
    });
  });
  const collect = async () => (await collectAll([fixture.repo], OCT15_WINDOW, []))[0];
  const cfg = { idlePrDays: 3, staleBranchDays: 7, oldBranchDays: 60, ciMaxAgeDays: 30, activeRepoDays: 7, ignoreBranchPrefixes: [] };

  it("attributes only nine unique feature commits and the direct main commit, keeping the merged PR", async () => {
    expect(fixture.branchCommits[fixture.feature]).toHaveLength(15);
    expect(fixture.branchCommits.main).toHaveLength(7);
    const snapshot = await collect();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot).toEqual({ ...fixture.expected, error: undefined });
    expect(snapshot.commits.filter((c) => c.branch === fixture.feature)).toHaveLength(9);
    expect(snapshot.commits.filter((c) => c.branch === "main").map((c) => c.sha)).toEqual([fixture.direct.sha]);
    expect(snapshot.commits.map((c) => c.sha)).not.toContain(fixture.merge.sha);
    expect(gh.paginate.mock.calls.filter(([endpoint]) => endpoint === gh.repos.listCommits).map(([, params]) => params.sha)).toEqual(["main", fixture.feature]);
    expect(gh.paginate.mock.calls.filter(([endpoint]) => endpoint === gh.pulls.listCommits)).toEqual([
      [gh.pulls.listCommits, { owner: "CourtneyFradreck", repo: "case-ai", pull_number: 2, per_page: 100 }],
    ]);
    const findings = runRules([snapshot], OCT15_NOW, cfg, OCT15_WINDOW);
    const options = { userName: "Courtney", now: DateTime.fromJSDate(OCT15_NOW) };
    const template = render(findings, [snapshot], OCT15_WINDOW, 3800, undefined, options);
    const model = renderModelBrief({ yesterday: findings.map((f) => ({ text: f.summary, sources: [f] })), attention: [], focus: [] }, [snapshot], OCT15_WINDOW, 3800, options);
    for (const text of [template, model]) {
      expect(text).toContain("9 commits on feat/m2-model-brief");
      expect(text).toContain("A README update on main.");
      expect(text).toContain('Merged PR #2 "GitHub morning brief pipeline and activity rules" (5 commits).');
      expect(text).not.toContain("15 commits");
      expect(text).not.toContain("Merge pull request");
      // The PR's own commits count once, as the merge: 9 unique feature commits and 1 on main, plus the PR.
      expect(text).toContain("Big case-ai day yesterday: 10 commits, most on feat/m2-model-brief plus a PR merged.");
    }
    expect(model).toBe(template);
  });
  it("gives shared non-PR commits to the default branch and skips all merge commits", async () => {
    gh.pulls.list.mockResolvedValue({ data: [] });
    const snapshot = await collect();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.commits.filter((c) => c.branch === "main")).toHaveLength(6);
    expect(snapshot.commits.filter((c) => c.branch === fixture.feature)).toHaveLength(9);
    expect(snapshot.commits.map((c) => c.sha)).not.toContain(fixture.merge.sha);
    expect(gh.paginate.mock.calls.filter(([endpoint]) => endpoint === gh.pulls.listCommits)).toEqual([]);
  });
  it("does not exclude commits for a PR merged outside the collection window", async () => {
    gh.pulls.list.mockResolvedValue({ data: [{ ...fixture.mergedPr, merged_at: OCT15_WINDOW.end.toISOString() }] });
    const snapshot = await collect();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.mergedPrs).toEqual([]);
    expect(snapshot.commits.filter((c) => c.branch === "main")).toHaveLength(6);
    expect(gh.paginate.mock.calls.filter(([endpoint]) => endpoint === gh.pulls.listCommits)).toEqual([]);
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
  it("collects PR openings from both open and closed PRs using the creation date", async () => {
    const pr = (number: number, created_at: string) => ({ number, title: `PR ${number}`, html_url: `https://github.com/me/demo/pull/${number}`, head: { ref: "feature" }, created_at, updated_at: yesterday, draft: false });
    openPrs = [pr(1, yesterday), pr(2, daysAgo(10)), pr(3, w.end.toISOString())];
    gh.pulls.list.mockResolvedValue({ data: [{ ...pr(4, yesterday), merged_at: yesterday }] });
    const [s] = await collect();
    expect(s.error).toBeUndefined();
    expect(s.openedPrs.map((p) => p.number)).toEqual([1, 4]);
    expect(s.openedPrs.map((p) => p.createdAt)).toEqual([yesterday, yesterday]);
    expect(s.mergedPrs.map((p) => p.number)).toEqual([4]);
  });
  it("retains current issue state so closed new issues are not subtracted from open counts", async () => {
    issues = [{ ...issue(8), created_at: yesterday, state: "closed" }] as typeof issues;
    expect((await collect())[0].newIssues).toMatchObject([{ number: 8, state: "closed" }]);
  });
  // 24 Oct brief: "1 open issue in case-ai" was my own trial issue #4.
  it("counts only open issues someone else opened, never PRs or my own", async () => {
    const mine = (n: number) => ({ ...issue(n), user: { login: "me" } });
    const theirs = (n: number) => ({ ...issue(n), user: { login: "tendai" } });
    issues = [mine(4), theirs(5), theirs(6), { ...theirs(7), pull_request: {} }] as typeof issues;
    expect((await collect())[0].openIssueCount).toBe(2);
    expect(gh.paginate).toHaveBeenCalledWith(gh.issues.listForRepo, { owner: "me", repo: "demo", state: "open", per_page: 100 });
  });
  it("counts no open issues as someone else's when my login is unknown", async () => {
    gh.users.getAuthenticated.mockRejectedValue(new Error("unavailable"));
    issues = [{ ...issue(5), user: { login: "tendai" } }] as typeof issues;
    expect((await collect())[0].openIssueCount).toBe(0);
  });
  it("marks new issues I opened as mine", async () => {
    issues = [{ ...issue(4), created_at: yesterday, user: { login: "me" } }, { ...issue(5), created_at: yesterday, user: { login: "tendai" } }] as typeof issues;
    expect((await collect())[0].newIssues.map((i) => [i.number, i.mine])).toEqual([[4, true], [5, false]]);
  });
  it("retains the snapshot if comments are unavailable", async () => {
    const paginate = gh.paginate.getMockImplementation()!;
    gh.paginate.mockImplementation(async (endpoint, params) => {
      if (endpoint === gh.issues.listCommentsForRepo) throw new Error("unavailable");
      return paginate(endpoint, params);
    });
    const [s] = await collect();
    expect(s).toMatchObject({ private: true, comments: [], openIssueCount: 1, error: undefined });
  });
  it("retains each branch's head timestamp without a repo-wide timestamp", async () => {
    expect((await collect())[0]).not.toHaveProperty("lastCommitAt");
    branches = [{ name: "main", commit: { sha: "old" } }, { name: "feature", commit: { sha: "new" } }];
    gh.repos.getCommit.mockImplementation(async ({ ref }) => ({ data: { commit: { committer: { date: ref === "new" ? daysAgo(2) : daysAgo(10) } } } }));
    gh.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { ahead_by: 1 } });
    const [s] = await collect();
    expect(s.branches.map((b) => b.lastCommitAt)).toEqual([daysAgo(10), daysAgo(2)]);
    expect(s).not.toHaveProperty("lastCommitAt");
  });
  it("keeps safe defaults for a failed repo", async () => {
    gh.repos.get.mockRejectedValue(new Error("unavailable"));
    expect((await collect())[0]).toMatchObject({ closedIssues: [], comments: [], openIssueCount: 0, error: "Couldn't access me/demo (unavailable)" });
  });
});

describe("NEXT.md collection", () => {
  const md = "# Now\r\n- [ ] Ship the parser\r\n- [x] Write docs\r\n";
  const file = (content = Buffer.from(md, "utf8").toString("base64")) => ({ data: { type: "file", sha: "f1le", content, encoding: "base64" } });
  const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  beforeEach(() => {
    vi.resetAllMocks();
    gh.users.getAuthenticated.mockResolvedValue({ data: { login: "me" } });
    gh.repos.get.mockResolvedValue({ data: { default_branch: "trunk", private: false, open_issues_count: 0, created_at: daysAgo(2) } });
    gh.pulls.list.mockResolvedValue({ data: [] });
    gh.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [] } });
    gh.paginate.mockResolvedValue([]);
    gh.repos.getContent.mockResolvedValue(file());
    gh.repos.listCommits.mockResolvedValue({ data: [{ commit: { committer: { date: daysAgo(3) } } }] });
  });
  const collect = async () => (await collectAll(["me/demo"], { start: NOW, end: NOW, label: "test" }, []))[0];

  it("reads NEXT.md on the default branch with its last change date", async () => {
    const s = await collect();
    expect(s.error).toBeUndefined();
    expect(s.createdAt).toBe(daysAgo(2));
    expect(s.next).toMatchObject({ status: "ok", sha: "f1le", url: "https://github.com/me/demo/blob/trunk/NEXT.md", lastChangedAt: daysAgo(3) });
    expect(s.next.status === "ok" && s.next.items.map((i) => [i.text, i.section, i.state, i.line])).toEqual([
      ["Ship the parser", "Now", "open", 2], ["Write docs", "Now", "done", 3],
    ]);
    expect(gh.repos.getContent).toHaveBeenCalledWith({ owner: "me", repo: "demo", path: "NEXT.md", ref: "trunk" });
    expect(gh.repos.listCommits).toHaveBeenCalledWith({ owner: "me", repo: "demo", path: "NEXT.md", sha: "trunk", per_page: 1 });
  });
  it("decodes base64 with line breaks and non-ASCII text", async () => {
    const encoded = Buffer.from("- [ ] Café menu — résumé\n", "utf8").toString("base64").replace(/(.{20})/g, "$1\n");
    gh.repos.getContent.mockResolvedValue(file(encoded));
    const s = await collect();
    expect(s.next.status === "ok" && s.next.items.map((i) => i.text)).toEqual(["Café menu — résumé"]);
  });
  it("sets lastChangedAt to null when no commit touched the file", async () => {
    gh.repos.listCommits.mockResolvedValue({ data: [] });
    expect((await collect()).next).toMatchObject({ status: "ok", lastChangedAt: null });
  });
  it("marks a 404 as missing", async () => {
    gh.repos.getContent.mockRejectedValue(httpError(404));
    const s = await collect();
    expect(s.error).toBeUndefined();
    expect(s.next).toEqual({ status: "missing" });
    expect(gh.repos.listCommits).not.toHaveBeenCalled();
  });
  it("records a 500 on NEXT.md without failing the repo", async () => {
    gh.repos.getContent.mockRejectedValue(httpError(500));
    gh.repos.get.mockResolvedValue({ data: { default_branch: "trunk", private: true, open_issues_count: 4, created_at: daysAgo(2) } });
    gh.paginate.mockImplementation(async (endpoint, params) => endpoint === gh.issues.listForRepo && params.state === "open"
      ? Array.from({ length: 4 }, (_, n) => ({ number: n, user: { login: "tendai" } })) : []);
    const s = await collect();
    expect(s.error).toBeUndefined();
    expect(s.next).toEqual({ status: "error", error: "Couldn't read NEXT.md in demo (500)" });
    expect(s).toMatchObject({ private: true, defaultBranch: "trunk", openIssueCount: 4 });
    expect(gh.actions.listWorkflowRunsForRepo).toHaveBeenCalled();
  });
  it("keeps the items with no last change date when the commit lookup returns a 500", async () => {
    gh.repos.listCommits.mockRejectedValue(httpError(500));
    const s = await collect();
    expect(s.error).toBeUndefined();
    expect(s.next).toMatchObject({ status: "ok", sha: "f1le", lastChangedAt: null });
    expect(s.next.status === "ok" && s.next.items.map((i) => [i.text, i.state])).toEqual([
      ["Ship the parser", "open"], ["Write docs", "done"],
    ]);
  });
  it("records an error when NEXT.md is a directory", async () => {
    gh.repos.getContent.mockResolvedValue({ data: [] });
    expect((await collect()).next).toEqual({ status: "error", error: "NEXT.md is not a file" });
  });
});

describe("branch globs", () => {
  it.each([
    ["pr-assets/phase-1-ios-shell", "pr-assets/*", true],
    ["pr-assets/a/b", "pr-assets/*", false],
    ["pr-assets/a/b", "pr-assets/**", true],
    ["gh-pages", "gh-pages", true],
    ["gh-pages-old", "gh-pages", false],
    ["feat.x", "feat?x", true],
    ["featyx", "feat.x", false],
  ])("matches %s against %s: %s", (name, glob, expected) => {
    expect(matchesGlob(name, glob)).toBe(expected);
  });
});

describe("per-branch isolation", () => {
  const httpError = (status: number, url?: string) => Object.assign(new Error(`HTTP ${status}`), { status, ...(url ? { request: { method: "GET", url } } : {}) });
  const head = (name: string, sha = `${name}-sha`) => ({ name, commit: { sha } });
  let branches: ReturnType<typeof head>[];
  let compare: Record<string, number | Error>;
  const w = { start: new Date(daysAgo(2)), end: new Date(NOW.getTime() + 1000), label: "test" };
  const collect = async () => (await collectAll(["CourtneyFradreck/1710"], w, []))[0];
  const logged = (spy: unknown) => (spy as { mock: { calls: unknown[][] } }).mock.calls.map(([line]) => JSON.parse(String(line)));
  beforeEach(() => {
    vi.resetAllMocks();
    forgetNoCommonHistory();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    branches = [head("main"), head("feature"), head("orphan"), head("pr-assets/phase-1-ios-shell")];
    compare = { feature: 2, orphan: httpError(404, "https://api.github.com/repos/CourtneyFradreck/1710/compare/main...orphan?per_page=1") };
    gh.users.getAuthenticated.mockResolvedValue({ data: { login: "me" } });
    gh.repos.get.mockResolvedValue({ data: { default_branch: "main", private: false, created_at: daysAgo(30) } });
    gh.repos.getContent.mockResolvedValue({ data: { type: "file", sha: "n", content: Buffer.from("- [ ] Ship\n").toString("base64") } });
    gh.repos.listCommits.mockResolvedValue({ data: [] });
    gh.repos.getCommit.mockResolvedValue({ data: { commit: { committer: { date: daysAgo(1) } } } });
    gh.repos.compareCommitsWithBasehead.mockImplementation(async ({ basehead }) => {
      const result = compare[basehead.split("...")[1]];
      if (result instanceof Error) throw result;
      return { data: { ahead_by: result } };
    });
    gh.pulls.list.mockResolvedValue({ data: [] });
    gh.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [] } });
    gh.paginate.mockImplementation(async (endpoint, params) => {
      if (endpoint === gh.repos.listBranches) return branches;
      if (endpoint === gh.repos.listCommits) return [{ sha: `${params.sha}-c`, html_url: "u", author: { login: "me" }, parents: [{ sha: "p" }],
        commit: { message: `Work on ${params.sha}`, committer: { date: NOW.toISOString() } } }];
      return [];
    });
  });

  it("keeps the repo when one branch's compare returns 404, skipping only that branch", async () => {
    const s = await collect();
    expect(s.error).toBeUndefined();
    expect(s.branches.map((b) => [b.name, b.aheadBy])).toEqual([["main", 0], ["feature", 2]]);
    expect(s.warnings).toEqual(["Skipped branch orphan in 1710 (no common history with main)"]);
    expect(s.next).toMatchObject({ status: "ok" });
    expect(s.commits.map((c) => c.branch)).toEqual(["main", "feature"]);
    expect(logged(console.warn)).toContainEqual(expect.objectContaining({
      event: "github_error", repo: "CourtneyFradreck/1710", branch: "orphan", status: 404,
      endpoint: "GET /repos/CourtneyFradreck/1710/compare/main...orphan?per_page=1",
    }));
  });
  it("skips a branch with no common history quietly until its head changes", async () => {
    await collect();
    gh.repos.compareCommitsWithBasehead.mockClear();
    const again = await collect();
    expect(again.warnings).toBeUndefined();
    expect(gh.repos.compareCommitsWithBasehead.mock.calls.map(([p]) => p.basehead)).toEqual(["main...feature"]);
    expect(logged(console.info)).toContainEqual({ event: "github_branch_skipped", repo: "CourtneyFradreck/1710", branch: "orphan", reason: "no common history with main" });
    branches[2] = head("orphan", "new-sha");
    expect((await collect()).warnings).toEqual(["Skipped branch orphan in 1710 (no common history with main)"]);
  });
  it("never reads excluded branches and leaves them out of the brief", async () => {
    const s = await collect();
    expect(gh.repos.getCommit).not.toHaveBeenCalledWith(expect.objectContaining({ ref: "pr-assets/phase-1-ios-shell-sha" }));
    expect(gh.repos.compareCommitsWithBasehead).not.toHaveBeenCalledWith(expect.objectContaining({ basehead: "main...pr-assets/phase-1-ios-shell" }));
    expect(s.branches.map((b) => b.name)).not.toContain("pr-assets/phase-1-ios-shell");
    expect(s.warnings?.join()).not.toContain("pr-assets");
    expect(logged(console.info)).toContainEqual({ event: "github_branch_skipped", repo: "CourtneyFradreck/1710", branch: "pr-assets/phase-1-ios-shell", reason: "excluded by pr-assets/*" });
  });
  it("compares with the repo's default branch when it isn't main", async () => {
    gh.repos.get.mockResolvedValue({ data: { default_branch: "trunk", private: false, created_at: daysAgo(30) } });
    branches = [head("trunk"), head("feature"), head("orphan")];
    const s = await collect();
    expect(gh.repos.compareCommitsWithBasehead.mock.calls.map(([p]) => p.basehead)).toEqual(["trunk...feature", "trunk...orphan"]);
    expect(s.branches.map((b) => [b.name, b.aheadBy])).toEqual([["trunk", 0], ["feature", 2]]);
    expect(s.warnings).toEqual(["Skipped branch orphan in 1710 (no common history with trunk)"]);
    expect(gh.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: "trunk" }));
  });
  it("skips a branch on a 422 or other unexpected failure without caching it", async () => {
    compare = { feature: httpError(422), orphan: 1 };
    gh.repos.getCommit.mockImplementation(async ({ ref }) => {
      if (ref === "orphan-sha") throw httpError(500);
      return { data: { commit: { committer: { date: daysAgo(1) } } } };
    });
    const s = await collect();
    expect(s.error).toBeUndefined();
    expect(s.branches.map((b) => b.name)).toEqual(["main"]);
    expect(s.warnings).toEqual(["Skipped branch feature in 1710 (422)", "Skipped branch orphan in 1710 (500)"]);
    expect((await collect()).warnings).toHaveLength(2);
  });
  it("skips commits on a branch whose commit list fails, keeping the others", async () => {
    const paginate = gh.paginate.getMockImplementation()!;
    gh.paginate.mockImplementation(async (endpoint, params) => {
      if (endpoint === gh.repos.listCommits && params.sha === "feature") throw httpError(502);
      return paginate(endpoint, params);
    });
    const s = await collect();
    expect(s.error).toBeUndefined();
    expect(s.commits.map((c) => c.branch)).toEqual(["main"]);
    expect(s.warnings).toContain("Skipped commits on feature in 1710 (502)");
  });
  it("reports a repo-level 401 as a repo failure naming the token", async () => {
    gh.repos.get.mockRejectedValue(httpError(401, "https://api.github.com/repos/CourtneyFradreck/1710"));
    const s = await collect();
    expect(s.error).toBe("Couldn't access CourtneyFradreck/1710 (401: check the token)");
    expect(s.branches).toEqual([]);
    expect(logged(console.warn)).toContainEqual(expect.objectContaining({ event: "github_error", endpoint: "GET /repos/CourtneyFradreck/1710", status: 401 }));
  });
  it("reports a repo-level 404 as not found or not visible", async () => {
    gh.repos.get.mockRejectedValue(httpError(404));
    expect((await collect()).error).toBe("Couldn't access CourtneyFradreck/1710 (404: not found, or the token can't see it)");
  });
  it("names the repo-level call that failed after the repo was found", async () => {
    gh.paginate.mockImplementation(async (endpoint) => {
      if (endpoint === gh.repos.listBranches) throw httpError(500);
      return [];
    });
    const s = await collect();
    expect(s.error).toBe("Couldn't read branches in 1710 (500)");
    expect(logged(console.warn)).toContainEqual(expect.objectContaining({ endpoint: "GET /repos/{owner}/{repo}/branches", status: 500 }));
  });
});

describe("branch cache", () => {
  const PUSHED = "2026-10-12T09:00:00Z";
  const cached = (over = {}) => ({ pushedAt: PUSHED, base: "main", branches: [
    { name: "main", sha: "m", lastCommitAt: daysAgo(1), aheadBy: 0, url: "https://github.com/me/demo/tree/main" },
    { name: "keep-open", sha: "k", lastCommitAt: daysAgo(90), aheadBy: 4, url: "https://github.com/me/demo/tree/keep-open" },
    { name: "pr-assets/shots", sha: "a", lastCommitAt: daysAgo(3), aheadBy: 1, url: "https://github.com/me/demo/tree/pr-assets/shots" },
  ], ...over });
  const collect = async (branchCache = cached()) => (await collectAll([{ repo: "me/demo", branchCache }], { start: NOW, end: NOW, label: "test" }, []))[0];
  beforeEach(() => {
    vi.resetAllMocks();
    forgetNoCommonHistory();
    vi.spyOn(console, "info").mockImplementation(() => {});
    gh.users.getAuthenticated.mockResolvedValue({ data: { login: "me" } });
    gh.repos.get.mockResolvedValue({ data: { default_branch: "main", private: false, pushed_at: PUSHED, created_at: daysAgo(30) } });
    gh.repos.getContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    gh.repos.getCommit.mockResolvedValue({ data: { commit: { committer: { date: daysAgo(1) } } } });
    gh.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { ahead_by: 7 } });
    gh.pulls.list.mockResolvedValue({ data: [] });
    gh.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [] } });
    gh.paginate.mockImplementation(async (endpoint) => endpoint === gh.repos.listBranches
      ? [{ name: "main", commit: { sha: "m2" } }, { name: "fresh", commit: { sha: "f" } }] : []);
  });

  it("reuses the cached branches without branch or compare calls when pushed_at is unchanged", async () => {
    const s = await collect();
    expect(s.pushedAt).toBe(PUSHED);
    expect(s.branches.map((b) => [b.name, b.aheadBy])).toEqual([["main", 0], ["keep-open", 4]]);
    expect(gh.paginate).not.toHaveBeenCalledWith(gh.repos.listBranches, expect.anything());
    expect(gh.repos.getCommit).not.toHaveBeenCalled();
    expect(gh.repos.compareCommitsWithBasehead).not.toHaveBeenCalled();
  });
  it.each([
    ["the repo was pushed to since", { pushedAt: "2026-10-11T09:00:00Z" }],
    ["the default branch changed", { base: "trunk" }],
  ])("reads the branches again when %s", async (_, over) => {
    const s = await collect(cached(over));
    expect(s.branches.map((b) => [b.name, b.aheadBy])).toEqual([["main", 0], ["fresh", 7]]);
    expect(gh.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(expect.objectContaining({ basehead: "main...fresh" }));
  });
  it("reads the branches when there is no cache", async () => {
    const [s] = await collectAll(["me/demo"], { start: NOW, end: NOW, label: "test" }, []);
    expect(s.branches.map((b) => b.name)).toEqual(["main", "fresh"]);
  });
});
