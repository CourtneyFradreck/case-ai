import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

const mocks = vi.hoisted(() => ({
  env: { telegramChatId: "42", repos: ["me/demo", "me/other"] },
  features: { focusButtons: true, snooze: false },
  sendMessage: vi.fn(), editMessageReplyMarkup: vi.fn(), editMessageText: vi.fn(),
  getBriefFocus: vi.fn(), getFocus: vi.fn(), insertFocus: vi.fn(), openNextItems: vi.fn(), setPendingFocus: vi.fn(), takePendingFocus: vi.fn(),
  getBriefSnoozable: vi.fn(), upsertSnooze: vi.fn(), listSnoozes: vi.fn(), deleteSnooze: vi.fn(),
}));
vi.mock("../src/env.js", () => ({ env: mocks.env }));
vi.mock("../src/features.js", () => ({ features: mocks.features }));
vi.mock("../src/telegram.js", () => ({ sendMessage: mocks.sendMessage, editMessageReplyMarkup: mocks.editMessageReplyMarkup, editMessageText: mocks.editMessageText }));
vi.mock("../src/store.js", () => ({
  getBriefFocus: mocks.getBriefFocus, getFocus: mocks.getFocus, insertFocus: mocks.insertFocus, openNextItems: mocks.openNextItems,
  setPendingFocus: mocks.setPendingFocus, takePendingFocus: mocks.takePendingFocus,
  getBriefSnoozable: mocks.getBriefSnoozable, upsertSnooze: mocks.upsertSnooze, listSnoozes: mocks.listSnoozes, deleteSnooze: mocks.deleteSnooze,
}));
import { onCallbackQuery, onTextMessage } from "../src/telegram-handlers.js";

// 23:30 in Harare on Wed 14 Oct; midnight is 22:00 UTC.
const NOW = DateTime.fromISO("2026-10-14T21:30:00Z");
const MIDNIGHT = new Date("2026-10-14T22:00:00Z");
const focus = [
  { text: "Fix CI", reason: "CI is failing", findingId: "ci", repo: "me/demo" },
  { text: "Ship the parser", reason: "Open in NEXT.md", findingId: "next_abc", repo: "me/demo" },
];
const message = (text: string) => ({ message_id: 9, chat: { id: 42 }, date: 0, text });
const tap = (data: string) => ({ id: "cb1", from: { id: 42 }, message: { message_id: 555, chat: { id: 42 } }, data });

describe("focus button taps", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.features.focusButtons = true;
    mocks.getBriefFocus.mockResolvedValue({ focus, created_at: new Date("2026-10-14T05:00:00Z"), telegram_message_id: "555" });
    mocks.editMessageReplyMarkup.mockResolvedValue(true);
  });

  it("stores the chosen suggestion from the stored brief and shows the choice", async () => {
    expect(await onCallbackQuery(tap("f:70:2"), NOW)).toEqual({ answerText: "Focus set: Ship the parser" });
    expect(mocks.getBriefFocus).toHaveBeenCalledWith(70);
    expect(mocks.insertFocus).toHaveBeenCalledWith({ date: "2026-10-14", text: "Ship the parser", findingId: "next_abc", repo: "me/demo", via: "button", briefId: 70 });
    expect(mocks.editMessageReplyMarkup).toHaveBeenCalledWith(555, { inline_keyboard: [[{ text: "Focus: Ship the parser", callback_data: "f:70:ok" }]] });
    expect(mocks.takePendingFocus).toHaveBeenCalledWith("42");
  });
  it("keeps the stored focus when editing the keyboard fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.editMessageReplyMarkup.mockRejectedValue(new Error("Telegram editMessageReplyMarkup failed (400)"));
    expect(await onCallbackQuery(tap("f:70:1"), NOW)).toEqual({ answerText: "Focus set: Fix CI" });
    expect(mocks.insertFocus).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
  it("asks for the focus and stores a pending state until midnight in Harare on Something else", async () => {
    await onCallbackQuery(tap("f:70:x"), NOW);
    expect(mocks.setPendingFocus).toHaveBeenCalledWith("42", 70, MIDNIGHT);
    expect(mocks.sendMessage).toHaveBeenCalledWith("What's your focus today? Reply with a short message.");
    expect(mocks.insertFocus).not.toHaveBeenCalled();
  });
  it("answers the chosen button with today's focus", async () => {
    mocks.getFocus.mockResolvedValue({ item_text: "Fix CI", repo: "me/demo", finding_id: "ci", created_at: new Date() });
    expect(await onCallbackQuery(tap("f:70:ok"), NOW)).toEqual({ answerText: "Focus: Fix CI" });
    expect(mocks.getFocus).toHaveBeenCalledWith("2026-10-14");
    expect(mocks.insertFocus).not.toHaveBeenCalled();
  });
  it("refuses a suggestion number the brief doesn't have", async () => {
    expect(await onCallbackQuery(tap("f:70:3"), NOW)).toEqual({ answerText: "That suggestion isn't on this brief." });
    expect(mocks.insertFocus).not.toHaveBeenCalled();
  });
  it("refuses taps on an earlier day's brief", async () => {
    mocks.getBriefFocus.mockResolvedValue({ focus, created_at: new Date("2026-10-13T21:59:00Z"), telegram_message_id: "555" });
    expect(await onCallbackQuery(tap("f:70:1"), NOW)).toMatchObject({ answerText: expect.stringContaining("earlier day") });
    expect(mocks.insertFocus).not.toHaveBeenCalled();
  });
  it("refuses a brief without stored suggestions", async () => {
    mocks.getBriefFocus.mockResolvedValue(undefined);
    expect(await onCallbackQuery(tap("f:71:1"), NOW)).toEqual({ answerText: "That brief has no suggestions." });
  });
  it.each(["focus:1", "f:70:1:x", ""])("ignores unrelated callback data %s", async (data) => {
    expect(await onCallbackQuery(tap(data), NOW)).toBeUndefined();
    expect(mocks.getBriefFocus).not.toHaveBeenCalled();
  });
  it("does nothing with focusButtons off", async () => {
    mocks.features.focusButtons = false;
    expect(await onCallbackQuery(tap("f:70:1"), NOW)).toBeUndefined();
    expect(mocks.getBriefFocus).not.toHaveBeenCalled();
    expect(mocks.insertFocus).not.toHaveBeenCalled();
  });
});

