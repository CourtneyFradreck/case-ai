import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ telegramBotToken: "123:secret" as string | undefined, telegramChatId: "42" as string | undefined }));
vi.mock("../src/env.js", () => ({ env }));
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage, TelegramError } from "../src/telegram.js";

const fetchMock = vi.fn();
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const sent = () => {
  const [url, init] = fetchMock.mock.calls[0];
  return { url: url as string, init: init as RequestInit, body: JSON.parse((init as RequestInit).body as string) };
};
const keyboard = { inline_keyboard: [[{ text: "Pick", callback_data: "focus:1" }]] };

describe("Telegram client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    env.telegramBotToken = "123:secret";
    env.telegramChatId = "42";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends HTML with web previews off to the configured chat", async () => {
    fetchMock.mockImplementation(async () => ok({ message_id: 9, chat: { id: 42 } }));
    expect(await sendMessage("<b>Hi</b>")).toEqual({ message_id: 9, chat: { id: 42 } });
    const { url, init, body } = sent();
    expect(url).toBe("https://api.telegram.org/bot123:secret/sendMessage");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(body).toEqual({ chat_id: "42", text: "<b>Hi</b>", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  it("attaches an inline keyboard when given", async () => {
    fetchMock.mockImplementation(async () => ok({ message_id: 9, chat: { id: 42 } }));
    await sendMessage("Hi", keyboard);
    expect(sent().body.reply_markup).toEqual(keyboard);
  });
  it("edits a message's buttons, and clears them without a markup", async () => {
    fetchMock.mockImplementation(async () => ok(true));
    await editMessageReplyMarkup(9, keyboard);
    expect(sent().url).toMatch(/\/editMessageReplyMarkup$/);
    expect(sent().body).toEqual({ chat_id: "42", message_id: 9, reply_markup: keyboard });
    fetchMock.mockClear();
    await editMessageReplyMarkup(9);
    expect(sent().body.reply_markup).toEqual({ inline_keyboard: [] });
  });
  it("answers a callback query, with optional text", async () => {
    fetchMock.mockImplementation(async () => ok(true));
    await answerCallbackQuery("cb1");
    expect(sent().url).toMatch(/\/answerCallbackQuery$/);
    expect(sent().body).toEqual({ callback_query_id: "cb1" });
    fetchMock.mockClear();
    await answerCallbackQuery("cb1", "Done");
    expect(sent().body).toEqual({ callback_query_id: "cb1", text: "Done" });
  });
  it("throws the Bot API description without leaking the token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }), { status: 400 }));
    const error = await sendMessage("<b").catch((e) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error.message).toBe("Telegram sendMessage failed (400): Bad Request: can't parse entities");
    expect(error.message).not.toContain("secret");
  });
  it("reports non-JSON responses and network failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 502, statusText: "Bad Gateway" }));
    await expect(sendMessage("Hi")).rejects.toThrow("Telegram sendMessage failed (502): Bad Gateway");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.telegram.org") }));
    await expect(sendMessage("Hi")).rejects.toThrow("Telegram sendMessage failed: fetch failed: getaddrinfo ENOTFOUND api.telegram.org");
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(sendMessage("Hi")).rejects.toThrow("Telegram sendMessage failed: timed out");
  });
  it("refuses to call the API without a token or chat id", async () => {
    env.telegramBotToken = undefined;
    await expect(sendMessage("Hi")).rejects.toThrow("TELEGRAM_BOT_TOKEN is not set");
    env.telegramBotToken = "123:secret";
    env.telegramChatId = undefined;
    await expect(sendMessage("Hi")).rejects.toThrow("TELEGRAM_CHAT_ID is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
