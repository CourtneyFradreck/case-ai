import { beforeEach, describe, expect, it, vi } from "vitest";
const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool }));
import { getFocus, insertFocus, openNextItems, setPendingFocus, takePendingFocus } from "../src/store.js";

describe("focus storage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
  });
  it("inserts a focus row in core.focus", async () => {
    await insertFocus({ date: "2026-10-14", text: "Fix CI", findingId: "ci", repo: "me/demo", via: "button", briefId: 70 });
    expect(pool.query).toHaveBeenCalledWith(
      "INSERT INTO core.focus(date, item_text, finding_id, repo, chosen_via, brief_id) VALUES ($1,$2,$3,$4,$5,$6)",
      ["2026-10-14", "Fix CI", "ci", "me/demo", "button", 70],
    );
  });
  it("reads the latest focus for a date, so a later choice replaces an earlier one", async () => {
    await getFocus("2026-10-14");
    expect(pool.query.mock.calls[0][0]).toContain("WHERE date=$1 ORDER BY created_at DESC, id DESC LIMIT 1");
  });
  it("upserts the pending state for a chat", async () => {
    const expires = new Date("2026-10-14T22:00:00Z");
    await setPendingFocus("42", 70, expires);
    expect(pool.query.mock.calls[0][0]).toContain("ON CONFLICT (chat_id) DO UPDATE");
    expect(pool.query.mock.calls[0][1]).toEqual(["42", 70, expires]);
  });
  it("consumes the pending state and ignores it once expired", async () => {
    const now = new Date("2026-10-14T21:30:00Z");
    pool.query.mockResolvedValueOnce({ rows: [{ brief_id: "70", expires_at: new Date("2026-10-14T22:00:00Z") }] });
    expect(await takePendingFocus("42", now)).toEqual({ briefId: 70 });
    expect(pool.query.mock.calls[0][0]).toBe("DELETE FROM focus_pending WHERE chat_id=$1 RETURNING brief_id, expires_at");
    pool.query.mockResolvedValueOnce({ rows: [{ brief_id: "70", expires_at: new Date("2026-10-14T22:00:00Z") }] });
    expect(await takePendingFocus("42", new Date("2026-10-14T22:00:00Z"))).toBeUndefined();
    expect(await takePendingFocus("42", now)).toBeUndefined();
  });
  it("lists only open items still in each repo's last-read NEXT.md", async () => {
    await openNextItems();
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain("JOIN next_files f ON f.repo = i.repo AND f.run_id = i.last_run_id");
    expect(sql).toContain("i.state = 'open' AND f.sha IS NOT NULL");
  });
});
