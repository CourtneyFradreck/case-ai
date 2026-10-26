import { describe, expect, it } from "vitest";
import { NOW, daysAgo, snap } from "./fixtures.js";
import { parseNext } from "../src/intent/parse.js";
import { leadingFile, runIntentRules, subjects, type IntentHistory } from "../src/intent/rules.js";
import type { NextFile, RepoSnapshot } from "../src/types.js";

const cfg = { newRepoDays: 7, nextStaleDays: 14, activeRepoDays: 7 };
const url = "https://github.com/me/demo/blob/main/NEXT.md";
const okNext = (md: string, over: Partial<Extract<NextFile, { status: "ok" }>> = {}): NextFile =>
  ({ status: "ok", sha: "sha2", url, lastChangedAt: daysAgo(1), items: parseNext("me/demo", md), ...over });
const recent = [{ name: "main", sha: "a", lastCommitAt: daysAgo(1), aheadBy: 0, url: "https://github.com/me/demo/tree/main" }];
const run = (s: Partial<RepoSnapshot>, history?: IntentHistory, missingReported?: Set<string>) =>
  runIntentRules([snap(s)], NOW, cfg, history, missingReported);
const rules = (s: Partial<RepoSnapshot>, rule: string, history?: IntentHistory) => run(s, history).filter((f) => f.rule === rule);
const idFor = (text: string) => parseNext("me/demo", `- [ ] ${text}`)[0].id;

describe("next_item", () => {
  const md = ["- [ ] Loose end", "# Now", "- [ ] Ship the parser", "- [x] Write docs"].join("\n");

  it("makes one info finding per open item and none for done items", () => {
    const found = rules({ next: okNext(md) }, "next_item");
    expect(found.map((f) => f.summary)).toEqual(["Next in me/demo: Loose end", "Next in me/demo: Ship the parser"]);
    expect(found.every((f) => f.severity === "info")).toBe(true);
  });
  it("cites the item line, prefixes the item ID and records intent", () => {
    const [, f] = rules({ next: okNext(md) }, "next_item");
    expect(f).toMatchObject({
      id: `next_${idFor("Ship the parser")}`,
      details: ["Now"],
      sources: [{ label: "NEXT.md", url: `${url}#L3` }],
      intent: { itemId: idFor("Ship the parser"), section: "Now", state: "open" },
    });
  });
  it("has no details for an item outside any section", () => {
    expect(rules({ next: okNext(md) }, "next_item")[0]).not.toHaveProperty("details");
  });
});

describe("next_done", () => {
  const before = ["# Now", "- [ ] Ship the parser", "- [ ] Write docs"].join("\n");
  const history = (sha = "sha1"): IntentHistory =>
    new Map([["me/demo", { sha, openIds: new Set(parseNext("me/demo", before).map((i) => i.id)) }]]);

  it("fires for an item ticked since the last run, with its text and line", () => {
    const after = ["# Now", "- [ ] Write docs", "## Done", "- [x] Ship the parser"].join("\n");
    expect(rules({ next: okNext(after) }, "next_done", history())).toMatchObject([{
      severity: "info", summary: "Finished in me/demo: Ship the parser",
      sources: [{ label: "NEXT.md", url: `${url}#L4` }],
      intent: { itemId: idFor("Ship the parser"), section: "Done", state: "done" },
    }]);
  });
  it("fires for an item removed when the file changed", () => {
    expect(rules({ next: okNext("# Now\n- [ ] Write docs") }, "next_done", history())).toMatchObject([{
      summary: "Finished in me/demo: an item from NEXT.md",
      sources: [{ label: "NEXT.md", url }],
      intent: { itemId: idFor("Ship the parser"), section: null, state: "done" },
    }]);
  });
  it("does not fire when the file sha is unchanged", () => {
    expect(rules({ next: okNext("- [ ] Write docs", { sha: "sha1" }) }, "next_done", history())).toEqual([]);
  });
  it("does not fire when NEXT.md is missing or errored", () => {
    expect(run({ next: { status: "missing" } }, history()).filter((f) => f.rule === "next_done")).toEqual([]);
    expect(run({ next: { status: "error", error: "GitHub 500" } }, history())).toEqual([]);
  });
  it("does not fire for an item still open under a new ID once history follows the edit", () => {
    const after = ["# Now", "- [ ] Ship the parser today", "- [ ] Write docs"].join("\n");
    const followed: IntentHistory = new Map([["me/demo", { sha: "sha1", openIds: new Set([idFor("Ship the parser today"), idFor("Write docs")]) }]]);
    expect(rules({ next: okNext(after) }, "next_done", followed)).toEqual([]);
  });
  it("does not fire without history", () => {
    expect(rules({ next: okNext("- [ ] Write docs") }, "next_done")).toEqual([]);
  });
});

