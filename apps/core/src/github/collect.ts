import { env } from "../env.js";
import { gh } from "./client.js";
import { inWindow, type Window } from "../time.js";
import { parseNext } from "../intent/parse.js";
import type { RepoSnapshot, Branch, BranchCache, Commit, CiRun, IssueComment, NextFile } from "../types.js";

const COMPARE = "GET /repos/{owner}/{repo}/compare/{basehead}";
const GET_COMMIT = "GET /repos/{owner}/{repo}/commits/{ref}";

// Branches whose compare returned 404 (no common history with the default branch), by repo, base
// and branch, with the head SHA seen then. They are skipped quietly until the head changes.
// Kept in memory, so the first run after a restart checks them once more.
const noCommonHistory = new Map<string, string>();
export const forgetNoCommonHistory = () => noCommonHistory.clear();

// Glob match for branch names: * and ? stay within one path segment, ** crosses segments.
export function matchesGlob(name: string, glob: string): boolean {
  const re = glob.split("**").map((part) => part.split("*")
    .map((p) => p.split("?").map((t) => t.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]"))
    .join("[^/]*")).join(".*");
  return new RegExp(`^${re}$`).test(name);
}

export const statusOf = (e: any): number | undefined => typeof e?.status === "number" ? e.status : undefined;

// Why a call failed, for the brief: the status with a hint for auth failures, else the error message.
export function reason(e: any): string {
  const status = statusOf(e);
  if (status === 401) return "401: check the token";
  if (status === 403) return "403: check the token's access or rate limit";
  return status ? String(status) : String(e?.message ?? e);
}

// Every GitHub failure is logged with its endpoint and status, whether or not the brief mentions it.
export function logFailure(repo: string, endpoint: string, e: any, extra: Record<string, unknown> = {}) {
  const url = e?.request?.url ? `${e.request.method ?? "GET"} ${String(e.request.url).replace(/^https:\/\/api\.github\.com/, "")}` : undefined;
  console.warn(JSON.stringify({ event: "github_error", repo, endpoint: url ?? endpoint, status: statusOf(e) ?? null,
    ...extra, message: String(e?.message ?? e).slice(0, 200) }));
}

const logSkip = (repo: string, branch: string, why: string) =>
  console.info(JSON.stringify({ event: "github_branch_skipped", repo, branch, reason: why }));

const shortName = (fullName: string) => fullName.split("/").pop()!;

// A repo-level call that failed; its message is shown in the brief in place of the repo.
class RepoError extends Error {}

async function repoCall<T>(fullName: string, what: string, endpoint: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    logFailure(fullName, endpoint, e);
    throw new RepoError(`Couldn't read ${what} in ${shortName(fullName)} (${reason(e)})`);
  }
}

// A repo to read, with its branches as last read if any.
export interface RepoTarget { repo: string; branchCache?: BranchCache }

export async function collectAll(repos: (string | RepoTarget)[], w: Window, ignoreAuthors: string[]) {
  let myLogin: string | null = null;
  try {
    const { data } = await gh.users.getAuthenticated();
    myLogin = data.login;
  } catch {
    // Missing identity must never turn comments into requests for attention.
  }
  const out: RepoSnapshot[] = [];
  // 3 repos at a time: fast, and gentle on the API
  for (let i = 0; i < repos.length; i += 3) {
    const batch = repos.slice(i, i + 3).map((r) => collectRepo(typeof r === "string" ? { repo: r } : r, w, ignoreAuthors, myLogin));
    out.push(...(await Promise.all(batch)));
  }
  return out;
}

