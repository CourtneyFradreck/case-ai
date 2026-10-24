import { beforeEach, describe, expect, it, vi } from "vitest";
import { snap } from "./fixtures.js";
import { parseNext } from "../src/intent/parse.js";
import type { NextFile } from "../src/types.js";

const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool }));
import { markMissingReported, storeNextItems } from "../src/store.js";

const url = "https://github.com/me/demo/blob/main/NEXT.md";
const okNext = (md: string): NextFile => ({ status: "ok", sha: "s1", url, lastChangedAt: null, items: parseNext("me/demo", md) });
const idFor = (text: string) => parseNext("me/demo", `- [ ] ${text}`)[0].id;
const FIRST = new Date("2026-09-01T05:00:00Z");
const MOVED = new Date("2026-09-10T05:00:00Z");
const row = (text: string, over: object = {}) => ({
  item_id: idFor(text), text, section: "Now", state: "open", last_run_id: "6", first_seen: FIRST, section_changed_at: MOVED, previous_ids: [], ...over,
});
const withRows = (rows: object[], file?: object) => pool.query.mockImplementation(async (sql: string) => ({
  rows: !sql.trimStart().startsWith("SELECT") ? [] : sql.includes("FROM next_files") ? (file ? [file] : []) : rows,
}));
const upserts = () => pool.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO next_items")).map(([, params]) => params);

describe("storeNextItems", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withRows([]);
  });
  it("upserts every item of a readable NEXT.md with the run ID", async () => {
    const next = okNext(["- [ ] Loose end", "# Now", "- [x] Ship the parser"].join("\n"));
    await storeNextItems(7, [snap({ next })]);
    expect(pool.query.mock.calls[0][1]).toEqual(["me/demo"]);
    expect(upserts()).toEqual([
      ["me/demo", idFor("Loose end"), "Loose end", null, "open", 7, null, null, "[]"],
      ["me/demo", idFor("Ship the parser"), "Ship the parser", "Now", "done", 7, null, null, "[]"],
    ]);
  });
  it("updates text, state, last_seen and run, and moves section_changed_at only on a section change", async () => {
    await storeNextItems(7, [snap({ next: okNext("- [ ] Item") })]);
    const sql = pool.query.mock.calls.map(([q]) => q as string).find((q) => q.includes("INSERT INTO next_items"))!;
    expect(sql).toContain("ON CONFLICT (repo, item_id) DO UPDATE");
    expect(sql).toMatch(/SET text=EXCLUDED\.text, state=EXCLUDED\.state, last_seen=now\(\), last_run_id=EXCLUDED\.last_run_id/);
    expect(sql).toMatch(/CASE WHEN next_items\.section IS DISTINCT FROM EXCLUDED\.section\s+THEN now\(\) ELSE next_items\.section_changed_at END/);
    expect(sql).not.toMatch(/SET[\s\S]*(first_seen|previous_ids)/);
  });
  it("skips errored snapshots and errored files", async () => {
    await storeNextItems(7, [
      snap({ error: "GitHub 500", next: okNext("- [ ] Item") }),
      snap({ next: { status: "error", error: "GitHub 500" } }),
    ]);
    expect(pool.query).not.toHaveBeenCalled();
  });
  it("records a missing file with no sha and leaves its items alone", async () => {
    await storeNextItems(7, [snap({ next: { status: "missing" } })]);
    expect(pool.query.mock.calls.map(([sql]) => sql as string).some((q) => q.includes("next_items"))).toBe(false);
    expect(pool.query.mock.calls[1]).toEqual([expect.stringContaining("INSERT INTO next_files"), ["me/demo", null, 7]]);
  });
  it("records the file sha for this run", async () => {
    await storeNextItems(7, [snap({ next: okNext("- [ ] Item") })]);
    expect(pool.query.mock.calls[1]).toEqual([expect.stringContaining("ON CONFLICT (repo) DO UPDATE"), ["me/demo", "s1", 7]]);
  });

  it("gives an edited item the old item's history", async () => {
    withRows([row("Ship the parsre", { previous_ids: ["older"] }), row("Write docs")]);
    await storeNextItems(7, [snap({ next: okNext("# Now\n- [ ] Ship the parser\n- [ ] Write docs") })]);
    expect(upserts()[0]).toEqual(["me/demo", idFor("Ship the parser"), "Ship the parser", "Now", "open", 7,
      FIRST, MOVED, JSON.stringify(["older", idFor("Ship the parsre")])]);
    expect(upserts()[1].slice(6)).toEqual([null, null, "[]"]);
  });
  it("treats an edit that also changed section as a section change", async () => {
    withRows([row("Ship the parsre")]);
    await storeNextItems(7, [snap({ next: okNext("# Later\n- [ ] Ship the parser") })]);
    expect(upserts()[0].slice(6)).toEqual([FIRST, null, JSON.stringify([idFor("Ship the parsre")])]);
  });
  it("only re-links items seen in the latest run", async () => {
    withRows([row("Ship the parsre", { last_run_id: "5" }), row("Write docs")]);
    await storeNextItems(7, [snap({ next: okNext("# Now\n- [ ] Ship the parser\n- [ ] Write docs") })]);
    expect(upserts()[0].slice(6)).toEqual([null, null, "[]"]);
  });
  it("doesn't re-link a rewrite", async () => {
    withRows([row("Ship the parser")]);
    await storeNextItems(7, [snap({ next: okNext("# Now\n- [ ] Write the parser docs") })]);
    expect(upserts()[0].slice(6)).toEqual([null, null, "[]"]);
  });

  it("only re-links items seen in the run recorded for the file", async () => {
    withRows([row("Ship the parsre", { last_run_id: "5" }), row("Write docs")], { sha: "s0", run_id: "5", missing_reported_at: null });
    await storeNextItems(7, [snap({ next: okNext("# Now\n- [ ] Ship the parser\n- [ ] Write docs") })]);
    expect(upserts()[0].slice(6)).toEqual([FIRST, MOVED, JSON.stringify([idFor("Ship the parsre")])]);
  });
});