describe("next_missing", () => {
  const active = [{ name: "master", sha: "e1", lastCommitAt: daysAgo(1), aheadBy: 0, url: "u" }];
  it("fires for a 2-day-old repo with no NEXT.md, with a stable ID", () => {
    const found = run({ createdAt: daysAgo(2), next: { status: "missing" } });
    expect(found).toMatchObject([{
      rule: "next_missing", severity: "low", summary: "demo has no NEXT.md. Add one so I can track next steps?",
      sources: [{ label: "repo", url: "https://github.com/me/demo" }],
    }]);
    expect(run({ createdAt: daysAgo(3), next: { status: "missing" } })[0].id).toBe(found[0].id);
  });
  // 24 Oct brief: event-hunters had 15 commits on master and no NEXT.md.
  it("fires for an old repo with commits in the last activeRepoDays", () => {
    expect(run({ createdAt: daysAgo(300), branches: active, next: { status: "missing" } })).toMatchObject([{ rule: "next_missing", ageDays: 1 }]);
  });
  it("does not fire while it was shown in the last week", () => {
    expect(run({ createdAt: daysAgo(2), next: { status: "missing" } }, undefined, new Set(["me/demo"]))).toEqual([]);
    expect(run({ createdAt: daysAgo(2), next: { status: "missing" } }, undefined, new Set(["me/other"]))).toHaveLength(1);
  });
  it("does not fire for an old repo without recent commits", () => {
    expect(run({ createdAt: daysAgo(30), next: { status: "missing" } })).toEqual([]);
    expect(run({ createdAt: daysAgo(30), branches: [{ ...active[0], lastCommitAt: daysAgo(8) }], next: { status: "missing" } })).toEqual([]);
  });
  it("does not fire when the file exists or errored", () => {
    expect(rules({ createdAt: daysAgo(2), next: okNext("") }, "next_missing")).toEqual([]);
    expect(run({ createdAt: daysAgo(2), branches: active, next: { status: "error", error: "GitHub 500" } })).toEqual([]);
  });
});

describe("next_stale", () => {
  const stale = (lastChangedAt: string | null, branches = recent) => rules({ branches, next: okNext("", { lastChangedAt }) }, "next_stale");

  it("fires from exactly nextStaleDays, not a day before", () => {
    expect(stale(daysAgo(13))).toEqual([]);
    expect(stale(daysAgo(14))).toMatchObject([{
      severity: "low", ageDays: 14,
      summary: "NEXT.md in me/demo hasn't changed in 14 days, though you've been committing",
      sources: [{ label: "NEXT.md", url }],
    }]);
  });
  it("needs commits within activeRepoDays", () => {
    expect(stale(daysAgo(30), [])).toEqual([]);
    expect(stale(daysAgo(30), [{ ...recent[0], lastCommitAt: daysAgo(8) }])).toEqual([]);
    expect(stale(daysAgo(30), [{ ...recent[0], lastCommitAt: daysAgo(7) }])).toHaveLength(1);
  });
  it("ignores branches without a commit date", () => {
    expect(stale(daysAgo(30), [{ ...recent[0], name: "undated", lastCommitAt: "" }, ...recent])).toHaveLength(1);
    expect(stale(daysAgo(30), [{ ...recent[0], lastCommitAt: "" }])).toEqual([]);
  });
  it("skips a file with no known last change", () => {
    expect(stale(null)).toEqual([]);
  });
});

describe("runIntentRules", () => {
  it("produces nothing for a snapshot with an error", () => {
    const history: IntentHistory = new Map([["me/demo", { sha: "sha1", openIds: new Set([idFor("Gone")]) }]]);
    expect(run({ error: "GitHub 500", createdAt: daysAgo(1), branches: recent, next: okNext("- [ ] Open", { lastChangedAt: daysAgo(30) }) }, history)).toEqual([]);
    expect(run({ error: "GitHub 500", createdAt: daysAgo(1), next: { status: "missing" } })).toEqual([]);
  });
  it("sorts like runRules: low before info", () => {
    const found = run({ branches: recent, next: okNext("- [ ] Open", { lastChangedAt: daysAgo(30) }) });
    expect(found.map((f) => f.rule)).toEqual(["next_stale", "next_item"]);
  });
});

