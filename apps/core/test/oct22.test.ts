import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { OCT22_FOCUS, OCT22_NOW, OCT22_PREVIOUS_BRIEF_AT, oct22Snapshots } from "./fixtures/oct22.js";
import { oldBranches } from "../src/rules/index.js";

// The real rules, focus and renderer; only GitHub, the database and Telegram are replaced.
const mocks = vi.hoisted(() => ({
  storeFindings: vi.fn(), storeBriefFocus: vi.fn(), previousRuns: vi.fn(),
  env: { briefMode: "rules", delivery: "n8n", repos: [] as string[] },
}));
vi.mock("../src/repos.js", () => ({ resolveRepos: async () => ({ repos: ["me/demo"] }), unannouncedRepos: async () => [], markAnnounced: async () => {} }));
vi.mock("../src/env.js", () => ({ env: mocks.env }));
// As shipped on 22 Oct, whatever config.json holds now.
vi.mock("../src/features.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features.js")>()),
  features: { focusButtons: true, snooze: false, streaks: false, quietMornings: false },
}));
vi.mock("../src/logs.js", () => ({ logsInWindow: async () => [] }));
vi.mock("../src/checkin.js", () => ({ completedFocusIds: async () => new Set() }));
vi.mock("../src/db.js", () => ({ pool: { connect: async () => ({ query: async () => ({ rows: [{ ok: true }] }), release: vi.fn() }) } }));
vi.mock("../src/github/collect.js", () => ({ collectAll: async () => oct22Snapshots() }));
vi.mock("../src/store.js", () => ({
  startRun: async () => 7, finishRun: vi.fn(), storeSnapshots: vi.fn(),
  storeNextItems: async () => ({ history: new Map(), missingReported: new Set() }), markMissingReported: vi.fn(),
  storeFindings: mocks.storeFindings, storeBrief: async () => 70, storeBriefFocus: mocks.storeBriefFocus,
  getFocus: async () => OCT22_FOCUS, previousBriefAt: async () => OCT22_PREVIOUS_BRIEF_AT, snoozedFocusIds: async () => new Set(),
  previousRuns: mocks.previousRuns,
}));
import { runBrief } from "../src/pipeline.js";

const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const cfg = { idlePrDays: 3, staleBranchDays: 7, oldBranchDays: 60, ciMaxAgeDays: 30, activeRepoDays: 7, ignoreBranchPrefixes: [] };

describe("the 22 Oct brief", () => {
  let text = "";
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    // Thursday: the last scheduled brief already listed the same old branches.
    const old = oldBranches(oct22Snapshots(), OCT22_NOW, cfg)[0];
    mocks.previousRuns.mockResolvedValue([{ id: 6, source: "schedule", status: "ok", windowEnd: new Date("2026-10-20T22:00:00Z"), findingIds: [old.id], attentionIds: [old.id] }]);
    text = (await runBrief("schedule", DateTime.fromJSDate(OCT22_NOW))).text;
  });

  it("matches the corrected render", async () => {
    await expect(text).toMatchFileSnapshot("./__snapshots__/oct22-brief.html");
  });
  it("counts yesterday's feature-branch commits in yesterday's focus line, agreeing with the recap", () => {
    const visible = plain(text);
    expect(visible).not.toContain("No commits");
    expect(visible).toContain("36 commits in case-ai yesterday");
    expect(visible).toContain("36 commits on feat/m3-intent (46 on the branch so far)");
  });
  it("asks to tick off the M2 merge instead of suggesting it", () => {
    const visible = plain(text);
    expect(visible).toContain('Looks like "Merge M2" is done (PR #3 merged). Tick it off in NEXT.md?');
    const suggestions = visible.split("Today, I'd suggest")[1]?.split("\nYesterday\n")[0] ?? "";
    expect(suggestions).not.toContain("M2");
  });
  it("names the taga branch once, on the last line, and never suggests closing it", () => {
    const visible = plain(text);
    expect(visible).not.toMatch(/Merge or close/);
    expect(visible.trimEnd().split("\n").at(-1)).toBe("⚪ Left open: feat/update-product-section in taga-technologies (idle 8 days)");
    expect(visible.match(/feat\/update-product-section/g)).toHaveLength(1);
    expect(visible).not.toMatch(/Unmerged and untouched|Open in NEXT\.md|has recent commits/);
    expect(visible).not.toContain("including");
    expect(visible).not.toContain("Here's your brief\" from noon");
  });
  it("suggests active NEXT.md work first, and only the first CASE_BRIEF_MODE step", () => {
    const suggestions = plain(text).split("Today, I'd suggest")[1]?.split("\nYesterday\n")[0] ?? "";
    expect(suggestions).toMatch(/^\n1\. Run CASE_BRIEF_MODE=command for 3 days/);
    expect(suggestions).not.toContain("Switch to CASE_BRIEF_MODE=all");
  });
  it("leaves the unchanged old branches out on a Thursday, but stores them", () => {
    expect(plain(text)).not.toContain("old unmerged branches");
    expect(mocks.storeFindings.mock.calls[0][1].map((f: { rule: string }) => f.rule)).toContain("old_branches");
  });
  it("keeps every suggestion's label within 40 characters", () => {
    const stored = mocks.storeBriefFocus.mock.calls[0][1] as { label: string }[];
    expect(stored.length).toBeGreaterThan(0);
    for (const s of stored) expect(s.label.length).toBeLessThanOrEqual(40);
  });
});
