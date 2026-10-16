import { Octokit } from "@octokit/rest";
import { env } from "../env.js";
import { inWindow, type Window } from "../time.js";
import type { RepoSnapshot, Branch, Commit, CiRun, IssueComment } from "../types.js";

const gh = new Octokit({ auth: env.githubToken, userAgent: "case-ai" });

export async function collectAll(repos: string[], w: Window, ignoreAuthors: string[]) {
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
    const batch = repos.slice(i, i + 3).map((r) => collectRepo(r, w, ignoreAuthors, myLogin));
    out.push(...(await Promise.all(batch)));
  }
  return out;
}

async function collectRepo(fullName: string, w: Window, ignoreAuthors: string[], myLogin: string | null): Promise<RepoSnapshot> {
  const [owner, repo] = fullName.split("/");
  const empty: RepoSnapshot = {
    repo: fullName, private: false, defaultBranch: "main",
    commits: [], openPrs: [], openedPrs: [], mergedPrs: [], newIssues: [], branches: [], ciRuns: [],
    closedIssues: [], comments: [], openIssueCount: 0,
  };

  try {
    const { data: meta } = await gh.repos.get({ owner, repo });
    const base = meta.default_branch;
    const since = w.start.toISOString();
    const until = w.end.toISOString();

    // 1. Branches: head date and whether unmerged
    const branchList = await gh.paginate(gh.repos.listBranches, { owner, repo, per_page: 100 });
    const branches: Branch[] = [];
    for (const b of branchList) {
      const { data: c } = await gh.repos.getCommit({ owner, repo, ref: b.commit.sha });
      let aheadBy = 0;
      if (b.name !== base) {
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
    }

    // 2. PRs and the commits already covered by a merge in this window.
    const open = await gh.paginate(gh.pulls.list, { owner, repo, state: "open", per_page: 100 });
    const { data: closed } = await gh.pulls.list({
      owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 50,
    });
    const merged = closed.filter((p) => inWindow(p.merged_at, w));
    const mergedShas = new Set<string>();
    for (const p of merged) {
      const commits = await gh.paginate(gh.pulls.listCommits, { owner, repo, pull_number: p.number, per_page: 100 });
      for (const c of commits) mergedShas.add(c.sha);
    }

    // 3. Walk the default branch first so shared SHAs belong to it, then
    // feature branches. PR commits and merge commits are covered by the PR line.
    const seen = new Map<string, Commit>();
    const activeBranches = branches.filter((b) => new Date(b.lastCommitAt) >= w.start)
      .sort((a, b) => Number(b.name === base) - Number(a.name === base));
    for (const b of activeBranches) {
      const list = await gh.paginate(gh.repos.listCommits, {
        owner, repo, sha: b.name, since, until, per_page: 100,
      });
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
    const issues = await gh.paginate(gh.issues.listForRepo, {
      owner, repo, state: "all", since, per_page: 100,
    });
    const issuesByNumber = new Map(issues.map((i) => [i.number, i]));
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
    } catch {
      // Comments are optional; retain all other repo data if unavailable.
    }

    // 5. CI: latest completed run per workflow on the default branch
    const ciRuns: CiRun[] = [];
    try {
      let activeWorkflowIds: Set<number> | undefined;
      try {
        const workflows = await gh.paginate(gh.actions.listRepoWorkflows, { owner, repo, per_page: 100 });
        activeWorkflowIds = new Set(workflows.filter((w) => w.state === "active").map((w) => w.id));
      } catch {
        // Keep CI data when workflow metadata is unavailable.
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
    } catch {
      // Actions disabled or none configured: no CI findings for this repo
    }

    return {
      repo: fullName,
      error: undefined,
      private: meta.private,
      defaultBranch: base,
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
      newIssues: issues
        .filter((i) => !i.pull_request && inWindow(i.created_at, w))
        .map((i) => ({ number: i.number, title: i.title, url: i.html_url, createdAt: i.created_at, state: i.state })),
      closedIssues: issues
        .filter((i) => !i.pull_request && inWindow(i.closed_at, w))
        .map((i) => ({ number: i.number, title: i.title, url: i.html_url, closedAt: i.closed_at! })),
      comments,
      openIssueCount: Math.max(0, meta.open_issues_count - open.length),
      branches,
      ciRuns,
    };
  } catch (e: any) {
    return { ...empty, error: e?.status ? `GitHub ${e.status}` : String(e?.message ?? e) };
  }
}
