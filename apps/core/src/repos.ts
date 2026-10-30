import { pool } from "./db.js";
import { env } from "./env.js";
import { activityRepos, listOwnedRepos, selectRepos, type OwnedRepo } from "./github/discover.js";
import { logFailure, reason, type RepoTarget } from "./github/collect.js";
import type { BranchCache, RepoSnapshot } from "./types.js";

// The repos to read this run. Discovery runs every time; if listing fails, CASE_REPOS entries and
// repos discovered earlier that were active then are read instead, and error says so.
export async function resolveRepos(now: Date, manual: string[] = env.repos, cfg = { exclude: env.repoExclude, activeDays: env.repoActiveDays }, windowStart = new Date(now.getTime() - 7 * 86_400_000)) {
  try {
    const owned = await listOwnedRepos();
    let activity = new Set<string>();
    let error: string | undefined;
    try { activity = await activityRepos(windowStart); }
    catch (e) {
      logFailure("(discovery)", "GET /search/issues", e);
      error = `Couldn't search PR/issue activity (${reason(e)}); quiet repos may be missing`;
    }
    const selection = selectRepos(owned, manual, now, cfg, activity);
    await storeDiscovered(selection.kept, selection.repos.filter((r) => manual.some((m) => m.toLowerCase() === r.toLowerCase())));
    console.info(JSON.stringify({ event: "repo_discovery", owned: owned.length, kept: selection.kept.length,
      reading: selection.repos, quiet: selection.quiet }));
    return { repos: selection.repos, ...(error ? { error } : {}) };
  } catch (e) {
    logFailure("(discovery)", "GET /user/repos", e);
    const cutoff = new Date(now.getTime() - cfg.activeDays * 86_400_000);
    const { rows } = await pool.query<{ full_name: string }>(
      "SELECT full_name FROM repos WHERE source = 'discovered' AND last_pushed_at >= $1 ORDER BY full_name", [cutoff]);
    const repos = [...new Set([...manual, ...rows.map((r) => r.full_name)])];
    return { repos, error: `Couldn't list your repos (${reason(e)}), so only CASE_REPOS and recently active repos were read` };
  }
}

// Upserts discovered repos, active or quiet. A repo in CASE_REPOS stays 'manual'.
async function storeDiscovered(kept: OwnedRepo[], manual: string[]) {
  if (!kept.length) return;
  await pool.query(
    `INSERT INTO repos(full_name, default_branch, private, last_pushed_at, source)
     SELECT * FROM unnest($1::text[], $2::text[], $3::bool[], $4::timestamptz[], $5::text[])
     ON CONFLICT (full_name) DO UPDATE SET default_branch=EXCLUDED.default_branch, private=EXCLUDED.private,
       last_pushed_at=EXCLUDED.last_pushed_at, source=EXCLUDED.source`,
    [kept.map((r) => r.repo), kept.map((r) => r.defaultBranch), kept.map((r) => r.private), kept.map((r) => r.pushedAt),
      kept.map((r) => manual.includes(r.repo) ? "manual" : "discovered")],
  );
}

// Each repo with its branches as last read, so unchanged repos skip the branch and compare calls.
export async function withBranchCaches(repos: string[]): Promise<RepoTarget[]> {
  const { rows } = repos.length ? await pool.query<{ full_name: string; branch_cache: BranchCache }>(
    "SELECT full_name, branch_cache FROM repos WHERE full_name = ANY($1) AND branch_cache IS NOT NULL", [repos]) : { rows: [] };
  const caches = new Map(rows.map((r) => [r.full_name, r.branch_cache]));
  return repos.map((repo) => caches.has(repo) ? { repo, branchCache: caches.get(repo) } : { repo });
}

// Caches each fully read repo's branches. A repo with skipped branches is read in full next time.
export async function storeBranchCaches(snaps: RepoSnapshot[]) {
  for (const s of snaps) {
    if (s.error || s.warnings?.length || !s.pushedAt) continue;
    const cache: BranchCache = { pushedAt: s.pushedAt, base: s.defaultBranch, branches: s.branches };
    await pool.query("UPDATE repos SET branch_cache = $2, last_pushed_at = $3 WHERE full_name = $1", [s.repo, JSON.stringify(cache), s.pushedAt]);
  }
}

// Of the repos read this run, those the brief hasn't announced yet.
export async function unannouncedRepos(repos: string[]): Promise<string[]> {
  if (!repos.length) return [];
  const { rows } = await pool.query<{ full_name: string }>(
    "SELECT full_name FROM repos WHERE announced_at IS NULL AND full_name = ANY($1) ORDER BY full_name", [repos]);
  return rows.map((r) => r.full_name);
}

export async function markAnnounced(repos: string[]) {
  if (repos.length) await pool.query("UPDATE repos SET announced_at = now() WHERE full_name = ANY($1)", [repos]);
}

// Every repo CASE knows of, for /next and log tags.
export async function knownRepos(): Promise<string[]> {
  const { rows } = await pool.query<{ full_name: string }>("SELECT full_name FROM repos ORDER BY full_name");
  return [...new Set([...env.repos, ...rows.map((r) => r.full_name)])];
}
