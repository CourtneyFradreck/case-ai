import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

const m = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn(), features: { focusButtons: false, snooze: false, eveningCheckIn: false } }));
vi.mock("../src/repos.js", () => ({ knownRepos: async () => [] }));
vi.mock("../src/db.js", () => ({ pool: { query: m.query } }));
vi.mock("../src/env.js", () => ({ env: { repos: [], telegramChatId: "42" } }));
vi.mock("../src/features.js", () => ({ features: m.features }));
vi.mock("../src/telegram.js", () => ({ sendMessage: m.send, editMessageText: vi.fn(), editMessageReplyMarkup: vi.fn() }));
vi.mock("../src/store.js", () => ({ takePendingFocus: vi.fn(), insertFocus: vi.fn() }));
import { onTextMessage } from "../src/telegram-handlers.js";

// 09:00 in Harare on Tue 3 Nov.
const NOW = DateTime.fromISO("2026-11-03T07:00:00Z");
const message = (text: string, replyTo?: number) => ({ message_id: 9, chat: { id: 42 }, date: 0, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) });
// 07:00 Mon 2 Nov and 07:00 Tue 3 Nov, Harare time.
const MONDAY = { id: "70", created_at: new Date("2026-11-02T05:00:00Z") };
const TUESDAY = { id: "71", created_at: new Date("2026-11-03T05:00:00Z") };

const inserts = () => m.query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO core.feedback"));

beforeEach(() => {
  vi.resetAllMocks();
  m.query.mockResolvedValue({ rows: [] });
  m.send.mockResolvedValue({ message_id: 10 });
});

describe("/wrong and /missed", () => {
  it("links the brief replied to", async () => {
    m.query.mockResolvedValueOnce({ rows: [MONDAY] });
    await onTextMessage(message("/wrong CI wasn't failing", 555), NOW);
    expect(m.query.mock.calls[0]).toEqual(["SELECT id, created_at FROM briefs WHERE telegram_message_id=$1 ORDER BY id DESC LIMIT 1", [555]]);
    expect(inserts()).toEqual([["INSERT INTO core.feedback(kind, text, brief_id) VALUES ($1,$2,$3)", ["wrong", "CI wasn't failing", "70"]]]);
    expect(m.send).toHaveBeenCalledWith("Noted: CI wasn't failing (brief of Mon 2 Nov)");
  });
  it("falls back to the latest delivered brief when the reply isn't to a brief", async () => {
    m.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [TUESDAY] });
    await onTextMessage(message("/missed the taga PR review", 999), NOW);
    expect(m.query.mock.calls[1][0]).toBe("SELECT id, created_at FROM briefs WHERE telegram_message_id IS NOT NULL ORDER BY id DESC LIMIT 1");
    expect(inserts()[0][1]).toEqual(["missed", "the taga PR review", "71"]);
    expect(m.send).toHaveBeenCalledWith("Noted: the taga PR review (brief of Tue 3 Nov)");
  });
  it("uses the latest delivered brief when not a reply", async () => {
    m.query.mockResolvedValueOnce({ rows: [TUESDAY] });
    await onTextMessage(message("/missed@case_bot the taga PR review"), NOW);
    expect(m.query.mock.calls[0][0]).toContain("telegram_message_id IS NOT NULL");
    expect(inserts()[0][1]).toEqual(["missed", "the taga PR review", "71"]);
  });
  it("stores a NULL brief when no brief has been delivered", async () => {
    await onTextMessage(message("/wrong streak count <3>"), NOW);
    expect(inserts()[0][1]).toEqual(["wrong", "streak count <3>", null]);
    expect(m.send).toHaveBeenCalledWith("Noted: streak count &lt;3&gt;");
  });
  it.each(["/wrong", "/missed   "])("shows usage and stores nothing for %j", async (text) => {
    await onTextMessage(message(text), NOW);
    expect(m.query).not.toHaveBeenCalled();
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).toMatch(/^Use \/(wrong|missed) </);
  });
  it("accepts 500 characters and rejects 501", async () => {
    await onTextMessage(message(`/wrong ${"x".repeat(501)}`), NOW);
    expect(m.query).not.toHaveBeenCalled();
    expect(m.send).toHaveBeenCalledWith("Keep feedback to 500 characters.");
    await onTextMessage(message(`/wrong ${"x".repeat(500)}`), NOW);
    expect(inserts()).toHaveLength(1);
  });
  it("works with every feature flag off", async () => {
    await onTextMessage(message("/wrong something"), NOW);
    expect(inserts()).toHaveLength(1);
  });
});

describe("/feedback", () => {
  it("lists the last 10 unresolved entries, newest first", async () => {
    m.query.mockResolvedValueOnce({ rows: [
      { id: "12", kind: "missed", text: "the taga PR review", created_at: new Date("2026-11-03T06:00:00Z") },
      { id: "11", kind: "wrong", text: "CI   wasn't\nfailing", created_at: new Date("2026-11-02T21:30:00Z") },
    ] });
    await onTextMessage(message("/feedback"), NOW);
    const [sql, params] = m.query.mock.calls[0];
    expect(sql).toContain("WHERE resolved_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $1");
    expect(params).toEqual([10]);
    // 21:30 UTC on 2 Nov is 23:30 in Harare, still 2 Nov.
    expect(m.send).toHaveBeenCalledWith(
      "#12 missed · 3 Nov: the taga PR review\n#11 wrong · 2 Nov: CI wasn't failing\n\nSend /feedback done <id> to resolve one.");
  });
  it("says when nothing is open", async () => {
    await onTextMessage(message("/feedback"), NOW);
    expect(m.send).toHaveBeenCalledWith("No open feedback.");
  });
  it("resolves an entry by id", async () => {
    m.query.mockResolvedValueOnce({ rows: [{ id: "12" }] });
    await onTextMessage(message("/feedback done 12"), NOW);
    expect(m.query).toHaveBeenCalledWith("UPDATE core.feedback SET resolved_at=COALESCE(resolved_at, $2) WHERE id=$1 RETURNING id", ["12", NOW.toJSDate()]);
    expect(m.send).toHaveBeenCalledWith("Resolved #12.");
  });
  it("errors on an unknown id", async () => {
    await onTextMessage(message("/feedback done 404"), NOW);
    expect(m.send).toHaveBeenCalledWith("No feedback #404.");
  });
  it("shows usage for anything else", async () => {
    await onTextMessage(message("/feedback done abc"), NOW);
    expect(m.query).not.toHaveBeenCalled();
    expect(m.send).toHaveBeenCalledWith("Use /feedback to list open feedback, or /feedback done <id>.");
  });
});
