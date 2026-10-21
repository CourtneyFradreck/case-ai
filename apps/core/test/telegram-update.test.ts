import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { telegramChatId: "42" as string | undefined },
  answerCallbackQuery: vi.fn(), onCallbackQuery: vi.fn(), onTextMessage: vi.fn(),
}));
vi.mock("../src/env.js", () => ({ env: mocks.env }));
vi.mock("../src/telegram.js", () => ({ answerCallbackQuery: mocks.answerCallbackQuery }));
vi.mock("../src/telegram-handlers.js", () => ({ onCallbackQuery: mocks.onCallbackQuery, onTextMessage: mocks.onTextMessage }));
import { handleUpdate } from "../src/telegram-update.js";

const message = (chatId: number, text?: string) => ({ message_id: 5, chat: { id: chatId }, date: 0, ...(text === undefined ? {} : { text }) });
const callback = (chatId: number) => ({ update_id: 2, callback_query: { id: "cb1", from: { id: chatId }, message: message(chatId), data: "focus:1" } });
const logged = () => vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(line));

describe("Telegram update routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.env.telegramChatId = "42";
    mocks.answerCallbackQuery.mockResolvedValue(true);
  });

  it("routes a text message from the configured chat", async () => {
    const update = { update_id: 1, message: message(42, "hello") };
    expect(await handleUpdate(update)).toBe("message");
    expect(mocks.onTextMessage).toHaveBeenCalledWith(update.message);
    expect(logged()).toEqual([{ event: "telegram_update", updateId: 1, outcome: "message" }]);
  });
  it("routes a callback query and answers it", async () => {
    expect(await handleUpdate(callback(42))).toBe("callback_query");
    expect(mocks.onCallbackQuery).toHaveBeenCalledWith(callback(42).callback_query);
    expect(mocks.answerCallbackQuery).toHaveBeenCalledWith("cb1", undefined);
  });
  it("answers with the handler's text", async () => {
    mocks.onCallbackQuery.mockResolvedValue({ answerText: "Focus set" });
    await handleUpdate(callback(42));
    expect(mocks.answerCallbackQuery).toHaveBeenCalledWith("cb1", "Focus set");
  });
  it("still answers the callback when the handler throws", async () => {
    mocks.onCallbackQuery.mockRejectedValue(new Error("boom"));
    await expect(handleUpdate(callback(42))).rejects.toThrow("boom");
    expect(mocks.answerCallbackQuery).toHaveBeenCalledWith("cb1", undefined);
  });
  it("logs, rather than throws, when answering fails", async () => {
    mocks.answerCallbackQuery.mockRejectedValue(new Error("Telegram answerCallbackQuery failed (400)"));
    expect(await handleUpdate(callback(42))).toBe("callback_query");
    expect(console.error).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["another chat", { update_id: 3, message: message(99, "/brief") }, "42"],
    ["a callback from another chat", callback(99), "42"],
    ["no configured chat", { update_id: 3, message: message(42, "/brief") }, undefined],
  ])("ignores and logs updates from %s", async (_name, update, configured) => {
    mocks.env.telegramChatId = configured;
    expect(await handleUpdate(update)).toBe("ignored_chat");
    expect(mocks.onTextMessage).not.toHaveBeenCalled();
    expect(mocks.onCallbackQuery).not.toHaveBeenCalled();
    expect(mocks.answerCallbackQuery).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "telegram_update", outcome: "ignored_chat", chatId: updateChatIdOf(update) });
  });
  it("ignores updates without a chat", async () => {
    expect(await handleUpdate({ update_id: 4 })).toBe("ignored_chat");
    expect(logged()[0]).toMatchObject({ chatId: null });
  });
  it("ignores messages without text, such as photos", async () => {
    expect(await handleUpdate({ update_id: 5, message: message(42) })).toBe("ignored_unsupported");
    expect(mocks.onTextMessage).not.toHaveBeenCalled();
  });
  it("never logs message text", async () => {
    await handleUpdate({ update_id: 6, message: message(42, "private note") });
    await handleUpdate({ update_id: 7, message: message(99, "private note") });
    expect(JSON.stringify(logged())).not.toContain("private note");
  });
});

function updateChatIdOf(update: { message?: { chat: { id: number } }; callback_query?: { message?: { chat: { id: number } } } }) {
  return update.message?.chat.id ?? update.callback_query?.message?.chat.id;
}
