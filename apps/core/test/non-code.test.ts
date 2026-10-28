import { beforeEach, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

const m = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn(), edit: vi.fn(), pendingFocus: vi.fn(), insertFocus: vi.fn(),
  features: { focusButtons: false, eveningCheckIn: true },
}));
vi.mock("../src/db.js", () => ({ pool: { query: m.query, connect: async () => ({ query: m.query, release: vi.fn() }) } }));
vi.mock("../src/checkin-config.js", () => ({ cutoff: "23:59" }));
vi.mock("../src/env.js", () => ({ env: { repos: ["me/Case-AI"], telegramChatId: "42", apiKey: "k" } }));
vi.mock("../src/features.js", () => ({ features: m.features }));
vi.mock("../src/telegram.js", () => ({ sendMessage: m.send, editMessageText: m.edit }));
vi.mock("../src/store.js", () => ({ takePendingFocus: m.pendingFocus, insertFocus: m.insertFocus }));
vi.mock("../src/pipeline.js", () => ({ runBrief: vi.fn(), BusyError: class extends Error {} }));
import { parseLog, logsInWindow } from "../src/logs.js";
import { onCallbackQuery, onTextMessage } from "../src/telegram-handlers.js";
import { parseCheckinCallback } from "../src/checkin.js";
import { app } from "../src/app.js";
import { yesterdayWindow } from "../src/time.js";

const now = DateTime.fromISO("2026-10-27T21:30:00Z");
const message = (text: string) => ({ message_id: 9, chat: { id: 42 }, date: 0, text });
const tap = (answer: string) => ({ id: "cb", from: { id: 42 }, message: { message_id: 9, chat: { id: 42 } }, data: `c:7:${answer}` });
const post = (key = "k") => app.request("/checkin", { method: "POST", headers: { "x-case-key": key } });

beforeEach(() => {
  vi.resetAllMocks();
  m.features.focusButtons = false;
  m.features.eveningCheckIn = true;
  m.query.mockResolvedValue({ rows: [] });
  m.send.mockResolvedValue({ message_id: 9 });
  m.edit.mockResolvedValue(true);
});

it.each([
  ["#DOT pitch edits", "pitch edits", "dot"],
  ["pitch edits #DOT", "pitch edits", "dot"],
  ["#case-ai pitch edits", "pitch edits", "Case-AI"],
  ["#one pitch #two", "pitch #two", "one"],
  ["pitch #one edits #two", "pitch #one edits", "two"],
  ["#dot", "", "dot"],
  ["pitch #dot edits", "pitch #dot edits", null],
])("parses %s", (input, text, tag) => expect(parseLog(input)).toEqual({ text, tag }));

it("logs with all flags off, using the Harare date and escaped confirmation", async () => {
  m.features.eveningCheckIn = false;
  await onTextMessage(message("/log #DOT <pitch> edits"), now.plus({ hours: 1 }));
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO core.activity_logs"), ["2026-10-28", "<pitch> edits", "dot", "command", null]);
  expect(m.send).toHaveBeenCalledWith("Logged: &lt;pitch&gt; edits (#dot)");
});

it.each(["/log", "/log #dot", `/log ${"x".repeat(500)}`])("does not store invalid input %s", async (text) => {
  await onTextMessage(message(text), now);
  expect(m.query).not.toHaveBeenCalled();
  expect(m.send).toHaveBeenCalledOnce();
});

it("accepts 499 characters", async () => {
  await onTextMessage(message(`/log ${"x".repeat(499)}`), now);
  expect(m.query).toHaveBeenCalledOnce();
});

it("undoes only the latest log today, or says there is nothing", async () => {
  m.query.mockResolvedValueOnce({ rows: [{ text: "pitch edits", tag: "dot" }] });
  await onTextMessage(message("/undo"), now);
  expect(m.query).toHaveBeenCalledWith(expect.stringMatching(/WHERE date=\$1 ORDER BY created_at DESC, id DESC LIMIT 1/), ["2026-10-27"]);
  expect(m.send).toHaveBeenLastCalledWith("Removed: pitch edits (#dot)");
  await onTextMessage(message("/undo"), now);
  expect(m.send).toHaveBeenLastCalledWith("Nothing to undo today.");
});

it("uses Harare calendar dates to load the recap logs", async () => {
  await logsInWindow(yesterdayWindow(now));
  expect(m.query).toHaveBeenCalledWith(expect.any(String), ["2026-10-26", "2026-10-27"]);
});

it("protects /checkin with the API key", async () => {
  expect((await post("wrong")).status).toBe(401);
  expect(m.query).not.toHaveBeenCalled();
});

