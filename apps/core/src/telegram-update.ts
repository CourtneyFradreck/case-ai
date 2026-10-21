import { env } from "./env.js";
import { answerCallbackQuery } from "./telegram.js";
import { onCallbackQuery, onTextMessage } from "./telegram-handlers.js";

// Only the fields case-core reads. Update text is untrusted input.
export type TelegramMessage = { message_id: number; chat: { id: number }; date?: number; text?: string };
export type TelegramCallbackQuery = { id: string; from: { id: number }; message?: TelegramMessage; data?: string };
export type TelegramUpdate = { update_id?: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery };

export type UpdateOutcome = "callback_query" | "message" | "ignored_chat" | "ignored_unsupported";

function log(update: TelegramUpdate, outcome: UpdateOutcome, extra: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ event: "telegram_update", updateId: update.update_id ?? null, outcome, ...extra }));
}

export function updateChatId(update: TelegramUpdate): number | undefined {
  return update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
}

export async function handleUpdate(update: TelegramUpdate): Promise<UpdateOutcome> {
  const chatId = updateChatId(update);
  if (chatId === undefined || !env.telegramChatId || String(chatId) !== env.telegramChatId) {
    log(update, "ignored_chat", { chatId: chatId ?? null });
    return "ignored_chat";
  }

  const query = update.callback_query;
  if (query) {
    log(update, "callback_query");
    let answerText: string | undefined;
    try {
      answerText = (await onCallbackQuery(query))?.answerText;
    } finally {
      // Always answer, even if the handler failed, so the button stops spinning.
      await answerCallbackQuery(query.id, answerText).catch((e) => console.error("answerCallbackQuery failed", e));
    }
    return "callback_query";
  }

  if (typeof update.message?.text === "string") {
    log(update, "message");
    await onTextMessage(update.message);
    return "message";
  }

  log(update, "ignored_unsupported");
  return "ignored_unsupported";
}
