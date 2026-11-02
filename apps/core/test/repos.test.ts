import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn(), listOwnedRepos: vi.fn(), activityRepos: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool: { query: m.query } }));
vi.mock("../src/env.js", () => ({ env: { githubToken: "test", repos: ["team/shared"], repoExclude: [], repoActiveDays: 14, branchExclude: [] } }));
vi.mock("../src/github/discover.js", async (actual) => ({ ...(await actual<object>()), listOwnedRepos: m.listOwnedRepos, activityRepos: m.activityRepos }));
import { knownRepos, resolveRepos, storeBranchCaches, withBranchCaches } from "../src/repos.js";
import { snap } from "./fixtures.js";

const NOW = new Date("2026-10-29T06:00:00Z");
const owned = (repo: string, pushedAt: string) => ({ repo, fork: false, archived: false, pushedAt, private: true, defaultBranch: "main" });

describe("repo resolution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    m.query.mockResolvedValue({ rows: [] });
    m.activityRepos.mockResolvedValue(new Set());
  });
  it("stores every kept owned repo, active or quiet, with its source", async () => {
    m.listOwnedRepos.mockResolvedValue([owned("me/active", "2026-10-28T00:00:00Z"), owned("me/quiet", "2026-01-01T00:00:00Z"), owned("team/shared", "2026-01-01T00:00:00Z")]);
    const { repos, error } = await resolveRepos(NOW);
    expect(error).toBeUndefined();
    expect(repos).toEqual(["team/shared", "me/active"]);
    const [sql, params] = m.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO repos/);
    expect(params[0]).toEqual(["me/active", "me/quiet", "team/shared"]);
    expect(params[3]).toEqual(["2026-10-28T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    expect(params[4]).toEqual(["discovered", "discovered", "manual"]);
  });
  it("falls back to CASE_REPOS and recently active discovered repos when listing fails", async () => {
    m.listOwnedRepos.mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401 }));
    m.query.mockResolvedValue({ rows: [{ full_name: "me/active" }] });
    const { repos, error } = await resolveRepos(NOW);
    expect(repos).toEqual(["team/shared", "me/active"]);
    expect(error).toBe("Couldn't list your repos (401: check the token), so only CASE_REPOS and recently active repos were read");
    expect(m.query).toHaveBeenCalledWith(expect.stringMatching(/source = 'discovered' AND last_pushed_at >= \$1/), [new Date("2026-10-15T06:00:00Z")]);
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0][0])).toMatchObject({ event: "github_error", endpoint: "GET /user/repos", status: 401 });
  });
  it("knows CASE_REPOS entries and every stored repo, for /next and log tags", async () => {
    m.query.mockResolvedValue({ rows: [{ full_name: "me/active" }, { full_name: "team/shared" }] });
    expect(await knownRepos()).toEqual(["team/shared", "me/active"]);
  });

  it("caches branches only for repos read in full", async () => {
    const branches = [{ name: "main", sha: "m", lastCommitAt: "2026-10-28T00:00:00Z", aheadBy: 0, url: "u" }];
    await storeBranchCaches([
      snap({ repo: "me/full", pushedAt: "2026-10-28T00:00:00Z", defaultBranch: "trunk", branches }),
      snap({ repo: "me/partial", pushedAt: "2026-10-28T00:00:00Z", warnings: ["Skipped branch x in partial (500)"] }),
      snap({ repo: "me/failed", pushedAt: "2026-10-28T00:00:00Z", error: "Couldn't read branches in failed (500)" }),
      snap({ repo: "me/unknown" }),
    ]);
    expect(m.query).toHaveBeenCalledTimes(1);
    const [, [repo, cache]] = m.query.mock.calls[0];
    expect(repo).toBe("me/full");
    expect(JSON.parse(cache)).toEqual({ pushedAt: "2026-10-28T00:00:00Z", base: "trunk", branches });
  });
  it("attaches each stored cache to its repo", async () => {
    const cache = { pushedAt: "2026-10-28T00:00:00Z", base: "main", branches: [] };
    m.query.mockResolvedValue({ rows: [{ full_name: "me/a", branch_cache: cache }] });
    expect(await withBranchCaches(["me/a", "me/b"])).toEqual([{ repo: "me/a", branchCache: cache }, { repo: "me/b" }]);
  });
});
