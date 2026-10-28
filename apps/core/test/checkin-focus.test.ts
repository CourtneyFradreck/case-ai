import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DateTime } from "luxon";

const mocks = vi.hoisted(() => ({ query: vi.fn(), edit: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool: { query: mocks.query } }));
vi.mock("../src/env.js", () => ({ env: { repos: ["me/demo"], telegramChatId: "42" } }));
vi.mock("../src/features.js", () => ({ features: { eveningCheckIn: true } }));
vi.mock("../src/telegram.js", () => ({ sendMessage: vi.fn(), editMessageText: mocks.edit }));
import { completedFocusIds, onCheckinCallback } from "../src/checkin.js";
import { getFocus, setFocusStatus } from "../src/store.js";
import { yesterdayFocus } from "../src/focus.js";
import { nextItems } from "../src/intent/rules.js";
import { parseNext } from "../src/intent/parse.js";
import { render } from "../src/render.js";
import { yesterdayWindow } from "../src/time.js";
import { snap } from "./fixtures.js";

const now = DateTime.fromISO("2026-10-27T19:00:00Z");
const date = "2026-10-27";
const items = parseNext("me/demo", "- [ ] Switch to CASE_BRIEF_MODE=all");
const findingId = `next_${items[0].id}`;
let db: DatabaseSync;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.edit.mockResolvedValue(true);
  // Execute the production queries against SQL, rather than simulating their state transitions.
  db = new DatabaseSync(":memory:");
  db.exec(`ATTACH DATABASE ':memory:' AS core;
    CREATE TABLE core.focus (id INTEGER PRIMARY KEY, date TEXT, item_text TEXT, short_label TEXT,
      repo TEXT, finding_id TEXT, created_at TEXT, status TEXT, status_until TEXT, checkin TEXT, checkin_at TEXT);
    CREATE TABLE core.checkin_pending (chat_id TEXT PRIMARY KEY, expires_at TEXT);`);
  db.prepare(`INSERT INTO core.focus (id, date, item_text, repo, finding_id, created_at, status)
    VALUES (7, ?, ?, 'me/demo', ?, ?, 'active')`).run(date, items[0].text, findingId, now.toISO());
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const bindings: SQLInputValue[] = [];
    const adapted = sql.replace(/\$(\d+)/g, (_, n: string) => {
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
  message: { message_id: 9, chat: { id: 42 } }, data: `c:7:${value}` }, now);
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
