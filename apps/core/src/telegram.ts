import { env } from "./env.js";

const TIMEOUT_MS = 10_000;

export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };
export type SentMessage = { message_id: number; chat: { id: number } };

// The bot token is part of the request URL, so errors never include the URL.
export class TelegramError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, description: string) {
    super(`Telegram ${method} failed${code ? ` (${code})` : ""}: ${description}`);
  }
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  if (!env.telegramBotToken) throw new TelegramError(method, undefined, "TELEGRAM_BOT_TOKEN is not set");
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new TelegramError(method, undefined, networkReason(e));
  }
  const data = await res.json().catch(() => undefined) as { ok?: boolean; result?: T; error_code?: number; description?: string } | undefined;
  if (!data?.ok) throw new TelegramError(method, data?.error_code ?? res.status, data?.description ?? (res.statusText || "invalid response"));
  return data.result as T;
}

function networkReason(e: unknown) {
  if (!(e instanceof Error)) return String(e);
  if (e.name === "TimeoutError") return "timed out";
  const cause = e.cause instanceof Error ? `: ${e.cause.message}` : "";
  return `${e.message}${cause}`;
}

function chatId(method: string) {
  if (!env.telegramChatId) throw new TelegramError(method, undefined, "TELEGRAM_CHAT_ID is not set");
  return env.telegramChatId;
}

export async function sendMessage(text: string, replyMarkup?: InlineKeyboardMarkup) {
  return call<SentMessage>("sendMessage", {
    chat_id: chatId("sendMessage"), text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// Without replyMarkup the message's buttons are removed.
export async function editMessageReplyMarkup(messageId: number, replyMarkup?: InlineKeyboardMarkup) {
  return call<SentMessage | true>("editMessageReplyMarkup", {
    chat_id: chatId("editMessageReplyMarkup"), message_id: messageId, reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  return call<true>("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}