it("returns off and ignores taps and pending replies when disabled", async () => {
  m.features.eveningCheckIn = false;
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sent: false, reason: "off" });
  await onCallbackQuery(tap("done"), now);
  await onTextMessage(message("hello"), now);
  expect(m.query).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
});

it("sends today's focus and answer buttons", async () => {
  m.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM core.checkins")
    ? [{ id: "3", focus_id: "7", kind: "focus", status: "pending" }]
    : sql.startsWith("SELECT id, item_text") || sql.startsWith("SELECT item_text")
      ? [{ id: "7", item_text: "Long pitch text", short_label: "Pitch" }] : [] }));
  expect(await (await post()).json()).toEqual({ sent: true });
  expect(m.query.mock.calls[1][0]).toContain("status IN ('active','done')");
  expect(m.send).toHaveBeenCalledWith("How did Pitch go?", { inline_keyboard: [[
    { text: "Done", callback_data: "c:3:done" }, { text: "Partly", callback_data: "c:3:partly" }, { text: "Didn't touch it", callback_data: "c:3:none" },
  ]] });
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("telegram_message_id=$3"), ["3", expect.any(Date), 9]);
});

it("sends an open question without focus and no keyboard", async () => {
  m.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM core.checkins")
    ? [{ id: "3", kind: "open", status: "pending", focus_id: null }] : [] }));
  expect(await (await post()).json()).toEqual({ sent: true });
  expect(m.send).toHaveBeenCalledWith("Anything worth logging from today? Just reply.");
});

it.each(["done", "partly", "none"])("records %s on both the focus and check-in", async (answer) => {
  m.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM core.checkins")
    ? [{ id: "7", date: "2026-10-27", focus_id: "12" }] : sql.startsWith("UPDATE core.focus") ? [{ item_text: "Pitch" }] : [] }));
  await onCallbackQuery(tap(answer), now);
  expect(m.query.mock.calls[2][1]).toEqual(["12", answer, now.toJSDate(), "2026-10-27"]);
  expect(m.query.mock.calls[3][1]).toEqual(["7", answer, now.toJSDate()]);
  expect(m.query.mock.calls[4][0]).toBe("COMMIT");
  expect(m.edit).toHaveBeenCalledWith(9, expect.stringContaining(answer === "done" ? "Anything else from today?" : "What got in the way?"));
});

it("ignores malformed callbacks and does not reopen expired check-ins", async () => {
  expect(parseCheckinCallback("c:7:other")).toBeUndefined();
  expect(await onCallbackQuery(tap("done"), now)).toEqual({ answerText: "That check-in has expired." });
  expect(m.query).toHaveBeenCalledTimes(3);
  expect(m.edit).not.toHaveBeenCalled();
});

it("keeps pending state for multiple replies and ignores commands", async () => {
  m.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM core.checkins") ? [{ id: "3", focus_id: "7", answer: null }] : [] }));
  await onTextMessage(message("#DOT first"), now);
  await onTextMessage(message("second"), now);
  await onTextMessage(message("/brief"), now);
  expect(m.query).toHaveBeenCalledTimes(4);
  expect(m.query.mock.calls[0][0]).toContain("date=$1 AND sent_at IS NOT NULL");
  expect(m.query.mock.calls[1][1]).toEqual(["2026-10-27", "first", "dot", "checkin", "7"]);
  expect(m.send.mock.calls).toEqual([["Logged."], ["Logged."]]);
});

it("lets focus pending win and ignores replies with no live pending state", async () => {
  m.features.focusButtons = true;
  m.pendingFocus.mockResolvedValueOnce({ briefId: 3 });
  await onTextMessage(message("Focus"), now);
  expect(m.insertFocus).toHaveBeenCalledOnce();
  expect(m.query).not.toHaveBeenCalled();
  m.send.mockClear();
  await onTextMessage(message("Nothing pending"), now);
  expect(m.send).not.toHaveBeenCalled();
});

it.each(["pause", "unpause"])("gates /%s behind eveningCheckIn", async (name) => {
  m.features.eveningCheckIn = false;
  await onTextMessage(message(`/${name}`), now);
  expect(m.query).not.toHaveBeenCalled();
  expect(m.send).toHaveBeenCalledWith(expect.stringContaining("features.eveningCheckIn"));
});

it("returns HTTP 500 when Telegram delivery fails", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  m.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM core.checkins")
    ? [{ id: "3", kind: "open", status: "pending", focus_id: null }] : [] }));
  m.send.mockRejectedValueOnce(new Error("offline"));
  expect((await post()).status).toBe(500);
  expect(m.query.mock.calls.some(([sql]) => sql.includes("status='sent'"))).toBe(false);
  error.mockRestore();
});
