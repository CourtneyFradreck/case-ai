import { gh } from "./client.js";
import { matchesGlob } from "./collect.js";

export interface OwnedRepo {
  repo: string; fork: boolean; archived: boolean;
  pushedAt: string | null; private: boolean; defaultBranch: string;
}

export interface RepoSelection {
  repos: string[];      // to read this run: CASE_REPOS entries first, then active discovered repos
  kept: OwnedRepo[];    // owned repos left after the fork, archive and exclude filters, active or quiet
  quiet: string[];      // kept but without pushes or issue/PR activity, so not read
}

// Every repo the token's user owns, across all pages.
export async function listOwnedRepos(client = gh): Promise<OwnedRepo[]> {
  const list = await client.paginate(client.repos.listForAuthenticatedUser, { affiliation: "owner", per_page: 100 });
  return list.map((r) => ({
    repo: r.full_name, fork: r.fork, archived: r.archived ?? false,
    pushedAt: r.pushed_at ?? null, private: r.private, defaultBranch: r.default_branch,
  }));
}

// Forks, archived repos and CASE_REPO_EXCLUDE matches (on owner/repo or the bare name) are dropped;
// Recent pushes, issue/PR activity, or an open collaborator PR make a repo active.
// CASE_REPOS entries are always read.
export function selectRepos(owned: OwnedRepo[], manual: string[], now: Date, cfg: { exclude: string[]; activeDays: number }, activity: Set<string> = new Set()): RepoSelection {
  const excluded = (name: string) => cfg.exclude.some((g) => matchesGlob(name, g) || matchesGlob(name.split("/").pop()!, g));
  const kept = owned.filter((r) => !r.fork && !r.archived && !excluded(r.repo));
  const cutoff = now.getTime() - cfg.activeDays * 86_400_000;
  const active = (r: OwnedRepo) => activity.has(r.repo.toLowerCase()) || (!!r.pushedAt && Date.parse(r.pushedAt) >= cutoff);
  // GitHub names are case-insensitive: a CASE_REPOS entry takes the owned repo's spelling.
  const canonical = new Map(owned.map((r) => [r.repo.toLowerCase(), r.repo]));
  const repos = new Map<string, string>();
  for (const name of [...manual.map((m) => canonical.get(m.toLowerCase()) ?? m), ...kept.filter(active).map((r) => r.repo)]) {
    if (!repos.has(name.toLowerCase())) repos.set(name.toLowerCase(), name);
  }
  return { repos: [...repos.values()], kept, quiet: kept.filter((r) => !active(r) && !repos.has(r.repo.toLowerCase())).map((r) => r.repo) };
}

// One owner-wide activity search, plus open collaborator PRs so waiting reviews survive quiet days.
export async function activityRepos(start: Date, client = gh): Promise<Set<string>> {
  const { data: user } = await client.users.getAuthenticated();
  const queries = [`user:${user.login} updated:>=${start.toISOString()}`, `user:${user.login} is:pr is:open -author:${user.login}`];
  const results = await Promise.all(queries.map((q) => client.paginate(client.search.issuesAndPullRequests, { q, per_page: 100 })));
  return new Set(results.flat().map((i) => i.repository_url.replace(/^.*\/repos\//, "").toLowerCase()));
}