describe("intent history from storeNextItems", () => {
  beforeEach(() => vi.resetAllMocks());
  const file = { sha: "s0", run_id: "6", missing_reported_at: null };

  it("returns the previous sha and the items open in the previous run", async () => {
    withRows([row("Ship the parser"), row("Write docs", { state: "done" }), row("Old item", { last_run_id: "4" })], file);
    const { history } = await storeNextItems(7, [snap({ next: okNext("# Now\n- [ ] Ship the parser") })]);
    expect(history).toEqual(new Map([["me/demo", { sha: "s0", openIds: new Set([idFor("Ship the parser")]) }]]));
  });
  it("follows an edit to the new item ID, so a reworded item isn't reported done", async () => {
    withRows([row("Ship the parsre"), row("Write docs")], file);
    const { history } = await storeNextItems(7, [snap({ next: okNext("# Now\n- [ ] Ship the parser") })]);
    expect(history.get("me/demo")!.openIds).toEqual(new Set([idFor("Ship the parser"), idFor("Write docs")]));
  });
  it("has no history on the first run or after a missing file", async () => {
    withRows([]);
    expect((await storeNextItems(7, [snap({ next: okNext("- [ ] Item") })])).history.size).toBe(0);
    withRows([], { sha: null, run_id: "6", missing_reported_at: null });
    expect((await storeNextItems(7, [snap({ next: okNext("- [ ] Item") })])).history.size).toBe(0);
  });
  it("returns repos the no-NEXT.md suggestion was shown for in the last week", async () => {
    const now = new Date("2026-10-24T05:00:00Z");
    const shown = (daysAgo: number | null) => withRows([], { sha: null, run_id: "6", missing_reported_at: daysAgo === null ? null : new Date(now.getTime() - daysAgo * 86_400_000) });
    shown(6.9);
    expect((await storeNextItems(7, [snap({ next: { status: "missing" } })], now)).missingReported).toEqual(new Set(["me/demo"]));
    shown(7);
    expect((await storeNextItems(7, [snap({ next: { status: "missing" } })], now)).missingReported.size).toBe(0);
    shown(null);
    expect((await storeNextItems(7, [snap({ next: { status: "missing" } })], now)).missingReported.size).toBe(0);
  });
});

describe("markMissingReported", () => {
  beforeEach(() => vi.resetAllMocks());
  it("sets missing_reported_at to now for the given repos, each time it's shown", async () => {
    await markMissingReported(["me/demo"]);
    expect(pool.query).toHaveBeenCalledWith("UPDATE next_files SET missing_reported_at=now() WHERE repo = ANY($1)", [["me/demo"]]);
  });
  it("skips the query with no repos", async () => {
    await markMissingReported([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