async function collectRepo(target: RepoTarget, w: Window, ignoreAuthors: string[], myLogin: string | null): Promise<RepoSnapshot> {
  const fullName = target.repo;
  const [owner, repo] = fullName.split("/");
  const short = shortName(fullName);
  // Branches skipped for an unexpected reason: one short line at the end of the brief.
  const warnings: string[] = [];

  try {
    let meta;
    try {
      ({ data: meta } = await gh.repos.get({ owner, repo }));
    } catch (e) {
      logFailure(fullName, "GET /repos/{owner}/{repo}", e);
      const why = statusOf(e) === 404 ? "404: not found, or the token can't see it" : reason(e);
      throw new RepoError(`Couldn't access ${fullName} (${why})`);
    }
    const base = meta.default_branch;
    const since = w.start.toISOString();
    const until = w.end.toISOString();
    const next = await collectNext(owner, repo, fullName, base);

    // 1. Branches: head date and whether unmerged. Unchanged until the repo is pushed to, so the
    // cached read is reused while pushed_at and the default branch are the same.
    const cache = target.branchCache;
    const cached = !!cache && !!meta.pushed_at && cache.pushedAt === meta.pushed_at && cache.base === base;
    if (cached) console.info(JSON.stringify({ event: "github_branches_cached", repo: fullName, pushedAt: meta.pushed_at }));
    const branches = cached
      ? cache.branches.filter((b) => !excludedBy(b.name, base))
      : await readBranches(owner, repo, fullName, base, warnings);

    // 2. PRs and the commits already covered by a merge in this window.
    const open = await repoCall(fullName, "open PRs", "GET /repos/{owner}/{repo}/pulls",
      () => gh.paginate(gh.pulls.list, { owner, repo, state: "open", per_page: 100 }));
    const { data: closed } = await repoCall(fullName, "closed PRs", "GET /repos/{owner}/{repo}/pulls",
      () => gh.pulls.list({ owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 50 }));
    const merged = closed.filter((p) => inWindow(p.merged_at, w));
    const mergedShas = new Set<string>();
    for (const p of merged) {
      const commits = await repoCall(fullName, `commits of PR #${p.number}`, "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
        () => gh.paginate(gh.pulls.listCommits, { owner, repo, pull_number: p.number, per_page: 100 }));
      for (const c of commits) mergedShas.add(c.sha);
    }

    // 3. Walk the default branch first so shared SHAs belong to it, then
    // feature branches. PR commits and merge commits are covered by the PR line.
    const seen = new Map<string, Commit>();
    const activeBranches = branches.filter((b) => new Date(b.lastCommitAt) >= w.start)
      .sort((a, b) => Number(b.name === base) - Number(a.name === base));
    for (const b of activeBranches) {
      let list;
      try {
        list = await gh.paginate(gh.repos.listCommits, { owner, repo, sha: b.name, since, until, per_page: 100 });
      } catch (e) {
        logFailure(fullName, "GET /repos/{owner}/{repo}/commits", e, { branch: b.name });
        warnings.push(`Skipped commits on ${b.name} in ${short} (${reason(e)})`);
        continue;
      }
      for (const c of list) {
        const author = c.author?.login ?? c.commit.author?.name ?? "unknown";
        if (c.parents.length > 1 || mergedShas.has(c.sha) || seen.has(c.sha) ||
          ignoreAuthors.includes(author) || !inWindow(c.commit.committer?.date, w)) continue;
        seen.set(c.sha, {
          sha: c.sha,
          message: c.commit.message.split("\n")[0],
          url: c.html_url,
          author,
          date: c.commit.committer?.date ?? "",
          branch: b.name,
          parentSha: c.parents[0]?.sha,
        });
      }
    }

    // 4. Issues (this endpoint also returns PRs, so filter them out)
    const issues = await repoCall(fullName, "issues", "GET /repos/{owner}/{repo}/issues",
      () => gh.paginate(gh.issues.listForRepo, { owner, repo, state: "all", since, per_page: 100 }));
    const issuesByNumber = new Map(issues.map((i) => [i.number, i]));
    // Unknown identity counts as yours, as for comments: it must never turn issues into requests for attention.
    const byMe = (i: { user?: { login?: string } | null }) => myLogin === null || i.user?.login === myLogin;
    // Open issues someone else opened. Issues you opened (a trial checklist, a reminder) are notes, not requests;
    // new comments on them from others still come through as issue_comments.
    const openIssues = await repoCall(fullName, "open issues", "GET /repos/{owner}/{repo}/issues",
      () => gh.paginate(gh.issues.listForRepo, { owner, repo, state: "open", per_page: 100 }));
    const othersOpen = openIssues.filter((i) => !i.pull_request && !byMe(i)).length;
    const comments: IssueComment[] = [];
    try {
      const list = await gh.paginate(gh.issues.listCommentsForRepo, { owner, repo, since, per_page: 100 });
      for (const c of list) {
        if (!inWindow(c.created_at, w)) continue;
        const author = c.user?.login ?? "unknown";
        if (c.user?.type === "Bot" || ignoreAuthors.includes(author)) continue;
        const issueNumber = Number(c.issue_url.split("/").pop());
        const issue = issuesByNumber.get(issueNumber);
        if (!issue) continue;
        comments.push({
          id: c.id, issueNumber, issueTitle: issue.title, isPr: !!issue.pull_request,
          author, url: c.html_url, createdAt: c.created_at,
          mine: myLogin === null || author === myLogin,
        });
      }
    } catch (e) {
      // Comments are optional; retain all other repo data if unavailable.
      logFailure(fullName, "GET /repos/{owner}/{repo}/issues/comments", e);
    }

    // 5. CI: latest completed run per workflow on the default branch
    const ciRuns: CiRun[] = [];
    try {
      let activeWorkflowIds: Set<number> | undefined;
      try {
        const workflows = await gh.paginate(gh.actions.listRepoWorkflows, { owner, repo, per_page: 100 });
        activeWorkflowIds = new Set(workflows.filter((w) => w.state === "active").map((w) => w.id));
      } catch (e) {
        // Keep CI data when workflow metadata is unavailable.
        logFailure(fullName, "GET /repos/{owner}/{repo}/actions/workflows", e);
      }
      const { data } = await gh.actions.listWorkflowRunsForRepo({
        owner, repo, branch: base, exclude_pull_requests: true, per_page: 30,
      });
      const latest = new Map<number, (typeof data.workflow_runs)[number]>();
      for (const r of data.workflow_runs) {
        if (activeWorkflowIds && !activeWorkflowIds.has(r.workflow_id)) continue;
        if (r.status === "completed" && !latest.has(r.workflow_id)) latest.set(r.workflow_id, r);
      }
      for (const r of latest.values()) {
        ciRuns.push({
          workflowId: r.workflow_id,
          workflowName: r.name ?? "workflow",
          conclusion: r.conclusion,
          url: r.html_url,
          finishedAt: r.updated_at,
        });
      }
    } catch (e) {
      // Actions disabled or none configured: no CI findings for this repo
      logFailure(fullName, "GET /repos/{owner}/{repo}/actions/runs", e);
    }

    return {
      repo: fullName,
      error: undefined,
      ...(meta.pushed_at ? { pushedAt: meta.pushed_at } : {}),
      private: meta.private,
      defaultBranch: base,
      createdAt: meta.created_at,
      commits: [...seen.values()],
      openPrs: open.map((p) => ({
        number: p.number, title: p.title, url: p.html_url,
        draft: !!p.draft, headRef: p.head.ref, updatedAt: p.updated_at, createdAt: p.created_at,
      })),
      openedPrs: [...open, ...closed].filter((p) => inWindow(p.created_at, w)).map((p) => ({
        number: p.number, title: p.title, url: p.html_url,
        draft: !!p.draft, headRef: p.head.ref, updatedAt: p.updated_at, createdAt: p.created_at,
      })),
      mergedPrs: merged.map((p) => ({
        number: p.number, title: p.title, url: p.html_url,
        draft: false, headRef: p.head.ref, updatedAt: p.updated_at, mergedAt: p.merged_at,
      })),
      recentlyMerged: closed.filter((p) => p.merged_at).map((p) => ({
        number: p.number, title: p.title, url: p.html_url,
        draft: false, headRef: p.head.ref, updatedAt: p.updated_at, mergedAt: p.merged_at,
      })),
      newIssues: issues
        .filter((i) => !i.pull_request && inWindow(i.created_at, w))
        .map((i) => ({ number: i.number, title: i.title, url: i.html_url, createdAt: i.created_at, state: i.state, mine: byMe(i) })),
      closedIssues: issues
        .filter((i) => !i.pull_request && inWindow(i.closed_at, w))
        .map((i) => ({ number: i.number, title: i.title, url: i.html_url, closedAt: i.closed_at! })),
      comments,
      openIssueCount: othersOpen,
      branches,
      ciRuns,
      next,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e: any) {
    if (e instanceof RepoError) return failedSnapshot(fullName, e.message);
    console.warn(JSON.stringify({ event: "collect_error", repo: fullName, message: String(e?.message ?? e).slice(0, 200) }));
    return failedSnapshot(fullName, `Couldn't read ${fullName} (${reason(e)})`);
  }
}

// The CASE_BRANCH_EXCLUDE glob a branch matches; the default branch is never excluded.
const excludedBy = (name: string, base: string) =>
  name === base ? undefined : (env.branchExclude ?? []).find((g) => matchesGlob(name, g));

// A branch that can't be read is skipped, never the repo; excluded branches are logged only.
async function readBranches(owner: string, repo: string, fullName: string, base: string, warnings: string[]): Promise<Branch[]> {
  const short = shortName(fullName);
  const branchList = await repoCall(fullName, "branches", "GET /repos/{owner}/{repo}/branches",
    () => gh.paginate(gh.repos.listBranches, { owner, repo, per_page: 100 }));
  const branches: Branch[] = [];
  for (const b of branchList) {
    const glob = excludedBy(b.name, base);
    if (glob) { logSkip(fullName, b.name, `excluded by ${glob}`); continue; }
    const orphanKey = `${fullName}\0${base}\0${b.name}`;
    if (noCommonHistory.get(orphanKey) === b.commit.sha) { logSkip(fullName, b.name, `no common history with ${base}`); continue; }
    let endpoint = GET_COMMIT;
    try {
      const { data: c } = await gh.repos.getCommit({ owner, repo, ref: b.commit.sha });
      let aheadBy = 0;
      if (b.name !== base) {
        endpoint = COMPARE;
        const { data: cmp } = await gh.repos.compareCommitsWithBasehead({
          owner, repo, basehead: `${base}...${b.name}`, per_page: 1,
        });
        aheadBy = cmp.ahead_by;
      }
      branches.push({
        name: b.name,
        sha: b.commit.sha,
        lastCommitAt: c.commit.committer?.date ?? c.commit.author?.date ?? "",
        aheadBy,
        url: `https://github.com/${fullName}/tree/${encodeURI(b.name)}`,
      });
    } catch (e) {
      logFailure(fullName, endpoint, e, { branch: b.name });
      // GitHub's compare returns 404 when the branch shares no history with the base.
      if (endpoint === COMPARE && statusOf(e) === 404) {
        noCommonHistory.set(orphanKey, b.commit.sha);
        warnings.push(`Skipped branch ${b.name} in ${short} (no common history with ${base})`);
      } else {
        warnings.push(`Skipped branch ${b.name} in ${short} (${reason(e)})`);
      }
    }
  }
  return branches;
}

// A repo that couldn't be read: safe empty data, and the sentence the brief shows.
export const failedSnapshot = (repo: string, error: string): RepoSnapshot => ({
  repo, private: false, defaultBranch: "main", createdAt: "",
  commits: [], openPrs: [], openedPrs: [], mergedPrs: [], newIssues: [], branches: [], ciRuns: [],
  closedIssues: [], comments: [], openIssueCount: 0,
  next: { status: "error", error: "not collected" },
  error,
});

// NEXT.md is optional: a failure here never marks the whole repo as unreadable.
async function collectNext(owner: string, repo: string, fullName: string, base: string): Promise<NextFile> {
  try {
    const { data } = await gh.repos.getContent({ owner, repo, path: "NEXT.md", ref: base });
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      return { status: "error", error: "NEXT.md is not a file" };
    }
    const md = Buffer.from(data.content, "base64").toString("utf8");
    let lastChangedAt: string | null = null;
    try {
      const { data: commits } = await gh.repos.listCommits({ owner, repo, path: "NEXT.md", sha: base, per_page: 1 });
      const last = commits[0]?.commit;
      lastChangedAt = last?.committer?.date ?? last?.author?.date ?? null;
    } catch (e) {
      // The items are still usable without a change date; next_stale just skips.
      logFailure(fullName, "GET /repos/{owner}/{repo}/commits", e, { path: "NEXT.md" });
    }
    return {
      status: "ok",
      sha: data.sha,
      url: `https://github.com/${fullName}/blob/${encodeURI(base)}/NEXT.md`,
      lastChangedAt,
      items: parseNext(fullName, md),
    };
  } catch (e: any) {
    if (e?.status === 404) return { status: "missing" };
    logFailure(fullName, "GET /repos/{owner}/{repo}/contents/{path}", e, { path: "NEXT.md" });
    return { status: "error", error: `Couldn't read NEXT.md in ${shortName(fullName)} (${reason(e)})` };
  }
}
