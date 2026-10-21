import { beforeEach, describe, expect, it, vi } from "vitest";
import { snap } from "./fixtures.js";
import { parseNext } from "../src/intent/parse.js";
import type { NextFile } from "../src/types.js";

const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool }));
import { storeNextItems } from "../src/store.js";

const url = "https://github.com/me/demo/blob/main/NEXT.md";
const okNext = (md: string): NextFile => ({ status: "ok", sha: "s1", url, lastChangedAt: null, items: parseNext("me/demo", md) });

describe("storeNextItems", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
  });
  it("upserts every item of a readable NEXT.md with the run ID", async () => {
    const next = okNext(["- [ ] Loose end", "# Now", "- [x] Ship the parser"].join("\n"));
    await storeNextItems(7, [snap({ next })]);
    const items = next.status === "ok" ? next.items : [];
    expect(pool.query.mock.calls.map(([, params]) => params)).toEqual([
      ["me/demo", items[0].id, "Loose end", null, "open", 7],
      ["me/demo", items[1].id, "Ship the parser", "Now", "done", 7],
    ]);
  });
  it("updates text, state, last_seen and run, and moves section_changed_at only on a section change", async () => {
    await storeNextItems(7, [snap({ next: okNext("- [ ] Item") })]);
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("ON CONFLICT (repo, item_id) DO UPDATE");
    expect(sql).toMatch(/SET text=EXCLUDED\.text, state=EXCLUDED\.state, last_seen=now\(\), last_run_id=EXCLUDED\.last_run_id/);
    expect(sql).toMatch(/CASE WHEN next_items\.section IS DISTINCT FROM EXCLUDED\.section\s+THEN now\(\) ELSE next_items\.section_changed_at END/);
    expect(sql).not.toMatch(/SET[\s\S]*first_seen/);
  });
  it("skips errored snapshots and missing or errored files", async () => {
    await storeNextItems(7, [
      snap({ error: "GitHub 500", next: okNext("- [ ] Item") }),
      snap({ next: { status: "missing" } }),
      snap({ next: { status: "error", error: "GitHub 500" } }),
    ]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
