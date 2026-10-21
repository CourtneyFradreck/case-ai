import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { snap } from "./fixtures.js";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), collectAll: vi.fn(), storeBrief: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool: { connect: async () => ({ query: async () => ({ rows: [{ ok: true }] }), release: vi.fn() }) } }));
vi.mock("../src/github/collect.js", () => ({ collectAll: mocks.collectAll }));
vi.mock("../src/store.js", () => ({ startRun: async () => 7, finishRun: vi.fn(), storeSnapshots: vi.fn(), storeNextItems: vi.fn(), storeFindings: vi.fn(), storeBrief: mocks.storeBrief }));
vi.mock("../src/llm/gemini.js", () => ({ GeminiBriefModel: class { name = "test-model"; generate = mocks.generate; } }));

describe("shared brief structure through the pipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    for (const name of ["DATABASE_URL", "CASE_API_KEY", "GITHUB_TOKEN", "GEMINI_API_KEY"]) vi.stubEnv(name, "test");
    vi.stubEnv("CASE_REPOS", "me/demo");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.collectAll.mockResolvedValue([snap({
      branches: [{ name: "main", sha: "abc", aheadBy: 0, lastCommitAt: "2026-10-15T10:00Z", url: "https://github.com/me/demo/tree/main" }],
      commits: [{ sha: "abc", message: "Add a personal brief", url: "https://github.com/me/demo/commit/abc", date: "2026-10-15T10:00Z", author: "me", branch: "main" }],
      newIssues: [{ number: 1, title: "Plan the next release", url: "https://github.com/me/demo/issues/1", createdAt: "2026-10-15T12:00Z", state: "open" }], openIssueCount: 1,
      ciRuns: [{ workflowId: 1, workflowName: "build", conclusion: "failure", finishedAt: "2026-10-15T10:00Z", url: "https://github.com/me/demo/actions/runs/1" }],
    })]);
    mocks.generate.mockResolvedValue({ model: "test-model", raw: JSON.stringify({ attention: [{ text: "Your build needs a fix.", sources: ["F1"] }], yesterday: [{ text: "You added a personal brief.", sources: ["F2"] }, { text: "Opened issue #1 to plan the next release.", sources: ["F3"] }], focus: [] }) });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(["rules", "model", "invalid mode", "missing key", "provider failure"])("keeps attention before recap with %s", async (path) => {
    vi.stubEnv("CASE_BRIEF_MODE", path === "rules" ? "rules" : path === "invalid mode" ? "unsupported" : "all");
    if (path === "missing key") vi.stubEnv("GEMINI_API_KEY", "");
    if (path === "provider failure") mocks.generate.mockRejectedValue(new Error("invalid model settings"));
    const { runBrief } = await import("../src/pipeline.js");
    const { text } = await runBrief("command", DateTime.fromISO("2026-10-16T05:00:00Z"));
    expect(text.split("\n").slice(0, 2)).toEqual(["<b>Good morning, Courtney. Here's your morning brief.</b>", "Friday, 16 Oct 2026"]);
    expect([...text.matchAll(/<b>(Here's what[^<]+)<\/b>/g)].map((m) => m[1])).toEqual(["Here's what needs your attention", "Here's what you worked on yesterday"]);
    expect(text.match(/issue #1/g)).toHaveLength(1);
    expect(text).toContain("<b>demo</b>\n• A commit on main: Add a personal brief.");
    expect(text).toContain('• Opened issue #1 "Plan the next release".');
    const recap = text.split("<b>Here's what you worked on yesterday</b>")[1];
    expect(recap.replace(/<[^>]+>/g, "")).not.toContain("me/demo");
    expect(recap).not.toMatch(/^• You\b/m);
    expect(text).not.toContain("productive day");
    expect(text).not.toContain("Nothing new");
    expect(mocks.generate).toHaveBeenCalledTimes(path === "model" ? 1 : path === "provider failure" ? 2 : 0);
    expect(mocks.collectAll.mock.calls[0][1]).toMatchObject({ start: new Date("2026-10-08T22:00Z"), end: new Date("2026-10-15T22:00Z") });
  });
});
