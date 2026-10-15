import { beforeEach, describe, expect, it, vi } from "vitest";
import { daysAgo, snap } from "./fixtures.js";

const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool }));
import { storeSnapshots } from "../src/store.js";

describe("issue activity events", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    pool.query.mockResolvedValue({ rows: [{ id: 42 }] });
  });
  it("keeps opened issues, closures and comments under separate conflict keys", async () => {
    const url = "https://github.com/me/demo/issues/8";
    const opened = { number: 8, title: "title", url, createdAt: daysAgo(1) };
    const closed = { number: 8, title: "title", url, closedAt: daysAgo(1) };
    const comment = { id: 99, issueNumber: 8, issueTitle: "title", isPr: false, author: "tendai", url: `${url}#issuecomment-99`, createdAt: daysAgo(1), mine: false };
    await storeSnapshots(7, [snap({ newIssues: [opened], closedIssues: [closed], comments: [comment] })]);
    const events = pool.query.mock.calls.slice(1).map(([, params]) => params);
    expect(events).toEqual([
      [42, "issue", "8", "title", url, opened.createdAt, JSON.stringify(opened), 7],
      [42, "issue_closed", "8", "title", url, closed.closedAt, JSON.stringify(closed), 7],
      [42, "issue_comment", "99", "title", comment.url, comment.createdAt, JSON.stringify(comment), 7],
    ]);
    expect(pool.query.mock.calls[1][0]).toContain("ON CONFLICT (repo_id, type, ref)");
  });
});
