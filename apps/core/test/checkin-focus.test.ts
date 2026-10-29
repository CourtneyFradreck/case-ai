import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DateTime } from "luxon";

const mocks = vi.hoisted(() => ({ query: vi.fn(), edit: vi.fn(), send: vi.fn(), connect: vi.fn(), release: vi.fn() }));
vi.mock("../src/repos.js", () => ({ knownRepos: async () => ["me/demo"] }));
vi.mock("../src/db.js", () => ({ pool: { query: mocks.query, connect: mocks.connect } }));
vi.mock("../src/env.js", () => ({ env: { repos: ["me/demo"], telegramChatId: "42" } }));
vi.mock("../src/features.js", () => ({ features: { eveningCheckIn: true } }));
vi.mock("../src/telegram.js", () => ({ sendMessage: mocks.send, editMessageText: mocks.edit }));
import { completedFocusIds, onCheckinCallback, onCheckinText, onPauseCommand, runCheckin } from "../src/checkin.js";
import { getFocus, setFocusStatus } from "../src/store.js";
import { yesterdayFocus } from "../src/focus.js";
import { nextItems } from "../src/intent/rules.js";
import { parseNext } from "../src/intent/parse.js";
import { render } from "../src/render.js";
import { yesterdayWindow } from "../src/time.js";
import { snap } from "./fixtures.js";
import { checkinCutoff } from "../src/checkin-config.js";

const now = DateTime.fromISO("2026-10-27T19:00:00Z");
const date = "2026-10-27";
const items = parseNext("me/demo", "- [ ] Switch to CASE_BRIEF_MODE=all");
const findingId = `next_${items[0].id}`;
let db: DatabaseSync;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.edit.mockResolvedValue(true);
  mocks.send.mockResolvedValue({ message_id: 99 });
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  // Execute the production queries against SQL, rather than simulating their state transitions.
  db = new DatabaseSync(":memory:");
  db.exec(`ATTACH DATABASE ':memory:' AS core;
    CREATE TABLE core.focus (id INTEGER PRIMARY KEY, date TEXT, item_text TEXT, short_label TEXT,
      repo TEXT, finding_id TEXT, created_at TEXT, status TEXT, status_until TEXT, checkin TEXT, checkin_at TEXT);
    CREATE TABLE core.checkins (id INTEGER PRIMARY KEY, date TEXT UNIQUE, focus_id INTEGER, kind TEXT,
      status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, sent_at TEXT, telegram_message_id INTEGER,
      answer TEXT, answered_at TEXT, reason TEXT, expires_at TEXT);
    CREATE TABLE core.pauses (start_date TEXT, end_date TEXT);
    CREATE TABLE core.activity_logs (id INTEGER PRIMARY KEY, date TEXT, text TEXT, tag TEXT, via TEXT, focus_id INTEGER);`);
  db.prepare(`INSERT INTO core.checkins (id, date, focus_id, kind, status, telegram_message_id, sent_at, expires_at)
    VALUES (3, ?, 7, 'focus', 'sent', 9, ?, ?)`).run(date, now.toISO(), "2026-10-28T10:00:00.000Z");
  db.prepare(`INSERT INTO core.focus (id, date, item_text, repo, finding_id, created_at, status)
    VALUES (7, ?, ?, 'me/demo', ?, ?, 'active')`).run(date, items[0].text, findingId, now.toISO());
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("pg_advisory_")) return { rows: [] };
    const bindings: SQLInputValue[] = [];
    const adapted = sql.replace(/ FOR UPDATE/g, "").replace(/\$(\d+)/g, (_, n: string) => {
      const value = params[Number(n) - 1];
      bindings.push(value instanceof Date ? value.toISOString() : value as SQLInputValue);
      return "?";
    });
    return { rows: db.prepare(adapted).all(...bindings).map((row) => ({ ...row,
      ...(row.created_at ? { created_at: new Date(String(row.created_at)) } : {}),
    })) };
  });
});
afterEach(() => db.close());

const answer = (value: string) => onCheckinCallback({ id: "cb", from: { id: 42 },
  message: { message_id: 9, chat: { id: 42 } }, data: `c:3:${value}` }, now);
const row = () => db.prepare("SELECT * FROM core.focus WHERE id=7").get();