describe("focus text and commands", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.features.focusButtons = true;
  });

  it("turns the next plain message into the focus while one is pending", async () => {
    mocks.takePendingFocus.mockResolvedValue({ briefId: 70 });
    await onTextMessage(message("  Write the   <M4> plan\n"), NOW);
    expect(mocks.takePendingFocus).toHaveBeenCalledWith("42", NOW.toJSDate());
    expect(mocks.insertFocus).toHaveBeenCalledWith({ date: "2026-10-14", text: "Write the <M4> plan", findingId: null, repo: null, via: "text", briefId: 70 });
    expect(mocks.sendMessage).toHaveBeenCalledWith("Focus for today: Write the &lt;M4&gt; plan");
  });
  it("ignores plain messages with nothing pending, or once it has expired", async () => {
    mocks.takePendingFocus.mockResolvedValue(undefined);
    await onTextMessage(message("hello"), NOW);
    expect(mocks.insertFocus).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
  it("leaves the pending state for other commands such as /brief", async () => {
    await onTextMessage(message("/brief"), NOW);
    expect(mocks.takePendingFocus).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
  it("sets or replaces today's focus with /focus and clears a pending state", async () => {
    await onTextMessage(message("/focus@case_bot Review the backup restore"), NOW);
    expect(mocks.insertFocus).toHaveBeenCalledWith({ date: "2026-10-14", text: "Review the backup restore", findingId: null, repo: null, via: "command", briefId: null });
    expect(mocks.takePendingFocus).toHaveBeenCalledWith("42");
    expect(mocks.sendMessage).toHaveBeenCalledWith("Focus for today: Review the backup restore");
  });
  it("shows today's focus, or how to set one, for a bare /focus", async () => {
    mocks.getFocus.mockResolvedValueOnce({ item_text: "Fix <CI>", repo: null, finding_id: null, created_at: new Date() }).mockResolvedValueOnce(undefined);
    await onTextMessage(message("/focus"), NOW);
    await onTextMessage(message("/focus   "), NOW);
    expect(mocks.insertFocus).not.toHaveBeenCalled();
    expect(mocks.sendMessage.mock.calls).toEqual([["Today's focus: Fix &lt;CI&gt;"], ["No focus set for today. Send /focus followed by what you'll work on."]]);
  });
  it("replies to /next with open items for all tracked repos or one", async () => {
    mocks.openNextItems.mockResolvedValue([{ repo: "me/demo", text: "Ship the parser", section: "M3" }]);
    await onTextMessage(message("/next"), NOW);
    await onTextMessage(message("/next other"), NOW);
    expect(mocks.sendMessage.mock.calls).toEqual([
      ["<b>Open NEXT.md items</b>\n\n<b>demo</b>\n• Ship the parser <i>(M3)</i>"],
      ["No open NEXT.md items in me/other."],
    ]);
  });
  it("answers /focus and /next once each with focusButtons off, and ignores plain text", async () => {
    mocks.features.focusButtons = false;
    mocks.takePendingFocus.mockResolvedValue({ briefId: 70 });
    for (const text of ["/focus Ship it", "/next@case_bot demo", "Ship it"]) await onTextMessage(message(text), NOW);
    expect(mocks.sendMessage.mock.calls).toEqual([
      ["/focus isn't switched on yet. Turn on features.focusButtons in config.json."],
      ["/next isn't switched on yet. Turn on features.focusButtons in config.json."],
    ]);
    expect(mocks.insertFocus).not.toHaveBeenCalled();
    expect(mocks.openNextItems).not.toHaveBeenCalled();
    expect(mocks.takePendingFocus).not.toHaveBeenCalled();
  });
  it("still ignores other commands with every flag off", async () => {
    mocks.features.focusButtons = false;
    for (const text of ["/brief", "/constructor", "/start"]) await onTextMessage(message(text), NOW);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

describe("snooze taps and commands", () => {
  const items = [{ findingId: "pr", repo: "me/demo", text: 'PR #4 "<Retry>" idle' }, { findingId: "oi", repo: "me/demo", text: "3 open issues" }];
  const WED = DateTime.fromISO("2026-10-14T05:00:00Z");
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.features.focusButtons = false;
    mocks.features.snooze = true;
    mocks.getBriefSnoozable.mockResolvedValue(items);
    mocks.editMessageText.mockResolvedValue(true);
  });

  it("sends the list of snoozable items from the stored brief", async () => {
    expect(await onCallbackQuery(tap("s:70"), WED)).toBeUndefined();
    expect(mocks.getBriefSnoozable).toHaveBeenCalledWith(70);
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.stringContaining("1. PR #4"), { inline_keyboard: expect.arrayContaining([[
      { text: "1: 3 days", callback_data: "s:70:1:3" }, { text: "1: 7 days", callback_data: "s:70:1:7" },
    ]]) });
  });
  it("stores a snooze and confirms by editing the list message", async () => {
    expect(await onCallbackQuery(tap("s:70:2:7"), WED)).toEqual({ answerText: "Snoozed until Thu 22 Oct" });
    expect(mocks.upsertSnooze).toHaveBeenCalledWith("oi", "me/demo", new Date("2026-10-21T22:00:00Z"));
    expect(mocks.editMessageText).toHaveBeenCalledWith(555, "Snoozed until Thu 22 Oct: 3 open issues");
  });
  it("refuses unknown items and briefs with nothing to snooze", async () => {
    expect(await onCallbackQuery(tap("s:70:3:3"), WED)).toEqual({ answerText: "That item isn't on this list." });
    mocks.getBriefSnoozable.mockResolvedValue(undefined);
    expect(await onCallbackQuery(tap("s:71"), WED)).toEqual({ answerText: "That brief has nothing to snooze." });
    expect(mocks.upsertSnooze).not.toHaveBeenCalled();
  });
  it("lists and removes snoozes by number", async () => {
    const rows = [{ finding_id: "pr", repo: "me/demo", until: new Date("2026-10-17T22:00:00Z"), summary: "PR #4 idle" }];
    mocks.listSnoozes.mockResolvedValue(rows);
    await onTextMessage(message("/snoozed"), WED);
    await onTextMessage(message("/unsnooze 1"), WED);
    await onTextMessage(message("/unsnooze 2"), WED);
    await onTextMessage(message("/unsnooze"), WED);
    expect(mocks.listSnoozes).toHaveBeenCalledWith(WED.toJSDate());
    expect(mocks.deleteSnooze.mock.calls).toEqual([["pr"]]);
    expect(mocks.sendMessage.mock.calls.map(([t]) => t)).toEqual([
      expect.stringContaining("1. PR #4 idle (back Sun 18 Oct)"),
      "Back on the brief: PR #4 idle",
      "No snooze with that number. Send /snoozed to see them.",
      "No snooze with that number. Send /snoozed to see them.",
    ]);
  });
  it("ignores snooze taps and answers /snoozed and /unsnooze with snooze off, whatever focusButtons is", async () => {
    mocks.features.snooze = false;
    mocks.features.focusButtons = true;
    expect(await onCallbackQuery(tap("s:70:1:3"), WED)).toBeUndefined();
    await onTextMessage(message("/snoozed"), WED);
    await onTextMessage(message("/unsnooze 1"), WED);
    expect(mocks.getBriefSnoozable).not.toHaveBeenCalled();
    expect(mocks.listSnoozes).not.toHaveBeenCalled();
    expect(mocks.deleteSnooze).not.toHaveBeenCalled();
    expect(mocks.sendMessage.mock.calls).toEqual([
      ["/snoozed isn't switched on yet. Turn on features.snooze in config.json."],
      ["/unsnooze isn't switched on yet. Turn on features.snooze in config.json."],
    ]);
  });
});
