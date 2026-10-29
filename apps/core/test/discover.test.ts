import { describe, expect, it, vi } from "vitest";
import { Octokit } from "@octokit/rest";
vi.mock("../src/env.js", () => ({ env: { githubToken: "test", branchExclude: [] } }));
import { listOwnedRepos, selectRepos, type OwnedRepo } from "../src/github/discover.js";

const NOW = new Date("2026-10-29T06:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const owned = (repo: string, over: Partial<OwnedRepo> = {}): OwnedRepo =>
  ({ repo, fork: false, archived: false, pushedAt: daysAgo(1), private: true, defaultBranch: "main", ...over });

describe("repo listing", () => {
  it("follows every page of the owner's repos", async () => {
    const api = (name: string, n: number) => ({ full_name: `me/${name}${n}`, fork: n === 2, archived: false, pushed_at: daysAgo(n), private: false, default_branch: "trunk" });
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const body = page === 1 ? [api("a", 1), api("a", 2)] : [api("b", 3)];
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (page === 1) headers.link = '<https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2>; rel="next"';
      return new Response(JSON.stringify(body), { status: 200, headers });
    };
    const repos = await listOwnedRepos(new Octokit({ request: { fetch } }));
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).pathname).toBe("/user/repos");
    expect(Object.fromEntries(new URL(urls[0]).searchParams)).toEqual({ affiliation: "owner", per_page: "100" });
    expect(repos).toEqual([
      { repo: "me/a1", fork: false, archived: false, pushedAt: daysAgo(1), private: false, defaultBranch: "trunk" },
      { repo: "me/a2", fork: true, archived: false, pushedAt: daysAgo(2), private: false, defaultBranch: "trunk" },
      { repo: "me/b3", fork: false, archived: false, pushedAt: daysAgo(3), private: false, defaultBranch: "trunk" },
    ]);
  });
});

describe("repo selection", () => {
  const cfg = { exclude: [] as string[], activeDays: 14 };
  it("drops forks, archived repos and excluded repos, by full or bare name", () => {
    const list = [owned("me/case-ai"), owned("me/fork", { fork: true }), owned("me/old", { archived: true }),
      owned("me/sandbox-1"), owned("me/scratch"), owned("me/1710")];
    const s = selectRepos(list, [], NOW, { ...cfg, exclude: ["sandbox-*", "me/scratch"] });
    expect(s.repos).toEqual(["me/case-ai", "me/1710"]);
    expect(s.kept.map((r) => r.repo)).toEqual(["me/case-ai", "me/1710"]);
  });
  it("reads only repos pushed to within the active days", () => {
    const list = [owned("me/today", { pushedAt: daysAgo(0) }), owned("me/edge", { pushedAt: daysAgo(14) }),
      owned("me/quiet", { pushedAt: daysAgo(15) }), owned("me/never", { pushedAt: null })];
    const s = selectRepos(list, [], NOW, cfg);
    expect(s.repos).toEqual(["me/today", "me/edge"]);
    expect(s.quiet).toEqual(["me/quiet", "me/never"]);
    expect(s.kept).toHaveLength(4);
    expect(selectRepos(list, [], NOW, { ...cfg, activeDays: 30 }).repos).toEqual(["me/today", "me/edge", "me/quiet"]);
  });
  it("always reads CASE_REPOS entries, even quiet, excluded or not owned", () => {
    const list = [owned("Me/Quiet", { pushedAt: daysAgo(90) }), owned("me/hidden"), owned("me/active")];
    const s = selectRepos(list, ["me/quiet", "team/shared", "me/hidden"], NOW, { ...cfg, exclude: ["hidden"] });
    expect(s.repos).toEqual(["Me/Quiet", "team/shared", "me/hidden", "me/active"]);
    expect(s.quiet).toEqual([]);
  });
  it("lists each repo once when a CASE_REPOS entry is also active", () => {
    expect(selectRepos([owned("me/demo")], ["me/demo"], NOW, cfg).repos).toEqual(["me/demo"]);
  });
  it("reads only CASE_REPOS when nothing is owned", () => {
    expect(selectRepos([], ["team/shared"], NOW, cfg)).toEqual({ repos: ["team/shared"], kept: [], quiet: [] });
  });
});