describe("sequences of NEXT.md items", () => {
  const waits = (md: string, extra: Partial<RepoSnapshot> = {}) => Object.fromEntries(rules({ next: okNext(md), branches: recent, ...extra }, "next_item")
    .map((f) => [f.summary.replace("Next in me/demo: ", ""), f.intent?.waitsOn ?? null]));

  it("lets an item that names the same setting as the open item above it wait its turn", () => {
    const md = ["## M2 rollout", "- [ ] Run CASE_BRIEF_MODE=command for 3 days; check logs", "- [ ] Switch to CASE_BRIEF_MODE=all"].join("\n");
    expect(waits(md)).toEqual({
      "Run CASE_BRIEF_MODE=command for 3 days; check logs": null,
      "Switch to CASE_BRIEF_MODE=all": idFor("Run CASE_BRIEF_MODE=command for 3 days; check logs"),
    });
  });
  it("frees the next step once the one above is ticked, or a merged PR likely finished it", () => {
    const ticked = ["## M2 rollout", "- [x] Run CASE_BRIEF_MODE=command for 3 days", "- [ ] Switch to CASE_BRIEF_MODE=all"].join("\n");
    expect(waits(ticked)).toEqual({ "Switch to CASE_BRIEF_MODE=all": null });
    // 23 Oct: "Merge M2" looked done (PR #3), so the first CASE_BRIEF_MODE step is the one to suggest.
    const merged = { number: 3, title: "feat: M2 model brief", url: "https://github.com/me/demo/pull/3", draft: false, headRef: "feat/m2-model-brief", updatedAt: daysAgo(3), mergedAt: daysAgo(3) };
    const md = ["## M2 rollout", "- [ ] Merge M2 after M1 trial ends", "- [ ] Run CASE_BRIEF_MODE=command for 3 days", "- [ ] Switch to CASE_BRIEF_MODE=all"].join("\n");
    expect(waits(md, { recentlyMerged: [merged] })).toEqual({
      "Run CASE_BRIEF_MODE=command for 3 days": null,
      "Switch to CASE_BRIEF_MODE=all": idFor("Run CASE_BRIEF_MODE=command for 3 days"),
    });
  });
  it("follows an explicit after: marker, and chains", () => {
    const md = ["# Launch", "- [ ] Write the post", "- [ ] after: Publish it", "- [ ] after: Share the link"].join("\n");
    expect(waits(md)).toEqual({ "Write the post": null, "Publish it": idFor("Write the post"), "Share the link": idFor("Publish it") });
  });
  it("leaves unrelated items, and items in other sections, free", () => {
    const md = ["## A", "- [ ] Turn on features.streaks", "- [ ] Tidy the README.md intro", "- [ ] Fix NEXT.md parsing", "## B", "- [ ] after: Turn on features.streaks again"].join("\n");
    expect(Object.values(waits(md))).toEqual([null, null, null, null]);
  });
  // 24 Oct brief: both were suggested side by side, though turning items into findings needs the parser first.
  it("waits when both items are about the same file", () => {
    const md = ["## M1", "- [ ] Parse NEXT.md in each tracked repo (open \"- [ ]\" items, section headings)", "- [ ] NEXT.md items become findings with stable IDs the validator can cite"].join("\n");
    expect(Object.values(waits(md))).toEqual([null, idFor("Parse NEXT.md in each tracked repo (open \"- [ ]\" items, section headings)")]);
  });
  it("finds the file an item is about only in its first three words", () => {
    expect(leadingFile("Parse NEXT.md in each tracked repo")).toBe("next.md");
    expect(leadingFile("`config.json`: turn on streaks")).toBe("config.json");
    expect(leadingFile("Tick it off in NEXT.md")).toBeUndefined();
    expect(leadingFile("Merge M2")).toBeUndefined();
  });
  it("names settings and milestones as subjects, not files or abbreviations", () => {
    expect([...subjects("Run CASE_BRIEF_MODE=command; check features.focusButtons, e.g. in NEXT.md and config.json for M3")])
      .toEqual(["case_brief_mode", "features.focusbuttons", "m3"]);
  });
});