it.each(["partly", "none"])("Done then %s reopens the focus and removes completion", async (value) => {
  await setFocusStatus(date, "done", null, now.minus({ hours: 8 }).toJSDate());
  expect(row()).toMatchObject({ status: "done", checkin: null, checkin_at: null });
  await answer(value);
  expect(row()).toMatchObject({ status: "active", checkin: value });
  const completed = await completedFocusIds();
  expect(completed.has(findingId)).toBe(false);
  const findings = nextItems(snap(), { status: "ok", sha: "a", url: "https://github.com/me/demo/NEXT.md", lastChangedAt: null, items }, completed);
  const w = yesterdayWindow(now.plus({ days: 1 }));
  const previousFocus = yesterdayFocus(await getFocus(date), [], { since: w.start, label: "yesterday" });
  const text = render(findings, [], w, 3800, undefined, { previousFocus });
  expect(text).not.toContain("You marked");
  expect(text).toContain(`You picked: Switch to CASE_BRIEF_MODE=all, ${value === "partly" ? "partly done" : "didn't get to it"}`);
});

it("Partly then the Done button completes the focus and refreshes its check-in time", async () => {
  await answer("partly");
  const later = now.plus({ minutes: 30 }).toJSDate();
  await setFocusStatus(date, "done", null, later);
  expect(row()).toMatchObject({ status: "done", checkin: "done", checkin_at: later.toISOString() });
  expect(record()).toMatchObject({ answer: "done", answered_at: later.toISOString() });
  expect(await completedFocusIds()).toEqual(new Set([findingId]));
});

it("Done then Done remains completed", async () => {
  await setFocusStatus(date, "done", null, now.toJSDate());
  await answer("done");
  expect(row()).toMatchObject({ status: "done", checkin: "done" });
  expect(await completedFocusIds()).toEqual(new Set([findingId]));
});

it.each(["done", "partly", "none"])("leaves a snoozed focus untouched for %s", async (value) => {
  await answer("partly");
  await setFocusStatus(date, "snoozed", now.plus({ days: 3 }).toJSDate());
  const before = row();
  mocks.edit.mockClear();
  expect(await answer(value)).toEqual({ answerText: "That check-in has expired." });
  expect(row()).toEqual(before);
  expect(mocks.edit).not.toHaveBeenCalled();
});

it.each(["partly", "none"])("lets a stored %s check-in override a legacy done status", async (value) => {
  db.prepare("UPDATE core.focus SET status='done', checkin=?").run(value);
  expect(await completedFocusIds()).toEqual(new Set());
});

const record = () => db.prepare("SELECT * FROM core.checkins WHERE date=?").get(date);
it("sends once across duplicate calls", async () => {
  db.exec("DELETE FROM core.checkins");
  expect(await runCheckin(now)).toEqual({ sent: true });
  expect(await runCheckin(now)).toEqual({ sent: false, reason: "sent" });
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(record()).toMatchObject({ attempts: 1, status: "sent", telegram_message_id: 99 });
  expect(mocks.send.mock.calls[0][1].inline_keyboard[0][0].callback_data).toBe("c:1:done");
});

it("serializes overlapping sends before reading the daily record", async () => {
  db.exec("DELETE FROM core.checkins");
  let tail = Promise.resolve();
  mocks.connect.mockImplementation(async () => {
    let unlock: () => void;
    return { release: mocks.release, query: async (sql: string, params: unknown[]) => {
      if (sql === "SELECT pg_advisory_lock(778)") {
        const previous = tail;
        tail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        return { rows: [] };
      }
      if (sql === "SELECT pg_advisory_unlock(778)") { unlock!(); return { rows: [] }; }
      return mocks.query(sql, params);
    } };
  });
  expect(await Promise.all([runCheckin(now), runCheckin(now)])).toEqual([
    { sent: true }, { sent: false, reason: "sent" },
  ]);
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(record()).toMatchObject({ attempts: 1 });
});

it("keeps a failed send pending and retries successfully", async () => {
  db.exec("DELETE FROM core.checkins");
  mocks.send.mockRejectedValueOnce(new Error("offline"));
  await expect(runCheckin(now)).rejects.toThrow("offline");
  expect(record()).toMatchObject({ attempts: 1, status: "pending", sent_at: null });
  expect(await runCheckin(now.plus({ minutes: 15 }))).toEqual({ sent: true });
  expect(await runCheckin(now.plus({ minutes: 30 }))).toEqual({ sent: false, reason: "sent" });
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(record()).toMatchObject({ attempts: 2, status: "sent" });
});

