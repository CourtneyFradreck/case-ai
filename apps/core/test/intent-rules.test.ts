import { describe, expect, it } from "vitest";
import { NOW, daysAgo, snap } from "./fixtures.js";
import { parseNext } from "../src/intent/parse.js";
import { runIntentRules, type IntentHistory } from "../src/intent/rules.js";
import type { NextFile, RepoSnapshot } from "../src/types.js";

const cfg = { newRepoDays: 7, nextStaleDays: 14, activeRepoDays: 7 };
const url = "https://github.com/me/demo/blob/main/NEXT.md";
const okNext = (md: string, over: Partial<Extract<NextFile, { status: "ok" }>> = {}): NextFile =>
  ({ status: "ok", sha: "sha2", url, lastChangedAt: daysAgo(1), items: parseNext("me/demo", md), ...over });
const recent = [{ name: "main", sha: "a", lastCommitAt: daysAgo(1), aheadBy: 0, url: "https://github.com/me/demo/tree/main" }];
const run = (s: Partial<RepoSnapshot>, history?: IntentHistory) => runIntentRules([snap(s)], NOW, cfg, history);
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
  it("does not fire without history", () => {
    expect(rules({ next: okNext("- [ ] Write docs") }, "next_done")).toEqual([]);
  });
});

describe("next_missing", () => {
  it("fires once for a 2-day-old repo with no NEXT.md, with a stable ID", () => {
    const found = run({ createdAt: daysAgo(2), next: { status: "missing" } });
    expect(found).toMatchObject([{
      rule: "next_missing", severity: "low", summary: "me/demo is new and has no NEXT.md yet",
      sources: [{ label: "repo", url: "https://github.com/me/demo" }],
    }]);
    expect(run({ createdAt: daysAgo(3), next: { status: "missing" } })[0].id).toBe(found[0].id);
  });
  it("does not fire for a 30-day-old repo", () => {
    expect(run({ createdAt: daysAgo(30), next: { status: "missing" } })).toEqual([]);
  });
  it("does not fire when the file exists or errored", () => {
    expect(rules({ createdAt: daysAgo(2), next: okNext("") }, "next_missing")).toEqual([]);
    expect(run({ createdAt: daysAgo(2), next: { status: "error", error: "GitHub 500" } })).toEqual([]);
  });
});

describe("next_stale", () => {
  const stale = (lastChangedAt: string | null, branches = recent) => rules({ branches, next: okNext("", { lastChangedAt }) }, "next_stale");

  it("fires once NEXT.md is older than nextStaleDays, not at exactly nextStaleDays", () => {
    expect(stale(daysAgo(14))).toEqual([]);
    expect(stale(daysAgo(15))).toMatchObject([{
      severity: "low", ageDays: 15,
      summary: "NEXT.md in me/demo hasn't changed in 15 days, though you've been committing",
      sources: [{ label: "NEXT.md", url }],
    }]);
  });
  it("needs commits within activeRepoDays", () => {
    expect(stale(daysAgo(30), [])).toEqual([]);
    expect(stale(daysAgo(30), [{ ...recent[0], lastCommitAt: daysAgo(8) }])).toEqual([]);
    expect(stale(daysAgo(30), [{ ...recent[0], lastCommitAt: daysAgo(7) }])).toHaveLength(1);
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
