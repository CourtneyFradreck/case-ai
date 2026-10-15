import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./fixtures.js";

const gh = vi.hoisted(() => ({
  paginate: vi.fn(),
  repos: { get: vi.fn(), listBranches: vi.fn() },
  pulls: { list: vi.fn() },
  issues: { listForRepo: vi.fn() },
  actions: { listRepoWorkflows: vi.fn(), listWorkflowRunsForRepo: vi.fn() },
}));
vi.mock("@octokit/rest", () => ({ Octokit: class { constructor() { return gh; } } }));
vi.mock("../src/env.js", () => ({ env: { githubToken: "test" } }));
import { collectAll } from "../src/github/collect.js";

describe("workflow collection", () => {
  const states = ["active", "disabled_manually", "disabled_inactivity", "disabled_fork", "deleted"];
  beforeEach(() => {
    vi.resetAllMocks();
    gh.repos.get.mockResolvedValue({ data: { default_branch: "main", private: false } });
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