it("skips after the Harare cutoff and creates a new row the next day", async () => {
  db.exec("DELETE FROM core.checkins");
  expect(await runCheckin(now.plus({ hours: 2 }))).toEqual({ sent: false, reason: "skipped" });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(record()).toMatchObject({ attempts: 0, status: "skipped" });
  expect(await runCheckin(now.plus({ days: 1 }))).toEqual({ sent: true });
  expect(record()).toMatchObject({ status: "skipped" });
  expect(db.prepare("SELECT COUNT(*) AS n FROM core.checkins").get()).toMatchObject({ n: 2 });
});

it("pauses inclusive days and lets unpause restore today's send", async () => {
  db.exec("DELETE FROM core.checkins");
  await onPauseCommand("pause", "3", now);
  expect(mocks.send).toHaveBeenLastCalledWith("Evening check-ins paused through 2026-10-29 (inclusive).");
  mocks.send.mockClear();
  expect(await runCheckin(now)).toEqual({ sent: false, reason: "paused" });
  expect(await runCheckin(now.plus({ days: 2 }))).toEqual({ sent: false, reason: "paused" });
  expect(mocks.send).not.toHaveBeenCalled();
  await onPauseCommand("unpause", "", now);
  expect(await runCheckin(now)).toEqual({ sent: true });
});

it.each(["0", "31", "-1", "1.5", "abc"])("rejects invalid pause duration %s", async (arg) => {
  await onPauseCommand("pause", arg, now);
  expect(db.prepare("SELECT * FROM core.pauses").all()).toEqual([]);
});

it("applies a late button to the original day and focus until noon", async () => {
  const tap = { id: "late", from: { id: 42 }, message: { message_id: 9, chat: { id: 42 } }, data: "c:3:partly" };
  const late = DateTime.fromISO("2026-10-28T07:00:00Z");
  expect(await onCheckinCallback(tap, late)).toEqual({ answerText: "Recorded" });
  expect(row()).toMatchObject({ date, checkin: "partly" });
  expect(record()).toMatchObject({ date, answer: "partly", answered_at: late.toJSDate().toISOString() });
  expect(await onCheckinCallback({ ...tap, data: "c:3:done" }, late.plus({ hours: 3 }))).toEqual({ answerText: "That check-in has expired." });
  await onCheckinText("42", "too late for a log", late);
  expect(db.prepare("SELECT * FROM core.activity_logs").all()).toEqual([]);
});

it.each(["partly", "none"])("stores the first %s reply as why, then logs with focus_id", async (value) => {
  await answer(value);
  expect(mocks.edit).toHaveBeenLastCalledWith(9, expect.stringContaining("What got in the way? (optional, just reply)"));
  await onCheckinText("42", "Meetings", now);
  expect(record()).toMatchObject({ reason: "Meetings" });
  expect(db.prepare("SELECT * FROM core.activity_logs").all()).toEqual([]);
  await onCheckinText("42", "Wrote notes", now);
  expect(db.prepare("SELECT * FROM core.activity_logs").get()).toMatchObject({ text: "Wrote notes", focus_id: 7 });
});

it("does not ask why after Done and logs its first reply", async () => {
  await answer("done");
  expect(mocks.edit.mock.calls[0][1]).not.toContain("What got in the way");
  await onCheckinText("42", "Shipped", now);
  expect(record()).toMatchObject({ reason: null });
  expect(db.prepare("SELECT * FROM core.activity_logs").get()).toMatchObject({ text: "Shipped", focus_id: 7 });
});

it("rolls back the focus answer if writing the check-in record fails", async () => {
  db.exec("CREATE TRIGGER core.fail_answer BEFORE UPDATE OF answer ON checkins BEGIN SELECT RAISE(ABORT, 'failed'); END");
  await expect(answer("done")).rejects.toThrow("failed");
  expect(row()).toMatchObject({ status: "active", checkin: null });
  expect(record()).toMatchObject({ answer: null });
  expect(mocks.edit).not.toHaveBeenCalled();
});

it("defaults and validates the cutoff", () => {
  expect(checkinCutoff({})).toBe("22:00");
  expect(checkinCutoff({ eveningCheckIn: { cutoff: "21:30" } })).toBe("21:30");
  expect(() => checkinCutoff({ eveningCheckIn: { cutoff: "25:00" } })).toThrow("HH:mm");
});

it("rejects a button from another message even if its id matches a new record", async () => {
  expect(await onCheckinCallback({ id: "old", from: { id: 42 },
    message: { message_id: 8, chat: { id: 42 } }, data: "c:3:done" }, now))
    .toEqual({ answerText: "That check-in has expired." });
  expect(record()).toMatchObject({ answer: null });
  expect(row()).toMatchObject({ checkin: null });
});
